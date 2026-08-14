import { Hono, type Context } from "hono";
import type { ArtifactRow, Env, VersionRow } from "./env";
import { api } from "./api";
import { waitlist } from "./waitlist";
import { authRoutes } from "./auth-routes";
import { requireUser, accessEmail, accountsFor, getIdentity, resolveAuth, type AuthVars } from "./auth";
import { serveArtifact } from "./serve";
import {
  listArtifacts,
  listArtifactsForCaller,
  getArtifact,
  grantedSlugs,
  hasGrant,
  allGrants,
  allVersions,
  getVersion,
  getViews,
  listGrants,
  listVersions,
  logView,
  viewCounts,
  recentViews,
} from "./db";
import { canView, canManage, isOwner, belongsToCaller } from "./authz";
import {
  accountIdsWithAtLeast,
  atLeast,
  memberRole,
  resolveAccountContext,
  MANAGE_ARTIFACTS,
} from "./accounts";
import type { Identity } from "./auth";
import { listApiTokens, toPublicToken, type PublicApiToken } from "./tokens";
import { allowlistView } from "./access-api";
import { adminEmails, describeUsers, listUsers, privilegedEmails, superAdminEmails } from "./users";
import { notFoundPage } from "./pages";
import { landingPage } from "./landing";
import { docsPage } from "./docs";
import { privacyPage, termsPage } from "./legal";
import { loginPage } from "./login";
import {
  overviewPage,
  artifactsPage,
  artifactDetailPage,
  galleryPage,
  settingsPage,
  platformPage,
  type ViewsInfo,
  type PlatformInfo,
} from "./admin";
import { peoplePage, type UsersInfo } from "./people";
import { integrationsPage } from "./integrations";
import { canSeeSection, portalNotFound, type PortalViewer } from "./portal";
import { isContentHost, isManagementPath, isPerOriginPath, firstContentHostname, parseHostnames } from "./host";
import {
  robotsTxt,
  sitemapXml,
  llmsTxt,
  ogImageSvg,
  OG_IMAGE_PNG_BASE64,
  LOGO_PNG_BASE64,
  isCanonicalHost,
  siteOrigin,
} from "./seo";

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

// Baseline response headers for the app and public pages. Artifact content adds its own
// content-specific policy in serveArtifact().
app.use("*", async (c, next) => {
  await next();
  if (!c.res.headers.has("X-Content-Type-Options")) c.header("X-Content-Type-Options", "nosniff");
  if (!c.res.headers.has("Referrer-Policy")) c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  if (!c.res.headers.has("X-Frame-Options")) c.header("X-Frame-Options", "DENY");
});

app.get("/health", (c) => c.text("ok"));

app.get("/whoami", async (c) => {
  const email = await accessEmail(c);
  return c.json({ email });
});

/** Narrow a slug-keyed lookup to the artifacts this portal page actually renders. */
function scope<T>(map: Map<string, T>, slugs: Set<string>): Map<string, T> {
  const out = new Map<string, T>();
  for (const slug of slugs) {
    const value = map.get(slug);
    if (value !== undefined) out.set(slug, value);
  }
  return out;
}

// --- /admin: the portal (issue #28) -----------------------------------------
// One server-rendered page per section, navigated with ordinary links. Every
// section re-derives the caller's identity and re-checks what they may see:
// there is no client router and no shared client state, so a URL typed by hand
// is exactly as safe as one clicked in the nav.
//
// Admins see and manage every artifact; a member sees and manages only the ones
// they own. (In production Cloudflare Access still gates who can reach /admin
// at all — see docs/DEPLOY_RTFX.md.)

type PortalContext = Context<{ Bindings: Env; Variables: AuthVars }>;

/**
 * Who is looking at the portal, including which workspace they are acting in
 * (issue #27).
 *
 * The two role systems are carried side by side and never merged: `role` is
 * PLATFORM authority derived from configuration, `workspace.role` is the
 * ACCOUNT role read from D1. Nothing in the workspace half can change what the
 * platform half permits — the nav, for example, still gates the Platform section
 * on `role === 'super_admin'` alone.
 */
async function viewerOf(c: PortalContext): Promise<PortalViewer> {
  const identity = c.get("identity");
  const ctx = await accountsFor(c);
  return {
    email: c.get("email"),
    isAdmin: identity.isAdmin,
    role: identity.role,
    isTokenCaller: !!identity.token,
    workspace:
      ctx.active && ctx.role
        ? {
            id: ctx.active.id,
            name: ctx.active.name,
            kind: ctx.active.kind,
            role: ctx.role,
            count: ctx.memberships.length,
          }
        : null,
  };
}

/** The artifacts this caller manages, with everything the cards need. */
async function artifactContext(c: PortalContext): Promise<{
  rows: ArtifactRow[];
  grants: Map<string, string[]>;
  versions: Map<string, VersionRow[]>;
  views: ViewsInfo;
}> {
  const identity = c.get("identity");
  // Platform admins see the instance; everybody else sees what they own by email
  // plus what their workspaces own. Identical results for a personal account.
  const rows = identity.isAdmin
    ? await listArtifacts(c.env)
    : await listArtifactsForCaller(
        c.env,
        identity.email,
        accountIdsWithAtLeast((await accountsFor(c)).roles, MANAGE_ARTIFACTS)
      );
  const slugs = new Set(rows.map((r) => r.slug));
  const [grants, versions, counts, recent] = await Promise.all([
    allGrants(c.env),
    allVersions(c.env),
    viewCounts(c.env),
    recentViews(c.env),
  ]);
  return {
    rows,
    grants: scope(grants, slugs),
    versions: scope(versions, slugs),
    views: { counts: scope(counts, slugs), recent: scope(recent, slugs) },
  };
}

/**
 * Every artifact this caller may *open* — what the Gallery section lists.
 *
 * Deliberately a different question from `artifactContext`, which answers "what
 * may I manage?". A member sees what they own, what their workspaces own, what
 * has been granted to them by name, and anything published to everyone signed
 * in. An admin sees the instance.
 */
async function readableArtifacts(c: PortalContext): Promise<ArtifactRow[]> {
  const identity = c.get("identity");
  const rows = await listArtifacts(c.env);
  if (identity.isAdmin) return rows;
  const [granted, accounts] = await Promise.all([
    identity.email ? grantedSlugs(c.env, identity.email) : Promise.resolve(new Set<string>()),
    // `ensure: false` — the gallery is a read path and must not provision an
    // account as a side effect of somebody looking at it.
    resolveAccountContext(
      c.env,
      { email: identity.email, accountId: identity.accountId, isToken: !!identity.token },
      { ensure: false }
    ),
  ]);
  return rows.filter(
    (r) =>
      r.visibility === "everyone" ||
      granted.has(r.slug) ||
      // Owner by email, or any member of the artifact's workspace — including a
      // `viewer`, whose whole purpose is to see without changing (issue #27).
      belongsToCaller(identity, r, accounts.roles)
  );
}

/**
 * The people directory, or null when this caller may not have it. Admin-only
 * data, and never for a bearer token — `/api/users` refuses one outright, so
 * the portal must not hand it the same directory by another route. Same shape
 * the JSON API returns from GET /api/users, so the server-rendered section and
 * anything scripted against the API can never disagree.
 */
async function usersInfoFor(c: PortalContext): Promise<UsersInfo | null> {
  const identity = c.get("identity");
  if (!identity.isAdmin || identity.token) return null;
  const [rows, allowlist] = await Promise.all([listUsers(c.env), allowlistView(c.env)]);
  return {
    users: describeUsers(c.env, rows, allowlist.emails),
    admins: privilegedEmails(c.env),
    allowlist,
    viewer: identity.email,
    canManageAdmins: identity.role === "super_admin",
  };
}

/**
 * Token metadata, or null when the caller may not manage tokens at all. Mirrors
 * `/api/tokens`: Access-authenticated callers only (see denyApiToken), so a
 * bearer token can't enumerate credentials via the portal. An admin sees every
 * token; a member only their own.
 */
async function tokensFor(c: PortalContext): Promise<PublicApiToken[] | null> {
  const identity = c.get("identity");
  if (identity.token) return null;
  const rows = identity.isAdmin
    ? await listApiTokens(c.env)
    : await listApiTokens(c.env, identity.email!);
  return rows.map(toPublicToken);
}

app.get("/admin", requireUser, async (c) => {
  const viewer = await viewerOf(c);
  const [{ rows, grants, versions, views }, users, tokens] = await Promise.all([
    artifactContext(c),
    usersInfoFor(c),
    tokensFor(c),
  ]);
  return c.html(overviewPage({ viewer, rows, grants, versions, views, tokens, users }));
});

app.get("/admin/artifacts", requireUser, async (c) => {
  const viewer = await viewerOf(c);
  const { rows, grants, versions, views } = await artifactContext(c);
  return c.html(artifactsPage({ viewer, rows, grants, versions, views }));
});

// One artifact, with its versions, view log, access list and danger zone.
// 404 for both "no such artifact" and "not yours", so probing a slug here can
// never reveal one exists — the same rule the public catch-all follows.
app.get("/admin/artifacts/:slug", requireUser, async (c) => {
  const viewer = await viewerOf(c);
  const slug = c.req.param("slug");
  const row = await getArtifact(c.env, slug);
  if (!row || !canManage(c.get("identity"), row, (await accountsFor(c)).roles)) {
    return c.html(portalNotFound(viewer, `The artifact "${slug}"`), 404);
  }
  const [emails, versions, stats] = await Promise.all([
    listGrants(c.env, slug),
    listVersions(c.env, slug),
    getViews(c.env, slug),
  ]);
  const views: ViewsInfo = {
    counts: new Map([[slug, { total: stats.total, unique: stats.unique }]]),
    recent: new Map([[slug, stats.recent]]),
  };
  return c.html(artifactDetailPage({ viewer, row, emails, versions, views }));
});

// The Gallery section (issue #35): what this person can open, rather than what
// they manage. Formerly the standalone /gallery page, which now redirects here.
app.get("/admin/gallery", requireUser, async (c) => {
  const viewer = await viewerOf(c);
  return c.html(galleryPage(viewer, await readableArtifacts(c)));
});

app.get("/admin/people", requireUser, async (c) => {
  const viewer = await viewerOf(c);
  const users = await usersInfoFor(c);
  if (!canSeeSection(viewer, "people") || !users) {
    return c.html(portalNotFound(viewer, "The People section"), 404);
  }
  return c.html(peoplePage(viewer, users));
});

app.get("/admin/integrations", requireUser, async (c) => {
  const viewer = await viewerOf(c);
  const tokens = await tokensFor(c);
  return c.html(integrationsPage(viewer, tokens, siteOrigin(c.env)));
});

app.get("/admin/settings", requireUser, async (c) => c.html(settingsPage(await viewerOf(c))));

app.get("/admin/platform", requireUser, async (c) => {
  const viewer = await viewerOf(c);
  if (!canSeeSection(viewer, "platform")) {
    return c.html(portalNotFound(viewer, "The Platform section"), 404);
  }
  const [rows, versions, users, tokens] = await Promise.all([
    listArtifacts(c.env),
    allVersions(c.env),
    listUsers(c.env),
    listApiTokens(c.env),
  ]);
  const info: PlatformInfo = {
    origin: siteOrigin(c.env),
    accessConfigured: !!(c.env.ACCESS_AUD && c.env.ACCESS_TEAM_DOMAIN),
    accessTeamDomain: c.env.ACCESS_TEAM_DOMAIN ?? "",
    accessManagementConfigured: !!(
      c.env.CF_API_TOKEN &&
      c.env.CF_ACCOUNT_ID &&
      c.env.ACCESS_VIEWER_APP_ID &&
      c.env.ACCESS_VIEWER_POLICY_ID
    ),
    contentHosts: [...parseHostnames(c.env.CONTENT_HOSTNAMES)],
    devLogin: c.env.DEV_LOGIN === "true",
    adminCount: adminEmails(c.env).length,
    superAdminCount: superAdminEmails(c.env).length,
    serviceTokenCount: (c.env.ADMIN_SERVICE_TOKENS ?? "").split(",").filter((s) => s.trim()).length,
    totals: {
      artifacts: rows.length,
      versions: [...versions.values()].reduce((n, v) => n + v.length, 0),
      bytes: rows.reduce((n, r) => n + r.size_bytes, 0),
      people: users.length,
      tokens: tokens.length,
    },
  };
  return c.html(platformPage(viewer, info));
});

// Anything else under /admin is not a section. Render the portal shell so the
// person still has navigation, but answer 404 so a mistyped URL is never a 200.
app.get("/admin/*", requireUser, async (c) =>
  c.html(portalNotFound(await viewerOf(c), "That page"), 404)
);

// JSON API for dashboard + CLI.
app.route("/api", api);

// Public landing-page waitlist signup (unauthenticated).
app.route("/waitlist", waitlist);

// App-owned sign-in (/auth/*). Mounted at the root because the module declares
// its own full paths. App host only — see MANAGEMENT_PREFIXES in host.ts.
app.route("/", authRoutes);

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

// Privacy policy and terms of use (issue #36). Public for the same reason /docs
// is: they are what somebody reads *before* deciding to sign up, so gating them
// behind the sign-in they are trying to evaluate would defeat them entirely.
app.get("/privacy", (c) => c.html(privacyPage(c.env), 200, { "Cache-Control": PUBLIC_HTML_CACHE }));

app.get("/terms", (c) => c.html(termsPage(c.env), 200, { "Cache-Control": PUBLIC_HTML_CACHE }));

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
/** One of the two checked-in brand rasters, decoded from base64 (see src/seo.ts). */
const pngResponse = (base64: string) =>
  new Response(Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0)), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });

app.get("/og.png", () => pngResponse(OG_IMAGE_PNG_BASE64));

// The square mark, for `Organization.logo` in the landing page's JSON-LD. That
// pointed at /og.png — a 1200×630 card that is mostly headline copy — which is
// not what a consumer of the graph is promised when it asks for a logo. Public,
// like the rest of the crawler-facing files, so it needs an Access Bypass
// destination alongside /og.png (docs/DEPLOY_RTFX.md §5.3).
app.get("/logo.png", () => pngResponse(LOGO_PNG_BASE64));


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

// Cloudflare's built-in /cdn-cgi/access/logout is edge-owned and can be awkward
// to expose consistently on a custom-domain Worker route. This first-party route
// gives the portal a stable Sign out target: expire the Access app cookies for
// this domain and land back on the public sign-in explainer.
app.get("/logout", () =>
  new Response(null, {
    status: 302,
    headers: [
      ["Location", "/login"],
      [
        "Set-Cookie",
        "CF_Authorization=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=None",
      ],
      [
        "Set-Cookie",
        "CF_AppSession=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax",
      ],
    ],
  })
);

/**
 * The gallery is a dashboard section now (issue #35). This route is kept as a
 * permanent alias, because the old URL is in bookmarks, in sent links and in
 * this repo's own documentation — but it renders nothing, so there is exactly
 * one gallery to maintain.
 *
 * The identity checks stay *here* rather than being left to `/admin/gallery`:
 * an anonymous visitor gets `/login`, which explains how to get in, instead of
 * `requireUser`'s JSON 403; and a paused account is told it is paused rather
 * than being bounced somewhere that looks like being signed out.
 */
app.get("/gallery", async (c) => {
  const { identity, disabled, disabledEmail } = await resolveAuth(c);
  if (disabled) return c.html(loginPage(c.env, { kind: "paused", email: disabledEmail }), 403);
  if (!identity) return c.redirect("/login", 302);
  return c.redirect("/admin/gallery", 302);
});

/**
 * Does this caller manage the artifact, for the two routes that authenticate
 * without the portal middleware (`/v/…` preview and the public catch-all)?
 *
 * Account membership is consulted only *after* the free checks — platform admin,
 * then `owner_email` — have already failed, and only when the artifact actually
 * belongs to an account. So the ordinary case (an owner previewing their own
 * work) costs no extra database read, and the serving hot path below pays for
 * the membership lookup only on a request that would otherwise 404.
 */
async function manages(
  env: Env,
  identity: Identity | null,
  art: ArtifactRow
): Promise<boolean> {
  if (canManage(identity, art)) return true;
  if (!art.account_id || !identity?.email) return false;
  return atLeast(await memberRole(env, art.account_id, identity.email), MANAGE_ARTIFACTS);
}

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
  if (!art) return c.html(notFoundPage(slug), 404);
  if (!(await manages(c.env, identity, art))) return c.html(notFoundPage(slug), 404);
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
  let owned = isOwner(identity, art);
  let granted = false;
  if (art.visibility === "restricted" && !identity?.isAdmin && !owned && identity?.email) {
    granted = await hasGrant(c.env, slug, identity.email);
  }
  // Workspace membership is the last thing tried, and only on a request that
  // would otherwise be refused — so serving a page costs no extra read in any
  // case that already worked before #27. Any role qualifies, `viewer` included.
  if (
    !canView(identity, art.visibility, granted, owned) &&
    art.account_id &&
    identity?.email &&
    (await memberRole(c.env, art.account_id, identity.email))
  ) {
    owned = true;
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
