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
import type { AppBindings, ArtifactRow, Env } from "./env";
import { SESSION_COOKIE } from "./auth";
import { mintSession, SESSION_TTL_SECONDS } from "./session";
import { customerDomainOf } from "./custom-domains";
import { createChallenge, redeemCode, redeemReviewerCode, redeemToken, CHALLENGE_TTL_MINUTES, type Challenge } from "./otp";
import { sendMail } from "./mail";
import { signinMail, guestMail } from "./mail-templates";
import { normalizeEmail } from "./waitlist";
import { incrementRateLimitBucket, clientAddress } from "./rate-limit";
import { touchLastSeen, effectiveRole } from "./users";
import { ensurePersonalAccount, ensureAccountPublicSlug, memberRole } from "./accounts";
import { canonicalPath } from "./canonical";
import { GUEST_COOKIE, inBackground, decideAccess } from "./viewing";
import { siteOrigin } from "./seo";
import { isContentHost, requestHostname } from "./host";
import { getIdentity, readCookie, revokeCurrentSession, type Identity } from "./auth";
import { hasGrant, getArtifact } from "./db";
import { magicLinkConfirmPage } from "./login";
import { safeNextPath } from "./util";
import { reviewerConfig } from "./reviewer";
import { recordAudit } from "./audit";
import { isAllowedOrigin } from "./cors";

export const authRoutes = new Hono<AppBindings>();

/**
 * Login CSRF: every `/auth/*` POST either establishes a session or spends a
 * sign-in budget, so none may be driven by another site. Without this, a page
 * elsewhere could auto-submit the attacker's own magic link and sign the
 * visitor into the attacker's account (SameSite=Lax still stores a cookie set
 * on a top-level POST navigation). A present Origin must be this instance's;
 * an absent one is accepted unless the browser says the request is
 * cross-site. Non-browser clients send neither and are unaffected.
 */
authRoutes.use("/auth/*", async (c, next) => {
  if (c.req.method !== "POST") return next();
  const origin = c.req.header("Origin");
  const crossSite = origin
    ? !isAllowedOrigin(c.env, c.req.url, origin)
    : c.req.header("Sec-Fetch-Site") === "cross-site";
  if (crossSite) return c.json({ error: "forbidden", detail: "cross-site sign-in requests are refused" }, 403);
  return next();
});

/** Per hour. Generous enough for a person retrying, tight enough to protect the domain. */
const START_PER_EMAIL = 5;
const START_PER_IP = 20;
/**
 * Sign-in starts for one address across every source, per hour. The per-email
 * cap above is keyed on address AND client, so a stranger requesting codes for
 * somebody else's address from elsewhere spends their own budget, not the
 * owner's; this outer cap still bounds how much mail one address can receive.
 */
const START_PER_EMAIL_ALL_SOURCES = 15;
/**
 * Typed-code guesses for one address per day, across every challenge. Each
 * challenge already burns after MAX_ATTEMPTS; without a longer horizon,
 * requesting fresh codes renews the guessing budget every hour. Past this the
 * code path stops for the day — the emailed magic link still signs in.
 */
const VERIFY_PER_EMAIL_PER_DAY = 25;

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

function guestCookie(token: string, maxAge: number): string {
  return [`${GUEST_COOKIE}=${token}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", `Max-Age=${maxAge}`].join("; ");
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
/**
 * How long a parked destination survives. Thirty minutes from opening the
 * sign-in page, restarted when the code is requested (`/auth/start`), so the
 * code's own 15 minutes are always covered. It was 10 minutes from the page
 * load, and a person who stepped away before asking for a code finished
 * signing in on /admin instead of their consent screen.
 */
const NEXT_TTL_SECONDS = 1800;
/** Encoded-value budget for the parked cookie, under the ~4096-byte browser limit. */
const NEXT_COOKIE_MAX = 3800;

/**
 * The `Set-Cookie` that parks a post-sign-in destination — or, for `null`,
 * clears a stale one. `/login` with no `next` clears on purpose: an abandoned
 * OAuth attempt must not silently redirect an ordinary sign-in later.
 */
export function pendingNextCookie(next: string | null): string {
  let value = next ? encodeURIComponent(next) : "";
  // A browser silently ignores a cookie over ~4 KB, which would leave a stale
  // destination in place. Say "no destination" out loud instead.
  if (value.length > NEXT_COOKIE_MAX) value = "";
  return [
    `${NEXT_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${value ? NEXT_TTL_SECONDS : 0}`,
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
async function signinOrigin(c: Context<AppBindings>): Promise<string> {
  const canonical = c.env.PUBLIC_BASE_URL || siteOrigin(c.env);
  let url: URL;
  try {
    url = new URL(c.req.url);
  } catch {
    return canonical;
  }
  if (url.protocol !== "https:") return canonical;
  if (isContentHost(c.env, c.req.url)) return canonical;
  // A sign-in that started on an ACTIVE custom domain finishes there: cookies are
  // host-only, so a link to rtfx.pro would sign the person in somewhere the page
  // they were looking at cannot see. (Flag off: always null.)
  if (await customerDomainOf(c.env, c.req.url)) return url.origin;

  const canonicalHost = requestHostname(canonical);
  const host = url.hostname.toLowerCase();
  if (!canonicalHost) return canonical;
  if (host !== canonicalHost && !host.endsWith(`.${canonicalHost}`)) return canonical;
  return url.origin;
}

/**
 * Where a member lands once a sign-in is redeemed.
 *
 * A challenge that names an artifact was asked for from that artifact's gate,
 * so it wins: it rides the challenge row itself, which is the only thing that
 * survives the person opening the email on another device. On a customer host
 * the artifact lives at that host's own `/<slug>` (and only when it belongs to
 * that host's workspace). Otherwise the parked `?next=`, then the home page.
 */
async function signinLanding(c: Context<AppBindings>, challenge: Challenge): Promise<string> {
  const customer = await customerDomainOf(c.env, c.req.url);
  if (challenge.purpose === "signin" && challenge.slug) {
    const art = await getArtifact(c.env, challenge.slug);
    if (art) {
      if (customer) {
        if (art.account_id === customer.account_id) return `/${encodeURIComponent(art.slug)}`;
      } else {
        const workspace = art.account_id ? await ensureAccountPublicSlug(c.env, art.account_id) : null;
        return canonicalPath(workspace, art.slug);
      }
    }
  }
  return pendingNext(c) ?? (customer ? "/" : "/admin");
}

/**
 * Does this address BELONG to the artifact, by the viewer's own rule: its owner,
 * any member of its workspace, or (for an ownerless artifact) a platform admin?
 * Those people hold no grant, since grants are how other people get in, so they
 * need a member sign-in rather than the scoped guest one. Reusing `decideAccess`
 * keeps the gate and the viewer from ever disagreeing about who gets in.
 */
async function belongsToArtifact(env: Env, art: ArtifactRow, email: string): Promise<boolean> {
  const role = effectiveRole(env, email);
  const identity: Identity = {
    email,
    commonName: null,
    isAdmin: role === "admin" || role === "super_admin",
    role,
  };
  if ((await decideAccess(env, art, identity)).owned) return true;
  // decideAccess skips the membership lookup when a grant already lets the
  // person in. A member who also holds a grant still belongs: prefer the member
  // sign-in over the scoped guest link.
  return !!(art.account_id && (await memberRole(env, art.account_id, email)));
}

async function startChallenge(
  c: Context<AppBindings>,
  email: string,
  purpose: "signin" | "guest",
  slug?: string
): Promise<void> {
  const now = new Date().toISOString();

  // Directory reviewer: the challenge is created and counted like any other
  // (same limits, same response) but nothing is emailed and no link exists. No
  // mail_log row is written, since no mail was attempted.
  if (purpose === "signin" && reviewerConfig(c.env)?.email === email) {
    // Slug and origin ride along (as for anyone else) so the reviewer lands on
    // the artifact and the code redeems on a customer host; still no mail, no link.
    const reviewerCustomer = await customerDomainOf(c.env, c.req.url);
    await createChallenge(c.env, {
      email,
      purpose,
      slug,
      now,
      noLink: true,
      origin: reviewerCustomer ? `https://${reviewerCustomer.hostname}` : null,
    });
    return;
  }

  const customer = await customerDomainOf(c.env, c.req.url);
  const issued = await createChallenge(c.env, {
    email,
    purpose,
    slug,
    now,
    origin: customer ? `https://${customer.hostname}` : null,
  });

  const origin = await signinOrigin(c);
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
async function establishSession(env: Env, email: string, aud?: string): Promise<string | null> {
  if (!env.SESSION_SECRET) return null;
  const now = new Date().toISOString();

  await touchLastSeen(env, email, effectiveRole(env, email), now);
  await ensurePersonalAccount(env, email, now);

  const token = await mintSession(env.SESSION_SECRET, { email, kind: "member", ...(aud ? { aud } : {}) }, now);
  return sessionCookie(token, SESSION_TTL_SECONDS);
}

/** Every reviewer sign-in leaves a log line and an audit row. */
async function noteReviewerSignin(c: Context<AppBindings>, email: string, now: string): Promise<void> {
  const country = (c.req.raw as { cf?: { country?: string } }).cf?.country ?? null;
  const ua = (c.req.header("User-Agent") ?? "").slice(0, 80);
  console.log(JSON.stringify({ event: "reviewer_signin", country, ua }));
  await recordAudit(c.env, {
    actor: { email, role: "member" },
    action: "auth.reviewer_signin",
    targetType: "user",
    targetId: email,
    summary: "Directory reviewer signed in",
    detail: { country, ua },
    now,
  });
}

authRoutes.post("/auth/start", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail((body as { email?: unknown } | null)?.email);
  if (!email) return c.json({ error: "bad_request", detail: "a valid email is required" }, 400);

  const ip = clientAddress(c);
  const [emailOk, allOk, ipOk] = await Promise.all([
    incrementRateLimitBucket(c, `auth:email-ip:${email}:${ip}`, START_PER_EMAIL),
    incrementRateLimitBucket(c, `auth:email:${email}`, START_PER_EMAIL_ALL_SOURCES),
    incrementRateLimitBucket(c, `auth:ip:${ip}`, START_PER_IP),
  ]);
  if (!emailOk || !allOk || !ipOk) {
    return c.json({ error: "rate_limited" }, 429, { "Retry-After": "3600" });
  }

  await startChallenge(c, email, "signin");
  // Restart the parked destination's clock (see NEXT_TTL_SECONDS). Only ever
  // re-parks what is already there, re-validated: nothing new is introduced.
  const next = pendingNext(c);
  return c.json(ACCEPTED, 202, next ? { "Set-Cookie": pendingNextCookie(next) } : {});
});

authRoutes.post("/auth/verify", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail((body as { email?: unknown } | null)?.email);
  const code = String((body as { code?: unknown } | null)?.code ?? "").trim();
  if (!email || !/^\d{6}$/.test(code)) {
    return c.json({ error: "bad_request" }, 400);
  }

  if (!(await incrementRateLimitBucket(c, `auth:verify:${email}`, VERIFY_PER_EMAIL_PER_DAY, 24 * 60 * 60))) {
    return c.json(
      { error: "rate_limited", detail: "too many codes tried for this address today — use the link in the email instead" },
      429,
      { "Retry-After": "86400" }
    );
  }

  const nowIso = new Date().toISOString();
  const reviewer = reviewerConfig(c.env);
  const isReviewer = !!reviewer && reviewer.email === email;
  const verifyCustomer = await customerDomainOf(c.env, c.req.url);
  const verifyOrigin = verifyCustomer ? `https://${verifyCustomer.hostname}` : null;
  const challenge = isReviewer
    ? await redeemReviewerCode(c.env, email, code, reviewer!.code, nowIso, verifyOrigin)
    : await redeemCode(c.env, email, code, nowIso, verifyOrigin);
  if (!challenge) return c.json({ error: "invalid_code" }, 401);

  const cookie = await establishSession(c.env, challenge.email, verifyCustomer?.hostname);
  if (!cookie) return c.json({ error: "not_configured" }, 503);
  if (isReviewer) await noteReviewerSignin(c, challenge.email, nowIso);

  // Two Set-Cookie headers, so the response is built by hand: `c.json`'s header
  // record holds one value per name, and dropping either the session or the
  // clear-down would be a silent bug rather than a visible one.
  const headers = new Headers({ "Content-Type": "application/json; charset=UTF-8" });
  headers.append("Set-Cookie", cookie);
  headers.append("Set-Cookie", pendingNextCookie(null));
  // Nothing under /admin exists on a customer host; land on its root instead.
  return new Response(JSON.stringify({ ok: true, redirect: await signinLanding(c, challenge) }), {
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
  const tokenCustomer = await customerDomainOf(c.env, c.req.url);
  const challenge = await redeemToken(
    c.env,
    c.req.param("token"),
    new Date().toISOString(),
    tokenCustomer ? `https://${tokenCustomer.hostname}` : null
  );
  if (!challenge) return c.json({ error: "invalid_link" }, 401);
  // The reviewer has no link; refuse one even if a stray challenge somehow has it.
  if (challenge.purpose === "signin" && reviewerConfig(c.env)?.email === challenge.email) {
    return c.json({ error: "invalid_link" }, 401);
  }

  // A guest challenge yields a GUEST credential, never a member session:
  // redeeming a share invitation must not create an account for somebody who
  // never asked for one, and must not replace the session of a member who is
  // already signed in. It is its own cookie, bound to this one artifact, and only
  // the viewer and its chat socket ever read it. The visitor lands on the
  // artifact's canonical address.
  // A guest challenge without a slug is malformed: refuse it rather than let it
  // fall through to the member session below.
  if (challenge.purpose === "guest" && !challenge.slug) return c.json({ error: "invalid_link" }, 401);
  if (challenge.purpose === "guest" && challenge.slug && c.env.SESSION_SECRET) {
    const token = await mintSession(
      c.env.SESSION_SECRET,
      {
        email: challenge.email,
        kind: "guest",
        slug: challenge.slug,
        ...(tokenCustomer ? { aud: tokenCustomer.hostname } : {}),
      },
      new Date().toISOString()
    );
    const art = await getArtifact(c.env, challenge.slug);
    // On a customer host the artifact lives at that host's own `/<slug>`.
    const customer = await customerDomainOf(c.env, c.req.url);
    let location: string;
    if (customer) {
      location = art && art.account_id === customer.account_id ? `/${encodeURIComponent(art.slug)}` : "/";
    } else {
      const workspace = art?.account_id ? await ensureAccountPublicSlug(c.env, art.account_id) : null;
      location = art ? canonicalPath(workspace, art.slug) : "/";
    }
    const headers = new Headers({ Location: location });
    headers.append("Set-Cookie", guestCookie(token, SESSION_TTL_SECONDS));
    return new Response(null, { status: 302, headers });
  }

  const cookie = await establishSession(c.env, challenge.email, tokenCustomer?.hostname);
  if (!cookie) return c.json({ error: "not_configured" }, 503);

  // Built by hand rather than with c.redirect(): that helper takes no headers,
  // and a redirect without the Set-Cookie would sign nobody in while looking
  // exactly like success.
  const headers = new Headers({ Location: await signinLanding(c, challenge) });
  headers.append("Set-Cookie", cookie);
  headers.append("Set-Cookie", pendingNextCookie(null));
  return new Response(null, { status: 302, headers });
});

/**
 * The artifact gate's form: whoever you are, prove you control the address.
 *
 * - Somebody who belongs to the artifact (owner, workspace member, or an admin
 *   of an ownerless one) gets an ordinary MEMBER sign-in, code and link, that
 *   lands back on it. They hold no grant, so the guest path alone sent them
 *   nothing while the page said a link was on its way.
 * - Somebody granted it gets a guest link scoped to this one artifact.
 * - Anybody else gets nothing.
 *
 * Answers 202 in every case, and whether or not the artifact exists; anything
 * else would let a stranger enumerate who has access and which slugs are real.
 * The lookup and the send run after the response so latency does not say which
 * case applied either.
 */
authRoutes.post("/auth/guest", async (c) => {
  const slug = (c.req.query("slug") ?? "").trim().toLowerCase();
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail((body as { email?: unknown } | null)?.email);
  if (!email || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    return c.json({ error: "bad_request" }, 400);
  }

  const [emailOk, ipOk] = await Promise.all([
    incrementRateLimitBucket(c, `guest:email-ip:${email}:${clientAddress(c)}`, START_PER_EMAIL),
    incrementRateLimitBucket(c, `guest:ip:${clientAddress(c)}`, START_PER_IP),
  ]);
  if (!emailOk || !ipOk) return c.json({ error: "rate_limited" }, 429, { "Retry-After": "3600" });

  const issue = async () => {
    const art = await getArtifact(c.env, slug);
    if (!art) return;
    // The request's own host when it is an active custom domain of THIS
    // artifact's workspace, so the person lands where they were looking. The
    // challenge is bound to that host: redeemable nowhere else.
    const customer = await customerDomainOf(c.env, c.req.url);
    const onCustom = !!customer && art.account_id === customer.account_id;

    // On a customer host a member sign-in is only for that host's own workspace;
    // a slug from another workspace falls through to the grant check below.
    if ((!customer || onCustom) && (await belongsToArtifact(c.env, art, email))) {
      // Same all-sources cap as /auth/start: the per-address bucket above is
      // keyed on the client too, so it alone does not bound mail to one address.
      if (!(await incrementRateLimitBucket(c, `auth:email:${email}`, START_PER_EMAIL_ALL_SOURCES))) return;
      await startChallenge(c, email, "signin", art.slug);
      return;
    }
    if (!(await hasGrant(c.env, slug, email))) return;

    const now = new Date().toISOString();
    const origin = onCustom ? `https://${customer!.hostname}` : c.env.PUBLIC_BASE_URL || siteOrigin(c.env);
    const issued = await createChallenge(c.env, {
      email,
      purpose: "guest",
      slug,
      now,
      origin: onCustom ? origin : null,
    });
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
  };
  await inBackground(c, issue().catch((err) => console.error("auth/guest: issuing a challenge failed", err)));

  return c.json(ACCEPTED, 202);
});

authRoutes.post("/auth/signout", async (c) => {
  await revokeCurrentSession(c);
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", sessionCookie("", 0));
  headers.append("Set-Cookie", guestCookie("", 0));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
});
