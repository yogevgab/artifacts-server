import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { PLANS, limitsFor, versionsToExpire } from "../src/quota";
import { initDb, clearR2, req, as } from "./fixtures";

const OWNER = "admin@test.com";

describe("plan tiers", () => {
  it("defines free, pro and team", () => {
    expect(Object.keys(PLANS).sort()).toEqual(["free", "pro", "team"]);
  });

  it("gives each paid tier strictly more than the one below", () => {
    const f = limitsFor("free"), p = limitsFor("pro"), t = limitsFor("team");
    expect(p.maxStorageBytes).toBeGreaterThan(f.maxStorageBytes);
    expect(t.maxStorageBytes).toBeGreaterThan(p.maxStorageBytes);
    expect(p.maxArtifacts).toBeGreaterThan(f.maxArtifacts);
    expect(t.maxArtifacts).toBeGreaterThan(p.maxArtifacts);
  });

  it("keeps full history on paid plans and a finite window on free", () => {
    expect(limitsFor("free").keepVersions).toBeGreaterThan(0);
    expect(limitsFor("pro").keepVersions).toBeNull();
    expect(limitsFor("team").keepVersions).toBeNull();
  });

  it("treats an unknown or legacy plan as free", () => {
    expect(limitsFor("enterprise-lol")).toEqual(limitsFor("free"));
    expect(limitsFor("")).toEqual(limitsFor("free"));
  });
});

/**
 * The retention window is the only thing that makes a storage cap mean what a
 * person expects. Versions are immutable and never deleted, so without it a
 * 100MB cap is a cap on LIFETIME PUBLISHES: republish a 5MB page twenty times
 * and the account is full with one artifact live.
 */
describe("versionsToExpire", () => {
  const versions = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

  it("keeps the newest N and expires the rest", () => {
    expect(versionsToExpire(versions, 5, 10)).toEqual([5, 4, 3, 2, 1]);
  });

  it("expires nothing when history is unlimited", () => {
    expect(versionsToExpire(versions, null, 10)).toEqual([]);
  });

  it("expires nothing when there are fewer versions than the window", () => {
    expect(versionsToExpire([3, 2, 1], 5, 3)).toEqual([]);
  });

  it("never expires the live version, even if it falls outside the window", () => {
    // A rollback can make an old version current. Deleting it would break the
    // artifact outright, which is worse than briefly exceeding the window.
    expect(versionsToExpire(versions, 3, 1)).not.toContain(1);
  });

  it("is stable regardless of the order it is given", () => {
    expect(versionsToExpire([1, 5, 3, 2, 4], 2, 5)).toEqual([3, 2, 1]);
  });
});

describe("publishing past the window on a free plan", () => {
  beforeEach(async () => {
    await initDb();
    await clearR2();
  });

  async function publish(n: number) {
    const body = new FormData();
    body.set("slug", "rolling");
    if (n === 1) body.set("title", "Rolling");
    body.set("file", new File([`<h1>v${n}</h1>`], "index.html", { type: "text/html" }));
    return req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
  }

  it("keeps only the newest versions and marks the rest expired", async () => {
    for (let i = 1; i <= 7; i++) expect((await publish(i)).status).toBeLessThan(300);

    const rows = await env.DB.prepare(
      "SELECT version, expired_at FROM artifact_versions WHERE slug = ? ORDER BY version DESC"
    ).bind("rolling").all<{ version: number; expired_at: string | null }>();

    const live = rows.results.filter((r) => !r.expired_at).map((r) => r.version);
    const expired = rows.results.filter((r) => r.expired_at).map((r) => r.version);

    expect(live).toEqual([7, 6, 5, 4, 3]);
    expect(expired).toEqual([2, 1]);
  });

  it("still serves the current version after older ones expire", async () => {
    for (let i = 1; i <= 7; i++) await publish(i);
    const res = await req("/rolling/", as(OWNER));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("v7");
  });

  it("keeps the history row so the version list stays honest", async () => {
    for (let i = 1; i <= 7; i++) await publish(i);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM artifact_versions WHERE slug = ?"
    ).bind("rolling").first<{ n: number }>();
    // Expired versions are marked, not deleted: "v2 existed and is gone" is
    // more useful than a hole in the numbering.
    expect(row?.n).toBe(7);
  });
});
