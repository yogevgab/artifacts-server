import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { ensurePersonalAccount } from "../src/accounts";
import { upsertArtifact } from "../src/db";
import type { ArtifactRow } from "../src/env";
import { exceeds, limitsFor, usageFor, PLANS, type Usage } from "../src/quota";
import { as, clearR2, htmlForm, initDb, req } from "./fixtures";

const ALICE = "alice@test.com";
const html = new TextEncoder().encode("<h1>hi</h1>");

beforeEach(async () => {
  await initDb();
  await clearR2();
});

// --- pure policy: table-driven, no D1, no env ------------------------------

describe("limitsFor", () => {
  it("returns the free plan's limits", () => {
    expect(limitsFor("free")).toEqual(PLANS.free);
  });

  it("falls back to free for an unrecognized or missing plan value", () => {
    expect(limitsFor("nonexistent")).toEqual(PLANS.free);
    expect(limitsFor("")).toEqual(PLANS.free);
  });
});

describe("exceeds", () => {
  const limits = PLANS.free;
  const usage = (over: Partial<Usage>): Usage => ({ artifacts: 0, storageBytes: 0, ...over });

  describe.each([
    {
      name: "artifacts",
      just_under: usage({ artifacts: limits.maxArtifacts - 1 }),
      at: usage({ artifacts: limits.maxArtifacts }),
      just_over: usage({ artifacts: limits.maxArtifacts + 1 }),
      expected: "artifacts" as const,
    },
    {
      name: "storage",
      just_under: usage({ storageBytes: limits.maxStorageBytes - 1 }),
      at: usage({ storageBytes: limits.maxStorageBytes }),
      just_over: usage({ storageBytes: limits.maxStorageBytes + 1 }),
      expected: "storage" as const,
    },
  ])("$name boundary", ({ just_under, at, just_over, expected }) => {
    it("is not exceeded just under the limit", () => {
      expect(exceeds(just_under, limits)).toBeNull();
    });
    it("is not exceeded exactly at the limit", () => {
      expect(exceeds(at, limits)).toBeNull();
    });
    it("is exceeded just over the limit", () => {
      expect(exceeds(just_over, limits)).toBe(expected);
    });
  });

  it("reports artifacts before storage when both are exceeded", () => {
    expect(
      exceeds(
        { artifacts: limits.maxArtifacts + 1, storageBytes: limits.maxStorageBytes + 1 },
        limits
      )
    ).toBe("artifacts");
  });

  it("returns null for well within bounds usage", () => {
    expect(exceeds({ artifacts: 1, storageBytes: 1 }, limits)).toBeNull();
  });
});

// --- usageFor: real D1 aggregate -------------------------------------------

describe("usageFor", () => {
  /** Insert an artifact row plus N version rows (with given sizes) directly, bypassing R2/HTTP. */
  async function seedArtifact(
    slug: string,
    accountId: string,
    ownerEmail: string,
    versionSizes: number[]
  ) {
    const now = new Date().toISOString();
    const row: ArtifactRow = {
      slug,
      title: slug,
      description: null,
      type: "single",
      entry: "index.html",
      file_count: 1,
      size_bytes: versionSizes[versionSizes.length - 1] ?? 0,
      created_by: ownerEmail,
      created_at: now,
      updated_at: now,
      visibility: "restricted",
      current_version: versionSizes.length,
      owner_email: ownerEmail,
      account_id: accountId,
    };
    await upsertArtifact(env as any, row);
    for (let i = 0; i < versionSizes.length; i++) {
      await env.DB.prepare(
        `INSERT INTO artifact_versions (slug, version, type, entry, file_count, size_bytes, note, created_by, created_at)
         VALUES (?, ?, 'single', 'index.html', 1, ?, NULL, ?, ?)`
      )
        .bind(slug, i + 1, versionSizes[i], ownerEmail, now)
        .run();
    }
  }

  it("counts artifacts and sums every version's size, including superseded ones", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");

    // Republished twice: three versions, only the last is live, but all three
    // are immutable and count against storage (spec §8.3).
    await seedArtifact("a1", account.id, ALICE, [100, 200, 300]);
    await seedArtifact("a2", account.id, ALICE, [50]);

    const usage = await usageFor(env as any, account.id);
    expect(usage.artifacts).toBe(2);
    expect(usage.storageBytes).toBe(100 + 200 + 300 + 50);
  });

  it("scopes usage to the given account only", async () => {
    const now = new Date().toISOString();
    const aliceAccount = await ensurePersonalAccount(env as any, ALICE, now);
    const bobAccount = await ensurePersonalAccount(env as any, "bob@test.com", now);
    if (!aliceAccount || !bobAccount) throw new Error("expected personal accounts");

    await seedArtifact("a1", aliceAccount.id, ALICE, [100]);
    await seedArtifact("b1", bobAccount.id, "bob@test.com", [999]);

    expect(await usageFor(env as any, aliceAccount.id)).toEqual({ artifacts: 1, storageBytes: 100 });
    expect(await usageFor(env as any, bobAccount.id)).toEqual({ artifacts: 1, storageBytes: 999 });
  });

  it("returns zero usage for an account with nothing published", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");
    expect(await usageFor(env as any, account.id)).toEqual({ artifacts: 0, storageBytes: 0 });
  });
});

// --- enforcement at publish time --------------------------------------------

describe("publish quota enforcement", () => {
  /** Fill alice's account with N pre-existing artifacts, directly (fast — no HTTP round trips). */
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

  it("allows publishing a brand-new artifact exactly at the boundary (one under the cap)", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");
    await seedArtifactCount(account.id, PLANS.free.maxArtifacts - 1);

    const res = await req(
      "/api/artifacts",
      as(ALICE, { method: "POST", body: htmlForm({ title: "new one", slug: "new-one" }, "index.html", html) })
    );
    expect(res.status).toBe(200);
  });

  it("refuses a brand-new artifact once the account is at its artifact limit, before writing to R2", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");
    await seedArtifactCount(account.id, PLANS.free.maxArtifacts);

    const res = await req(
      "/api/artifacts",
      as(ALICE, { method: "POST", body: htmlForm({ title: "one too many", slug: "one-too-many" }, "index.html", html) })
    );
    expect(res.status).toBe(413);
    const body = await res.json<{ error: string; detail: string; limit: string }>();
    expect(body.error).toBe("quota_exceeded");
    expect(body.limit).toBe("artifacts");
    expect(body.detail).toMatch(/10-artifact limit/);

    // No partial state: neither the D1 row nor any R2 object exists for the refused slug.
    const row = await env.DB.prepare("SELECT 1 FROM artifacts WHERE slug = ?")
      .bind("one-too-many")
      .first();
    expect(row).toBeNull();
    const listed = await env.FILES.list({ prefix: "one-too-many/" });
    expect(listed.objects).toHaveLength(0);
  });

  it("still allows republishing an EXISTING artifact at the artifact-count limit (doesn't add a new slug)", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");
    // One of the seeded artifacts, plus enough others to reach the cap.
    await seedArtifactCount(account.id, PLANS.free.maxArtifacts);

    const res = await req(
      "/api/artifacts",
      as(ALICE, { method: "POST", body: htmlForm({ slug: "seed-0" }, "index.html", html) })
    );
    expect(res.status).toBe(200);
  });

  it("refuses when the account is at its storage limit, before writing to R2", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");
    const now = new Date().toISOString();
    // One existing artifact whose single version is exactly at the storage cap.
    await upsertArtifact(env as any, {
      slug: "big",
      title: "big",
      description: null,
      type: "single",
      entry: "index.html",
      file_count: 1,
      size_bytes: PLANS.free.maxStorageBytes,
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
      .bind(PLANS.free.maxStorageBytes, ALICE, now)
      .run();

    const res = await req(
      "/api/artifacts",
      as(ALICE, { method: "POST", body: htmlForm({ title: "tips it over", slug: "tips-over" }, "index.html", html) })
    );
    expect(res.status).toBe(413);
    const body = await res.json<{ error: string; detail: string; limit: string }>();
    expect(body.error).toBe("quota_exceeded");
    expect(body.limit).toBe("storage");
    expect(body.detail).toMatch(/storage limit/);

    // No partial state: no new artifact row, no new version row, no R2 object.
    const row = await env.DB.prepare("SELECT 1 FROM artifacts WHERE slug = ?").bind("tips-over").first();
    expect(row).toBeNull();
    const versions = await env.DB.prepare("SELECT COUNT(*) AS n FROM artifact_versions WHERE slug = 'big'").first<{
      n: number;
    }>();
    expect(versions?.n).toBe(1);
    const listed = await env.FILES.list({ prefix: "tips-over/" });
    expect(listed.objects).toHaveLength(0);
  });

  it("allows a publish that lands exactly at the storage boundary", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, new Date().toISOString());
    if (!account) throw new Error("expected a personal account");
    const now = new Date().toISOString();
    const room = PLANS.free.maxStorageBytes - html.byteLength;
    await upsertArtifact(env as any, {
      slug: "near-full",
      title: "near-full",
      description: null,
      type: "single",
      entry: "index.html",
      file_count: 1,
      size_bytes: room,
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
       VALUES ('near-full', 1, 'single', 'index.html', 1, ?, NULL, ?, ?)`
    )
      .bind(room, ALICE, now)
      .run();

    const res = await req(
      "/api/artifacts",
      as(ALICE, { method: "POST", body: htmlForm({ title: "fits exactly", slug: "fits-exactly" }, "index.html", html) })
    );
    expect(res.status).toBe(200);
  });
});
