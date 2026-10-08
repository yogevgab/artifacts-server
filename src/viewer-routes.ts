/**
 * The viewer, on the APP host, at the canonical address:
 * `https://rtfx.pro/<workspace>/<artifact>[/<path>]`.
 *
 * This is the whole security story, so read it before changing anything here.
 *
 *  - The page this route renders is OURS: the toolbar, the chat drawer and one
 *    `<iframe>`. It contains no artifact bytes, ever. The frame points at the
 *    CONTENT origin (`a.rtfx.pro`), a different origin that serves uploaded
 *    HTML and nothing else, with `sandbox` and deliberately WITHOUT
 *    `allow-same-origin`. Uploaded HTML therefore never runs same-origin with
 *    the app, on any path, and cannot read the app's cookies.
 *  - Every access rule runs HERE, once, against the app-host identity (session
 *    cookie, guest cookie, per-artifact link cookie). The frame then carries a
 *    short-lived path capability (`mintFrameToken`) because a sandboxed frame
 *    sends no cookies.
 *  - Anything that is not a top-level browser navigation (curl, the CLI, a
 *    subresource, `?raw=1`) is bounced to the content host's raw path, exactly
 *    as machine clients have always been served. The app host never answers a
 *    request with artifact bytes when a content host is configured.
 *
 * Address resolution (first segment):
 *   1. a workspace address that owns the second segment → the viewer;
 *   2. otherwise, if the first segment is an artifact slug → its canonical
 *      address (browsers) or its raw content (machines): the old URL forms keep
 *      working;
 *   3. otherwise 404.
 * A workspace/artifact mismatch renders the same 404 page as a missing
 * artifact, so the namespace is not an existence oracle.
 */

import type { Next } from "hono";
import type { ArtifactRow, Env } from "./env";
import { getIdentity, type Identity } from "./auth";
import { getArtifact, listGrants } from "./db";
import { canManage } from "./authz";
import {
  ensureAccountPublicSlug,
  getAccountByPublicSlug,
  resolveAccountContext,
} from "./accounts";
import { isAccountSlugShape, isReservedAccountSlug } from "./account-slugs";
import { firstContentHostname, isContentHost } from "./host";
import { notFoundPage } from "./pages";
import { siteOrigin } from "./seo";
import { shellPage, FRAME_TOKEN_SEGMENT } from "./shell";
import { mintFrameToken } from "./session";
import { blocksOnSuspension, blocksOnViewLimit, viewLimitStatus } from "./quota";
import { overViewLimitPage, suspendedContentPage } from "./view-limit-page";
import { appOriginFor, canonicalOrigin, canonicalPath, contentOrigin } from "./canonical";
import {
  decideAccess,
  guestIdentityFor,
  linkCookie,
  linkPreviewResponse,
  logDeadLinkAttempt,
  logLinkEvent,
  logViewInBackground,
  presentedKey,
  wantsShell,
  type AppContext,
} from "./viewing";

/** Decoded, non-empty path segments, or null when the path is not valid UTF-8 escapes. */
function pathSegments(path: string): string[] | null {
  try {
    return path
      .split("/")
      .filter((s) => s !== "")
      .map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/** Search params of the request with the ones that never belong on a viewer URL removed. */
function cleanSearch(url: URL, drop: string[]): string {
  const next = new URL(url.toString());
  for (const k of drop) next.searchParams.delete(k);
  return next.search;
}

/**
 * Redirect a browser to an artifact's canonical viewer address. `rest` is the
 * path inside the artifact. Keeps `?k=` (so an old share link keeps working)
 * and nothing else: the viewer ignores other parameters, `raw` must never
 * survive, and the retired `ct` handoff has no meaning any more.
 */
export async function redirectToViewer(
  c: AppContext,
  art: ArtifactRow,
  rest: string
): Promise<Response> {
  const ws = art.account_id ? await ensureAccountPublicSlug(c.env, art.account_id) : null;
  const k = new URL(c.req.url).searchParams.get("k");
  const location =
    appOriginFor(c.env, c.req.url) +
    canonicalPath(ws, art.slug, rest) +
    (k ? `?k=${encodeURIComponent(k)}` : "");
  return c.redirect(location, 302);
}

/** Where raw bytes for this artifact live (content host, or this origin on a single-host deploy). */
function rawLocation(c: AppContext, slug: string, rest: string, search: string): string {
  const origin = contentOrigin(c.env, c.req.url) ?? new URL(c.req.url).origin;
  const tail = rest
    .split("/")
    .filter((s) => s !== "")
    .map(encodeURIComponent)
    .join("/");
  return `${origin}/${encodeURIComponent(slug)}/${tail}${search}`;
}

/** A visitor with nothing to present goes to sign-in and comes back to exactly this address. */
function signInRedirect(c: AppContext, slug: string): Response {
  const url = new URL(c.req.url);
  const next = url.pathname + cleanSearch(url, ["k", "raw", "ct"]);
  return c.redirect(`/shared/${encodeURIComponent(slug)}?next=${encodeURIComponent(next)}`, 302);
}

function notFound(c: AppContext, slug: string): Response {
  return c.html(notFoundPage(slug, siteOrigin(c.env)), 404);
}

/** Does this request carry a `?k=` or any link cookie? Cheap, no I/O. */
function carriesKeyMaterial(c: AppContext): boolean {
  if (new URL(c.req.url).searchParams.has("k")) return true;
  return (c.req.header("Cookie") ?? "").includes("rtfx_link_");
}

/** True when the request carries any identity or capability for this slug. */
async function hasAnyCredential(c: AppContext, slug: string): Promise<boolean> {
  if (await getIdentity(c)) return true;
  if (await guestIdentityFor(c, slug)) return true;
  return !!(await presentedKey(c, slug)).viaLink;
}

/**
 * The Hono handler. Registered as a late wildcard so every named route wins; it
 * only ever answers app-host paths.
 */
export async function viewerRoute(c: AppContext, next: Next): Promise<Response | void> {
  // The content host never runs this: `/a/b` there is an artifact's own asset path.
  if (isContentHost(c.env, c.req.url)) return next();

  const segs = pathSegments(c.req.path);
  if (!segs) return c.html(notFoundPage(undefined, siteOrigin(c.env)), 404);
  if (segs.length === 0) return next();

  const twoHost = !!firstContentHostname(c.env);

  // The frame-token path is a content-host construct. On a single-host
  // deployment it is the very same Worker, so let the content route have it.
  if (segs[1] === FRAME_TOKEN_SEGMENT) {
    return twoHost ? notFound(c, segs[0]) : next();
  }

  // A two-host deployment names one canonical app origin. The viewer frames
  // content that only allows THAT origin as an ancestor, so a request that
  // arrived on another app host (mcp.rtfx.pro) is sent to the canonical one.
  if (twoHost && (c.env.PUBLIC_BASE_URL ?? "").trim()) {
    const here = new URL(c.req.url);
    const canonical = new URL(canonicalOrigin(c.env));
    if (here.origin !== canonical.origin && (c.req.method === "GET" || c.req.method === "HEAD")) {
      return c.redirect(canonical.origin + here.pathname + here.search, 302);
    }
  }

  const first = segs[0].toLowerCase();
  const account =
    segs.length >= 2 && isAccountSlugShape(first) && !isReservedAccountSlug(first)
      ? await getAccountByPublicSlug(c.env, first)
      : null;

  if (account) {
    const art = await getArtifact(c.env, segs[1]);
    if (art && art.account_id === account.id) {
      return viewArtifact(c, art, account.public_slug ?? first, segs.slice(2));
    }
  }

  // Not an exact `<workspace>/<artifact>` match. A share key that opens
  // `segs[1]` means the link was minted before its workspace's address changed
  // (or names the wrong one): the key already proves access, so send it to the
  // artifact's CURRENT address rather than strand it. Only attempted when the
  // request carries key material at all, so ordinary 404 probes cost nothing.
  if (segs.length >= 2 && carriesKeyMaterial(c)) {
    const keyed = await getArtifact(c.env, segs[1]);
    if (keyed && (await presentedKey(c, keyed.slug)).viaLink) {
      return redirectToViewer(c, keyed, segs.slice(2).join("/"));
    }
  }

  if (account) {
    // `first` may also be a plain artifact slug (an old-form URL whose slug is
    // coincidentally a workspace address too); try that reading before giving up.
    const legacy = await getArtifact(c.env, segs[0]);
    if (legacy) return legacyForm(c, legacy, segs.slice(1), twoHost, next);
    // Nothing to show. A signed-out browser is sent to sign in rather than told
    // "no such artifact", so the namespace answers the same whether or not the
    // artifact exists.
    if (wantsShell(c) && !(await hasAnyCredential(c, segs[1]))) return signInRedirect(c, segs[1]);
    return notFound(c, segs[1]);
  }

  const art = await getArtifact(c.env, segs[0]);
  if (!art) return notFound(c, segs[0]);
  return legacyForm(c, art, segs.slice(1), twoHost, next);
}

/**
 * `/<slug>[/path]` on the app host: the old form. A browser goes to the
 * canonical address; a machine goes straight to the bytes. An artifact with no
 * workspace has no canonical `<ws>/<slug>`, and is viewed here, at `/<slug>`.
 */
async function legacyForm(
  c: AppContext,
  art: ArtifactRow,
  restSegs: string[],
  twoHost: boolean,
  next: Next
): Promise<Response | void> {
  const rest = restSegs.join("/");
  const ws = art.account_id ? await ensureAccountPublicSlug(c.env, art.account_id) : null;
  if (!ws) return viewArtifact(c, art, null, restSegs);

  if (wantsShell(c) || (c.req.method === "GET" && c.req.header("Sec-Fetch-Dest") === "document")) {
    return redirectToViewer(c, art, rest);
  }
  if (twoHost) {
    const url = new URL(c.req.url);
    return c.redirect(rawLocation(c, art.slug, rest, url.search), 302);
  }
  // Single-host: this origin serves content too; the content route answers it.
  return next();
}

/** The viewer proper: access decision, view bookkeeping, the shell. */
async function viewArtifact(
  c: AppContext,
  art: ArtifactRow,
  ws: string | null,
  restSegs: string[]
): Promise<Response> {
  const slug = art.slug;
  const filePath = restSegs.join("/");
  const url = new URL(c.req.url);

  const key = await presentedKey(c, slug);
  await logDeadLinkAttempt(c, slug, key);

  const preview = await linkPreviewResponse(c, slug, key);
  if (preview) return preview;

  // `?raw=1` is how the frame asks for content; as a top-level page it would be
  // the bare artifact. Never here: send the browser to the viewer.
  if (c.req.method === "GET" && c.req.header("Sec-Fetch-Dest") === "document" && url.searchParams.has("raw")) {
    return c.redirect(url.pathname + cleanSearch(url, ["raw"]), 302);
  }

  // Not a browser navigation: curl, the CLI, a subresource. Bytes live on the
  // content origin, never here.
  if (!wantsShell(c)) {
    return c.redirect(rawLocation(c, slug, filePath, url.search), 302);
  }

  // A valid key in the address: trade it for a per-artifact cookie and drop it
  // from the URL (history, logs, referrers).
  if (key.queryKey && key.viaLink) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.pathname + cleanSearch(url, ["k"]),
        "Set-Cookie": linkCookie(slug, key.queryKey),
      },
    });
  }

  const memberIdentity = await getIdentity(c);
  const guest = await guestIdentityFor(c, slug);
  if (!memberIdentity && !guest && !key.viaLink) return signInRedirect(c, slug);

  let identity: Identity | null = memberIdentity;
  let decision = await decideAccess(c.env, art, memberIdentity);
  if (!decision.allowed && guest) {
    identity = guest;
    decision = await decideAccess(c.env, art, guest);
  }
  const linkGrantsThis = !!key.viaLink;
  if (!linkGrantsThis && !decision.allowed) return notFound(c, slug);

  // The account's monthly view allowance, and suspension (a takedown control
  // that binds even the owner; this read bypasses the ~60s cache on purpose).
  const status = art.account_id ? await viewLimitStatus(c.env, art.account_id, undefined, undefined, true) : null;
  if (blocksOnSuspension(status, !!identity?.isAdmin)) {
    return c.html(suspendedContentPage(slug, siteOrigin(c.env)), 403);
  }
  if (blocksOnViewLimit(status, decision.owned || !!identity?.isAdmin)) {
    return c.html(overViewLimitPage(slug, siteOrigin(c.env)), 503);
  }

  const grants = art.visibility === "restricted" ? await listGrants(c.env, slug) : [];
  const frameToken = c.env.SESSION_SECRET
    ? await mintFrameToken(c.env.SESSION_SECRET, slug, new Date().toISOString())
    : undefined;

  if (linkGrantsThis && key.viaLink) {
    // A share-link open: logged here, at the viewer render of the top-level
    // document, and not on the ?k= redirect hop (which would double count) or
    // the framed request (which carries no credential). No email unless the
    // visitor also holds a session, and never a read-receipt mail.
    await logLinkEvent(c, art, filePath || art.entry || "index.html", {
      linkId: key.viaLink.id,
      email: identity?.email ?? null,
      outcome: "viewed",
    });
  } else if (frameToken && identity?.email) {
    await logViewInBackground(c, art, identity.email, filePath || art.entry || "index.html");
  }

  const frameOrigin = contentOrigin(c.env, c.req.url);
  const canonical = appOriginFor(c.env, c.req.url) + canonicalPath(ws, slug);
  const html = shellPage({
    slug,
    title: art.title || slug,
    version: art.current_version,
    // Holding a link is not ownership: arriving by link means arriving as a
    // reader, and the banner would otherwise show for anyone the URL was
    // forwarded to. A share-link visitor sees the artifact alone.
    chromeless: linkGrantsThis,
    canManage:
      !linkGrantsThis &&
      canManage(identity, art, (await resolveAccountContext(c.env, identity)).roles),
    visibility: art.visibility,
    grantCount: grants.length,
    filePath,
    entry: art.entry,
    isDocument: art.entry?.toLowerCase().endsWith(".pdf") ?? false,
    contentOrigin: frameOrigin ?? undefined,
    brandedUrl: canonical,
    frameToken,
  });

  return c.html(html, 200, {
    "Cache-Control": "private, no-store",
    // The page may frame exactly one origin, and may not be re-based or embed
    // plugins. (Inline script/style is the shell's own, so those stay open.)
    "Content-Security-Policy": `frame-src ${frameOrigin ?? "'self'"}; base-uri 'none'; object-src 'none'`,
  });
}
