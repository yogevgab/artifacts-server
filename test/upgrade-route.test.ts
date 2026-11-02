import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { ensurePersonalAccount } from "../src/accounts";
import { createApiToken } from "../src/tokens";
import { UPGRADE_PRO_PATH, tierCta } from "../src/plan-copy";
import { as, clearR2, initDb, withToken } from "./fixtures";

/**
 * The public "Buy Pro" button (`/upgrade/pro`). A checkout has to be tied to a
 * workspace, so a signed-out visitor is sent through sign-up with this path as
 * `next`, and a signed-in owner below Pro is redirected straight to the hosted
 * checkout for their own workspace. Everything else lands on Billing — never on
 * a checkout prefilled with somebody's email.
 */

const ALICE = "alice@test.com";
const ANON = { headers: { "X-Dev-Anonymous": "true" } };
const HTML = { Accept: "text/html" };

const configured = () => ({
  ...(env as any),
  LEMONSQUEEZY_STORE_ID: "test-store",
  LEMONSQUEEZY_VARIANT_PRO: "variant-pro",
  LEMONSQUEEZY_VARIANT_TEAM: "variant-team",
  LEMONSQUEEZY_CHECKOUT_PRO: "slug-pro",
  LEMONSQUEEZY_CHECKOUT_TEAM: "slug-team",
});

const get = (path: string, init: RequestInit = {}, e: unknown = configured()) =>
  app.request(path, { ...init, redirect: "manual" }, e as any);

beforeEach(async () => {
  await initDb();
  await clearR2();
});

describe("Buy Pro CTA", () => {
  it("points at /upgrade/pro and says it is a purchase", () => {
    const cta = tierCta("pro");
    expect(cta.href).toBe(UPGRADE_PRO_PATH);
    expect(cta.kind).toBe("self-serve");
    expect(cta.label).toContain("Buy Pro");
    expect(cta.label).toContain("$12/mo");
  });

  it("is the primary button on the public /pro page", async () => {
    const body = await (await get("/pro", ANON)).text();
    expect(body).toContain(`href="${UPGRADE_PRO_PATH}" data-cta="pro-primary"`);
  });
});

describe("GET /upgrade/pro", () => {
  it("sends a signed-out visitor to sign up, coming back here afterwards", async () => {
    const res = await get(UPGRADE_PRO_PATH, { headers: { ...ANON.headers, ...HTML } });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/signup?next=%2Fupgrade%2Fpro");
  });

  it("redirects a signed-in owner on Free to the checkout for their own workspace", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");
    const res = await get(UPGRADE_PRO_PATH, as(ALICE, { headers: HTML }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const location = new URL(res.headers.get("Location")!);
    expect(location.hostname).toBe("test-store.lemonsqueezy.com");
    expect(location.pathname).toBe("/checkout/buy/slug-pro");
    expect(location.searchParams.get("enabled")).toBe("variant-pro");
    expect(location.searchParams.get("checkout[email]")).toBe(ALICE);
    expect(location.searchParams.get("checkout[custom][account_id]")).toBe(account.id);
  });

  it("sends somebody already on Pro to Billing instead of selling them Pro again", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(account.id).run();
    const res = await get(UPGRADE_PRO_PATH, as(ALICE, { headers: HTML }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/billing");
  });

  it("falls back to Billing when checkout is not configured on this deployment", async () => {
    await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    const res = await get(UPGRADE_PRO_PATH, as(ALICE, { headers: HTML }), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/billing");
  });

  it("never hands a bearer token a checkout prefilled with its owner's email", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");
    const { token } = await createApiToken(env as any, {
      name: "ci",
      ownerEmail: ALICE,
      accountId: account.id,
      isAdmin: false,
      scopes: ["read", "publish"],
      createdBy: ALICE,
      expiresAt: null,
      now: new Date().toISOString(),
    });
    const res = await get(UPGRADE_PRO_PATH, withToken(token, { headers: HTML }));
    const location = res.headers.get("Location") ?? "";
    expect(location).not.toContain("lemonsqueezy");
  });
});

describe("/signup?next=", () => {
  it("parks a same-origin destination and carries it on the sign-in link", async () => {
    const res = await get(`/signup?next=${encodeURIComponent(UPGRADE_PRO_PATH)}`, ANON);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(`rtfx_next=${encodeURIComponent(UPGRADE_PRO_PATH)}`);
    expect(cookie).toContain("HttpOnly");
    const body = await res.text();
    expect(body).toContain(`href="/login?next=${encodeURIComponent(UPGRADE_PRO_PATH)}"`);
  });

  it("refuses an off-site destination (no open redirect)", async () => {
    const res = await get(`/signup?next=${encodeURIComponent("https://evil.example/x")}`, ANON);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("rtfx_next=;");
    expect(cookie).toContain("Max-Age=0");
    expect(await res.text()).toContain('href="/login"');
  });

  it("sends somebody already signed in straight on to the destination", async () => {
    const res = await get(`/signup?next=${encodeURIComponent(UPGRADE_PRO_PATH)}`, as(ALICE));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(UPGRADE_PRO_PATH);
  });
});
