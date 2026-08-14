/**
 * "Ask for access" from the 404 page: POST /_access-request/:slug.
 *
 * Mounted under `/_access-request`, not `/api/...` — deliberately, and for
 * the same reason chat lives at `/_chat` (see src/host.ts): this route must
 * be reachable from the content host, where `notFoundPage` is also rendered
 * (src/pages.ts), and `/api/*` is a management-only prefix that 404s there.
 * `/_access-request` is added to `CONTENT_PREFIXES` in src/host.ts so both
 * hosts serve it identically.
 *
 * Existence-oracle analysis — read this before changing anything here.
 * `notFoundPage` intentionally answers identically whether a slug is missing
 * or merely off-limits (see src/pages.ts), so probing a slug cannot tell
 * those apart. This route is the form target on that exact page, so it
 * inherits the same obligation for its own response:
 *
 *   1. Validation (is `email` a plausible address?) and rate limiting run
 *      first, and depend only on the request itself — never on whether the
 *      slug names anything. Their outcomes (400, 429) are therefore already
 *      safe: any two requests with the same body/IP/history get the same
 *      answer regardless of slug.
 *   2. Past that point, the handler ALWAYS returns the same 202 `ACCEPTED`
 *      body, no matter what `notifyOwnerIfEligible` below decides to do.
 *      Slug existence, grant status, mail delivery success/failure — none of
 *      it is allowed to change the shape or content of the HTTP response.
 *   3. The one place existence is allowed to matter is *inside*
 *      `notifyOwnerIfEligible`, which runs after the response is already
 *      decided and whose only externally observable effect is an email —
 *      sent to the artifact's owner, an address the caller does not control
 *      and never sees confirmation of reaching.
 *
 * This is the same shape as `POST /auth/guest` in src/auth-routes.ts, which
 * solves an identical problem ("does this address hold a grant?") the same
 * way: validate and rate-limit up front, decide what to do in a helper whose
 * return value never reaches the response, always answer 202.
 */

import { Hono } from "hono";
import type { AppBindings, Env } from "./env";
import { getArtifact, hasGrant } from "./db";
import { sendMail } from "./mail";
import { accessRequestMail } from "./mail-templates";
import { normalizeEmail } from "./waitlist";
import { incrementRateLimitBucket, clientAddress } from "./rate-limit";
import { siteOrigin } from "./seo";

export const accessRequestRoutes = new Hono<AppBindings>();

/** The one response this route ever gives past validation — see the module comment. */
const ACCEPTED = { status: "accepted" as const };

/** Per hour. Generous enough for someone retrying a typo'd address, tight enough to deter spamming an owner. */
const PER_EMAIL_MAX = 5;
const PER_IP_MAX = 20;

function manageUrl(env: Env, slug: string): string {
  const origin = env.PUBLIC_BASE_URL || siteOrigin(env);
  return `${origin}/admin/artifacts/${encodeURIComponent(slug)}`;
}

/**
 * Mail the owner iff the artifact is real and this requester does not
 * already have access. Returns nothing the caller could use to distinguish
 * its outcomes — see the module comment.
 */
async function notifyOwnerIfEligible(env: Env, slug: string, requesterEmail: string): Promise<void> {
  const art = await getArtifact(env, slug);
  if (!art || !art.owner_email) return;
  if (await hasGrant(env, slug, requesterEmail)) return;

  const owner = art.owner_email.trim().toLowerCase();
  if (owner === requesterEmail) return; // an owner "requesting" their own artifact notifies nobody

  await sendMail(env, {
    to: owner,
    kind: "access_request",
    message: accessRequestMail({
      requesterEmail,
      title: art.title || slug,
      manageUrl: manageUrl(env, slug),
    }),
    now: new Date().toISOString(),
  });
}

accessRequestRoutes.post("/_access-request/:slug", async (c) => {
  const slug = c.req.param("slug");
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail((body as { email?: unknown } | null)?.email);
  if (!email) return c.json({ error: "bad_request", detail: "a valid email is required" }, 400);

  const [emailOk, ipOk] = await Promise.all([
    incrementRateLimitBucket(c, `access-request:email:${email}`, PER_EMAIL_MAX),
    incrementRateLimitBucket(c, `access-request:ip:${clientAddress(c)}`, PER_IP_MAX),
  ]);
  if (!emailOk || !ipOk) {
    return c.json({ error: "rate_limited" }, 429, { "Retry-After": "3600" });
  }

  await notifyOwnerIfEligible(c.env, slug, email);
  return c.json(ACCEPTED, 202);
});
