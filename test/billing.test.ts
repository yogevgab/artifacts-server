import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { billingRoutes } from "../src/billing-routes";
import app from "../src/index";
import { createAccount } from "../src/accounts";
import { verifyWebhook, planForVariant, checkoutUrl, processWebhookEvent } from "../src/billing";
import { initDb, clearR2 } from "./fixtures";

const SECRET = "whsec_test_lemonsqueezy_secret";
const STORE = "rtfx-store";
const VARIANT_PRO = "1001";
const VARIANT_TEAM = "2002";
const AT = "2026-08-14T12:00:00.000Z";

function billingEnv(extra: Record<string, unknown> = {}) {
  return {
    ...(env as any),
    LEMONSQUEEZY_WEBHOOK_SECRET: SECRET,
    LEMONSQUEEZY_STORE_ID: STORE,
    LEMONSQUEEZY_VARIANT_PRO: VARIANT_PRO,
    LEMONSQUEEZY_VARIANT_TEAM: VARIANT_TEAM,
    ...extra,
  };
}

/** Sign a body exactly the way Lemon Squeezy does: hex HMAC-SHA256 of the raw bytes. */
async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function subscriptionPayload(opts: {
  eventName: string;
  accountId?: string | null;
  variantId?: string | number | null;
  subscriptionId?: string;
}): string {
  return JSON.stringify({
    meta: {
      event_name: opts.eventName,
      ...(opts.accountId !== undefined && opts.accountId !== null
        ? { custom_data: { account_id: opts.accountId } }
        : {}),
    },
    data: {
      type: "subscriptions",
      id: opts.subscriptionId ?? "sub_1",
      attributes: {
        store_id: 1,
        variant_id: opts.variantId ?? null,
        status: "active",
      },
    },
  });
}

async function post(body: string, headers: Record<string, string> = {}, e = billingEnv()) {
  return billingRoutes.request(
    "https://rtfx.pro/api/billing/webhook",
    { method: "POST", body, headers: { "Content-Type": "application/json", ...headers } },
    e
  );
}

beforeEach(async () => {
  await initDb();
  await clearR2();
});

describe("verifyWebhook", () => {
  it("accepts a correctly signed body", async () => {
    const body = subscriptionPayload({ eventName: "subscription_created" });
    expect(await verifyWebhook(SECRET, body, await sign(SECRET, body))).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const body = subscriptionPayload({ eventName: "subscription_created" });
    const signature = await sign(SECRET, body);
    const tampered = body.replace("subscription_created", "subscription_expired");
    expect(await verifyWebhook(SECRET, tampered, signature)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const body = subscriptionPayload({ eventName: "subscription_created" });
    expect(await verifyWebhook(SECRET, body, await sign("some-other-secret", body))).toBe(false);
  });

  it("rejects a missing signature", async () => {
    const body = subscriptionPayload({ eventName: "subscription_created" });
    expect(await verifyWebhook(SECRET, body, undefined)).toBe(false);
    expect(await verifyWebhook(SECRET, body, null)).toBe(false);
    expect(await verifyWebhook(SECRET, body, "")).toBe(false);
  });

  it("rejects everything when no secret is configured", async () => {
    const body = subscriptionPayload({ eventName: "subscription_created" });
    expect(await verifyWebhook(undefined, body, await sign(SECRET, body))).toBe(false);
  });
});

describe("planForVariant", () => {
  it("maps the configured pro and team variants", () => {
    const e = billingEnv();
    expect(planForVariant(e, VARIANT_PRO)).toBe("pro");
    expect(planForVariant(e, VARIANT_TEAM)).toBe("team");
    expect(planForVariant(e, Number(VARIANT_PRO))).toBe("pro");
  });

  it("does not default an unknown variant to a paid plan", () => {
    expect(planForVariant(billingEnv(), "99999999")).toBeNull();
    expect(planForVariant(billingEnv(), null)).toBeNull();
    expect(planForVariant(billingEnv(), undefined)).toBeNull();
  });
});

describe("checkoutUrl", () => {
  it("builds a hosted checkout URL prefilled with email and the account id", () => {
    const url = checkoutUrl(billingEnv(), "pro", { id: "acct_abc123" }, "buyer@example.com");
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.hostname).toBe(`${STORE}.lemonsqueezy.com`);
    expect(parsed.pathname).toBe(`/checkout/buy/${VARIANT_PRO}`);
    expect(parsed.searchParams.get("checkout[email]")).toBe("buyer@example.com");
    expect(parsed.searchParams.get("checkout[custom][account_id]")).toBe("acct_abc123");
  });

  it("returns null when the store or variant is not configured", () => {
    expect(checkoutUrl(billingEnv({ LEMONSQUEEZY_STORE_ID: undefined }), "pro", { id: "a" }, "x@x.com")).toBeNull();
    expect(checkoutUrl(billingEnv({ LEMONSQUEEZY_VARIANT_TEAM: undefined }), "team", { id: "a" }, "x@x.com")).toBeNull();
  });
});

describe("POST /api/billing/webhook", () => {
  async function account(plan = "free") {
    const a = await createAccount(env as any, {
      name: "Acme",
      kind: "team",
      personalEmail: null,
      createdBy: "owner@acme.com",
      now: AT,
    });
    if (plan !== "free") {
      await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, a.id).run();
    }
    return a;
  }

  it("is reachable with no authentication at all — signature is the only gate", async () => {
    const acct = await account();
    const body = subscriptionPayload({ eventName: "subscription_created", accountId: acct.id, variantId: VARIANT_PRO });
    // Deliberately no Cookie, no Authorization header.
    const res = await post(body, { "X-Signature": await sign(SECRET, body) });
    expect(res.status).toBe(200);
  });

  it("accepts a validly signed delivery", async () => {
    const acct = await account();
    const body = subscriptionPayload({ eventName: "subscription_created", accountId: acct.id, variantId: VARIANT_PRO });
    const res = await post(body, { "X-Signature": await sign(SECRET, body) });
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ ok: true, plan: "pro" });
  });

  it("rejects a tampered body even with a signature attached", async () => {
    const acct = await account();
    const body = subscriptionPayload({ eventName: "subscription_created", accountId: acct.id, variantId: VARIANT_PRO });
    const signature = await sign(SECRET, body);
    const tampered = body.replace(VARIANT_PRO, VARIANT_TEAM);
    const res = await post(tampered, { "X-Signature": signature });
    expect(res.status).toBe(401);
    expect((await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(acct.id).first<any>())!.plan).toBe(
      "free"
    );
  });

  it("rejects a signature produced with the wrong secret", async () => {
    const body = subscriptionPayload({ eventName: "subscription_created" });
    const res = await post(body, { "X-Signature": await sign("wrong-secret", body) });
    expect(res.status).toBe(401);
  });

  it("rejects a request with no signature header", async () => {
    const body = subscriptionPayload({ eventName: "subscription_created" });
    const res = await post(body);
    expect(res.status).toBe(401);
  });

  it("refuses every request when the webhook secret is not configured", async () => {
    const body = subscriptionPayload({ eventName: "subscription_created" });
    const res = await post(body, { "X-Signature": await sign(SECRET, body) }, billingEnv({ LEMONSQUEEZY_WEBHOOK_SECRET: undefined }));
    expect(res.status).toBe(503);
  });

  it("subscription_created sets the plan from the verified variant, never from the body's say-so", async () => {
    const acct = await account();
    const body = subscriptionPayload({ eventName: "subscription_created", accountId: acct.id, variantId: VARIANT_TEAM });
    await post(body, { "X-Signature": await sign(SECRET, body) });
    const row = await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(acct.id).first<any>();
    expect(row.plan).toBe("team");
  });

  it("subscription_updated re-syncs the plan (e.g. pro -> team upgrade)", async () => {
    const acct = await account("pro");
    const body = subscriptionPayload({ eventName: "subscription_updated", accountId: acct.id, variantId: VARIANT_TEAM });
    await post(body, { "X-Signature": await sign(SECRET, body) });
    const row = await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(acct.id).first<any>();
    expect(row.plan).toBe("team");
  });

  it("an unknown variant id is ignored rather than granting a paid plan", async () => {
    const acct = await account();
    const body = subscriptionPayload({ eventName: "subscription_created", accountId: acct.id, variantId: "not-a-configured-variant" });
    const res = await post(body, { "X-Signature": await sign(SECRET, body) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).plan).toBeNull();
    const row = await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(acct.id).first<any>();
    expect(row.plan).toBe("free");
  });

  it("subscription_cancelled returns the account to free", async () => {
    const acct = await account("pro");
    const body = subscriptionPayload({ eventName: "subscription_cancelled", accountId: acct.id, variantId: VARIANT_PRO });
    const res = await post(body, { "X-Signature": await sign(SECRET, body) });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(acct.id).first<any>();
    expect(row.plan).toBe("free");
  });

  it("subscription_expired returns the account to free", async () => {
    const acct = await account("team");
    const body = subscriptionPayload({ eventName: "subscription_expired", accountId: acct.id, variantId: VARIANT_TEAM });
    await post(body, { "X-Signature": await sign(SECRET, body) });
    const row = await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(acct.id).first<any>();
    expect(row.plan).toBe("free");
  });

  it("ignores an event type it does not act on, without erroring", async () => {
    const body = subscriptionPayload({ eventName: "order_created" });
    const res = await post(body, { "X-Signature": await sign(SECRET, body) });
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ ok: true, ignored: true });
  });

  it("a replayed delivery (same signed body twice) is a no-op the second time", async () => {
    const acct = await account();
    const body = subscriptionPayload({ eventName: "subscription_created", accountId: acct.id, variantId: VARIANT_PRO });
    const signature = await sign(SECRET, body);

    const first = await post(body, { "X-Signature": signature });
    expect(first.status).toBe(200);
    expect(((await first.json()) as any).duplicate).toBeFalsy();

    const second = await post(body, { "X-Signature": signature });
    expect(second.status).toBe(200);
    expect(((await second.json()) as any).duplicate).toBe(true);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM billing_events").first<any>();
    expect(count.n).toBe(1);
  });

  it("a replay cannot un-cancel a subscription that moved on since", async () => {
    // Regression shape: process created (-> pro), then cancelled (-> free), then
    // replay the *original* created delivery. It must still be a no-op — the
    // replay is keyed by its own body digest, already recorded — not a second
    // application that would silently resurrect the paid plan.
    const acct = await account();
    const createdBody = subscriptionPayload({ eventName: "subscription_created", accountId: acct.id, variantId: VARIANT_PRO });
    const createdSig = await sign(SECRET, createdBody);
    await post(createdBody, { "X-Signature": createdSig });

    const cancelledBody = subscriptionPayload({ eventName: "subscription_cancelled", accountId: acct.id, variantId: VARIANT_PRO });
    await post(cancelledBody, { "X-Signature": await sign(SECRET, cancelledBody) });

    await post(createdBody, { "X-Signature": createdSig });

    const row = await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(acct.id).first<any>();
    expect(row.plan).toBe("free");
  });

  it("still records the delivery (so it isn't retried forever) when the account id cannot be resolved", async () => {
    const body = subscriptionPayload({ eventName: "subscription_created", accountId: null, variantId: VARIANT_PRO });
    const res = await post(body, { "X-Signature": await sign(SECRET, body) });
    expect(res.status).toBe(200);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM billing_events").first<any>();
    expect(count.n).toBe(1);
  });
});

describe("processWebhookEvent (unit level, bypassing signing)", () => {
  it("is a pure reconciliation once a payload is verified and parsed", async () => {
    const acct = await createAccount(env as any, {
      name: "Direct",
      kind: "team",
      personalEmail: null,
      createdBy: "owner@direct.com",
      now: AT,
    });
    const e = billingEnv();
    const body = subscriptionPayload({ eventName: "subscription_created", accountId: acct.id, variantId: VARIANT_PRO });
    const outcome = await processWebhookEvent(e as any, body, JSON.parse(body), AT);
    expect(outcome).toMatchObject({ ok: true, accountId: acct.id, plan: "pro" });
  });
});

describe("the webhook is actually reachable in the app", () => {
  /**
   * The route lived in its own module for a while without being mounted, which
   * every unit test would happily pass through. This asserts the wiring.
   */
  it("is mounted, and refuses an unsigned request rather than 404ing", async () => {
    const res = await app.request(
      "https://rtfx.pro/api/billing/webhook",
      { method: "POST", body: "{}" },
      // DEV_LOGIN must be off, or requireUser resolves an identity and the
      // request sails through the /api middleware that would reject it in
      // production. This test passed for that reason once already.
      { ...(env as any), DEV_LOGIN: undefined, LEMONSQUEEZY_WEBHOOK_SECRET: "s".repeat(32) }
    );
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(401);
  });

  it("is never served from the content host", async () => {
    const res = await app.request(
      "https://a.rtfx.pro/api/billing/webhook",
      { method: "POST", body: "{}" },
      { ...(env as any), CONTENT_HOSTNAMES: "a.rtfx.pro", LEMONSQUEEZY_WEBHOOK_SECRET: "s".repeat(32) }
    );
    expect(res.status).toBe(404);
  });
});

describe("downgrading to the free variant", () => {
  /**
   * The store has a free "starter" variant alongside the paid ones. Before this
   * was mapped, a subscription_updated naming it resolved to null, no plan was
   * written, and the customer silently kept the paid plan they had just left.
   */
  const freeEnv = (extra: Record<string, unknown> = {}) => ({
    ...(env as any),
    LEMONSQUEEZY_WEBHOOK_SECRET: SECRET,
    LEMONSQUEEZY_VARIANT_PRO: "2020319",
    LEMONSQUEEZY_VARIANT_TEAM: "2020323",
    LEMONSQUEEZY_VARIANT_FREE: "2020313",
    ...extra,
  });

  it("maps the free variant to the free plan, not to null", () => {
    expect(planForVariant(freeEnv(), "2020313")).toBe("free");
    expect(planForVariant(freeEnv(), "2020319")).toBe("pro");
    expect(planForVariant(freeEnv(), "2020323")).toBe("team");
  });

  it("still refuses a variant nobody configured", () => {
    expect(planForVariant(freeEnv(), "9999999")).toBeNull();
    expect(planForVariant(freeEnv(), "")).toBeNull();
  });

  it("actually moves a paid account back to free", async () => {
    const account = await createAccount(env as any, {
      name: "Downgrader",
      kind: "team",
      personalEmail: null,
      createdBy: "d@x.com",
      now: new Date().toISOString(),
    });
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(account!.id).run();

    const e = freeEnv();
    const body = JSON.stringify({
      meta: { event_name: "subscription_updated", custom_data: { account_id: account!.id } },
      data: { attributes: { variant_id: 2020313, status: "active" } },
    });
    const res = await billingRoutes.request(
      "/api/billing/webhook",
      { method: "POST", body, headers: { "X-Signature": await sign(SECRET, body) } },
      e
    );
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?")
      .bind(account!.id)
      .first<{ plan: string }>();
    expect(row?.plan).toBe("free");
  });
});
