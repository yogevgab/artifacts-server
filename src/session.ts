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
  now: string
): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, keyFrom(secret), {
      currentDate: new Date(now),
    });
    const kind = payload.kind;
    if (kind !== "member" && kind !== "guest") return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    const slug = typeof payload.slug === "string" ? payload.slug : undefined;
    return { email: payload.sub, kind, ...(slug ? { slug } : {}) };
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
 * A one-shot credential for crossing from the app host to the content host.
 *
 * The session cookie is host-only by design — it must never be sent to the
 * origin that serves uploaded HTML. So a viewer arriving at the content host
 * has no identity there, and needs one minted by the host that does know them.
 *
 * Deliberately short-lived: it rides in a URL, which lands in history, logs and
 * referrers. Sixty seconds is long enough for a redirect and useless to anyone
 * who finds it later.
 */
export const HANDOFF_TTL_SECONDS = 60;

export async function mintHandoff(
  secret: string,
  claims: SessionClaims,
  now: string
): Promise<string> {
  const key = keyFrom(secret);
  const issued = Math.floor(Date.parse(now) / 1000);
  return new SignJWT({
    kind: claims.kind,
    ...(claims.slug ? { slug: claims.slug } : {}),
    use: "handoff",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(normalize(claims.email))
    .setIssuedAt(issued)
    .setExpirationTime(issued + HANDOFF_TTL_SECONDS)
    .sign(key);
}

/**
 * Verify a handoff. Rejects a full session token presented here: the two have
 * different lifetimes and different exposure, and one must never be usable as
 * the other.
 */
export async function verifyHandoff(
  secret: string,
  token: string,
  now: string
): Promise<SessionClaims | null> {
  const claims = await verifySession(secret, token, now);
  if (!claims) return null;
  try {
    const { payload } = await jwtVerify(token, keyFrom(secret), { currentDate: new Date(now) });
    if (payload.use !== "handoff") return null;
  } catch {
    return null;
  }
  return claims;
}
