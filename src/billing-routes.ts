/**
 * `POST /api/billing/webhook` — where Lemon Squeezy tells us a subscription
 * changed.
 *
 * Kept out of `src/api.ts` (owned by another agent) and mounted separately, for
 * the same reason share-routes.ts is separate: a self-contained surface with
 * its own auth story. Unlike everything in api.ts, this route carries NO
 * session or API-token auth — Lemon Squeezy calls it directly, so the HMAC
 * signature is the only gate. See src/billing.ts for why that is safe: the
 * body is verified before a single byte of it is parsed or trusted.
 */

import { Hono } from "hono";
import type { Env } from "./env";
import { verifyWebhook, processWebhookEvent } from "./billing";

export const billingRoutes = new Hono<{ Bindings: Env }>();

billingRoutes.post("/api/billing/webhook", async (c) => {
  const secret = c.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) {
    // No secret configured on this deployment means no request to this route
    // can ever be verified — refuse everything rather than trust an
    // unverifiable body. (Also the honest answer for a deploy that hasn't
    // run `wrangler secret put` yet.)
    return c.json({ error: "not_configured" }, 503);
  }

  // Read the exact bytes Lemon Squeezy sent — not `c.req.json()` — because the
  // signature is computed over the raw body and must be checked before
  // anything in it is parsed, let alone acted on.
  const rawBody = await c.req.text();
  const signature = c.req.header("X-Signature");
  if (!(await verifyWebhook(secret, rawBody, signature))) {
    return c.json({ error: "invalid_signature" }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "bad_request", detail: "invalid JSON" }, 400);
  }

  const result = await processWebhookEvent(c.env, rawBody, payload, new Date().toISOString());
  return c.json(result);
});
