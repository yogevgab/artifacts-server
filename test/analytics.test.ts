import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { strToU8 } from "fflate";
import { initDb, clearR2, req, as, htmlForm } from "./fixtures";
import { viewersFor, viewsByVersion, viewSources } from "../src/db";

/**
 * Owner-facing view analytics (the data already logged by `artifact_views`,
 * simply never surfaced). Two layers:
 *
 *  - the aggregate read functions in src/db.ts, exercised directly against
 *    seeded rows — no HTTP, no serving path, because the point here is
 *    reading the log, not producing it;
 *  - the artifact detail page in src/admin.ts, which renders those aggregates
 *    behind the same `canManage` gate every other panel on that page uses.
 */

beforeEach(async () => {
  await initDb();
  await clearR2();
});

interface SeedView {
  slug: string;
  version?: number;
  email?: string | null;
  path?: string | null;
  country?: string | null;
  referrer?: string | null;
  viewed_at: string;
}

/** Insert a view row directly, bypassing serving — see file header. */
async function seedView(v: SeedView) {
  await env.DB.prepare(
    `INSERT INTO artifact_views (slug, version, email, path, country, referrer, viewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      v.slug,
      v.version ?? 1,
      v.email ?? null,
      v.path ?? "",
      v.country ?? null,
      v.referrer ?? null,
      v.viewed_at
    )
    .run();
}

describe("viewersFor", () => {
  it("is empty when nobody has opened the artifact", async () => {
    expect(await viewersFor(env as any, "nope")).toEqual([]);
  });

  it("aggregates repeat views by the same person into one row", async () => {
    await seedView({ slug: "s", email: "a@x.com", version: 1, viewed_at: "2026-01-01T10:00:00Z" });
    await seedView({ slug: "s", email: "a@x.com", version: 2, viewed_at: "2026-01-02T10:00:00Z" });
    const viewers = await viewersFor(env as any, "s");
    expect(viewers).toHaveLength(1);
    expect(viewers[0]).toMatchObject({ email: "a@x.com", views: 2, lastVersion: 2 });
    expect(viewers[0].lastViewedAt).toBe("2026-01-02T10:00:00Z");
  });

  it("orders viewers by most recent view first", async () => {
    await seedView({ slug: "s", email: "old@x.com", viewed_at: "2026-01-01T00:00:00Z" });
    await seedView({ slug: "s", email: "new@x.com", viewed_at: "2026-01-05T00:00:00Z" });
    const viewers = await viewersFor(env as any, "s");
    expect(viewers.map((v) => v.email)).toEqual(["new@x.com", "old@x.com"]);
  });

  it("keeps an anonymous viewer as its own honest row, never merged into a named one", async () => {
    await seedView({ slug: "s", email: null, version: 1, viewed_at: "2026-01-01T00:00:00Z" });
    await seedView({ slug: "s", email: null, version: 1, viewed_at: "2026-01-02T00:00:00Z" });
    await seedView({ slug: "s", email: "a@x.com", viewed_at: "2026-01-03T00:00:00Z" });
    const viewers = await viewersFor(env as any, "s");
    expect(viewers).toHaveLength(2);
    const anon = viewers.find((v) => v.email === null);
    expect(anon).toMatchObject({ email: null, views: 2, lastVersion: 1 });
  });

  it("only counts views for the requested slug", async () => {
    await seedView({ slug: "s1", email: "a@x.com", viewed_at: "2026-01-01T00:00:00Z" });
    await seedView({ slug: "s2", email: "b@x.com", viewed_at: "2026-01-01T00:00:00Z" });
    expect(await viewersFor(env as any, "s1")).toHaveLength(1);
  });
});

describe("viewsByVersion", () => {
  it("is empty when nothing has been viewed", async () => {
    expect(await viewsByVersion(env as any, "nope")).toEqual([]);
  });

  it("groups by version with total and unique viewer counts, newest version first", async () => {
    await seedView({ slug: "s", version: 1, email: "a@x.com", viewed_at: "2026-01-01T00:00:00Z" });
    await seedView({ slug: "s", version: 1, email: "a@x.com", viewed_at: "2026-01-01T01:00:00Z" });
    await seedView({ slug: "s", version: 1, email: "b@x.com", viewed_at: "2026-01-01T02:00:00Z" });
    await seedView({ slug: "s", version: 2, email: "b@x.com", viewed_at: "2026-01-02T00:00:00Z" });
    const rows = await viewsByVersion(env as any, "s");
    expect(rows).toEqual([
      { version: 2, total: 1, unique: 1, lastViewedAt: "2026-01-02T00:00:00Z" },
      { version: 1, total: 3, unique: 2, lastViewedAt: "2026-01-01T02:00:00Z" },
    ]);
  });

  it("counts anonymous views toward a version's totals", async () => {
    await seedView({ slug: "s", version: 1, email: null, viewed_at: "2026-01-01T00:00:00Z" });
    const rows = await viewsByVersion(env as any, "s");
    expect(rows[0]).toMatchObject({ version: 1, total: 1 });
  });
});

describe("viewSources", () => {
  it("is empty in both dimensions when nothing has been viewed", async () => {
    expect(await viewSources(env as any, "nope")).toEqual({ referrers: [], countries: [] });
  });

  it("ranks referrers and countries by view count, most first", async () => {
    await seedView({ slug: "s", referrer: "https://a.com", country: "US", viewed_at: "2026-01-01T00:00:00Z" });
    await seedView({ slug: "s", referrer: "https://a.com", country: "US", viewed_at: "2026-01-01T01:00:00Z" });
    await seedView({ slug: "s", referrer: "https://b.com", country: "DE", viewed_at: "2026-01-01T02:00:00Z" });
    const sources = await viewSources(env as any, "s");
    expect(sources.referrers[0]).toMatchObject({ referrer: "https://a.com", count: 2 });
    expect(sources.referrers[1]).toMatchObject({ referrer: "https://b.com", count: 1 });
    expect(sources.countries[0]).toMatchObject({ country: "US", count: 2 });
  });

  it("groups missing referrer/country data together instead of dropping it", async () => {
    await seedView({ slug: "s", referrer: null, country: null, viewed_at: "2026-01-01T00:00:00Z" });
    await seedView({ slug: "s", referrer: null, country: null, viewed_at: "2026-01-01T01:00:00Z" });
    const sources = await viewSources(env as any, "s");
    expect(sources.referrers).toEqual([{ referrer: null, count: 2 }]);
    expect(sources.countries).toEqual([{ country: null, count: 2 }]);
  });
});

describe("artifact detail page: analytics panels", () => {
  const publish = (slug: string, title: string) =>
    req("/api/artifacts", {
      method: "POST",
      body: htmlForm({ title, slug }, "x.html", strToU8(`<h1>${slug}</h1>`)),
    });
  const detail = async (slug: string) => await (await req(`/admin/artifacts/${slug}`)).text();

  it("explains an empty viewer list instead of showing a bare zero", async () => {
    await publish("quiet2", "Quiet2");
    const page = await detail("quiet2");
    expect(page).toContain('data-panel="viewers"');
    expect(page.toLowerCase()).toContain("nobody has opened this yet");
  });

  it("lists viewers with their view count and last version, and names an anonymous view honestly", async () => {
    await publish("busy", "Busy");
    await seedView({ slug: "busy", email: "reader@x.com", version: 1, viewed_at: "2026-01-01T00:00:00Z" });
    await seedView({ slug: "busy", email: "reader@x.com", version: 1, viewed_at: "2026-01-02T00:00:00Z" });
    await seedView({ slug: "busy", email: null, version: 1, viewed_at: "2026-01-03T00:00:00Z" });
    const page = await detail("busy");
    expect(page).toContain("reader@x.com");
    expect(page).toMatch(/reader@x\.com[\s\S]{0,80}2 views/);
    expect(page.toLowerCase()).toContain("signed out");
  });

  it("shows which versions are still being opened, so a rollback call is informed", async () => {
    await publish("rollback", "Rollback");
    await seedView({ slug: "rollback", version: 1, email: "a@x.com", viewed_at: "2026-01-01T00:00:00Z" });
    const page = await detail("rollback");
    expect(page).toContain('data-panel="version-views"');
    expect(page).toMatch(/v1[\s\S]{0,60}1 view/);
  });

  it("explains an empty version breakdown instead of a bare zero", async () => {
    await publish("freshpub", "FreshPub");
    const page = await detail("freshpub");
    expect(page).toContain('data-panel="version-views"');
    expect(page.toLowerCase()).toContain("no version");
  });

  it("surfaces top referrers and countries, already captured and never shown before", async () => {
    await publish("sourced", "Sourced");
    await seedView({
      slug: "sourced",
      referrer: "https://news.ycombinator.com",
      country: "US",
      viewed_at: "2026-01-01T00:00:00Z",
    });
    const page = await detail("sourced");
    expect(page).toContain('data-panel="sources"');
    expect(page).toContain("news.ycombinator.com");
    expect(page).toContain("US");
  });

  it("explains empty sources instead of a bare zero", async () => {
    await publish("nosource", "NoSource");
    const page = await detail("nosource");
    expect(page).toContain('data-panel="sources"');
    expect(page.toLowerCase()).toContain("no referrer");
  });

  it("never renders analytics for someone who does not own the artifact — same gate as the rest of the page", async () => {
    await publish("mine3", "Mine3");
    await seedView({ slug: "mine3", email: "reader@x.com", viewed_at: "2026-01-01T00:00:00Z" });
    const res = await req("/admin/artifacts/mine3", as("bob@beta.com"));
    expect(res.status).toBe(404);
  });
});
