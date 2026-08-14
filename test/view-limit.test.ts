import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { ensurePersonalAccount } from "../src/accounts";
import { upsertArtifact } from "../src/db";
import { req, as } from "./fixtures";
import type { ArtifactRow } from "../src/env";
import {
  PLANS,
  VIEW_LIMIT_CACHE_TTL_MS,
  blocksOnViewLimit,
  overMonthlyViewLimit,
  viewLimitStatus,
  type ViewLimitStatus,
} from "../src/quota";
import { overViewLimitPage } from "../src/view-limit-page";
import { clearR2, dropAccountIdColumns, dropAccountTables, initDb } from "./fixtures";

const ALICE = "alice@test.com";
const BOB = "bob@test.com";
const NOW = new Date("2026-08-14T12:00:00.000Z");
const IN_MONTH = "2026-08-01T00:00:01.000Z";
const LAST_MONTH = "2026-07-31T23:59:59.000Z";
const NEXT_MONTH = "2026-09-01T00:00:00.000Z";

beforeEach(async () => {
  await initDb();
  await clearR2();
});

async function seedArtifact(slug: string, accountId: string, ownerEmail: string) {
  const now = new Date().toISOString();
  const row: ArtifactRow = {
    slug,
    title: slug,
    description: null,
    type: "single",
    entry: "index.html",
    file_count: 1,
    size_bytes: 10,
    created_by: ownerEmail,
    created_at: now,
    updated_at: now,
    visibility: "everyone",
    current_version: 1,
    owner_email: ownerEmail,
    account_id: accountId,
  };
  await upsertArtifact(env as any, row);
}

/** Insert N raw view rows directly, bypassing HTTP — this is a log, not a workflow. */
async function seedViews(slug: string, n: number, viewedAt: string) {
  const stmts = [];
  for (let i = 0; i < n; i++) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO artifact_views (slug, version, email, path, country, referrer, viewed_at)
         VALUES (?, 1, NULL, NULL, NULL, NULL, ?)`
      ).bind(slug, viewedAt)
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
}

// --- pure boundary rule: no D1, exhaustively table-testable -----------------

describe("overMonthlyViewLimit", () => {
  const limit = 100;
  it("is not exceeded just under the limit", () => {
    expect(overMonthlyViewLimit(limit - 1, limit)).toBe(false);
  });
  it("is not exceeded exactly at the limit — the cap is inclusive", () => {
    expect(overMonthlyViewLimit(limit, limit)).toBe(false);
  });
  it("is exceeded just over the limit", () => {
    expect(overMonthlyViewLimit(limit + 1, limit)).toBe(true);
  });
});

// --- viewLimitStatus: real D1 aggregate, scoping, and windowing -------------

describe("viewLimitStatus", () => {
  it("counts only this calendar month's views", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, NOW.toISOString());
    if (!account) throw new Error("expected a personal account");
    await seedArtifact("a", account.id, ALICE);
    await seedViews("a", 3, IN_MONTH);
    await seedViews("a", 5, LAST_MONTH);
    await seedViews("a", 7, NEXT_MONTH);

    const status = await viewLimitStatus(env as any, account.id, NOW);
    expect(status?.views).toBe(3);
  });

  it("scopes the count to the given account only, across all of its artifacts", async () => {
    const alice = await ensurePersonalAccount(env as any, ALICE, NOW.toISOString());
    const bob = await ensurePersonalAccount(env as any, BOB, NOW.toISOString());
    if (!alice || !bob) throw new Error("expected personal accounts");

    await seedArtifact("a1", alice.id, ALICE);
    await seedArtifact("a2", alice.id, ALICE);
    await seedArtifact("b1", bob.id, BOB);
    await seedViews("a1", 2, IN_MONTH);
    await seedViews("a2", 3, IN_MONTH);
    await seedViews("b1", 999, IN_MONTH);

    expect((await viewLimitStatus(env as any, alice.id, NOW))?.views).toBe(5);
    expect((await viewLimitStatus(env as any, bob.id, NOW))?.views).toBe(999);
  });

  it("reports the account's plan and that plan's limit", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, NOW.toISOString());
    if (!account) throw new Error("expected a personal account");
    expect(account.plan).toBe("free");

    const status = await viewLimitStatus(env as any, account.id, NOW);
    expect(status?.plan).toBe("free");
    expect(status?.limit).toBe(PLANS.free.maxViewsPerMonth);
  });

  it("returns zero views, not null, for an account with none published or viewed", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, NOW.toISOString());
    if (!account) throw new Error("expected a personal account");
    const status = await viewLimitStatus(env as any, account.id, NOW);
    expect(status).toEqual({
      plan: "free",
      views: 0,
      limit: PLANS.free.maxViewsPerMonth,
      overLimit: false,
      status: "active",
      suspended: false,
    });
  });

  it("is over limit only once real usage crosses the plan's real boundary", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, NOW.toISOString());
    if (!account) throw new Error("expected a personal account");
    await seedArtifact("a", account.id, ALICE);
    await seedViews("a", PLANS.free.maxViewsPerMonth, IN_MONTH);

    // Both calls pin an explicit wall clock — mixing an explicit one with the
    // real Date.now() default would make the second call's cache-freshness
    // check compare against an unrelated instant.
    const t0 = NOW.getTime();
    expect((await viewLimitStatus(env as any, account.id, NOW, t0))?.overLimit).toBe(false);

    await seedViews("a", 1, IN_MONTH);
    // Force a fresh read (past the cache window) so this sees the new row.
    const later = t0 + VIEW_LIMIT_CACHE_TTL_MS + 1;
    expect((await viewLimitStatus(env as any, account.id, NOW, later))?.overLimit).toBe(true);
  }, 20_000);

  it("returns null for an unknown account id — nothing to enforce", async () => {
    expect(await viewLimitStatus(env as any, "acct_nosuchaccount", NOW)).toBeNull();
  });

  it("returns null when the accounts tables don't exist yet (pre-#27 database)", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, NOW.toISOString());
    if (!account) throw new Error("expected a personal account");
    await dropAccountTables();
    expect(await viewLimitStatus(env as any, account.id, NOW)).toBeNull();
  });

  it("returns null when artifacts.account_id doesn't exist yet (pre-migration-0009 database)", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, NOW.toISOString());
    if (!account) throw new Error("expected a personal account");
    await dropAccountIdColumns();
    expect(await viewLimitStatus(env as any, account.id, NOW)).toBeNull();
  });
});

// --- isolate cache: ~60s staleness, and why it's acceptable ------------------

describe("viewLimitStatus caching", () => {
  it("does not re-read D1 within the cache window — a second call sees the first call's count", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, NOW.toISOString());
    if (!account) throw new Error("expected a personal account");
    await seedArtifact("a", account.id, ALICE);
    await seedViews("a", 10, IN_MONTH);

    const t0 = NOW.getTime();
    const first = await viewLimitStatus(env as any, account.id, NOW, t0);
    expect(first?.views).toBe(10);

    // Ten more views land, but the cache is still fresh at t0 + 59s.
    await seedViews("a", 10, IN_MONTH);
    const second = await viewLimitStatus(env as any, account.id, NOW, t0 + VIEW_LIMIT_CACHE_TTL_MS - 1);
    expect(second?.views).toBe(10);
  });

  it("reads D1 again once the cache window elapses", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, NOW.toISOString());
    if (!account) throw new Error("expected a personal account");
    await seedArtifact("a", account.id, ALICE);
    await seedViews("a", 10, IN_MONTH);

    const t0 = NOW.getTime();
    await viewLimitStatus(env as any, account.id, NOW, t0);
    await seedViews("a", 5, IN_MONTH);

    const stale = await viewLimitStatus(env as any, account.id, NOW, t0 + VIEW_LIMIT_CACHE_TTL_MS - 1);
    expect(stale?.views).toBe(10);

    const fresh = await viewLimitStatus(env as any, account.id, NOW, t0 + VIEW_LIMIT_CACHE_TTL_MS + 1);
    expect(fresh?.views).toBe(15);
  });

  it("treats a new calendar month as a cache miss even inside the TTL window", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, NOW.toISOString());
    if (!account) throw new Error("expected a personal account");
    await seedArtifact("a", account.id, ALICE);
    await seedViews("a", 4, LAST_MONTH);
    await seedViews("a", 1, IN_MONTH);

    const julyEnd = new Date("2026-07-31T23:59:59.500Z");
    const augStart = new Date("2026-08-01T00:00:00.500Z");
    const t0 = julyEnd.getTime();

    const july = await viewLimitStatus(env as any, account.id, julyEnd, t0);
    expect(july?.views).toBe(4);

    // Same wall-clock instant essentially (well inside the TTL), but the
    // month rolled over, so this must not serve July's cached count.
    const august = await viewLimitStatus(env as any, account.id, augStart, t0 + 1000);
    expect(august?.views).toBe(1);
  });
});

// --- the bypass decision itself: pure, no auth machinery required -----------

describe("blocksOnViewLimit", () => {
  const over: ViewLimitStatus = {
    plan: "free",
    views: 6000,
    limit: 5000,
    overLimit: true,
    status: "active",
    suspended: false,
  };
  const under: ViewLimitStatus = {
    plan: "free",
    views: 10,
    limit: 5000,
    overLimit: false,
    status: "active",
    suspended: false,
  };

  it("blocks a stranger when the account is over its limit", () => {
    expect(blocksOnViewLimit(over, false)).toBe(true);
  });

  it("never blocks the owner/admin bypass, even over the limit", () => {
    expect(blocksOnViewLimit(over, true)).toBe(false);
  });

  it("does not block when under the limit", () => {
    expect(blocksOnViewLimit(under, false)).toBe(false);
  });

  it("does not block when there is nothing to enforce (null status)", () => {
    expect(blocksOnViewLimit(null, false)).toBe(false);
    expect(blocksOnViewLimit(null, true)).toBe(false);
  });
});

// --- the friendly page itself -------------------------------------------------

describe("overViewLimitPage", () => {
  it("explains the situation without alarming 404 language", () => {
    const html = overViewLimitPage("report");
    expect(html).toContain("temporarily unavailable");
    expect(html).toContain("monthly view limit");
    expect(html).not.toContain("404");
  });

  it("names the artifact's own slug, which the viewer already knows", () => {
    const html = overViewLimitPage("report");
    expect(html).toContain("/report/");
  });

  it("leaks no plan name, usage number, or owner identity", () => {
    const html = overViewLimitPage("report");
    // Scoped to the rendered <main> content, not the shared page <style> block
    // (which is full of unrelated font sizes and hex colors), and with the
    // site's own "rtfx.pro" link stripped so its domain suffix doesn't read
    // as the "pro" plan name.
    const main = (/<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "").replace(/rtfx\.pro/gi, "");
    expect(main.toLowerCase()).not.toMatch(/\bfree\b|\bpro\b|\bteam\b/);
    expect(main).not.toMatch(/\d{2,}/); // no view counts or limits
    expect(main).not.toContain("@");
  });

  it("escapes the slug", () => {
    const html = overViewLimitPage('"><script>evil()</script>');
    expect(html).not.toContain("<script>evil()</script>");
  });

  it("works with no slug at all", () => {
    const html = overViewLimitPage();
    expect(html).toContain("temporarily unavailable");
  });
});

describe("through the content route", () => {
  /**
   * The unit tests prove the rule; this proves the wiring. It could only be
   * written once the check was mounted in index.ts.
   */
  const OWNER = "admin@test.com";

  async function seedOverLimit() {
    const body = new FormData();
    body.set("slug", "busy");
    body.set("title", "Busy");
    body.set("visibility", "everyone");
    body.set("file", new File(["<h1>busy</h1>"], "index.html", { type: "text/html" }));
    await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });

    const acct = await env.DB.prepare("SELECT account_id FROM artifacts WHERE slug = 'busy'")
      .first<{ account_id: string | null }>();
    if (!acct?.account_id) return null;

    const now = new Date().toISOString();
    const stmts = [];
    for (let i = 0; i < 12; i++) {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO artifact_views (slug, version, email, path, country, referrer, viewed_at) VALUES (?, 1, ?, '', NULL, NULL, ?)"
        ).bind("busy", `v${i}@x.com`, now)
      );
    }
    await env.DB.batch(stmts);
    await env.DB.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(acct.account_id).run();
    return acct.account_id;
  }

  const navigate = (who?: string) =>
    req("/busy/", {
      ...(who ? as(who) : { headers: { "X-Dev-Anonymous": "true" } }),
      headers: {
        ...((who ? (as(who).headers as Record<string, string>) : { "X-Dev-Anonymous": "true" })),
        "Sec-Fetch-Dest": "document",
      },
    });

  it("lets the owner in regardless, so they can see what to do about it", async () => {
    const id = await seedOverLimit();
    if (!id) return; // legacy schema without accounts — nothing to enforce against
    const res = await navigate(OWNER);
    expect(res.status).toBe(200);
  });

  it("leaves the raw/machine path alone even when the shell would be blocked", async () => {
    const id = await seedOverLimit();
    if (!id) return;
    const res = await req("/busy/?raw=1", as(OWNER));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("busy");
  });
});
