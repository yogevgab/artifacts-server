import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { ensurePersonalAccount } from "../src/accounts";
import { PLANS, limitsFor, type Usage } from "../src/quota";
import {
  PLAN_LABEL,
  PLAN_PRICE,
  priceLabel,
  nextPaidPlan,
  usageWarning,
  workspaceBilling,
  planFeatures,
  ALL_PLANS,
} from "../src/plan-copy";
import { initDb, clearR2 } from "./fixtures";

const ALICE = "alice@test.com";

beforeEach(async () => {
  await initDb();
  await clearR2();
});

describe("priceLabel", () => {
  it("is 'Free' for the free plan", () => {
    expect(priceLabel("free")).toBe("Free");
  });

  it("shows the real PLAN_PRICE dollar amount for a paid plan", () => {
    expect(priceLabel("pro")).toBe(`$${PLAN_PRICE.pro}/mo`);
    expect(priceLabel("team")).toBe(`$${PLAN_PRICE.team}/mo`);
  });
});

describe("nextPaidPlan", () => {
  it("free upgrades to pro", () => {
    expect(nextPaidPlan("free")).toBe("pro");
  });

  it("pro upgrades to team", () => {
    expect(nextPaidPlan("pro")).toBe("team");
  });

  it("team has nowhere left to go", () => {
    expect(nextPaidPlan("team")).toBeNull();
  });

  it("treats an unrecognized or legacy plan value as free", () => {
    expect(nextPaidPlan("nonexistent")).toBe("pro");
    expect(nextPaidPlan("")).toBe("pro");
  });
});

describe("planFeatures / ALL_PLANS", () => {
  it("lists all three tiers in selling order", () => {
    expect(ALL_PLANS).toEqual(["free", "pro", "team"]);
  });

  it("carries the real limits from PLANS, never invented numbers", () => {
    for (const name of ALL_PLANS) {
      const f = planFeatures(name);
      expect(f.limits).toEqual(PLANS[name]);
      expect(f.label).toBe(PLAN_LABEL[name]);
    }
  });
});

describe("usageWarning", () => {
  const limits = PLANS.free; // 10 artifacts, 100MB

  it("is null well under both limits", () => {
    expect(usageWarning({ artifacts: 1, storageBytes: 1 }, limits)).toBeNull();
  });

  it("is null just under the 80% threshold", () => {
    const usage: Usage = { artifacts: 7, storageBytes: 0 }; // 70%
    expect(usageWarning(usage, limits)).toBeNull();
  });

  it("fires at exactly 80% artifacts", () => {
    const usage: Usage = { artifacts: 8, storageBytes: 0 }; // 80%
    const w = usageWarning(usage, limits);
    expect(w).not.toBeNull();
    expect(w!.limit).toBe("artifacts");
    expect(w!.ratio).toBeCloseTo(0.8);
  });

  it("fires at 80% storage", () => {
    const usage: Usage = { artifacts: 0, storageBytes: Math.ceil(limits.maxStorageBytes * 0.8) };
    const w = usageWarning(usage, limits);
    expect(w).not.toBeNull();
    expect(w!.limit).toBe("storage");
  });

  it("still fires once a limit is fully exceeded, not only near it", () => {
    const usage: Usage = { artifacts: limits.maxArtifacts + 5, storageBytes: 0 };
    expect(usageWarning(usage, limits)?.limit).toBe("artifacts");
  });

  it("reports artifacts before storage when both are near, like exceeds() does", () => {
    const usage: Usage = {
      artifacts: Math.ceil(limits.maxArtifacts * 0.9),
      storageBytes: Math.ceil(limits.maxStorageBytes * 0.9),
    };
    expect(usageWarning(usage, limits)?.limit).toBe("artifacts");
  });
});

describe("workspaceBilling", () => {
  it("reports the account's plan, real usage, and no checkout link when billing isn't configured", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");

    const billing = await workspaceBilling(env as any, account, ALICE);
    expect(billing.plan).toBe("free");
    expect(billing.limits).toEqual(limitsFor("free"));
    expect(billing.usage).toEqual({ artifacts: 0, storageBytes: 0 });
    expect(billing.warning).toBeNull();
    expect(billing.nextPlan).toBe("pro");
    // No LEMONSQUEEZY_* configured in the test environment by default.
    expect(billing.checkout.pro).toBeNull();
    expect(billing.checkout.team).toBeNull();
  });

  it("builds a real checkout link, carrying the account id and email, when a store is configured", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");

    const configured = {
      ...(env as any),
      LEMONSQUEEZY_STORE_ID: "test-store",
      LEMONSQUEEZY_VARIANT_PRO: "variant-pro",
      LEMONSQUEEZY_VARIANT_TEAM: "variant-team",
    };
    const billing = await workspaceBilling(configured, account, ALICE);
    expect(billing.checkout.pro).toContain("test-store.lemonsqueezy.com");
    expect(billing.checkout.pro).toContain("variant-pro");
    expect(billing.checkout.pro).toContain(encodeURIComponent(ALICE));
    expect(billing.checkout.pro).toContain(account.id);
    expect(billing.checkout.team).toContain("variant-team");
  });

  it("offers no next plan and no upgrade for a team-plan workspace, even when billing is configured", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");
    await env.DB.prepare("UPDATE accounts SET plan = 'team' WHERE id = ?").bind(account.id).run();

    const configured = {
      ...(env as any),
      LEMONSQUEEZY_STORE_ID: "test-store",
      LEMONSQUEEZY_VARIANT_PRO: "variant-pro",
      LEMONSQUEEZY_VARIANT_TEAM: "variant-team",
    };
    const billing = await workspaceBilling(configured, { id: account.id, plan: "team" }, ALICE);
    expect(billing.nextPlan).toBeNull();
    expect(billing.limits).toEqual(limitsFor("team"));
  });
});
