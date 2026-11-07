/**
 * Cross-host sign-in handoff between the two APP hosts.
 *
 * The session cookie is host-only on purpose (no Domain attribute): the content
 * host serves untrusted uploaded HTML and must never receive it, and a customer
 * custom domain is run by somebody else. The price is that a sign-in on
 * `mcp.rtfx.pro` (where OAuth authorize lives) is invisible to `rtfx.pro`, where
 * the artifact link the connector hands back opens.
 *
 * A handoff carries a *verified sign-in* from one app host to the other without
 * sharing any cookie. Four top-level redirects, all GET, all in the same browser.
 * A is the host that holds the session, B the host that wants one:
 *
 *   B /auth/handoff/begin?next=<url on A>      sets a `__Host-` nonce cookie on B
 *   A /auth/handoff/issue?h=sha256(nonce)&next  needs A's session; mints a token
 *   B /auth/handoff?t=<token>                   checks nonce cookie, mints B's session
 *   -> A <next>
 *
 * Why the nonce lives on the TARGET (B), not the source: the thing to defend is
 * login CSRF — an attacker signs in as themselves on A, then gets the victim to
 * open `B/auth/handoff?t=<attacker's token>`, which would sign the victim into
 * the attacker's account on B. B must therefore be able to tell "this browser
 * started this handoff" before it mints anything, and only B can see B's cookies.
 * The token is bound to hash(nonce); the attacker cannot plant the matching
 * cookie in the victim's browser, so the redeem fails. The cookie is `__Host-`
 * prefixed so a script on the content host (a.rtfx.pro, same registrable domain)
 * cannot toss a `Domain=rtfx.pro` cookie of the same name over it.
 *
 * Token: 32 random bytes, stored only as a SHA-256 hash, 60 s TTL, single use via
 * one conditional UPDATE ... RETURNING that also checks target host, source host
 * and nonce. Never logged.
 */

import type { Env } from "./env";
import { hashToken } from "./tokens";
import { isContentHost, requestHostname } from "./host";
import { siteOrigin } from "./seo";
import { customerDomainOf } from "./custom-domains";
import { safeNextPath } from "./util";
import { sessionRevoked } from "./session-revocation";

export const HANDOFF_TTL_SECONDS = 60;
export const HANDOFF_COOKIE = "__Host-rtfx_handoff";
/** The browser nonce only needs to outlive the four redirects. */
export const HANDOFF_COOKIE_TTL_SECONDS = 120;

/** The MCP host is always `mcp.<canonical host>` (wrangler.jsonc routes). */
const MCP_LABEL = "mcp";

export interface AppHostPair {
  /** The host serving this request. */
  self: string;
  /** The other app host. */
  partner: string;
  /** The canonical (non-MCP) host. */
  canonical: string;
}

/**
 * The (self, partner) app-host pair for this request, or null when the request
 * is not on one of the two app hosts — a content host, a customer domain, any
 * other host, or plain http. Handoff exists only between these two hosts.
 */
export async function appHostPair(env: Env, url: string): Promise<AppHostPair | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const canonical = requestHostname(env.PUBLIC_BASE_URL || siteOrigin(env));
  if (!canonical) return null;
  const mcp = `${MCP_LABEL}.${canonical}`;
  const self = u.hostname.toLowerCase();
  if (self !== canonical && self !== mcp) return null;
  // Misconfiguration guard: an app host listed as a content host is not an app host.
  if (isContentHost(env, `https://${canonical}/`) || isContentHost(env, `https://${mcp}/`)) return null;
  if (await customerDomainOf(env, url)) return null;
  return { self, partner: self === canonical ? mcp : canonical, canonical };
}

/**
 * `next` as handed to /begin: an absolute https URL on exactly `host`. Returns the
 * path+query (validated like every post-sign-in destination), or null. Anything
 * else — another host, another scheme, userinfo, a different port — is refused,
 * so the handoff is never an open redirect.
 */
export function nextOnHost(raw: unknown, host: string): string | null {
  if (typeof raw !== "string" || !raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname.toLowerCase() !== host) return null;
  if (u.port || u.username || u.password) return null;
  return safeNextPath(u.pathname + u.search);
}

/**
 * Where a successful sign-in on this request's host should go next. On the MCP
 * host that is the handoff to the canonical host (which finally lands on `path`
 * back here); anywhere else it is `path` unchanged.
 */
export async function afterSignin(env: Env, requestUrl: string, path: string): Promise<string> {
  const pair = await appHostPair(env, requestUrl);
  if (!pair || pair.self === pair.canonical) return path;
  const back = `https://${pair.self}${path}`;
  return `https://${pair.partner}/auth/handoff/begin?next=${encodeURIComponent(back)}`;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const HEX64 = /^[0-9a-f]{64}$/;

async function ensureTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS auth_handoffs (
       token_hash   TEXT PRIMARY KEY,
       email        TEXT NOT NULL,
       source_host  TEXT NOT NULL,
       target_host  TEXT NOT NULL,
       next_path    TEXT NOT NULL,
       nonce_hash   TEXT NOT NULL,
       expires_at   TEXT NOT NULL,
       consumed_at  TEXT,
       created_at   TEXT NOT NULL
     )`
  ).run();
}

/** Mint a one-time token for `email`, to be redeemed on `targetHost` by the browser holding the nonce. */
export async function issueHandoff(
  env: Env,
  o: { email: string; sourceHost: string; targetHost: string; nextPath: string; nonceHash: string; now: string }
): Promise<string> {
  await ensureTable(env);
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.parse(o.now) + HANDOFF_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO auth_handoffs
       (token_hash, email, source_host, target_host, next_path, nonce_hash, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  )
    .bind(await hashToken(token), o.email.trim().toLowerCase(), o.sourceHost, o.targetHost, o.nextPath, o.nonceHash, expires, o.now)
    .run();
  return token;
}

export type HandoffRedeem =
  | { ok: true; email: string; sourceHost: string; nextPath: string }
  /** `nextPath` is where a failed handoff may still send the browser (never a credential). */
  | { ok: false; nextPath: string | null };

/**
 * Redeem atomically, burning FIRST. One conditional UPDATE consumes the row on a
 * token match alone (unconsumed, unexpired); only then are target host, source
 * host and the browser nonce checked. A presented token that does not fit is
 * therefore destroyed, not left live: a token minted for the wrong browser (an
 * attacker-chosen nonce hash) dies on the victim's first, failed redeem instead
 * of sitting valid in history and request logs. Two concurrent redeems cannot
 * both win.
 */
export async function redeemHandoff(
  env: Env,
  o: { token: string; targetHost: string; sourceHost: string; nonce: string; now: string }
): Promise<HandoffRedeem> {
  if (!HEX64.test(o.token)) return { ok: false, nextPath: null };
  await ensureTable(env);
  const row = await env.DB.prepare(
    `UPDATE auth_handoffs SET consumed_at = ?
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
      RETURNING email, source_host, target_host, next_path, nonce_hash, created_at`
  )
    .bind(o.now, await hashToken(o.token), o.now)
    .first<{
      email: string;
      source_host: string;
      target_host: string;
      next_path: string;
      nonce_hash: string;
      created_at: string;
    }>();
  if (!row) return { ok: false, nextPath: null };
  const fits =
    !!o.nonce &&
    row.target_host === o.targetHost &&
    row.source_host === o.sourceHost &&
    row.nonce_hash === (await hashToken(o.nonce));
  // Wrong host or wrong browser: the token is spent. The stored path is only
  // offered as a place to land (on the source host, which holds the session).
  if (!fits) return { ok: false, nextPath: row.source_host === o.sourceHost ? row.next_path : null };
  // Signed out on either host between issue and redeem: that sign-out voids
  // sessions issued before it, and a session minted now must not resurrect it.
  if (await sessionRevoked(env, row.email, Math.floor(Date.parse(row.created_at) / 1000))) {
    return { ok: false, nextPath: row.next_path };
  }
  return { ok: true, email: row.email, sourceHost: row.source_host, nextPath: row.next_path };
}

/**
 * The handoff runs one way only: from the MCP host (where OAuth sign-in happens)
 * to the canonical host. `begin` and the redeem run on the canonical host,
 * `issue` on the MCP host. The reverse is refused rather than left reachable
 * through the symmetric URLs.
 */
export type HandoffStep = "begin" | "issue" | "redeem";
export function stepAllowed(pair: AppHostPair, step: HandoffStep): boolean {
  return step === "issue" ? pair.self !== pair.canonical : pair.self === pair.canonical;
}

/**
 * Sec-Fetch-Site must say the whole navigation chain stayed on this site. The
 * real chain (mcp.rtfx.pro <-> rtfx.pro) is same-site; a chain started from
 * another site or from the sandboxed content host (opaque origin) is cross-site,
 * and "none"/absent never occurs in it. Refusing those stops an attacker from
 * driving a victim's browser into minting a token.
 */
export function sameSiteNavigation(header: string | undefined | null): boolean {
  return header === "same-origin" || header === "same-site";
}
