/**
 * `/auth/handoff*`: the HTTP half of the cross-host sign-in handoff. The design
 * and its security argument live in src/handoff.ts.
 */

import { Hono } from "hono";
import type { AppBindings } from "./env";
import { resolveAuth } from "./auth";
import { mintSession, SESSION_TTL_SECONDS } from "./session";
import { sessionCookie } from "./auth-routes";
import { safeNextPath } from "./util";
import { incrementRateLimitBucket, clientAddress } from "./rate-limit";
import { ensurePersonalAccount } from "./accounts";
import { hashToken } from "./tokens";
import {
  appHostPair,
  nextOnHost,
  issueHandoff,
  redeemHandoff,
  HANDOFF_COOKIE,
  HANDOFF_COOKIE_TTL_SECONDS,
  HEX64,
  stepAllowed,
  sameSiteNavigation,
} from "./handoff";

export const handoffRoutes = new Hono<AppBindings>();

const ISSUE_PER_IP_PER_HOUR = 60;

/** Nothing here may be cached, and the token must not leak through Referer. */
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };


/**
 * The nonce cookie carries `<nonce>` or `<nonce>:<urlencoded next path>`. The path
 * is only there so a FAILED redeem can still send the browser back to where it
 * was going (the source host still holds its session): there must be no dead end
 * in the chain. It grants nothing and is re-validated with `safeNextPath`.
 */
const NONCE_RE = /^[0-9a-f]{48}$/;
const COOKIE_NEXT_MAX = 3000;

function nonceCookie(value: string, maxAge: number): string {
  // `__Host-` forces Secure, Path=/ and no Domain, and stops a script on a
  // sibling host (the content host) from setting a same-named Domain cookie.
  return `${HANDOFF_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/**
 * The handoff cookie, or nulls. Refuses (returns nulls) when the name appears
 * more than once: two cookies of one name mean something other than this
 * server set one of them. Trims only ASCII space and tab around the pair.
 */
function readHandoffCookie(header: string | undefined): { nonce: string | null; next: string | null } {
  const none = { nonce: null, next: null };
  if (!header) return none;
  const values: string[] = [];
  for (const part of header.split(";")) {
    const trimmed = part.replace(/^[ \t]+/, "");
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).replace(/[ \t]+$/, "") === HANDOFF_COOKIE) values.push(trimmed.slice(eq + 1).replace(/[ \t]+$/, ""));
  }
  if (values.length !== 1) return none;
  const [rawNonce, rawNext] = [values[0].split(":", 1)[0], values[0].includes(":") ? values[0].slice(values[0].indexOf(":") + 1) : null];
  if (!NONCE_RE.test(rawNonce)) return none;
  let next: string | null = null;
  if (rawNext) {
    try {
      next = safeNextPath(decodeURIComponent(rawNext));
    } catch {
      next = null;
    }
  }
  return { nonce: rawNonce, next };
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, ...HEADERS });
  for (const ck of cookies) headers.append("Set-Cookie", ck);
  return new Response(null, { status: 302, headers });
}

const NOT_AVAILABLE = () => new Response("Not found", { status: 404, headers: HEADERS });

/** Step 1, on the canonical host (the one that wants a session). */
handoffRoutes.get("/auth/handoff/begin", async (c) => {
  const pair = await appHostPair(c.env, c.req.url);
  if (!pair || !stepAllowed(pair, "begin")) return NOT_AVAILABLE();
  const next = nextOnHost(c.req.query("next"), pair.partner);
  if (!next) return c.text("Bad request", 400, HEADERS);
  // Not a same-site chain: do not start a handoff, just carry on to where the
  // person was going.
  if (!sameSiteNavigation(c.req.header("Sec-Fetch-Site"))) return redirect(`https://${pair.partner}${next}`);

  const nonce = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const enc = encodeURIComponent(next);
  const value = enc.length <= COOKIE_NEXT_MAX ? `${nonce}:${enc}` : nonce;
  return redirect(
    `https://${pair.partner}/auth/handoff/issue?h=${await hashToken(nonce)}&next=${enc}`,
    [nonceCookie(value, HANDOFF_COOKIE_TTL_SECONDS)]
  );
});

/** Step 2, on the MCP host (the one that holds the session). */
handoffRoutes.get("/auth/handoff/issue", async (c) => {
  const pair = await appHostPair(c.env, c.req.url);
  if (!pair || !stepAllowed(pair, "issue")) return NOT_AVAILABLE();
  const h = c.req.query("h") ?? "";
  const next = safeNextPath(c.req.query("next"));
  if (!HEX64.test(h) || !next) return c.text("Bad request", 400, HEADERS);

  // Every refusal below continues to `next` on this host instead of stranding
  // the person (an OAuth flow must still reach its consent screen).
  //
  // A chain that did not stay on this site is never allowed to mint a token: an
  // attacker page could otherwise point a signed-in victim's browser here with
  // an attacker-chosen `h`.
  if (!sameSiteNavigation(c.req.header("Sec-Fetch-Site"))) return redirect(next);
  if (!(await incrementRateLimitBucket(c, `handoff:ip:${clientAddress(c)}`, ISSUE_PER_IP_PER_HOUR))) {
    return redirect(next);
  }

  // Only an interactive member session can be handed off: not an API token, not
  // a guest credential, not a paused account, not an edge/dev identity.
  const { identity, disabled } = await resolveAuth(c);
  if (disabled || !identity?.email || identity.token || identity.kind !== "member") return redirect(next);

  const token = await issueHandoff(c.env, {
    email: identity.email,
    sourceHost: pair.self,
    targetHost: pair.partner,
    nextPath: next,
    nonceHash: h,
    now: new Date().toISOString(),
  });
  console.log(JSON.stringify({ event: "auth_handoff_issued", from: pair.self, to: pair.partner }));
  return redirect(`https://${pair.partner}/auth/handoff?t=${token}`);
});

/** Step 3, back on the canonical host: redeem, mint its own host-only session, return. */
handoffRoutes.get("/auth/handoff", async (c) => {
  const pair = await appHostPair(c.env, c.req.url);
  if (!pair || !stepAllowed(pair, "redeem")) return NOT_AVAILABLE();
  const clear = nonceCookie("", 0);
  const { nonce, next: cookieNext } = readHandoffCookie(c.req.header("Cookie") ?? c.req.header("cookie"));
  // Any failure still ends where the person was going: the MCP host holds their
  // session, so the consent screen works. Never a dead end.
  const fail = (path: string | null) => {
    console.log(JSON.stringify({ event: "auth_handoff_failed", at: pair.self }));
    return redirect(`https://${pair.partner}${path ?? cookieNext ?? "/"}`, [clear]);
  };

  const secret = c.env.SESSION_SECRET;
  if (!secret) return fail(null);
  if (!sameSiteNavigation(c.req.header("Sec-Fetch-Site"))) return fail(null);

  const now = new Date().toISOString();
  const handoff = await redeemHandoff(c.env, {
    token: c.req.query("t") ?? "",
    targetHost: pair.self,
    sourceHost: pair.partner,
    nonce: nonce ?? "",
    now,
  });
  if (!handoff.ok) return fail(handoff.nextPath);

  await ensurePersonalAccount(c.env, handoff.email, now);
  // Same identity and kind as a direct sign-in; no `aud`, because this is an app host.
  const session = await mintSession(secret, { email: handoff.email, kind: "member" }, now);
  console.log(JSON.stringify({ event: "auth_handoff_redeemed", from: pair.partner, to: pair.self }));
  return redirect(`https://${handoff.sourceHost}${handoff.nextPath}`, [sessionCookie(session, SESSION_TTL_SECONDS), clear]);
});
