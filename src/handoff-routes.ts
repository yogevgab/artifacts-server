/**
 * `/auth/handoff*`: the HTTP half of the cross-host sign-in handoff. The design
 * and its security argument live in src/handoff.ts.
 */

import { Hono } from "hono";
import type { AppBindings } from "./env";
import { readCookie, resolveAuth } from "./auth";
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
} from "./handoff";

export const handoffRoutes = new Hono<AppBindings>();

const ISSUE_PER_IP_PER_HOUR = 60;

/** Nothing here may be cached, and the token must not leak through Referer. */
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

function nonceCookie(value: string, maxAge: number): string {
  // `__Host-` forces Secure, Path=/ and no Domain, and stops a script on a
  // sibling host (the content host) from setting a same-named Domain cookie.
  return `${HANDOFF_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, ...HEADERS });
  for (const ck of cookies) headers.append("Set-Cookie", ck);
  return new Response(null, { status: 302, headers });
}

const NOT_AVAILABLE = () => new Response("Not found", { status: 404, headers: HEADERS });

/** Step 1, on the host that wants a session (B). */
handoffRoutes.get("/auth/handoff/begin", async (c) => {
  const pair = await appHostPair(c.env, c.req.url);
  if (!pair) return NOT_AVAILABLE();
  const next = nextOnHost(c.req.query("next"), pair.partner);
  if (!next) return c.text("Bad request", 400, HEADERS);

  const nonce = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const h = await hashToken(nonce);
  return redirect(
    `https://${pair.partner}/auth/handoff/issue?h=${h}&next=${encodeURIComponent(next)}`,
    [nonceCookie(nonce, HANDOFF_COOKIE_TTL_SECONDS)]
  );
});

/** Step 2, on the host that holds the session (A). */
handoffRoutes.get("/auth/handoff/issue", async (c) => {
  const pair = await appHostPair(c.env, c.req.url);
  if (!pair) return NOT_AVAILABLE();
  const h = c.req.query("h") ?? "";
  const next = safeNextPath(c.req.query("next"));
  if (!HEX64.test(h) || !next) return c.text("Bad request", 400, HEADERS);

  if (!(await incrementRateLimitBucket(c, `handoff:ip:${clientAddress(c)}`, ISSUE_PER_IP_PER_HOUR))) {
    return c.text("Too many requests", 429, { ...HEADERS, "Retry-After": "3600" });
  }

  // Only an interactive member session can be handed off: not an API token, not
  // a guest credential, not a paused account. Without one, just go on to `next`
  // (which will ask for a sign-in itself) rather than looping.
  const { identity, disabled } = await resolveAuth(c);
  if (disabled || !identity?.email || identity.token || identity.kind === "guest") return redirect(next);

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

/** Step 3, back on B: redeem, mint B's own host-only session, return to A. */
handoffRoutes.get("/auth/handoff", async (c) => {
  const pair = await appHostPair(c.env, c.req.url);
  if (!pair) return NOT_AVAILABLE();
  const clear = nonceCookie("", 0);
  const fail = () =>
    new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign-in link expired</title>' +
        `<p style="font:16px system-ui;margin:3rem auto;max-width:28rem">This sign-in link expired or was already used. <a href="/login">Sign in again</a>.</p>`,
      { status: 400, headers: { ...HEADERS, "Content-Type": "text/html; charset=UTF-8", "Set-Cookie": clear } }
    );

  const nonce = readCookie(c.req.header("Cookie") ?? c.req.header("cookie"), HANDOFF_COOKIE);
  const secret = c.env.SESSION_SECRET;
  if (!nonce || !secret) return fail();

  const now = new Date().toISOString();
  const handoff = await redeemHandoff(c.env, {
    token: c.req.query("t") ?? "",
    targetHost: pair.self,
    sourceHost: pair.partner,
    nonce,
    now,
  });
  if (!handoff) return fail();

  await ensurePersonalAccount(c.env, handoff.email, now);
  // Same identity and kind as a direct sign-in; no `aud`, because this is an app host.
  const session = await mintSession(secret, { email: handoff.email, kind: "member" }, now);
  console.log(JSON.stringify({ event: "auth_handoff_redeemed", from: pair.partner, to: pair.self }));
  return redirect(`https://${handoff.sourceHost}${handoff.nextPath}`, [sessionCookie(session, SESSION_TTL_SECONDS), clear]);
});
