import { Hono, type Context } from "hono";
import type { ArtifactRow, Env, VersionRow } from "./env";
import { api } from "./api";
import { waitlist } from "./waitlist";
import { authRoutes } from "./auth-routes";
import { requireUser, accessEmail, accountsFor, getIdentity, resolveAuth, readCookie, SESSION_COOKIE, type AuthVars } from "./auth";
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
  viewersFor,
  mailStatusFor,
  viewsByVersion,
  viewSources,
} from "./db";
import { canView, canManage, canManageMembers, isOwner, belongsToCaller } from "./authz";
import {
  listMembers,
  accountIdsWithAtLeast,
  atLeast,
  memberRole,
  resolveAccountContext,
  MANAGE_ARTIFACTS,
} from "./accounts";
import type { Identity } from "./auth";
import { listApiTokens, toPublicToken, type PublicApiToken } from "./tokens";
import { adminEmails, describeUsers, listUsers, privilegedEmails, superAdminEmails } from "./users";
import { notFoundPage } from "./pages";
import { shellPage } from "./shell";
import { viewLimitStatus, blocksOnViewLimit } from "./quota";
import { overViewLimitPage } from "./view-limit-page";
export { ChatRoom } from "./chat";
import { redeemShareLink } from "./share";

/**
 * Carries a redeemed share key.
 *
 * Scoped by NAME rather than by path: the chat socket lives at `/_chat/<slug>`,
 * which a cookie pathed to `/<slug>/` can never match, so path scoping silently
 * broke chat for link holders. A per-slug name keeps two links held at once
 * from overwriting each other, and the server still checks the key resolves to
 * the slug being requested — so a cookie sent to another artifact does nothing.
 */
const linkCookieName = (slug: string) => `rtfx_link_${slug}`;
import { shareRoutes } from "./share-routes";
import { billingRoutes } from "./billing-routes";
import { membersRoutes } from "./members-routes";
import { receiptsRoutes } from "./receipts-routes";
import { accessRequestRoutes } from "./access-request-routes";
import { recordViewAndMaybeNotify } from "./read-receipts";
import { membersPage } from "./members";
import { verifyHandoff, mintSession, SESSION_TTL_SECONDS } from "./session";
import { landingPage } from "./landing";
import { proPage, teamPage, enterprisePage } from "./plan-pages";
import { contactRoutes, contactPage, normalizePlan } from "./contact";
import { docsPage } from "./docs";
import { privacyPage, termsPage } from "./legal";
import { signupPage, loginPage, guestSigninPage } from "./login";
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
import { posthogConfig } from "./posthog";
import { workspaceBilling } from "./plan-copy";
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
  // Costs one aggregate query, and only for a caller who actually has a
  // workspace — the dashboard is the only surface that renders it.
  const billing = ctx.active ? await workspaceBilling(c.env, ctx.active, c.get("email")) : undefined;
  return {
    email: c.get("email"),
    isAdmin: identity.isAdmin,
    role: identity.role,
    isTokenCaller: !!identity.token,
    // null unless POSTHOG_KEY is configured, which is what keeps a deployment
    // that never sets it behaving exactly as it did before the feature existed.
    posthog: posthogConfig(c.env),
    workspace:
      ctx.active && ctx.role
        ? {
            id: ctx.active.id,
            name: ctx.active.name,
            kind: ctx.active.kind,
            role: ctx.role,
            count: ctx.memberships.length,
            // Usage against the plan's limits, plus real checkout links. Absent
            // means "not computed", never "definitely free" — the UI degrades
            // to showing nothing rather than showing something wrong.
            billing,
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
 * has been granted to them by name, and what their workspaces own. An admin
 * sees the instance.
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
  const rows = await listUsers(c.env);
  return {
    users: describeUsers(c.env, rows),
    admins: privilegedEmails(c.env),
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
  const [emails, versions, stats, viewers, versionViews, sources] = await Promise.all([
    listGrants(c.env, slug),
    listVersions(c.env, slug),
    getViews(c.env, slug),
    viewersFor(c.env, slug),
    viewsByVersion(c.env, slug),
    viewSources(c.env, slug),
  ]);
  // Delivery state per grantee, so "they never got the invitation" is answerable
  // in the panel instead of by reading mail_log. Needs the grant list first, so
  // it cannot join the Promise.all above.
  const mailStatus = await mailStatusFor(c.env, emails);
  const views: ViewsInfo = {
    counts: new Map([[slug, { total: stats.total, unique: stats.unique }]]),
    recent: new Map([[slug, stats.recent]]),
  };
  return c.html(
    artifactDetailPage({ viewer, row, emails, versions, views, viewers, versionViews, sources, mailStatus })
  );
});

// The Gallery section (issue #35): what this person can open, rather than what
// they manage. Formerly the standalone /gallery page, which now redirects here.

/**
 * Workspace members. Distinct from /admin/people, which is the PLATFORM
 * directory: this is who is in *this workspace*, which is what the Team plan
 * sells. `canManage` is computed here and used for rendering only — every
 * route in membersRoutes re-checks it.
 */
app.get("/admin/members", requireUser, async (c) => {
  const viewer = await viewerOf(c);
  const ctx = await accountsFor(c);
  const account = ctx.active;
  if (!account) return c.html(portalNotFound(viewer, "A workspace"), 404);

  const identity = c.get("identity");
  return c.html(
    membersPage({
      viewer,
      account,
      members: await listMembers(c.env, account.id),
      canManage: canManageMembers(identity, ctx.roles, account.id),
      viewerEmail: identity.email,
    })
  );
});

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
// Mounted BEFORE /api: that mount installs requireUser across /api/*, which
// would answer 403 to Lemon Squeezy before this handler ran. The webhook is
// unauthenticated by necessity — the HMAC signature on the raw body is its
// only gate. See src/billing.ts.
app.route("/", billingRoutes);
app.route("/", membersRoutes);
app.route("/", receiptsRoutes);
app.route("/", accessRequestRoutes);

app.route("/api", api);

// Public landing-page waitlist signup (unauthenticated).
app.route("/waitlist", waitlist);

// POST /contact — the "Talk to us" form behind the Team and Enterprise CTAs.
// Unauthenticated by necessity: the whole point is that somebody who has no
// account can reach a person. Rate-limited per address and per IP, exactly like
// the waitlist. See src/contact.ts.
app.route("/", contactRoutes);

// App-owned sign-in (/auth/*). Mounted at the root because the module declares
// its own full paths. App host only — see MANAGEMENT_PREFIXES in host.ts.
app.route("/", authRoutes);
app.route("/", shareRoutes);

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

// A page per paid tier (src/plan-pages.ts). Public and cached like the rest of
// the product surface: these are what a "Talk to us" button and a shared link
// land on, so they must render identically for a crawler and a buyer, with no
// identity read. `/enterprise` in particular is the page that has to be
// reachable before anybody signs up — it is mostly a list of what we do NOT do.
app.get("/pro", (c) => c.html(proPage(c.env), 200, { "Cache-Control": PUBLIC_HTML_CACHE }));

app.get("/team", (c) => c.html(teamPage(c.env), 200, { "Cache-Control": PUBLIC_HTML_CACHE }));

app.get("/enterprise", (c) =>
  c.html(enterprisePage(c.env), 200, { "Cache-Control": PUBLIC_HTML_CACHE })
);

/**
 * The contact/support page. `?plan=team|enterprise` only preselects the
 * dropdown — an unrecognized value is dropped rather than refused
 * (`normalizePlan`), because it arrives from a query string anybody can edit
 * and a mistyped one should still deliver the enquiry.
 *
 * Not cached at the edge with the others: the rendered `<option selected>`
 * varies with the query string, and a shared cache keyed on path alone would
 * hand the next visitor somebody else's preselected plan.
 */
app.get("/contact", (c) => c.html(contactPage(c.env, normalizePlan(c.req.query("plan")))));

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
app.get("/signup", async (c) => {
  const { identity } = await resolveAuth(c);
  if (identity?.email) {
    return c.html(signupPage(c.env, { kind: "signed-in", email: identity.email }));
  }
  return c.html(signupPage(c.env, { kind: "signed-out" }));
});

/**
 * Where the content host sends a visitor it cannot identify. `slug` is only used
 * to address the guest challenge and is never confirmed to exist — this page
 * looks the same for a real artifact and an invented one.
 */
app.get("/shared/:slug", async (c) => {
  const { identity } = await resolveAuth(c);
  const slug = c.req.param("slug");
  if (identity?.email) {
    const host = firstContentHostname(c.env);
    if (host) return c.redirect(`https://${host}/${encodeURIComponent(slug)}/`, 302);
  }
  return c.html(guestSigninPage(c.env, slug));
});

app.get("/login", async (c) => {
  const { identity, disabled, disabledEmail } = await resolveAuth(c);
  if (disabled) return c.html(loginPage(c.env, { kind: "paused", email: disabledEmail }), 403);
  if (identity?.email) return c.html(loginPage(c.env, { kind: "signed-in", email: identity.email }));
  return c.html(loginPage(c.env, { kind: "signed-out" }));
});

// Cloudflare's built-in /cdn-cgi/access/logout is edge-owned and can be awkward
// to expose consistently on a custom-domain Worker route. This first-party route
// gives the portal a stable Sign out target.
//
// It must expire BOTH credentials. During the Access migration a person can hold
// an app session, a Cloudflare Access session, or both, and "sign out" that
// leaves either one standing is not a sign-out. Clearing a cookie that was never
// set is harmless, so this is unconditional rather than clever.
app.get("/logout", () =>
  new Response(null, {
    status: 302,
    headers: [
      ["Location", "/login"],
      [
        "Set-Cookie",
        `${SESSION_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`,
      ],
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

/** True when the caller belongs to the artifact's workspace/account. */
async function callerIsInWorkspace(
  env: Env,
  art: ArtifactRow,
  identity: Identity | null
): Promise<boolean> {
  if (!art.account_id || !identity?.email) return false;
  return (await memberRole(env, art.account_id, identity.email)) !== null;
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

/**
 * Should this request get the shell rather than the bytes?
 *
 * Only a top-level browser navigation. `Sec-Fetch-Dest: document` is sent by
 * every current browser on a navigation and by nothing else; its absence means
 * a non-browser client (curl, the CLI, the MCP server), which must keep getting
 * raw content exactly as before. `?raw=1` is how the shell asks for the content
 * it frames, and is therefore never itself shelled — without it the shell would
 * frame a copy of itself, forever.
 */
function wantsShell(c: Context<{ Bindings: Env; Variables: AuthVars }>): boolean {
  if (new URL(c.req.url).searchParams.has("raw")) return false;
  if (c.req.method !== "GET") return false;
  return c.req.header("Sec-Fetch-Dest") === "document";
}


/**
 * The chat socket for one artifact.
 *
 * This handler is the entire authorization boundary for chat. It answers
 * exactly the question `canView` already answers for the artifact itself, then
 * hands the socket to the Durable Object — which never sees a credential and
 * cannot be reached any other way. If you cannot open the document, you cannot
 * open its conversation; there is one rule, not two.
 *
 * Lives on the content host because the shell does: the app origin's session
 * cookie is host-only, so a cross-origin socket would arrive with nothing.
 */
app.get("/_chat/:slug", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ error: "expected_websocket" }, 426);
  }
  if (!c.env.CHAT) return c.json({ error: "not_configured" }, 503);

  const slug = c.req.param("slug");
  const art = await getArtifact(c.env, slug);
  if (!art) return c.json({ error: "not_found" }, 404);

  const key = readCookie(c.req.header("Cookie") ?? c.req.header("cookie"), linkCookieName(slug));
  const link = key ? await redeemShareLink(c.env, key, new Date().toISOString()) : null;
  const viaLink = !!link && link.slug === slug;

  const identity = await getIdentity(c);
  // A guest session is bound to one artifact; it must not open another's room.
  if (identity?.kind === "guest" && identity.slug !== slug) {
    return c.json({ error: "not_found" }, 404);
  }

  const owned = isOwner(identity, art);
  // 'everyone' means everyone in the artifact's workspace, not every identity
  // on the instance (see canView). The chat room has to answer the same
  // question the artifact itself does, or somebody who cannot open a page can
  // still join the conversation attached to it.
  const inWorkspace = await callerIsInWorkspace(c.env, art, identity);
  let granted = false;
  if (!identity?.isAdmin && !owned && !inWorkspace && identity?.email) {
    granted = await hasGrant(c.env, slug, identity.email);
  }
  if (!viaLink && !canView(identity, art.visibility, granted, owned, inWorkspace)) {
    return c.json({ error: "not_found" }, 404);
  }

  const kind = owned || identity?.isAdmin
    ? "owner"
    : viaLink
      ? "link"
      : identity?.kind === "guest"
        ? "guest"
        : "member";

  const headers = new Headers(c.req.raw.headers);
  // A share-link viewer has no identity, and we do not invent one for them.
  headers.set("X-Chat-Email", viaLink ? "" : (identity?.email ?? ""));
  headers.set("X-Chat-Kind", kind);
  headers.set("X-Chat-Version", String(art.current_version));

  const stub = c.env.CHAT.get(c.env.CHAT.idFromName(slug));
  return stub.fetch(new Request(c.req.url, { headers, method: "GET" }));
});

app.get("*", async (c) => {
  const rest = c.req.path.replace(/^\/+/, "");
  const idx = rest.indexOf("/");
  const slug = decodeURIComponent(idx === -1 ? rest : rest.slice(0, idx));
  const filePath = idx === -1 ? "" : decodeURIComponent(rest.slice(idx + 1));

  // Crossing from the app host: exchange the one-shot handoff for a cookie of
  // this origin's own, then redirect to the clean URL so the token stops riding
  // in the address bar, history and any referrer.
  const handoff = new URL(c.req.url).searchParams.get("ct");
  if (handoff && c.env.SESSION_SECRET) {
    const claims = await verifyHandoff(c.env.SESSION_SECRET, handoff, new Date().toISOString());
    if (claims) {
      const token = await mintSession(c.env.SESSION_SECRET, claims, new Date().toISOString());
      const clean = new URL(c.req.url);
      clean.searchParams.delete("ct");
      return new Response(null, {
        status: 302,
        headers: {
          Location: clean.pathname + clean.search,
          // Host-only: no Domain attribute, so this never travels back to the
          // app host. Each origin holds its own credential.
          "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
        },
      });
    }
  }

  // A share link is a capability: whoever holds the URL may open this one
  // artifact, with no identity involved. Checked before identity so a link
  // works for somebody who has never signed in and never will.
  //
  // The key is accepted from the query once, then exchanged for a cookie scoped
  // to this artifact's path. Without that, the shell's frame URL and every
  // relative asset inside the artifact arrive with no credential and 404 — a
  // link would open index.html and nothing it references.
  const url = new URL(c.req.url);
  const queryKey = url.searchParams.get("k");
  const cookieKey = readCookie(c.req.header("Cookie") ?? c.req.header("cookie"), linkCookieName(slug));
  const shareKey = queryKey ?? cookieKey;
  const viaLink = shareKey ? await redeemShareLink(c.env, shareKey, new Date().toISOString()) : null;

  if (queryKey && viaLink && viaLink.slug === slug) {
    const clean = new URL(c.req.url);
    clean.searchParams.delete("k");
    return new Response(null, {
      status: 302,
      headers: {
        Location: clean.pathname + clean.search,
        // Path-scoped to this artifact, which is exactly the capability's
        // scope: the cookie cannot open anything the link could not.
        "Set-Cookie": `${linkCookieName(slug)}=${encodeURIComponent(queryKey)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
      },
    });
  }

  const identity = await getIdentity(c);
  const art = await getArtifact(c.env, slug);
  // 404 for both missing and unauthorized, so probing a slug can't reveal it exists.
  if (!art) return c.html(notFoundPage(slug), 404);
  // A guest session is minted for one artifact. Holding a grant on another does
  // not widen it: the credential was issued against a specific share, and a
  // person can always re-authenticate for the other one.
  if (identity?.kind === "guest" && identity.slug !== slug) {
    return c.html(notFoundPage(slug), 404);
  }

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
  // No identity on the content host is the normal first visit, not a refusal:
  // the session cookie is host-only and lives on the app host. Send a browser
  // there to be identified and come back. A machine client (no Sec-Fetch-Dest)
  // is never bounced — it gets the same 404 it always did.
  const linkGrantsThis = !!viaLink && viaLink.slug === slug;

  if (!identity && !linkGrantsThis && wantsShell(c) && c.env.SESSION_SECRET && isContentHost(c.env, c.req.url)) {
    const app_origin = c.env.PUBLIC_BASE_URL || siteOrigin(c.env);
    // Ask the app host who this is. If it knows them, it hands them straight
    // back; if not, that route shows the guest sign-in for this artifact.
    const back = `${app_origin}/auth/content?next=${encodeURIComponent(c.req.url)}&slug=${encodeURIComponent(slug)}`;
    return c.redirect(back, 302);
  }

  if (!linkGrantsThis && !canView(identity, art.visibility, granted, owned)) {
    return c.html(notFoundPage(slug), 404);
  }

  // A top-level navigation gets the viewer shell; everything else — subresources,
  // the shell's own framed request (?raw=1), curl, the CLI — gets the bytes.
  // Sec-Fetch-Dest is absent on non-browser clients, which is why its absence
  // means "raw" rather than "shell": the machine path must not change.
  // The account's monthly view allowance. Checked only for a real browser
  // navigation: the shell's own iframe fetch, curl, the CLI and the MCP server
  // all take the raw path and are untouched. A blocked browser never receives
  // the shell, so it never issues the iframe request either — the block
  // cascades without serveArtifact needing to know about plans.
  //
  // `owned` here is deliberately the route's existing notion, which includes a
  // workspace member: somebody inside the account can always still reach their
  // own content, which is what lets them see the message and act on it.
  if (wantsShell(c) && art.account_id) {
    const status = await viewLimitStatus(c.env, art.account_id);
    if (blocksOnViewLimit(status, owned || !!identity?.isAdmin)) {
      return c.html(overViewLimitPage(slug), 503);
    }
  }

  if (wantsShell(c)) {
    const grants = art.visibility === "restricted" ? await listGrants(c.env, slug) : [];
    return c.html(
      shellPage({
        slug,
        title: art.title || slug,
        version: art.current_version,
        // Holding a link is not ownership. Even if the same person could manage
        // this artifact when signed in, arriving by link means they are here as
        // a reader — and the banner would otherwise appear for anyone the URL
        // was forwarded to.
        canManage:
          !linkGrantsThis &&
          canManage(identity, art, (await resolveAccountContext(c.env, identity)).roles),
        visibility: art.visibility,
        grantCount: grants.length,
        filePath,
        entry: art.entry,
        isDocument: art.entry?.toLowerCase().endsWith(".pdf") ?? false,
      })
    );
  }

  const res = await serveArtifact(c, slug, art.current_version, filePath);

  // Log a view for an HTML page load by a signed-in person (not assets, not
  // machine/service-token fetches). Non-blocking in production; awaited in tests.
  const isHtml = (res.headers.get("Content-Type") ?? "").startsWith("text/html");
  if (res.ok && isHtml && identity?.email) {
    const cf = (c.req.raw as { cf?: { country?: string } }).cf;
    // Records the view and, on somebody's FIRST view of an artifact shared with
    // them, emails the owner. Same view object, same fire-and-forget handling —
    // a mail failure must never affect serving the page.
    const p = recordViewAndMaybeNotify(c.env, {
      slug,
      version: art.current_version,
      email: identity.email,
      path: filePath,
      country: cf?.country ?? null,
      referrer: (c.req.header("Referer") ?? "").slice(0, 500) || null,
      viewed_at: new Date().toISOString(),
    }, art);
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
