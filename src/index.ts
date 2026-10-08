import { Hono, type Context } from "hono";
import type { ArtifactRow, Env, VersionRow } from "./env";
import { api, viewUrl } from "./api";
import { mcpRoutes } from "./mcp";
import { oauthRoutes } from "./oauth-routes";
import { waitlist } from "./waitlist";
import { authRoutes, pendingNextCookie } from "./auth-routes";
import { requireUser, accessEmail, accountsFor, getIdentity, resolveAuth, readCookie, SESSION_COOKIE, type AuthVars } from "./auth";
import { serveArtifact } from "./serve";
import { safeNextPath } from "./util";
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
  listViewEvents,
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
  ensureAccountPublicSlug,
  getAccountByPublicSlug,
  memberRole,
  resolveAccountContext,
  MANAGE_ARTIFACTS,
} from "./accounts";
import type { Identity } from "./auth";
import { listApiTokens, toPublicToken, type PublicApiToken } from "./tokens";
import { describeUsers, listUsers, privilegedEmails } from "./users";
import { notFoundPage } from "./pages";
import { sharePage, FRAME_TOKEN_SEGMENT } from "./shell";
import { viewLimitStatus, blocksOnSuspension } from "./quota";
import { suspendedContentPage } from "./view-limit-page";
export { ChatRoom } from "./chat";
import { redeemShareLink } from "./share";
import { accountSlugRoutes, addressNotice, brandedBase } from "./account-slug-routes";
import { viewerRoute, redirectToViewer } from "./viewer-routes";
import {
  callerIsInWorkspace,
  decideAccess,
  GUEST_COOKIE,
  guestIdentityFor,
  linkCookie,
  linkCookieName,
  linkPreviewResponse,
  logDeadLinkAttempt,
  logViewInBackground,
  presentedKey,
} from "./viewing";
import { isAllowedOrigin } from "./cors";
import { canonicalPath } from "./canonical";

import { shareRoutes } from "./share-routes";
import { billingRoutes } from "./billing-routes";
import { membersRoutes } from "./members-routes";
import { receiptsRoutes } from "./receipts-routes";
import { accessRequestRoutes } from "./access-request-routes";
import { membersPage } from "./members";
import { billingPage } from "./billing-page";
import { workspaceBilling } from "./plan-copy";
import { verifyFrameToken } from "./session";
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
  type ViewsInfo,
} from "./admin";
import { platformRoutes } from "./platform-routes";
import { workspaceRoutes } from "./workspace-routes";
import { viewerOf, type PortalContext } from "./viewer";
import { peoplePage, type UsersInfo } from "./people";
import { integrationsPage } from "./integrations";
import { canSeeSection, portalNotFound } from "./portal";
import { isContentHost, isContentPrefix, isManagementPath, isPerOriginPath, firstContentHostname } from "./host";
import { uploadRoutes } from "./upload-routes";
import {
  robotsTxt,
  sitemapXml,
  llmsTxt,
  ogImageSvg,
  OG_IMAGE_PNG_BASE64,
  LOGO_PNG_BASE64,
  LOGO_SMALL_PNG_BASE64,
  isCanonicalHost,
  siteOrigin,
  securityTxt,
  SECURITY_TXT_PATHS,
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
  } else if (
    !isManagementPath(c.req.path) &&
    !isPerOriginPath(c.req.path) &&
    !isContentPrefix(c.req.path)
  ) {
    // Everything else on the APP host is a viewer address (`/<workspace>/<slug>`,
    // any depth) or one of the old forms that redirect to it. Those are GETs and
    // are answered by `viewerRoute` below, which on a two-host deployment never
    // serves artifact bytes. Any other method has nothing to do here.
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      await next();
      return;
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
  // A response that declares its own `frame-ancestors` (artifact content, which the
  // viewer on the app origin frames) owns its framing policy; XFO: DENY would fight it.
  if (
    !c.res.headers.has("X-Frame-Options") &&
    !(c.res.headers.get("Content-Security-Policy") ?? "").includes("frame-ancestors")
  ) {
    c.header("X-Frame-Options", "DENY");
  }
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
// they own. Reaching /admin at all takes a signed-in app session (`rtfx_session`)
// belonging to a directory account that is not paused.

/** The artifacts this caller manages, with everything the cards need. */
/** Branded URL per slug for the artifacts a portal page is about to show. */
async function brandedLinks(c: PortalContext, rows: readonly ArtifactRow[]): Promise<Map<string, string>> {
  const addresses = new Map<string, Promise<string | null>>();
  const links = new Map<string, string>();
  for (const row of rows) {
    links.set(row.slug, await viewUrl(c, row.account_id, row.slug, addresses));
  }
  return links;
}

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
  return c.html(overviewPage({ viewer, rows, grants, versions, views, tokens, users, links: await brandedLinks(c, rows) }));
});

app.get("/admin/artifacts", requireUser, async (c) => {
  const viewer = await viewerOf(c);
  const { rows, grants, versions, views } = await artifactContext(c);
  return c.html(artifactsPage({ viewer, rows, grants, versions, views, links: await brandedLinks(c, rows) }));
});

// One artifact, with its versions, view log, access list and danger zone.
// 404 for both "no such artifact" and "not yours", so probing a slug here can
// never reveal one exists — the same rule the public catch-all follows.
// The share page (who can open it, share links). App host only: the viewer on
// the content origin links here because that origin refuses /api by design.
app.get("/share/:slug", requireUser, async (c) => {
  const viewer = await viewerOf(c);
  const slug = c.req.param("slug");
  const row = await getArtifact(c.env, slug);
  if (!row || !canManage(c.get("identity"), row, (await accountsFor(c)).roles)) {
    return c.html(portalNotFound(viewer, `The artifact "${slug}"`), 404);
  }
  const grants = row.visibility === "restricted" ? await listGrants(c.env, slug) : [];
  return c.html(
    sharePage({
      slug,
      title: row.title || slug,
      visibility: row.visibility,
      grantCount: grants.length,
      viewUrl: await viewUrl(c, row.account_id, slug),
    }),
    200,
    { "Cache-Control": "no-store" }
  );
});

app.get("/admin/artifacts/:slug", requireUser, async (c) => {
  const viewer = await viewerOf(c);
  const slug = c.req.param("slug");
  const row = await getArtifact(c.env, slug);
  if (!row || !canManage(c.get("identity"), row, (await accountsFor(c)).roles)) {
    return c.html(portalNotFound(viewer, `The artifact "${slug}"`), 404);
  }
  const [emails, versions, stats, viewers, versionViews, sources, events] = await Promise.all([
    listGrants(c.env, slug),
    listVersions(c.env, slug),
    getViews(c.env, slug),
    viewersFor(c.env, slug),
    viewsByVersion(c.env, slug),
    viewSources(c.env, slug),
    listViewEvents(c.env, slug, { limit: 50 }),
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
    artifactDetailPage({
      viewer,
      row,
      emails,
      versions,
      views,
      viewers,
      versionViews,
      sources,
      // Pre-0023 this is [] and the panel falls back to the old recent list.
      events: events.length ? events : undefined,
      mailStatus,
      brandedUrl: await viewUrl(c, row.account_id, slug),
    })
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

/**
 * The customer's billing page. Distinct from `/admin/platform/accounts/:id`,
 * which is the OPERATOR's view of the same workspace: this one shows what the
 * people paying for it are entitled to and what they can act on, and never the
 * override note, the internal notes or the audit trail.
 *
 * `canSeeSection` is re-checked rather than trusted from the nav — hiding a nav
 * item has never protected anything — which is what keeps a bearer token out:
 * a token is pinned to one workspace and must never be handed a checkout link
 * prefilled with its owner's email.
 */
app.get("/admin/billing", requireUser, async (c) => {
  const viewer = await viewerOf(c);
  const ctx = await accountsFor(c);
  if (!canSeeSection(viewer, "billing") || !ctx.active || !ctx.role) {
    return c.html(portalNotFound(viewer, "Billing"), 404);
  }
  // `viewerOf` has already computed this for the shell; recomputing would cost
  // a second `usageFor` aggregate for the same answer. The fallback is for a
  // caller shape that hasn't (none today), never a guess at the plan.
  const billing =
    viewer.workspace?.billing ?? (await workspaceBilling(c.env, ctx.active, c.get("email")));
  const [members, views] = await Promise.all([
    listMembers(c.env, ctx.active.id),
    // Isolate-cached for ~60s (see src/quota.ts), so this is a Map lookup on a
    // warm isolate rather than a monthly aggregate per page view.
    viewLimitStatus(c.env, ctx.active.id),
  ]);
  return c.html(
    billingPage({
      viewer,
      account: ctx.active,
      role: ctx.role,
      billing,
      members: members.length,
      views,
    })
  );
});

app.get("/admin/gallery", requireUser, async (c) => {
  const viewer = await viewerOf(c);
  const rows = await readableArtifacts(c);
  return c.html(galleryPage(viewer, rows, await brandedLinks(c, rows)));
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

app.get("/admin/settings", requireUser, async (c) => {
  const viewer = await viewerOf(c);
  const ws = viewer.workspace;
  // Every workspace has an address; assign the auto one now if migration 0021's
  // backfill has not reached this account yet.
  const address = ws ? (ws.publicSlug ?? (await ensureAccountPublicSlug(c.env, ws.id))) : null;
  return c.html(
    settingsPage(
      viewer,
      ws
        ? {
            origin: c.env.PUBLIC_BASE_URL || siteOrigin(c.env),
            slug: address,
            canEdit: ws.role === "owner" || ws.role === "admin" || viewer.isAdmin,
            // Absent billing means "not computed", never "free" — so the row
            // shows the address without offering an upgrade it cannot price.
            planAllows: ws.brandedAddressAllowed ?? false,
            notice: addressNotice(c.req.query("address")),
          }
        : undefined
    )
  );
});

// The operator control plane: /admin/platform and everything under it, GET and
// POST. Mounted BEFORE the /admin/* catch-all below, which would otherwise
// answer 404 to every one of its routes. It owns its own authorization — super
// admin, re-checked per request — see src/platform-routes.ts.
app.route("/", platformRoutes);

// Switching the active workspace: POST /admin/workspace (the header switcher)
// and POST /api/workspace/active (the JSON equivalent). Mounted here for the
// same reason platformRoutes is — the /admin/* catch-all below owns everything
// after it. See src/workspace-routes.ts.
app.route("/", workspaceRoutes);

// Claiming/changing the workspace's branded address: POST /admin/workspace/address
// (the Settings form) and PUT|DELETE /api/workspace/:id/slug. Mounted here for
// the same reason workspaceRoutes is — the /admin/* catch-all below owns
// everything after it. See src/account-slug-routes.ts.
app.route("/", accountSlugRoutes);

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

// Browser/CLI upload by single-use link (GET /u/:token, POST /api/uploads/:token).
// The path token is the credential, so this is mounted BEFORE /api, whose
// requireUser gate would refuse it. See src/upload-routes.ts.
app.route("/", uploadRoutes);

app.route("/api", api);

// Remote MCP over Streamable HTTP: POST /mcp, authenticated by the same bearer
// token `/api/machine/*` takes. It exposes doctor plus publish-by-content; OAuth
// discovery/login routes below can mint that same kind of bearer token.
// See src/mcp.ts and docs/REMOTE_MCP_OAUTH.md.
app.route("/", mcpRoutes);

// The OAuth 2.1 authorization server that `claude mcp login` drives: the two
// discovery documents, dynamic client registration, the consent flow, token
// issuance and revocation. Mounted at the root because the module declares its
// own full paths, and app-host only (MANAGEMENT_PREFIXES in host.ts). Its
// discovery documents and /mcp itself must never sit behind an edge gate on a
// legacy/self-host instance — see docs/DEPLOY_RTFX.md and docs/REMOTE_MCP_OAUTH.md.
app.route("/", oauthRoutes);

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
// They authenticate nobody. On a legacy/self-host instance still gated at the
// edge these paths must sit outside that gate (see docs/DEPLOY_RTFX.md), or a
// visitor meets a sign-in screen instead of the public page.

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

// security.txt (RFC 9116), served at both the canonical `/.well-known` path and
// the legacy top-level one — a researcher who tries either must find it rather
// than a 302 or a 404. App host only: both paths are management paths, so the
// content origin 404s them like every other product surface (src/host.ts).
//
// Public bytes, identical for everyone, no identity read and no cookie set —
// which is the point of routing it here rather than letting it fall through to
// artifact routing on the content host.
for (const path of SECURITY_TXT_PATHS) {
  app.get(path, (c) =>
    c.text(securityTxt(c.env, new Date()), 200, { "Cache-Control": PUBLIC_FILE_CACHE })
  );
}

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
// like the rest of the crawler-facing files, so a legacy/self-host edge gate must
// be told to let it through alongside /og.png (docs/DEPLOY_RTFX.md).
app.get("/logo.png", () => pngResponse(LOGO_PNG_BASE64));
// The small mark for share-link previews (src/link-preview.ts).
app.get("/logo-128.png", () => pngResponse(LOGO_SMALL_PNG_BASE64));


// Sign-up surface. Public on purpose: it explains how to get in, so it must stay
// reachable without a session (and outside any legacy/self-host edge gate — see
// docs/DEPLOY_RTFX.md). It never authenticates anyone itself: the form posts to
// /auth/start, the same endpoint /login uses, which is what emails the one-time
// code.
app.get("/signup", async (c) => {
  const { identity } = await resolveAuth(c);
  if (identity?.email) {
    return c.html(signupPage(c.env, { kind: "signed-in", email: identity.email }));
  }
  return c.html(signupPage(c.env, { kind: "signed-out" }));
});

/**
 * Where the viewer sends a visitor it cannot identify. `slug` is only used to
 * address the guest challenge and is never confirmed to exist — this page looks
 * the same for a real artifact and an invented one.
 *
 * `?next=` is the canonical viewer address to come back to. Already signed in,
 * the visitor goes straight there (`safeNextPath` keeps it a path on this
 * origin, so this cannot be an open redirect).
 */
app.get("/shared/:slug", async (c) => {
  const { identity } = await resolveAuth(c);
  const slug = c.req.param("slug");
  const next = safeNextPath(c.req.query("next"));
  if (identity?.email) {
    if (next) return c.redirect(next, 302);
    const art = await getArtifact(c.env, slug);
    if (art) return redirectToViewer(c, art, "");
  }
  return c.html(guestSigninPage(c.env, slug, next));
});

/**
 * `?next=` is what makes `claude mcp login` finish.
 *
 * `/oauth/authorize` bounces a signed-out visitor here carrying the authorization
 * request as a local path (src/oauth-routes.ts). Without this, sign-in succeeded
 * and then dropped the person on `/admin`, while the client sat waiting on a
 * callback that was never going to come.
 *
 * Already signed in, it is a redirect rather than a "you're already in" sheet:
 * the destination is the thing they were trying to do, and the sheet is a dead
 * end in front of it. `safeNextPath` keeps it a path on this origin, so this can
 * never become an open redirect — the one bug that would matter here, since the
 * next thing to happen is a session being minted.
 */
app.get("/login", async (c) => {
  const { identity, disabled, disabledEmail } = await resolveAuth(c);
  if (disabled) return c.html(loginPage(c.env, { kind: "paused", email: disabledEmail }), 403);
  const next = safeNextPath(c.req.query("next"));
  if (identity?.email) {
    return next
      ? c.redirect(next, 302)
      : c.html(loginPage(c.env, { kind: "signed-in", email: identity.email }));
  }
  return c.html(loginPage(c.env, { kind: "signed-out" }), 200, {
    "Set-Cookie": pendingNextCookie(next),
  });
});

// Cloudflare's built-in /cdn-cgi/access/logout is edge-owned and can be awkward
// to expose consistently on a custom-domain Worker route. This first-party route
// gives the portal a stable Sign out target.
//
// It must expire BOTH credentials. On a legacy/self-host instance a person can
// hold an app session, an edge Access session, or both, and a "sign out" that
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
        `${GUEST_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`,
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

// Version preview for people who manage the artifact (admin or owner):
// /v/<slug>/<n>/<path> serves a specific version. Relative assets resolve within
// this prefix. Everyone else gets 404 (existence stays hidden).
app.get("/v/*", async (c) => {
  const identity = await getIdentity(c);
  const parts = c.req.path.replace(/^\/v\/+/, "").split("/");
  const slug = decodeURIComponent(parts[0] ?? "");
  const version = Number(parts[1]);
  const filePath = parts.slice(2).map(decodeURIComponent).join("/");
  if (!slug || !Number.isInteger(version) || version < 1) return c.html(notFoundPage(slug, siteOrigin(c.env)), 404);
  const art = await getArtifact(c.env, slug);
  if (!art) return c.html(notFoundPage(slug, siteOrigin(c.env)), 404);
  if (!(await manages(c.env, identity, art))) return c.html(notFoundPage(slug, siteOrigin(c.env)), 404);
  if (!(await getVersion(c.env, slug, version))) return c.html(notFoundPage(slug, siteOrigin(c.env)), 404);
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
 * Lives on the APP host, where the viewer is: the session cookie and the
 * per-artifact link cookie are host-only, so the socket has to be opened from
 * the page that holds them. A guest credential is its own cookie (see
 * `GUEST_COOKIE`) and only ever opens the room of the artifact it was minted for.
 *
 * A browser always sends `Origin` on a WebSocket handshake. If it names an
 * origin that is not ours the handshake is refused, so a page on another site
 * (or a sandboxed artifact, whose origin is the opaque `null`) cannot open a
 * room using a visitor's cookies.
 */
app.get("/_chat/:slug", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ error: "expected_websocket" }, 426);
  }
  if (!c.env.CHAT) return c.json({ error: "not_configured" }, 503);

  const origin = c.req.header("Origin");
  if (origin !== undefined && !isAllowedOrigin(c.env, c.req.url, origin)) {
    return c.json({ error: "forbidden_origin" }, 403);
  }

  const slug = c.req.param("slug");
  const art = await getArtifact(c.env, slug);
  if (!art) return c.json({ error: "not_found" }, 404);

  const key = readCookie(c.req.header("Cookie") ?? c.req.header("cookie"), linkCookieName(slug));
  const link = key ? await redeemShareLink(c.env, key, new Date().toISOString()) : null;
  const viaLink = !!link && link.slug === slug;

  const identity = (await getIdentity(c)) ?? (await guestIdentityFor(c, slug));
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

/**
 * The canonical viewer and the old URL forms that lead to it. See
 * src/viewer-routes.ts for the model; it is a wildcard registered after every
 * named route so it can never shadow one, and it falls through (`next()`) only
 * on a single-host deployment, where the content route below also lives here.
 */
app.get("*", viewerRoute);

/**
 * Raw content. Reached on the CONTENT host (and, on a single-host deployment,
 * on the one host there is).
 *
 * Browsers never read content from here as a page: a top-level navigation is
 * sent to the canonical viewer on the app host, which frames the bytes served
 * by the `~t` branch below. What remains is the machine path — curl, the CLI,
 * the MCP server, a bearer-token fetch — and the frame itself.
 */
app.get("*", async (c) => {
  // A two-host deployment never serves artifact bytes from the app host.
  if (firstContentHostname(c.env) !== undefined && !isContentHost(c.env, c.req.url)) {
    return c.html(notFoundPage(undefined, siteOrigin(c.env)), 404);
  }

  const rest = c.req.path.replace(/^\/+/, "");
  const idx = rest.indexOf("/");
  let slug: string;
  let filePath: string;
  try {
    slug = decodeURIComponent(idx === -1 ? rest : rest.slice(0, idx));
    filePath = idx === -1 ? "" : decodeURIComponent(rest.slice(idx + 1));
  } catch {
    return c.html(notFoundPage(undefined, siteOrigin(c.env)), 404);
  }

  // The viewer's frame, and everything the framed artifact loads by a relative
  // URL. See `mintFrameToken` (src/session.ts) for why the credential rides in
  // the path: the sandboxed frame sends no cookies at all.
  const framePrefix = `${FRAME_TOKEN_SEGMENT}/`;
  if (filePath.startsWith(framePrefix)) {
    const afterPrefix = filePath.slice(framePrefix.length);
    const cut = afterPrefix.indexOf("/");
    const frameToken = cut === -1 ? afterPrefix : afterPrefix.slice(0, cut);
    const framedPath = cut === -1 ? "" : afterPrefix.slice(cut + 1);

    // Somebody opened a frame URL directly (copied it, or "open frame in new
    // tab"). Never serve artifact HTML as a top-level document on this origin;
    // send them to the viewer, which runs its own access check and re-frames.
    if (c.req.header("Sec-Fetch-Dest") === "document") {
      const art = await getArtifact(c.env, slug);
      if (art) return redirectToViewer(c, art, framedPath);
      return c.html(notFoundPage(slug, siteOrigin(c.env)), 404);
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.html(notFoundPage(slug, siteOrigin(c.env)), 404);
    }
    const valid =
      !!c.env.SESSION_SECRET &&
      (await verifyFrameToken(c.env.SESSION_SECRET, frameToken, slug, new Date().toISOString()));
    const art = valid ? await getArtifact(c.env, slug) : null;
    if (!art) return c.html(notFoundPage(slug, siteOrigin(c.env)), 404);
    // Suspension is a takedown control and binds every path, this one included.
    const status = art.account_id
      ? await viewLimitStatus(c.env, art.account_id, undefined, undefined, true)
      : null;
    if (blocksOnSuspension(status, false)) {
      return c.html(suspendedContentPage(slug, siteOrigin(c.env)), 403);
    }
    const served = await serveArtifact(c, slug, art.current_version, framedPath, { framed: true });
    // The framed document has an opaque origin, so its own fetch()/XHR of a
    // sibling file is cross-origin and the browser drops the response unless
    // it is CORS-readable. (Images, media and scripts load without CORS, which
    // is why only fetch broke — e.g. a "Download PDF" button that fetches the
    // file first.) `*` is safe on this path alone: it never carries or honours
    // a cookie, and the token in the URL is already the whole credential.
    const res = new Response(served.body, served);
    res.headers.set("Access-Control-Allow-Origin", "*");
    res.headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type, ETag");
    return res;
  }

  // A top-level browser navigation to the content origin — an old link, a
  // bookmark, `?raw=1` pasted into the address bar — goes to the canonical
  // viewer. Share keys (`?k=`) ride along and are redeemed there. If there is no
  // such artifact the request falls through to the same 404 as before.
  if (c.req.method === "GET" && c.req.header("Sec-Fetch-Dest") === "document") {
    const known = await getArtifact(c.env, slug);
    if (known) return redirectToViewer(c, known, filePath);
  }

  // From here on this is the machine path: no viewer, no frame, no redirect to
  // one. A share key (`?k=`) is still accepted, and exchanged for a per-artifact
  // cookie, for a client that keeps cookies.
  const key = await presentedKey(c, slug);
  await logDeadLinkAttempt(c, slug, key);
  const linkGrantsThis = !!key.viaLink;

  if (key.queryKey && key.viaLink) {
    // A link-card crawler gets the artifact's title and description instead of a
    // redirect it cannot use.
    const preview = await linkPreviewResponse(c, slug, key);
    if (preview) return preview;
    const clean = new URL(c.req.url);
    clean.searchParams.delete("k");
    return new Response(null, {
      status: 302,
      headers: {
        Location: clean.pathname + clean.search,
        "Set-Cookie": linkCookie(slug, key.queryKey),
      },
    });
  }

  const identity = await getIdentity(c);
  const art = await getArtifact(c.env, slug);
  // 404 for both missing and unauthorized, so probing a slug can't reveal it exists.
  if (!art) return c.html(notFoundPage(slug, siteOrigin(c.env)), 404);
  const decision = await decideAccess(c.env, art, identity);
  if (!linkGrantsThis && !decision.allowed) {
    return c.html(notFoundPage(slug, siteOrigin(c.env)), 404);
  }

  // Suspension applies to raw requests as well as navigations, and the owner
  // does not bypass it: an operator who suspends a workspace for phishing has to
  // have its content actually stop serving, including to `curl` and including to
  // the person who published it. This read bypasses the ~60s view-limit cache
  // on purpose (see `blocksOnSuspension` in src/quota.ts). The monthly view
  // allowance is a browser-navigation limit and is enforced by the viewer.
  const status = art.account_id ? await viewLimitStatus(c.env, art.account_id, undefined, undefined, true) : null;
  if (blocksOnSuspension(status, !!identity?.isAdmin)) {
    return c.html(suspendedContentPage(slug, siteOrigin(c.env)), 403);
  }

  const res = await serveArtifact(c, slug, art.current_version, filePath);

  // Log a view for an HTML page load by a signed-in person (not assets, not
  // machine/service-token fetches).
  const isHtml = (res.headers.get("Content-Type") ?? "").startsWith("text/html");
  if (res.ok && isHtml && identity?.email) {
    await logViewInBackground(c, art, identity.email, filePath);
  }

  return res;
});

export default app;
