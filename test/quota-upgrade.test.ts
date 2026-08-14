import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { ensurePersonalAccount } from "../src/accounts";
import { upsertArtifact } from "../src/db";
import { PLANS } from "../src/quota";
import { as, clearR2, htmlForm, initDb } from "./fixtures";

/**
 * The conversion moment (issue: free-to-paid path, §3): what `quota_exceeded`
 * actually says once a publish is refused. test/quota.test.ts already pins
 * the boundary behavior and the base `detail` substrings this must not break;
 * this file covers the new `upgrade` field — which plan, what it costs, what
 * it grants, and the real checkout link (never hand-built).
 */

const ALICE = "alice@test.com";
const html = new TextEncoder().encode("<h1>hi</h1>");

beforeEach(async () => {
  await initDb();
  await clearR2();
});

async function seedArtifactCount(accountId: string, n: number) {
  const now = new Date().toISOString();
  for (let i = 0; i < n; i++) {
    const slug = `seed-${i}`;
    await upsertArtifact(env as any, {
      slug,
      title: slug,
      description: null,
      type: "single",
      entry: "index.html",
      file_count: 1,
      size_bytes: 10,
      created_by: ALICE,
      created_at: now,
      updated_at: now,
      visibility: "restricted",
      current_version: 1,
      owner_email: ALICE,
      account_id: accountId,
    });
    await env.DB.prepare(
      `INSERT INTO artifact_versions (slug, version, type, entry, file_count, size_bytes, note, created_by, created_at)
       VALUES (?, 1, 'single', 'index.html', 1, 10, NULL, ?, ?)`
    )
      .bind(slug, ALICE, now)
      .run();
  }
}

interface QuotaBody {
  error: string;
  limit: string;
  detail: string;
  upgrade: { plan: string; label: string; price: string; url: string | null } | null;
}

describe("quota_exceeded names the next plan and what it grants", () => {
  it("offers Pro, with its real numbers, when a free workspace hits the artifact cap", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");
    await seedArtifactCount(account.id, PLANS.free.maxArtifacts);

    const res = await app.request(
      "/api/artifacts",
      as(ALICE, { method: "POST", body: htmlForm({ title: "one too many", slug: "one-too-many" }, "index.html", html) }),
      env as any
    );
    expect(res.status).toBe(413);
    const body = await res.json<QuotaBody>();
    expect(body.upgrade).not.toBeNull();
    expect(body.upgrade!.plan).toBe("pro");
    expect(body.upgrade!.label).toBe("Pro");
    expect(body.upgrade!.price).toBe("$12/mo");
    expect(body.detail).toMatch(/upgrade to Pro/);
    expect(body.detail).toContain(String(PLANS.pro.maxArtifacts));
    // No LEMONSQUEEZY_* configured in this test environment.
    expect(body.upgrade!.url).toBeNull();
  });

  it("builds a real checkout URL for the offered plan when a store is configured — never hand-rolled", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");
    await seedArtifactCount(account.id, PLANS.free.maxArtifacts);

    const configured = {
      ...(env as any),
      LEMONSQUEEZY_STORE_ID: "test-store",
      LEMONSQUEEZY_VARIANT_PRO: "variant-pro",
      LEMONSQUEEZY_VARIANT_TEAM: "variant-team",
    };
    const res = await app.request(
      "/api/artifacts",
      as(ALICE, { method: "POST", body: htmlForm({ title: "one too many", slug: "one-too-many" }, "index.html", html) }),
      configured
    );
    expect(res.status).toBe(413);
    const body = await res.json<QuotaBody>();
    expect(body.upgrade!.url).toContain("test-store.lemonsqueezy.com");
    expect(body.upgrade!.url).toContain("variant-pro");
    expect(body.upgrade!.url).toContain(account.id);
    expect(body.upgrade!.url).toContain(encodeURIComponent(ALICE));
  });

  it("offers Team, with its real numbers, when a pro workspace hits the storage cap", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(account.id).run();
    const now = new Date().toISOString();
    await upsertArtifact(env as any, {
      slug: "big",
      title: "big",
      description: null,
      type: "single",
      entry: "index.html",
      file_count: 1,
      size_bytes: PLANS.pro.maxStorageBytes,
      created_by: ALICE,
      created_at: now,
      updated_at: now,
      visibility: "restricted",
      current_version: 1,
      owner_email: ALICE,
      account_id: account.id,
    });
    await env.DB.prepare(
      `INSERT INTO artifact_versions (slug, version, type, entry, file_count, size_bytes, note, created_by, created_at)
       VALUES ('big', 1, 'single', 'index.html', 1, ?, NULL, ?, ?)`
    )
      .bind(PLANS.pro.maxStorageBytes, ALICE, now)
      .run();

    const res = await app.request(
      "/api/artifacts",
      as(ALICE, { method: "POST", body: htmlForm({ title: "tips it over", slug: "tips-over" }, "index.html", html) }),
      env as any
    );
    expect(res.status).toBe(413);
    const body = await res.json<QuotaBody>();
    expect(body.upgrade!.plan).toBe("team");
    expect(body.upgrade!.label).toBe("Team");
    expect(body.detail).toMatch(/upgrade to Team/);
  });

  it("offers no upgrade for a team workspace that hits its own cap — there is nowhere left to go", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");
    await env.DB.prepare("UPDATE accounts SET plan = 'team' WHERE id = ?").bind(account.id).run();
    // Storage, not the 10,000-artifact cap: cheaper to seed (one row) and it
    // exercises the same "nowhere left to upgrade to" branch either way.
    const now = new Date().toISOString();
    await upsertArtifact(env as any, {
      slug: "big",
      title: "big",
      description: null,
      type: "single",
      entry: "index.html",
      file_count: 1,
      size_bytes: PLANS.team.maxStorageBytes,
      created_by: ALICE,
      created_at: now,
      updated_at: now,
      visibility: "restricted",
      current_version: 1,
      owner_email: ALICE,
      account_id: account.id,
    });
    await env.DB.prepare(
      `INSERT INTO artifact_versions (slug, version, type, entry, file_count, size_bytes, note, created_by, created_at)
       VALUES ('big', 1, 'single', 'index.html', 1, ?, NULL, ?, ?)`
    )
      .bind(PLANS.team.maxStorageBytes, ALICE, now)
      .run();

    const res = await app.request(
      "/api/artifacts",
      as(ALICE, { method: "POST", body: htmlForm({ title: "tips it over", slug: "tips-over" }, "index.html", html) }),
      env as any
    );
    expect(res.status).toBe(413);
    const body = await res.json<QuotaBody>();
    expect(body.upgrade).toBeNull();
    expect(body.detail).not.toMatch(/upgrade/i);
  });
});
