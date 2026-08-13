import { Hono } from "hono";
import type { Env } from "./env";
import { api } from "./api";
import { waitlist } from "./waitlist";
import { requireUser, accessEmail, getIdentity, resolveAuth, type AuthVars } from "./auth";
import { serveArtifact } from "./serve";
import {
  listArtifacts,
  listArtifactsOwnedBy,
  getArtifact,
  grantedSlugs,
  hasGrant,
  allGrants,
  allVersions,
  getVersion,
  logView,
  viewCounts,
  recentViews,
} from "./db";
import { canView, canManage, isOwner } from "./authz";
import { listApiTokens, toPublicToken, type PublicApiToken } from "./tokens";
import { allowlistView } from "./access-api";
import { describeUsers, listUsers, privilegedEmails } from "./users";
import { galleryPage, notFoundPage } from "./pages";
import { landingPage } from "./landing";
import { docsPage } from "./docs";
import { loginPage } from "./login";
import { adminPage, type DashboardViewer } from "./admin";
import { isContentHost, isManagementPath, isPerOriginPath, firstContentHostname } from "./host";
import { robotsTxt, sitemapXml, llmsTxt, ogImageSvg, isCanonicalHost } from "./seo";

const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// Content-origin isolation: when CONTENT_HOSTNAMES is configured, a content
// host may only serve artifact files — never the dashboard/API/admin/gallery
// routes — and the app host must never serve uploaded artifact HTML, since
// that content is untrusted and would otherwise run same-origin as the app.
app.use("*", async (c, next) => {
  const contentHost = firstContentHostname(c.env);
  if (contentHost === undefined) {
    await next();
    return;
  }
  const onContentHost = isContentHost(c.env, c.req.url);
  if (onContentHost) {
    // robots.txt is answered by whichever origin was asked (see isPerOriginPath).
    if (isPerOriginPath(c.req.path)) {
      await next();
      return;
    }
    if (isManagementPath(c.req.path)) return c.html(notFoundPage(), 404);
  } else if (!isManagementPath(c.req.path) && !isPerOriginPath(c.req.path)) {
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      const target = new URL(c.req.url);
      target.host = contentHost;
      return c.redirect(target.toString(), 302);
    }
    return c.html(notFoundPage(), 404);
  }
  await next();
});

app.get("/health", (c) => c.text("ok"));

app.get("/whoami", async (c) => {
  const email = await accessEmail(c);
  return c.json({ email });
});

/** Narrow a slug-keyed lookup to the artifacts this dashboard actually renders. */
function scope<T>(map: Map<string, T>, slugs: Set<string>): Map<string, T> {
  const out = new Map<string, T>();
  for (const slug of slugs) {
    const value = map.get(slug);
    if (value !== undefined) out.set(slug, value);
  }
  return out;
}

// Management dashboard. Admins see and manage every artifact; a member sees
// and manages only the ones they own. (In production Cloudflare Access still
// gates who can reach this path at all — see docs/DEPLOY_RTFX.md.)
app.get("/admin", requireUser, async (c) => {
  const identity = c.get("identity");
  const rows = identity.isAdmin
    ? await listArtifacts(c.env)
    : await listArtifactsOwnedBy(c.env, identity.email!);
  const slugs = new Set(rows.map((r) => r.slug));

  const [grants, versions, viewCountsMap, recentViewsMap] = await Promise.all([
    allGrants(c.env),
    allVersions(c.env),
    viewCounts(c.env),
    recentViews(c.env),
  ]);

  // The user directory is admin-only data — never fetch or render it otherwise.
  // Same shape the JSON API returns from GET /api/users, so the server-rendered
  // panel and anything scripted against the API can never disagree.
  let usersInfo: DashboardViewer["users"] = null;
  if (identity.isAdmin) {
    const [rows, allowlist] = await Promise.all([listUsers(c.env), allowlistView(c.env)]);
    usersInfo = {
      users: describeUsers(c.env, rows, allowlist.emails),
      admins: privilegedEmails(c.env),
      allowlist,
      viewer: identity.email,
      canManageAdmins: identity.role === "super_admin",
    };
  }

  // Token management mirrors /api/tokens: Access-authenticated callers only
  // (see denyApiToken), so a bearer token can't even enumerate credentials via
  // the dashboard. An admin sees every token; a member only their own.
  let tokens: PublicApiToken[] | null = null;
  if (!identity.token) {
    const tokenRows = identity.isAdmin
      ? await listApiTokens(c.env)
      : await listApiTokens(c.env, identity.email!);
    tokens = tokenRows.map(toPublicToken);
  }

  return c.html(
    adminPage(
      rows,
      scope(grants, slugs),
      scope(versions, slugs),
      { counts: scope(viewCountsMap, slugs), recent: scope(recentViewsMap, slugs) },
      c.get("email"),
      { isAdmin: identity.isAdmin, users: usersInfo, tokens }
    )
  );
});

// JSON API for dashboard + CLI.
app.route("/api", api);

// Public landing-page waitlist signup (unauthenticated).
app.route("/waitlist", waitlist);

// --- Public product surface (issue #29) -------------------------------------
// Everything below is served to anyone, identically, without reading an identity:
// the two marketing/doc pages plus the files crawlers and AI agents look for.
// These paths must sit OUTSIDE the Cloudflare Access application in production
// (see docs/DEPLOY_RTFX.md), or a visitor meets Access's login screen instead.

/** Public pages are the same bytes for everyone, so they cache at the edge. */
const PUBLIC_HTML_CACHE = "public, max-age=300";
const PUBLIC_FILE_CACHE = "public, max-age=3600";

app.get("/", (c) =>
  c.html(landingPage(c.env), 200, { "Cache-Control": PUBLIC_HTML_CACHE })
);

// Public product documentation: use cases, publishing (CLI/API/Claude Code/
// Hermes), the access-control and privacy model, and the FAQ that backs the
// FAQPage structured data on the page.
app.get("/docs", (c) => c.html(docsPage(c.env), 200, { "Cache-Control": PUBLIC_HTML_CACHE }));

// robots.txt is answered by whichever origin was asked, with three different
// answers: crawl the product pages (canonical app host), crawl nothing (the
// artifact content host), crawl nothing (a preview/staging host, so it can
// never compete with rtfx.pro in an index).
app.get("/robots.txt", (c) => {
  const audience = isContentHost(c.env, c.req.url)
    ? "content"
    : isCanonicalHost(c.env, c.req.url)
      ? "public"
      : "non-canonical";
  return c.text(robotsTxt(c.env, audience), 200, { "Cache-Control": PUBLIC_FILE_CACHE });
});

app.get(
  "/sitemap.xml",
  (c) =>
    new Response(sitemapXml(c.env), {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": PUBLIC_FILE_CACHE,
      },
    })
);

// llms.txt (llmstxt.org): the machine-readable product summary for AI agents and
// answer engines — what this is, who it's for, how publishing works, and what is
// deliberately not crawlable.
app.get("/llms.txt", (c) => c.text(llmsTxt(c.env), 200, { "Cache-Control": PUBLIC_FILE_CACHE }));

app.get(
  "/og.svg",
  (c) =>
    new Response(ogImageSvg(), {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      },
    })
);

// Sign-in surface. Public on purpose: it explains how to get in, so it must sit
// OUTSIDE the Cloudflare Access application (see docs/DEPLOY_RTFX.md). It never
// authenticates anyone itself — "Continue with email" simply hands off to
// /admin, which Access gates, which is what sends the one-time code.
app.get("/login", async (c) => {
  const { identity, disabled, disabledEmail } = await resolveAuth(c);
  if (disabled) return c.html(loginPage(c.env, { kind: "paused", email: disabledEmail }), 403);
  if (identity?.email) return c.html(loginPage(c.env, { kind: "signed-in", email: identity.email }));
  return c.html(loginPage(c.env, { kind: "signed-out" }));
});

// Gallery — filtered to what the viewer may see. Requires sign-in; anonymous
// visitors are sent to /login, which explains how to get in, rather than an
// empty gallery. A paused account is told so instead of looking signed out.
app.get("/gallery", async (c) => {
  const { identity, disabled, disabledEmail } = await resolveAuth(c);
  if (disabled) return c.html(loginPage(c.env, { kind: "paused", email: disabledEmail }), 403);
  if (!identity) return c.redirect("/login", 302);
  const rows = await listArtifacts(c.env);
  let visible = rows;
  if (!identity.isAdmin) {
    const granted = identity.email ? await grantedSlugs(c.env, identity.email) : new Set<string>();
    visible = rows.filter(
      (r) => r.visibility === "everyone" || granted.has(r.slug) || isOwner(identity, r)
    );
  }
  return c.html(galleryPage(visible));
});

// Version preview for people who manage the artifact (admin or owner):
// /v/<slug>/<n>/<path> serves a specific version. Relative assets resolve within
// this prefix. Everyone else gets 404 (existence stays hidden).
app.get("/v/*", async (c) => {
  const identity = await getIdentity(c);
  const parts = c.req.path.replace(/^\/v\/+/, "").split("/");
  const slug = decodeURIComponent(parts[0] ?? "");
  const version = Number(parts[1]);
  const filePath = parts.slice(2).map(decodeURIComponent).join("/");
  if (!slug || !Number.isInteger(version) || version < 1) return c.html(notFoundPage(slug), 404);
  const art = await getArtifact(c.env, slug);
  if (!art || !canManage(identity, art)) return c.html(notFoundPage(slug), 404);
  if (!(await getVersion(c.env, slug, version))) return c.html(notFoundPage(slug), 404);
  return serveArtifact(c, slug, version, filePath);
});

// Catch-all: serve the current version's files, subject to per-artifact
// authorization. Runs last so named routes win.
app.get("*", async (c) => {
  const rest = c.req.path.replace(/^\/+/, "");
  const idx = rest.indexOf("/");
  const slug = decodeURIComponent(idx === -1 ? rest : rest.slice(0, idx));
  const filePath = idx === -1 ? "" : decodeURIComponent(rest.slice(idx + 1));

  const identity = await getIdentity(c);
  const art = await getArtifact(c.env, slug);
  // 404 for both missing and unauthorized, so probing a slug can't reveal it exists.
  if (!art) return c.html(notFoundPage(slug), 404);
  const owned = isOwner(identity, art);
  let granted = false;
  if (art.visibility === "restricted" && !identity?.isAdmin && !owned && identity?.email) {
    granted = await hasGrant(c.env, slug, identity.email);
  }
  if (!canView(identity, art.visibility, granted, owned)) return c.html(notFoundPage(slug), 404);

  const res = await serveArtifact(c, slug, art.current_version, filePath);

  // Log a view for an HTML page load by a signed-in person (not assets, not
  // machine/service-token fetches). Non-blocking in production; awaited in tests.
  const isHtml = (res.headers.get("Content-Type") ?? "").startsWith("text/html");
  if (res.ok && isHtml && identity?.email) {
    const cf = (c.req.raw as { cf?: { country?: string } }).cf;
    const p = logView(c.env, {
      slug,
      version: art.current_version,
      email: identity.email,
      path: filePath,
      country: cf?.country ?? null,
      referrer: (c.req.header("Referer") ?? "").slice(0, 500) || null,
      viewed_at: new Date().toISOString(),
    });
    let ctx: { waitUntil(promise: Promise<unknown>): void } | undefined;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = undefined;
    }
    if (ctx) ctx.waitUntil(p);
    else await p;
  }

  return res;
});

export default app;
