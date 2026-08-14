/**
 * Lemon Squeezy billing: verifying webhooks, mapping a purchased variant to a
 * plan, building checkout links, and reconciling `accounts.plan` — the single
 * source of truth for what an account may do (see src/quota.ts).
 *
 * No SDK: Lemon Squeezy's webhook contract is "HMAC-SHA256 the raw body, send
 * the hex digest in `X-Signature`" and its checkout contract is "a URL with
 * `checkout[...]` query params" — both are a handful of lines with `fetch` and
 * `crypto.subtle`, so pulling in a dependency for them would cost more than it
 * saves. (Verified against Lemon Squeezy's public docs and search results as of
 * 2026-08; see the report for exactly what was confirmed vs assumed.)
 */

import type { Env } from "./env";
import { effectivePlan, getAccount, overrideActive } from "./accounts";
import { recordAudit, SYSTEM_ACTOR } from "./audit";
import { invalidateAccountStatus } from "./quota";

/** The two plans Lemon Squeezy actually sells. `free` is never assigned by billing —
 *  it is the default every account starts at and the floor a cancellation returns to. */
export type PaidPlan = "pro" | "team";

/**
 * Every subscription event carries the subscription's current status, so
 * entitlement is derived from status × variant rather than from a switch over
 * event names. That covers all twelve events this store sends — and any Lemon
 * Squeezy adds later — without a list that silently goes stale. A
 * `subscription_plan_changed` ignored because it was missing from a list is an
 * upgrade the customer paid for and did not receive.
 */
const SUBSCRIPTION_EVENT = /^subscription_/;

// --- signature verification ---------------------------------------------------

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time comparison of two digests. Comparing with `===` short-circuits
 * on the first differing byte, which leaks timing information an attacker can
 * use to forge a signature one byte at a time; XOR-accumulating over the whole
 * string and checking the total at the end takes the same time regardless of
 * where (or whether) the strings differ.
 *
 * The length check does not reopen that hole: both inputs are SHA-256 hex
 * digests, always 64 characters, so a length mismatch only ever means "not
 * even a well-formed digest" — nothing secret-dependent is revealed by it.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Lemon Squeezy webhook delivery. This is the entire security boundary
 * of the billing feature: `POST /api/billing/webhook` has no session, no API
 * token, nothing else standing between the public internet and writing to
 * `accounts.plan`. Must be called — and must pass — before a single field of
 * the body is parsed or trusted.
 *
 * Takes the exact raw bytes Lemon Squeezy sent (not a re-serialized JSON.parse
 * of them): HMACs are computed over byte strings, and re-encoding JSON is not
 * guaranteed to reproduce the original bytes (key order, whitespace, unicode
 * escaping), which would make a genuine, unmodified delivery fail verification.
 */
export async function verifyWebhook(
  secret: string | undefined,
  rawBody: string,
  signatureHeader: string | null | undefined
): Promise<boolean> {
  if (!secret || !signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return timingSafeEqual(hex(mac), signatureHeader.trim().toLowerCase());
}

// --- plan <-> variant mapping ---------------------------------------------------

/**
 * The plan a Lemon Squeezy variant id corresponds to, or null for anything not
 * explicitly configured. Deliberately narrow: an id that doesn't match either
 * configured variant is unknown, not a default — a webhook must never be able
 * to grant a plan just by naming a variant nobody configured as `pro`/`team`.
 */
export function planForVariant(env: Env, variantId: unknown): PaidPlan | "free" | null {
  if (variantId === null || variantId === undefined) return null;
  const id = String(variantId).trim();
  if (!id) return null;
  if (env.LEMONSQUEEZY_VARIANT_PRO && id === env.LEMONSQUEEZY_VARIANT_PRO) return "pro";
  if (env.LEMONSQUEEZY_VARIANT_TEAM && id === env.LEMONSQUEEZY_VARIANT_TEAM) return "team";
  // The store also sells a free "starter" variant. It must map explicitly:
  // returning null for it would mean a downgrade webhook writes no plan at all,
  // and the customer keeps the paid plan they just left. Still `null` for any
  // variant nobody configured — an unknown id must never grant anything.
  if (env.LEMONSQUEEZY_VARIANT_FREE && id === env.LEMONSQUEEZY_VARIANT_FREE) return "free";
  return null;
}

/**
 * What an account is entitled to, given a subscription's status and the plan
 * its variant maps to. `null` means "change nothing".
 *
 * Two of these are the difference between a correct billing system and an
 * annoying one:
 *
 *  - **cancelled** does NOT revoke. In Lemon Squeezy, cancelling means "do not
 *    renew"; the subscription stays live until `ends_at`, and
 *    `subscription_expired` arrives then. Dropping somebody to free the moment
 *    they cancel takes away time they have already paid for.
 *  - **past_due** does not revoke either, so dunning can run. Lemon Squeezy
 *    moves the subscription to `unpaid` or `expired` if it never recovers, and
 *    those do revoke.
 *
 * An unrecognized variant yields `null` regardless of status: an active
 * subscription to something nobody configured must never grant a plan.
 */
/** The status an event name implies, for a payload that carries none. */
function impliedStatus(eventName: string): string {
  if (eventName === "subscription_expired") return "expired";
  if (eventName === "subscription_cancelled") return "cancelled";
  if (eventName === "subscription_paused") return "paused";
  if (eventName === "subscription_payment_failed") return "past_due";
  return "active";
}

export function entitlementFor(
  status: string,
  variantPlan: PaidPlan | "free" | null
): PaidPlan | "free" | null {
  switch (status) {
    case "paused":
    case "unpaid":
    case "expired":
      return "free";
    case "cancelled":
    case "past_due":
      return null;
    case "active":
    case "on_trial":
      return variantPlan;
    default:
      // An unfamiliar status is not a reason to change what somebody has.
      return variantPlan === "free" ? "free" : null;
  }
}

// --- checkout ---------------------------------------------------------------

/**
 * A hosted Lemon Squeezy checkout URL for `plan`, prefilled with `email` and
 * carrying `account.id` as checkout custom data so the webhook can attribute
 * the resulting subscription back to this account (see `processWebhookEvent`).
 *
 * `checkout[custom][account_id]` is the documented query-param form for a
 * hosted "buy" link (`/checkout/buy/<variant>`) — the JSON API's checkout
 * endpoint instead nests this under a top-level `checkout_data.custom` object,
 * which is a different surface. Since this builds a plain link rather than
 * calling the Checkouts API, the query-param form is the correct one.
 *
 * Returns null when this deployment has no store/variant configured for
 * `plan`, so a caller can show "billing not available" instead of a broken link.
 */
export function checkoutUrl(
  env: Env,
  plan: PaidPlan,
  account: { id: string },
  email: string
): string | null {
  const store = env.LEMONSQUEEZY_STORE_ID;
  const variantId = plan === "pro" ? env.LEMONSQUEEZY_VARIANT_PRO : env.LEMONSQUEEZY_VARIANT_TEAM;
  if (!store || !variantId) return null;

  const url = new URL(`https://${store}.lemonsqueezy.com/checkout/buy/${encodeURIComponent(variantId)}`);
  url.searchParams.set("checkout[email]", email);
  url.searchParams.set("checkout[custom][account_id]", account.id);
  return url.toString();
}

// --- webhook processing ------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isUniqueViolation(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /unique constraint/i.test(message);
}

/**
 * The id a processed delivery is recorded under.
 *
 * Lemon Squeezy's webhook payload carries no documented, stable per-delivery
 * id (no `X-Event-Id` header, no `meta.event_id` field) — only `X-Event-Name`
 * and a resource id under `data.id` that stays constant across every event for
 * the same subscription, so it cannot serve as a per-*delivery* key on its
 * own. A SHA-256 of the raw body sidesteps needing one: a retried delivery of
 * the *same* event resends byte-identical JSON (same digest, correctly a
 * no-op), while any genuinely new event — even for the same subscription,
 * e.g. upgrade then cancel — has different attributes and therefore a
 * different digest (correctly processed).
 */
export async function webhookEventId(rawBody: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody));
  return hex(digest);
}

export interface WebhookOutcome {
  ok: true;
  /** True when this exact delivery (by body digest) was already processed. */
  duplicate?: boolean;
  /** True for an event type this webhook doesn't act on (e.g. order_created). */
  ignored?: boolean;
  accountId?: string | null;
  /** The plan this delivery wrote to `accounts.plan` — what billing now says. */
  plan?: PaidPlan | "free" | null;
  /**
   * True when an operator plan override was in force, so this delivery changed
   * what the account is *billed* for without changing what it is *entitled* to.
   * See the note on `processWebhookEvent`.
   */
  overridden?: boolean;
  /** What the account is actually entitled to after this delivery. */
  effectivePlan?: string;
}

/**
 * Reconcile `accounts.plan` from one verified, parsed webhook payload.
 *
 * Never trusts a `plan` field from the body — there isn't one to trust; the
 * plan is always re-derived from the verified `data.attributes.variant_id`
 * (created/updated) or hard-coded to `free` (cancelled/expired). This is what
 * keeps a webhook from being able to grant a plan nobody actually paid for,
 * even if Lemon Squeezy's payload shape changed to include a stray plan-like
 * field some day.
 *
 * ## Operator overrides
 *
 * This writes `accounts.plan` and nothing else, so it cannot clobber an
 * operator's comp — `plan_override` is a different column, and `effectivePlan`
 * (src/accounts.ts) prefers it while it is live. That is a structural property,
 * not a check somebody has to remember to write: there is no code path here
 * that touches an override, because the override is not in the statement.
 *
 * The plan column is still updated under a live override, deliberately. It is
 * the record of what the customer is actually paying for, and the operator
 * needs that to stay true — otherwise removing an override would drop the
 * account onto whatever plan it happened to hold when the override was applied,
 * rather than onto the subscription it has been paying for all along. What the
 * webhook does instead is leave a trail: an audit row (see src/audit.ts) saying
 * that billing moved underneath an override, so the change is visible on the
 * account's page rather than only in Lemon Squeezy.
 *
 * Idempotent: a row is inserted into `billing_events` keyed by the body's
 * digest (see `webhookEventId`) after (not before) the plan write, so a crash
 * between the two leaves a delivery that will simply be retried and reapplied
 * — reapplying the same plan is harmless — rather than one that is marked
 * done but was never actually applied. The one race this doesn't fully close
 * — two literally concurrent deliveries of the same event — is closed by the
 * `billing_events` primary key: the loser's INSERT fails with a unique-
 * constraint error, which is treated as "already recorded", not a 500 (a 500
 * here would make Lemon Squeezy retry a delivery that, in fact, fully
 * succeeded).
 */
export async function processWebhookEvent(
  env: Env,
  rawBody: string,
  payload: unknown,
  now: string
): Promise<WebhookOutcome> {
  const id = await webhookEventId(rawBody);

  const already = await env.DB.prepare("SELECT id FROM billing_events WHERE id = ?").bind(id).first();
  if (already) return { ok: true, duplicate: true };

  const meta = isRecord(payload) && isRecord(payload.meta) ? payload.meta : null;
  const eventName = meta && typeof meta.event_name === "string" ? meta.event_name : null;
  const customData = meta && isRecord(meta.custom_data) ? meta.custom_data : null;
  const accountId =
    customData && typeof customData.account_id === "string" && customData.account_id
      ? customData.account_id
      : null;

  if (!eventName || !SUBSCRIPTION_EVENT.test(eventName)) {
    // Nothing here changes accounts.plan, so there is nothing that needs to
    // survive a replay — no billing_events row is spent on it.
    return { ok: true, ignored: true };
  }

  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  const attributes = data && isRecord(data.attributes) ? data.attributes : null;
  // Real deliveries always carry a status; this fallback is for a malformed or
  // truncated one, where the event name still says plainly what happened. It
  // must not be the primary path — status is authoritative because an
  // `updated` event can describe a subscription that has already expired.
  const status =
    typeof attributes?.status === "string" && attributes.status
      ? attributes.status
      : impliedStatus(eventName);
  const plan = entitlementFor(status, planForVariant(env, attributes?.variant_id));

  const account = accountId ? await getAccount(env, accountId) : null;
  let overridden = false;
  let effective: string | undefined;
  if (accountId && plan && account) {
    overridden = overrideActive(account, now);
    await env.DB.prepare("UPDATE accounts SET plan = ?, updated_at = ? WHERE id = ?")
      .bind(plan, now, accountId)
      .run();
    // The monthly-view cache holds this account's effective plan; the row it
    // was derived from just changed. Cheap, and it means a genuine upgrade
    // takes effect on the next request instead of within the minute.
    invalidateAccountStatus(accountId);
    effective = effectivePlan({ ...account, plan }, now);
    if (overridden) {
      // Best-effort by design (see `recordAudit`): this is an observation, and
      // failing to record it must never turn into a non-200 that makes Lemon
      // Squeezy retry a delivery which in fact fully succeeded.
      await recordAudit(env, {
        actor: SYSTEM_ACTOR,
        action: "billing.plan_change_under_override",
        targetType: "account",
        targetId: accountId,
        summary:
          `Billing moved ${account.name} to ${plan}, but an operator override keeps it on ` +
          `${effective} — remove the override to hand the account back to billing`,
        detail: {
          account_name: account.name,
          event: eventName,
          billed_plan_before: account.plan,
          billed_plan_after: plan,
          effective_plan: effective,
          override_expires_at: account.plan_override_expires_at ?? null,
        },
        now,
      });
    }
  }

  try {
    await env.DB.prepare(
      "INSERT INTO billing_events (id, event_name, account_id, processed_at) VALUES (?, ?, ?, ?)"
    )
      .bind(id, eventName, accountId, now)
      .run();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }

  return { ok: true, accountId, plan, overridden, ...(effective ? { effectivePlan: effective } : {}) };
}
