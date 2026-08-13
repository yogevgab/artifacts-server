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
import { loginPage } from "./login";
import { adminPage, type DashboardViewer } from "./admin";
import { isContentHost, isManagementPath, firstContentHostname } from "./host";

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
    if (isManagementPath(c.req.path)) return c.html(notFoundPage(), 404);
  } else if (!isManagementPath(c.req.path)) {
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

// Management dashboard. Admins see and manage every artifact; a beta user sees
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
  // the dashboard. An admin sees every token; a beta user only their own.
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

// Public landing page: marketing pitch, pricing/beta messaging, waitlist signup.
// Reachable by anyone — never gates on identity.
app.get("/", (c) => c.html(landingPage()));

// Sign-in surface. Public on purpose: it explains how to get in, so it must sit
// OUTSIDE the Cloudflare Access application (see docs/DEPLOY_RTFX.md). It never
// authenticates anyone itself — "Continue with email" simply hands off to
// /admin, which Access gates, which is what sends the one-time code.
app.get("/login", async (c) => {
  const { identity, disabled, disabledEmail } = await resolveAuth(c);
  if (disabled) return c.html(loginPage({ kind: "paused", email: disabledEmail }), 403);
  if (identity?.email) return c.html(loginPage({ kind: "signed-in", email: identity.email }));
  return c.html(loginPage({ kind: "signed-out" }));
});

// Gallery — filtered to what the viewer may see. Requires sign-in; anonymous
// visitors are sent to /login, which explains how to get in, rather than an
// empty gallery. A paused account is told so instead of looking signed out.
app.get("/gallery", async (c) => {
  const { identity, disabled, disabledEmail } = await resolveAuth(c);
  if (disabled) return c.html(loginPage({ kind: "paused", email: disabledEmail }), 403);
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
