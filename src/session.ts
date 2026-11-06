/**
 * Signed session cookies.
 *
 * Sessions are stateless: a signed JWT, not a database row. There is no session
 * table and no per-request session read.
 *
 * Revocation still works, because `getIdentity` already reads the user's status
 * from D1 on every request — `disabled` takes effect immediately, exactly as it
 * did under Cloudflare Access. Adding a session table would buy a revocation
 * mechanism the app already has, at the cost of a second read on every request.
 */

import { SignJWT, jwtVerify } from "jose";

/** Who a session belongs to, and how much of the product they may reach. */
export type SessionKind = "member" | "guest";

export interface SessionClaims {
  email: string;
  kind: SessionKind;
  /** Guest sessions only: the single artifact this session was minted for. */
  slug?: string;
  /** Issued-at, seconds since the epoch: what a server-side sign-out is compared against. */
  iat?: number;
  /**
   * The custom-domain hostname this session was minted on. Absent = minted on an
   * app host. A session is only valid on the host it was minted for: the owner of
   * a custom domain controls the server behind it and can read every cookie sent
   * there, so such a cookie must be worthless on rtfx.pro (and vice versa).
   */
  aud?: string;
}

/** 30 days. Sliding — see `shouldRefresh`. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * HS256 needs at least 32 bytes of key material to be worth anything. Failing
 * loudly here means a deploy with a placeholder secret breaks at the first
 * sign-in attempt rather than issuing forgeable sessions indefinitely.
 */
const MIN_SECRET_BYTES = 32;

function keyFrom(secret: string): Uint8Array {
  const bytes = new TextEncoder().encode(secret);
  if (bytes.length < MIN_SECRET_BYTES) {
    throw new Error(
      `session secret must be at least ${MIN_SECRET_BYTES} bytes; got ${bytes.length}`
    );
  }
  return bytes;
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

export async function mintSession(
  secret: string,
  claims: SessionClaims,
  now: string
): Promise<string> {
  const key = keyFrom(secret);
  const issued = Math.floor(Date.parse(now) / 1000);

  const jwt = new SignJWT({
    kind: claims.kind,
    ...(claims.slug ? { slug: claims.slug } : {}),
    ...(claims.aud ? { aud: claims.aud } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(normalize(claims.email))
    .setIssuedAt(issued)
    .setExpirationTime(issued + SESSION_TTL_SECONDS);

  return jwt.sign(key);
}

/**
 * Verify a session cookie. Returns null for anything that is not a valid,
 * unexpired token signed by us — never throws, because every caller's correct
 * response to a bad cookie is identical: treat the request as signed out.
 */
export async function verifySession(
  secret: string,
  token: string,
  now: string,
  /**
   * The custom-domain hostname of the request, or null on an app host. The
   * token's `aud` must equal it exactly: tokens without `aud` (everything minted
   * before custom domains) are accepted on app hosts only.
   */
  expectedAud: string | null = null
): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, keyFrom(secret), {
      currentDate: new Date(now),
    });
    const aud = typeof payload.aud === "string" ? payload.aud : undefined;
    if ((aud ?? null) !== (expectedAud ?? null)) return null;
    const kind = payload.kind;
    if (kind !== "member" && kind !== "guest") return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    const slug = typeof payload.slug === "string" ? payload.slug : undefined;
    return {
      email: payload.sub,
      kind,
      ...(slug ? { slug } : {}),
      ...(aud ? { aud } : {}),
      ...(typeof payload.iat === "number" ? { iat: payload.iat } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * True once a session is past half its life. Callers re-mint on the way out, so
 * an active browser never gets logged out on a fixed schedule while an idle one
 * still expires.
 */
export function shouldRefresh(claims: { iat?: number }, now: string): boolean {
  if (!claims.iat) return false;
  const age = Math.floor(Date.parse(now) / 1000) - claims.iat;
  return age > SESSION_TTL_SECONDS / 2;
}

/**
 * A capability for the viewer shell's frame, carried in the frame's URL path.
 *
 * The frame is sandboxed without `allow-same-origin` (see src/shell.ts), so the
 * browser gives the artifact an opaque origin and sends no SameSite=Lax cookie
 * with anything it loads — its images, scripts, styles, media and the pages it
 * links to. Every artifact needs a credential, so without this every relative
 * asset 404'd and a multi-file site rendered as bare HTML.
 *
 * The token sits in a path segment (`/<slug>/~t/<token>/<file>`) rather than a
 * query string because relative URLs inherit the path but drop the query: an
 * `img/a.jpg` inside the frame resolves to `/<slug>/~t/<token>/img/a.jpg` with
 * no help from the artifact.
 *
 * Scope is one artifact, read-only, current version, for FRAME_TTL_SECONDS —
 * kept short because revoking access does not reach a frame already open —
 * the same shape as a share link, minted only after the shell's own access
 * check passed. It carries no `kind` or `sub`, so `verifySession` rejects it,
 * and `use: "frame"` keeps a session or handoff from being accepted here.
 */
export const FRAME_TTL_SECONDS = 4 * 60 * 60;

export async function mintFrameToken(
  secret: string,
  slug: string,
  now: string,
  /**
   * Origin of the viewer that frames this content, when it is NOT the canonical
   * app origin (a custom domain). The content host adds it to `frame-ancestors`
   * only after re-checking it is an active domain of the artifact's workspace
   * (src/custom-domains.ts `allowedFrameAncestor`), so the claim alone grants
   * nothing. Omitted = exactly the token this has always been.
   */
  anc?: string,
  /**
   * `artifactCreatedAt` pins the token to this artifact rather than to whatever
   * holds the slug: if the artifact is deleted and somebody else publishes under
   * the same slug within the token's lifetime, an old frame URL must not open
   * the newcomer's content.
   */
  artifactCreatedAt?: string
): Promise<string> {
  const issued = Math.floor(Date.parse(now) / 1000);
  return new SignJWT({
    use: "frame",
    slug,
    ...(anc ? { anc } : {}),
    ...(artifactCreatedAt ? { art: artifactCreatedAt } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(issued)
    .setExpirationTime(issued + FRAME_TTL_SECONDS)
    .sign(keyFrom(secret));
}

/** The claims of an unexpired frame token minted for exactly this artifact, or null. */
export async function readFrameToken(
  secret: string,
  token: string,
  slug: string,
  now: string
): Promise<{ anc?: string; art?: string } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, keyFrom(secret), { currentDate: new Date(now) });
    if (payload.use !== "frame" || payload.slug !== slug) return null;
    return {
      ...(typeof payload.anc === "string" && payload.anc ? { anc: payload.anc } : {}),
      ...(typeof payload.art === "string" && payload.art ? { art: payload.art } : {}),
    };
  } catch {
    return null;
  }
}

/** True only for an unexpired frame token minted for exactly this artifact. */
export async function verifyFrameToken(
  secret: string,
  token: string,
  slug: string,
  now: string,
  artifactCreatedAt?: string
): Promise<boolean> {
  const claims = await readFrameToken(secret, token, slug, now);
  if (!claims) return false;
  return artifactCreatedAt === undefined || claims.art === undefined || claims.art === artifactCreatedAt;
}
