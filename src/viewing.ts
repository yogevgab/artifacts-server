/**
 * Shared machinery for "somebody is looking at an artifact": share-key
 * handling, the access decision, view logging, and the link cookie.
 *
 * It used to live inline in the content-host catch-all in src/index.ts. The
 * viewer now runs on the APP host (src/viewer-routes.ts), and the content host
 * keeps a smaller raw path for machine clients, so the rules both need are here
 * once rather than copied.
 */

import type { Context } from "hono";
import type { ArtifactRow, Env, ViewOutcome, ViewRow } from "./env";
import {
  type AuthVars,
  type Identity,
  readCookie,
} from "./auth";
import { getArtifact, hasGrant, logView } from "./db";
import { canView, isOwner } from "./authz";
import { memberRole } from "./accounts";
import { inspectShareLink, redeemShareLink } from "./share";
import { isLinkPreviewCrawler, linkPreviewPage } from "./link-preview";
import { captureViewContext } from "./view-context";
import { recordViewAndMaybeNotify } from "./read-receipts";
import { viewLimitStatus, blocksOnSuspension } from "./quota";
import { siteOrigin } from "./seo";
import { verifySession } from "./session";

export type AppContext = Context<{ Bindings: Env; Variables: AuthVars }>;

/**
 * Carries a redeemed share key.
 *
 * Scoped by NAME rather than by path: the chat socket lives at `/_chat/<slug>`,
 * which a cookie pathed to the artifact can never match, so path scoping
 * silently broke chat for link holders. A per-slug name keeps two links held at
 * once from overwriting each other, and the server still checks the key
 * resolves to the slug being requested — so a cookie sent to another artifact
 * does nothing.
 */
export const linkCookieName = (slug: string) => `rtfx_link_${slug}`;

/** Set-Cookie value for a redeemed share key. HttpOnly, Secure, Lax, one day. */
export function linkCookie(slug: string, key: string): string {
  return `${linkCookieName(slug)}=${encodeURIComponent(key)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;
}

/**
 * Guest credential on the APP host. Kept apart from `rtfx_session` on purpose:
 * a guest holds one artifact's grant and must never be mistaken for a signed-in
 * member by any other route, and clicking an invitation must never replace the
 * session of a member who happens to be signed in. Only the viewer and the chat
 * socket ever read this cookie.
 */
export const GUEST_COOKIE = "rtfx_guest";

/**
 * The guest identity this request carries FOR THIS ARTIFACT, or null. A guest
 * credential is minted against one share, so it never widens to another slug.
 */
export async function guestIdentityFor(c: AppContext, slug: string): Promise<Identity | null> {
  const secret = c.env.SESSION_SECRET;
  if (!secret) return null;
  const raw = readCookie(c.req.header("Cookie") ?? c.req.header("cookie"), GUEST_COOKIE);
  if (!raw) return null;
  const claims = await verifySession(secret, raw, new Date().toISOString());
  if (!claims || claims.kind !== "guest" || claims.slug !== slug) return null;
  return {
    email: claims.email,
    commonName: null,
    isAdmin: false,
    role: "member",
    token: null,
    kind: "guest",
    slug: claims.slug,
  };
}

/**
 * Should this request get the viewer rather than the bytes?
 *
 * Only a top-level browser navigation. `Sec-Fetch-Dest: document` is sent by
 * every current browser on a navigation and by nothing else; its absence means
 * a non-browser client (curl, the CLI, the MCP server), which keeps getting raw
 * content exactly as before. `?raw=1` is how a viewer used to ask for content,
 * and is never itself a viewer request.
 */
export function wantsShell(c: AppContext): boolean {
  if (new URL(c.req.url).searchParams.has("raw")) return false;
  if (c.req.method !== "GET") return false;
  return c.req.header("Sec-Fetch-Dest") === "document";
}

/** Hand a promise to waitUntil in production; await it where there is no execution context (tests). */
export async function inBackground(c: AppContext, p: Promise<unknown>): Promise<void> {
  let ctx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  if (ctx) ctx.waitUntil(p);
  else await p;
}

/** A view-log row for this request: where it came from and what device opened it. */
export function viewFor(
  c: AppContext,
  art: ArtifactRow,
  path: string,
  o: { email?: string | null; linkId?: string | null; outcome?: ViewOutcome; device?: string } = {}
): ViewRow {
  const vc = captureViewContext(c.req.raw);
  return {
    slug: art.slug,
    version: art.current_version,
    email: o.email ?? null,
    path,
    country: vc.country,
    referrer: (c.req.header("Referer") ?? "").slice(0, 500) || null,
    viewed_at: new Date().toISOString(),
    ip: vc.ip,
    region: vc.region,
    city: vc.city,
    device: o.device ?? vc.device,
    os: vc.os,
    browser: vc.browser,
    user_agent: vc.user_agent,
    link_id: o.linkId ?? null,
    outcome: o.outcome ?? "viewed",
  };
}

/**
 * Records a view and, on somebody's FIRST view of an artifact shared with them,
 * emails the owner. Fire-and-forget in production (awaited in tests) — a mail
 * failure must never affect serving the page.
 */
export async function logViewInBackground(
  c: AppContext,
  art: ArtifactRow,
  email: string,
  path: string
): Promise<void> {
  await inBackground(c, recordViewAndMaybeNotify(c.env, viewFor(c, art, path, { email }), art));
}

/** Record a share-link event (open, preview, or attempt with a dead link). Never notifies the owner. */
export async function logLinkEvent(
  c: AppContext,
  art: ArtifactRow,
  path: string,
  o: { email?: string | null; linkId: string; outcome: ViewOutcome; device?: string }
): Promise<void> {
  await inBackground(c, logView(c.env, viewFor(c, art, path, o)));
}

/** True when the caller belongs to the artifact's workspace/account. */
export async function callerIsInWorkspace(
  env: Env,
  art: ArtifactRow,
  identity: Identity | null
): Promise<boolean> {
  if (!art.account_id || !identity?.email) return false;
  return (await memberRole(env, art.account_id, identity.email)) !== null;
}

// --- share keys ---------------------------------------------------------------

export interface PresentedKey {
  /** The raw `?k=` value, if any. */
  queryKey: string | null;
  /** The redeemed link when the key (query or cookie) opens `slug`, else null. */
  viaLink: Awaited<ReturnType<typeof redeemShareLink>>;
}

/**
 * A share link is a capability: whoever holds the URL may open this one
 * artifact, with no identity involved. The key arrives as `?k=` once and is
 * then carried by a per-artifact cookie. A key for ANOTHER artifact is treated
 * as no key.
 */
export async function presentedKey(c: AppContext, slug: string): Promise<PresentedKey> {
  const queryKey = new URL(c.req.url).searchParams.get("k");
  const cookieKey = readCookie(c.req.header("Cookie") ?? c.req.header("cookie"), linkCookieName(slug));
  const shareKey = queryKey ?? cookieKey;
  const redeemed = shareKey ? await redeemShareLink(c.env, shareKey, new Date().toISOString()) : null;
  return { queryKey, viaLink: redeemed && redeemed.slug === slug ? redeemed : null };
}

/**
 * A browser navigation (or a link-card crawler) presenting a key that no longer
 * works: record it if — and only if — the key really belonged to THIS artifact.
 * Garbage keys write nothing, so this cannot be used to fill the table. What
 * the visitor sees is unchanged. Repeats are deduplicated inside `logView`.
 */
export async function logDeadLinkAttempt(c: AppContext, slug: string, key: PresentedKey): Promise<void> {
  if (
    !key.queryKey ||
    key.viaLink ||
    c.req.method !== "GET" ||
    !(c.req.header("Sec-Fetch-Dest") === "document" || isLinkPreviewCrawler(c.req.raw.headers))
  ) {
    return;
  }
  try {
    const found = await inspectShareLink(c.env, key.queryKey, new Date().toISOString());
    if (found && found.link.slug === slug && found.state !== "valid") {
      const dead = await getArtifact(c.env, slug);
      if (dead) {
        await logLinkEvent(c, dead, "", {
          linkId: found.link.id,
          outcome: found.state === "revoked" ? "link_revoked" : "link_expired",
        });
      }
    }
  } catch (e) {
    console.error("link attempt log failed", e instanceof Error ? e.message : String(e));
  }
}

/**
 * A link-card crawler (X, WhatsApp, iMessage, Slack…) holding a VALID key gets
 * the artifact's title and description instead of a redirect it cannot use. See
 * src/link-preview.ts for why this is limited to a valid key. Returns null when
 * this request is not such a crawler (or the workspace is suspended).
 */
export async function linkPreviewResponse(
  c: AppContext,
  slug: string,
  key: PresentedKey
): Promise<Response | null> {
  if (!key.queryKey || !key.viaLink) return null;
  if (c.req.method !== "GET" || !isLinkPreviewCrawler(c.req.raw.headers)) return null;
  const previewed = await getArtifact(c.env, slug);
  if (!previewed) return null;
  const status = previewed.account_id
    ? await viewLimitStatus(c.env, previewed.account_id, undefined, undefined, true)
    : null;
  if (blocksOnSuspension(status, false)) return null;
  // The crawler is a bot, not a reader: record the preview, not a view.
  await logLinkEvent(c, previewed, "", { linkId: key.viaLink.id, outcome: "preview", device: "bot" });
  return c.html(
    linkPreviewPage({
      title: previewed.title || slug,
      description: previewed.description ?? null,
      image: `${(c.env.PUBLIC_BASE_URL || siteOrigin(c.env)).replace(/\/+$/, "")}/logo-128.png`,
    }),
    200,
    { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" }
  );
}

// --- the access decision --------------------------------------------------------

export interface AccessDecision {
  allowed: boolean;
  /** Owner, or any member of the artifact's workspace. */
  owned: boolean;
}

/**
 * May this identity open this artifact? The one rule, used by the viewer and the
 * raw content path alike.
 *
 * A guest session is minted for one artifact; holding a grant on another does
 * not widen it. Workspace membership is the last thing tried, and only on a
 * request that would otherwise be refused, so serving a page costs no extra
 * read in any case that already worked.
 */
export async function decideAccess(
  env: Env,
  art: ArtifactRow,
  identity: Identity | null
): Promise<AccessDecision> {
  if (identity?.kind === "guest" && identity.slug !== art.slug) return { allowed: false, owned: false };
  let owned = isOwner(identity, art);
  let granted = false;
  if (art.visibility === "restricted" && !identity?.isAdmin && !owned && identity?.email) {
    granted = await hasGrant(env, art.slug, identity.email);
  }
  if (
    !canView(identity, art.visibility, granted, owned) &&
    art.account_id &&
    identity?.email &&
    (await memberRole(env, art.account_id, identity.email))
  ) {
    owned = true;
  }
  return { allowed: canView(identity, art.visibility, granted, owned), owned };
}
