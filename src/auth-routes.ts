/**
 * App-owned sign-in: `/auth/*`.
 *
 * Two ways in, one challenge behind them — type the code or click the link.
 * Signup and sign-in are the same endpoint on purpose: whether a `users` row is
 * created or merely touched is decided by whether one already exists, so the
 * two paths cannot drift apart or disagree about who you are.
 *
 * See docs/superpowers/specs/2026-08-14-app-owned-identity-design.md §6.
 */

import { Hono, type Context } from "hono";
import type { AppBindings, Env } from "./env";
import { SESSION_COOKIE } from "./auth";
import { mintSession, mintHandoff, SESSION_TTL_SECONDS } from "./session";
import { createChallenge, redeemCode, redeemToken, CHALLENGE_TTL_MINUTES } from "./otp";
import { sendMail } from "./mail";
import { signinMail, guestMail } from "./mail-templates";
import { normalizeEmail } from "./waitlist";
import { incrementRateLimitBucket, clientAddress } from "./rate-limit";
import { touchLastSeen, effectiveRole } from "./users";
import { ensurePersonalAccount } from "./accounts";
import { siteOrigin } from "./seo";
import { parseHostnames, firstContentHostname, isContentHost, requestHostname } from "./host";
import { getIdentity, readCookie } from "./auth";
import { hasGrant, getArtifact } from "./db";
import { magicLinkConfirmPage } from "./login";
import { safeNextPath } from "./util";

export const authRoutes = new Hono<AppBindings>();

/** Per hour. Generous enough for a person retrying, tight enough to protect the domain. */
const START_PER_EMAIL = 5;
const START_PER_IP = 20;

/**
 * The one response `/auth/start` ever gives. Identical for a known address, an
 * unknown one, and one whose mail bounced — anything else turns this endpoint
 * into an account-enumeration oracle. The real reason is in `mail_log`.
 */
const ACCEPTED = { status: "accepted" as const };

function sessionCookie(token: string, maxAge: number): string {
  // Host-only (no Domain attribute): this cookie must never be sent to the
  // content host, where uploaded HTML runs.
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

/**
 * Where `?next=` is parked between "email me a code" and the code arriving.
 *
 * It cannot ride the challenge: the person may finish on the emailed link
 * instead of the typed code, and the link is a bare token with nowhere to carry
 * a destination. A short-lived host-only cookie covers both endings, and covers
 * them on the host the sign-in *started* on — which is the whole problem on a
 * multi-host instance, where the session cookie for `mcp.rtfx.pro` is not the
 * one for `rtfx.pro`.
 *
 * `SameSite=Lax` is deliberate and load-bearing: the emailed link is a top-level
 * GET navigation, which Lax permits, so the confirm page's POST still finds it.
 */
const NEXT_COOKIE = "rtfx_next";
const NEXT_TTL_SECONDS = 600;

/**
 * The `Set-Cookie` that parks a post-sign-in destination — or, for `null`,
 * clears a stale one. `/login` with no `next` clears on purpose: an abandoned
 * OAuth attempt must not silently redirect an ordinary sign-in ten minutes later.
 */
export function pendingNextCookie(next: string | null): string {
  const value = next ? encodeURIComponent(next) : "";
  return [
    `${NEXT_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${next ? NEXT_TTL_SECONDS : 0}`,
  ].join("; ");
}

/**
 * The parked destination, re-validated on the way out. `safeNextPath` already
 * ran when the cookie was set; running it again means a tampered cookie is worth
 * no more than an absent one, and a redirect after sign-in can only ever be a
 * path on this origin.
 */
function pendingNext(c: Context<AppBindings>): string | null {
  const raw = readCookie(c.req.header("Cookie") ?? c.req.header("cookie"), NEXT_COOKIE);
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return safeNextPath(decoded);
}

/**
 * The origin a sign-in email should point back at.
 *
 * Normally `PUBLIC_BASE_URL`. But a sign-in that *started* on another app host of
 * this same instance — `mcp.rtfx.pro`, mid `claude mcp login` — has to finish
 * there: the session cookie is host-only, so a link to `rtfx.pro` signs the
 * person in somewhere their consent screen cannot see.
 *
 * Three guards, so the address in an outgoing email is never a surprise: https
 * only, never a content host (that origin serves uploaded HTML), and the host
 * must be the canonical site host or a subdomain of it.
 */
function signinOrigin(c: Context<AppBindings>): string {
  const canonical = c.env.PUBLIC_BASE_URL || siteOrigin(c.env);
  let url: URL;
  try {
    url = new URL(c.req.url);
  } catch {
    return canonical;
  }
  if (url.protocol !== "https:") return canonical;
  if (isContentHost(c.env, c.req.url)) return canonical;

  const canonicalHost = requestHostname(canonical);
  const host = url.hostname.toLowerCase();
  if (!canonicalHost) return canonical;
  if (host !== canonicalHost && !host.endsWith(`.${canonicalHost}`)) return canonical;
  return url.origin;
}

async function startChallenge(
  c: Context<AppBindings>,
  email: string,
  purpose: "signin" | "guest",
  slug?: string
): Promise<void> {
  const now = new Date().toISOString();
  const issued = await createChallenge(c.env, { email, purpose, slug, now });

  const origin = signinOrigin(c);
  const message = signinMail({
    code: issued.code,
    magicUrl: `${origin}/auth/m/${issued.token}`,
    expiresMinutes: CHALLENGE_TTL_MINUTES,
  });

  await sendMail(c.env, { to: email, kind: "signin", message, now });
}

/**
 * Establish a session for a verified address and return the Set-Cookie value.
 * Provisions the directory row and personal workspace on the way through, which
 * is what makes signup unattended.
 */
async function establishSession(env: Env, email: string): Promise<string | null> {
  if (!env.SESSION_SECRET) return null;
  const now = new Date().toISOString();

  await touchLastSeen(env, email, effectiveRole(env, email), now);
  await ensurePersonalAccount(env, email, now);

  const token = await mintSession(env.SESSION_SECRET, { email, kind: "member" }, now);
  return sessionCookie(token, SESSION_TTL_SECONDS);
}

authRoutes.post("/auth/start", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail((body as { email?: unknown } | null)?.email);
  if (!email) return c.json({ error: "bad_request", detail: "a valid email is required" }, 400);

  const [emailOk, ipOk] = await Promise.all([
    incrementRateLimitBucket(c, `auth:email:${email}`, START_PER_EMAIL),
    incrementRateLimitBucket(c, `auth:ip:${clientAddress(c)}`, START_PER_IP),
  ]);
  if (!emailOk || !ipOk) {
    return c.json({ error: "rate_limited" }, 429, { "Retry-After": "3600" });
  }

  await startChallenge(c, email, "signin");
  return c.json(ACCEPTED, 202);
});

authRoutes.post("/auth/verify", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail((body as { email?: unknown } | null)?.email);
  const code = String((body as { code?: unknown } | null)?.code ?? "").trim();
  if (!email || !/^\d{6}$/.test(code)) {
    return c.json({ error: "bad_request" }, 400);
  }

  const challenge = await redeemCode(c.env, email, code, new Date().toISOString());
  if (!challenge) return c.json({ error: "invalid_code" }, 401);

  const cookie = await establishSession(c.env, challenge.email);
  if (!cookie) return c.json({ error: "not_configured" }, 503);

  // Two Set-Cookie headers, so the response is built by hand: `c.json`'s header
  // record holds one value per name, and dropping either the session or the
  // clear-down would be a silent bug rather than a visible one.
  const headers = new Headers({ "Content-Type": "application/json; charset=UTF-8" });
  headers.append("Set-Cookie", cookie);
  headers.append("Set-Cookie", pendingNextCookie(null));
  return new Response(JSON.stringify({ ok: true, redirect: pendingNext(c) ?? "/admin" }), {
    status: 200,
    headers,
  });
});

/**
 * The magic link is a two-step on purpose.
 *
 * Gmail, Outlook Safe Links and most corporate mail filters fetch every URL in
 * a message before a human ever sees it. When GET consumed the token, the
 * scanner signed in and the recipient was told their link had expired — we
 * watched it happen in production, 14 seconds after the first real send.
 *
 * So GET is inert: it renders a page with a button. Only the POST behind that
 * button consumes anything, and scanners do not POST.
 */
authRoutes.get("/auth/m/:token", (c) =>
  c.html(magicLinkConfirmPage(c.env, c.req.param("token")))
);

authRoutes.post("/auth/m/:token", async (c) => {
  const challenge = await redeemToken(c.env, c.req.param("token"), new Date().toISOString());
  if (!challenge) return c.json({ error: "invalid_link" }, 401);

  // A guest challenge yields a guest credential on the content host, never a
  // member session here: redeeming a share invitation must not create an
  // account for somebody who never asked for one.
  if (challenge.purpose === "guest" && challenge.slug && c.env.SESSION_SECRET) {
    const host = firstContentHostname(c.env);
    if (host) {
      const ct = await mintHandoff(
        c.env.SESSION_SECRET,
        { email: challenge.email, kind: "guest", slug: challenge.slug },
        new Date().toISOString()
      );
      return c.redirect(
        `https://${host}/${encodeURIComponent(challenge.slug)}/?ct=${encodeURIComponent(ct)}`,
        302
      );
    }
  }

  const cookie = await establishSession(c.env, challenge.email);
  if (!cookie) return c.json({ error: "not_configured" }, 503);

  // Built by hand rather than with c.redirect(): that helper takes no headers,
  // and a redirect without the Set-Cookie would sign nobody in while looking
  // exactly like success.
  const headers = new Headers({ Location: pendingNext(c) ?? "/admin" });
  headers.append("Set-Cookie", cookie);
  headers.append("Set-Cookie", pendingNextCookie(null));
  return new Response(null, { status: 302, headers });
});

/**
 * Guest sign-in: prove you control an address somebody granted this artifact to.
 *
 * Answers 202 whether or not the address holds a grant, and whether or not the
 * artifact exists. Anything else would let a stranger enumerate both who has
 * access and which slugs are real.
 */
authRoutes.post("/auth/guest", async (c) => {
  const slug = (c.req.query("slug") ?? "").trim().toLowerCase();
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail((body as { email?: unknown } | null)?.email);
  if (!email || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    return c.json({ error: "bad_request" }, 400);
  }

  const [emailOk, ipOk] = await Promise.all([
    incrementRateLimitBucket(c, `guest:email:${email}`, START_PER_EMAIL),
    incrementRateLimitBucket(c, `guest:ip:${clientAddress(c)}`, START_PER_IP),
  ]);
  if (!emailOk || !ipOk) return c.json({ error: "rate_limited" }, 429, { "Retry-After": "3600" });

  const art = await getArtifact(c.env, slug);
  if (art && (await hasGrant(c.env, slug, email))) {
    const now = new Date().toISOString();
    const issued = await createChallenge(c.env, { email, purpose: "guest", slug, now });
    const origin = c.env.PUBLIC_BASE_URL || siteOrigin(c.env);
    await sendMail(c.env, {
      to: email,
      kind: "share_notice",
      message: guestMail({
        title: art.title || slug,
        magicUrl: `${origin}/auth/m/${issued.token}`,
        expiresMinutes: CHALLENGE_TTL_MINUTES,
      }),
      now,
    });
  }

  return c.json(ACCEPTED, 202);
});

authRoutes.post("/auth/signout", (c) =>
  c.json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) })
);

/**
 * Hand a signed-in caller across to the content host.
 *
 * The session cookie is host-only so it never reaches the origin serving
 * uploaded HTML. That means the content host cannot identify anyone on its own,
 * and has to ask the app host — this route — for a short-lived token it can
 * exchange for a cookie of its own.
 *
 * `next` is validated against CONTENT_HOSTNAMES rather than merely checked for
 * a prefix: an open redirect here would hand a valid credential to whatever
 * host an attacker named.
 */
authRoutes.get("/auth/content", async (c) => {
  const next = c.req.query("next") ?? "";
  let target: URL;
  try {
    target = new URL(next);
  } catch {
    return c.json({ error: "bad_request", detail: "next must be an absolute URL" }, 400);
  }
  const hosts = parseHostnames(c.env.CONTENT_HOSTNAMES);
  if (target.protocol !== "https:" || !hosts.has(target.hostname)) {
    return c.json({ error: "bad_request", detail: "next must be a content host" }, 400);
  }

  const identity = await getIdentity(c);
  if (!identity?.email) {
    // Somebody following a shared link is usually not a member. Send them to the
    // guest page for this artifact rather than a sign-in they have no account for.
    const slug = c.req.query("slug");
    return c.redirect(slug ? `/shared/${encodeURIComponent(slug)}` : `/login`, 302);
  }
  if (!c.env.SESSION_SECRET) return c.json({ error: "not_configured" }, 503);

  const ct = await mintHandoff(
    c.env.SESSION_SECRET,
    { email: identity.email, kind: identity.kind === "guest" ? "guest" : "member" },
    new Date().toISOString()
  );
  target.searchParams.set("ct", ct);
  return c.redirect(target.toString(), 302);
});
