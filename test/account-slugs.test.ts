import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import {
  ACCOUNT_SLUG_RE,
  brandedArtifactUrl,
  brandedPathParts,
  AUTO_ACCOUNT_SLUG_RE,
  checkAccountSlug,
  generateAutoAccountSlug,
  isAutoAccountSlug,
  isReservedAccountSlug,
  normalizeAccountSlug,
  planAllowsBrandedSlug,
  suggestAccountSlug,
  RESERVED_ACCOUNT_SLUGS,
} from "../src/account-slugs";
import { reservedTopLevelSegments } from "../src/host";
import type { Env as AppEnv } from "../src/env";
import {
  ensureAccountPublicSlug,
  getAccountByPublicSlug,
  personalAccountFor,
  setAccountPublicSlug,
} from "../src/accounts";
import { createApiToken } from "../src/tokens";
import { initDb, clearR2, as, withToken } from "./fixtures";
import schemaSql from "../schema.sql?raw";
import migration0020 from "../migrations/0020_account_slugs.sql?raw";
import migration0021 from "../migrations/0021_auto_account_slugs.sql?raw";
import fixturesSource from "./fixtures.ts?raw";

/**
 * Branded workspace addresses — `rtfx.pro/yogev/q3-board-report`.
 *
 * Split in two on purpose. Everything above `--- the API ---` is pure and runs
 * as a table: the rules about what a workspace may call itself have to be
 * exhaustively checkable without a database, because "which names are
 * unclaimable" is the part that is expensive to get wrong and impossible to fix
 * afterwards. Below it is the surface a person actually uses.
 */

const OWNER = "yogev@rtfx.pro";
const OTHER = "maya@rtfx.pro";

/**
 * A `.local` app origin, because `DEV_LOGIN` (which `as()` rides on) is
 * deliberately inert on the canonical production hostname — see
 * `isCanonicalProductionRequest` in src/auth.ts. Everything the routes do is
 * origin-relative, so `rtfx.local/yogev/q3-board-report` exercises exactly the
 * shape `rtfx.pro/yogev/q3-board-report` has in production.
 */
const APP = "https://rtfx.local";
const APP_HOST = "rtfx.local";
const CONTENT_HOST = "a.rtfx.local";

function e(extra: Record<string, unknown> = {}) {
  return {
    ...(env as any),
    CONTENT_HOSTNAMES: CONTENT_HOST,
    PUBLIC_BASE_URL: APP,
    ...extra,
  };
}

const appReq = (path: string, init?: RequestInit, extra: Record<string, unknown> = {}) =>
  app.request(`${APP}${path}`, init, e(extra) as any);

/** Publish one artifact as `email`, creating their personal workspace on the way. */
async function publish(slug: string, email: string) {
  const body = new FormData();
  body.set("slug", slug);
  body.set("title", slug);
  body.set("file", new File([`<h1>${slug}</h1>`], "index.html", { type: "text/html" }));
  const res = await appReq("/api/artifacts", { method: "POST", body, ...as(email) });
  expect(res.status).toBe(200);
  return res;
}

/** Put somebody's personal workspace on a plan, the way billing would. */
async function setPlan(email: string, plan: string) {
  const account = await personalAccountFor(env as any, email);
  expect(account).not.toBeNull();
  await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, account!.id).run();
  return account!;
}

describe("what a workspace may call itself", () => {
  it("accepts the addresses the product advertises", () => {
    for (const slug of ["yogev", "maya", "acme-partners", "a1b", "x".repeat(63)]) {
      expect(checkAccountSlug(slug), slug).toMatchObject({ ok: true, slug });
    }
  });

  it("lowercases and trims before judging", () => {
    expect(checkAccountSlug("  Yogev  ")).toMatchObject({ ok: true, slug: "yogev" });
    expect(normalizeAccountSlug("  MAYA ")).toBe("maya");
    expect(normalizeAccountSlug(42)).toBe("");
  });

  it("refuses shapes that would not survive being a path or a DNS label", () => {
    for (const bad of [
      "", // nothing
      "ab", // two characters — the scarce end of a shared namespace
      "-yogev", // leading hyphen
      "yogev-", // trailing hyphen
      "yo gev", // space
      "yogev/report", // a second segment smuggled in
      "yogev.pro", // a dot
      "Yogev_1", // underscore
      "x".repeat(64), // longer than a DNS label
      "café", // non-ASCII
      "../etc", // traversal
    ]) {
      const checked = checkAccountSlug(bad);
      expect(checked.ok, `accepted ${JSON.stringify(bad)}`).toBe(false);
      if (!checked.ok) expect(checked.reason).toBe("shape");
    }
  });

  it("gives a sentence that says what to do next, not a regex", () => {
    const checked = checkAccountSlug("-nope");
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.detail).toContain("lowercase");
      expect(checked.detail).not.toContain("^[a-z0-9]");
    }
  });

  /**
   * The reserved list is the load-bearing half. A workspace holding `/docs`
   * would own a namespace no request could ever reach — the real page wins the
   * route — and one holding `/support` or `/billing` is a phishing surface.
   */
  it("refuses every path the app host already answers for itself", () => {
    for (const path of ["docs", "login", "logout", "signup", "admin", "api", "privacy", "terms",
      "pro", "team", "enterprise", "health", "gallery", "contact", "waitlist", "shared", "auth",
      "mcp", "oauth", "whoami", "v"]) {
      const checked = checkAccountSlug(path);
      expect(checked.ok, `claimable: ${path}`).toBe(false);
      // "v" is refused on shape (one character); the rest on reservation.
      if (!checked.ok && path.length >= 3) expect(checked.reason, path).toBe("reserved");
    }
  });

  it("derives that list from the router rather than restating it", () => {
    for (const segment of reservedTopLevelSegments()) {
      expect(RESERVED_ACCOUNT_SLUGS.has(segment), `not reserved: ${segment}`).toBe(true);
    }
  });

  it("refuses crawler files, operator-sounding words and product pages it may want later", () => {
    for (const word of ["robots", "sitemap", "llms", "security", "support", "settings", "billing",
      "www", "static", "assets", "well-known", "status", "help", "pricing", "blog", "app", "me"]) {
      expect(isReservedAccountSlug(word), `claimable: ${word}`).toBe(true);
    }
  });

  it("suggests an address from an email's local part, or nothing at all", () => {
    expect(suggestAccountSlug("maya@example.com")).toBe("maya");
    expect(suggestAccountSlug("Yogev Gabay")).toBe("yogev-gabay");
    // A suggestion is only useful if it is claimable — a reserved or
    // too-short one is worse than no suggestion, because it will be refused.
    expect(suggestAccountSlug("admin@example.com")).toBe("");
    expect(suggestAccountSlug("ab")).toBe("");
  });

  it("keeps the shape regex and the advertised bounds in step", () => {
    expect(ACCOUNT_SLUG_RE.test("abc")).toBe(true);
    expect(ACCOUNT_SLUG_RE.test("ab")).toBe(false);
  });

  it("gates claiming on the paid plans, and treats an operator's enterprise as above team", () => {
    for (const plan of ["pro", "team", "enterprise"]) {
      expect(planAllowsBrandedSlug(plan), plan).toBe(true);
    }
    for (const plan of ["free", "", "trial", "Pro"]) {
      expect(planAllowsBrandedSlug(plan), plan).toBe(false);
    }
  });
});

/**
 * Three files declare this column: the migration that adds it to a live
 * database, `schema.sql` (what a fresh instance is created from), and the test
 * fixture (what the whole suite runs against). Two of them agreeing is not
 * enough — a fixture without the UNIQUE index would let every test above pass
 * while production kept a guarantee the tests never exercised.
 */
describe("the column, the index, and the three places that declare them", () => {
  it("adds the column and a partial unique index in migration 0020", () => {
    expect(migration0020).toMatch(/ALTER TABLE accounts ADD COLUMN public_slug TEXT/i);
    expect(migration0020).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_public_slug/i);
    expect(migration0020).toMatch(/WHERE public_slug IS NOT NULL/i);
  });

  it("says the same thing in schema.sql, so a fresh instance needs no migration", () => {
    expect(schemaSql).toMatch(/public_slug\s+TEXT/i);
    expect(schemaSql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_public_slug/i);
    expect(schemaSql).toMatch(/ON accounts \(public_slug\) WHERE public_slug IS NOT NULL/i);
  });

  it("and in the fixture, index included", () => {
    expect(fixturesSource).toContain("public_slug TEXT");
    expect(fixturesSource).toContain("idx_accounts_public_slug");
  });

  it("gives a new personal workspace an auto address at creation", async () => {
    await initDb();
    await clearR2();
    await publish("report", OWNER);
    const account = await personalAccountFor(env as any, OWNER);
    expect(account!.public_slug).toMatch(AUTO_ACCOUNT_SLUG_RE);
  });
});

describe("auto addresses", () => {
  beforeEach(async () => {
    await initDb();
    await clearR2();
  });

  it("generates w- plus 8 lowercase hex, and recognises only that shape as auto", () => {
    for (let i = 0; i < 50; i++) expect(generateAutoAccountSlug()).toMatch(/^w-[0-9a-f]{8}$/);
    expect(isAutoAccountSlug("w-3f9a0c12")).toBe(true);
    for (const not of ["w-3F9A0C12", "w-3f9a0c1", "w-3f9a0c123", "w-3f9a0c1g", "yogev", "", null, undefined]) {
      expect(isAutoAccountSlug(not as any), String(not)).toBe(false);
    }
    // An auto-shaped name is a valid slug shape and not on the router's list —
    // only the explicit auto rule keeps it unclaimable.
    expect(suggestAccountSlug("w-3f9a0c12@example.com")).toBe("");
  });

  it("refuses to let anyone claim a name of the auto shape", async () => {
    const checked = checkAccountSlug("w-3f9a0c12");
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.reason).toBe("reserved");
      expect(checked.detail).toContain("w-xxxxxxxx");
    }
    await publish("report", OWNER);
    const account = await setPlan(OWNER, "pro");
    const res = await appReq(`/api/workspace/${account.id}/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug: "w-3f9a0c12" }),
      ...as(OWNER),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).detail).toContain("reserved");
  });

  it("lazily assigns an address to a workspace that has none, and keeps it stable", async () => {
    await publish("report", OWNER);
    const account = (await personalAccountFor(env as any, OWNER))!;
    await env.DB.prepare("UPDATE accounts SET public_slug = NULL WHERE id = ?").bind(account.id).run();
    const first = await ensureAccountPublicSlug(env as any, account.id);
    expect(first).toMatch(AUTO_ACCOUNT_SLUG_RE);
    expect(await ensureAccountPublicSlug(env as any, account.id)).toBe(first);
    expect(await ensureAccountPublicSlug(env as any, "acct_missing")).toBeNull();
  });

  it("retries on a UNIQUE collision instead of failing", async () => {
    await publish("report", OWNER);
    const account = (await personalAccountFor(env as any, OWNER))!;
    await env.DB.prepare("UPDATE accounts SET public_slug = NULL WHERE id = ?").bind(account.id).run();
    // Force the first draw to collide with a slug another account holds.
    const taken = "w-00000000";
    await publish("other", OTHER);
    await env.DB.prepare("UPDATE accounts SET public_slug = ? WHERE personal_email = ?").bind(taken, OTHER).run();
    const original = crypto.getRandomValues.bind(crypto);
    let calls = 0;
    (crypto as any).getRandomValues = (arr: Uint8Array) => {
      if (calls++ === 0) return arr.fill(0);
      return original(arr);
    };
    try {
      const got = await ensureAccountPublicSlug(env as any, account.id);
      expect(got).toMatch(AUTO_ACCOUNT_SLUG_RE);
      expect(got).not.toBe(taken);
    } finally {
      (crypto as any).getRandomValues = original;
    }
  });

  it("migration 0021 backfills only NULL rows, with the auto shape, and is safe to re-run", async () => {
    expect(migration0021).toContain("randomblob(4)");
    expect(migration0021).toMatch(/wrangler d1 migrations apply/);
    await publish("report", OWNER);
    await publish("other", OTHER);
    await env.DB.prepare("UPDATE accounts SET public_slug = NULL WHERE personal_email = ?").bind(OWNER).run();
    await env.DB.prepare("UPDATE accounts SET public_slug = 'maya' WHERE personal_email = ?").bind(OTHER).run();
    const update = migration0021.split("\n").filter((l) => !l.startsWith("--")).join("\n").trim();
    await env.DB.prepare(update).run();
    const mine = await personalAccountFor(env as any, OWNER);
    const theirs = await personalAccountFor(env as any, OTHER);
    expect(mine!.public_slug).toMatch(AUTO_ACCOUNT_SLUG_RE);
    expect(theirs!.public_slug).toBe("maya");
    await env.DB.prepare(update).run();
    expect((await personalAccountFor(env as any, OWNER))!.public_slug).toBe(mine!.public_slug);
  });

  it("gives a team workspace an auto address at creation too", async () => {
    const { createAccount } = await import("../src/accounts");
    const team = await createAccount(env as any, {
      name: "Acme",
      kind: "team",
      personalEmail: null,
      createdBy: OWNER,
      now: "2026-08-28T09:00:00.000Z",
    });
    expect(team.public_slug).toMatch(AUTO_ACCOUNT_SLUG_RE);
  });

  it("a free workspace still cannot claim a custom address", async () => {
    await publish("report", OWNER);
    const account = (await personalAccountFor(env as any, OWNER))!;
    const before = account.public_slug;
    const res = await appReq(`/api/workspace/${account.id}/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug: "yogev" }),
      ...as(OWNER),
    });
    expect(res.status).toBe(403);
    expect((await personalAccountFor(env as any, OWNER))!.public_slug).toBe(before);
  });

  it("releasing a custom address reverts to a fresh auto one, never NULL", async () => {
    await publish("report", OWNER);
    const account = await setPlan(OWNER, "pro");
    await setAccountPublicSlug(env as any, account.id, "yogev", "2026-08-28T09:00:00.000Z");
    const res = await appReq(`/api/workspace/${account.id}/slug`, { method: "DELETE", ...as(OWNER) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.public_slug).toMatch(AUTO_ACCOUNT_SLUG_RE);
    expect(body.branded_base).toContain(`/${body.public_slug}`);
    expect(await getAccountByPublicSlug(env as any, "yogev")).toBeNull();
  });

  it("shows the generated address in Settings, with an upgrade note on Free", async () => {
    await publish("report", OWNER);
    const account = (await personalAccountFor(env as any, OWNER))!;
    const html = await (await appReq("/admin/settings", as(OWNER))).text();
    expect(html).toContain('data-address-state="auto"');
    expect(html).toContain(account.public_slug!);
    expect(html).toContain("generated");
    expect(html).toContain("needs Pro");
    expect(html).not.toContain("data-address-release");
  });
});

describe("the branded path itself", () => {
  it("splits exactly two segments, with or without a trailing slash", () => {
    expect(brandedPathParts("/yogev/q3-board-report")).toEqual({
      accountSlug: "yogev",
      artifactSlug: "q3-board-report",
    });
    expect(brandedPathParts("/maya/client-proposal/")).toEqual({
      accountSlug: "maya",
      artifactSlug: "client-proposal",
    });
  });

  it("is not a prefix match — an artifact's own asset path is not a branded link", () => {
    for (const path of [
      "/", // the landing page
      "/report", // one segment: the legacy app-host artifact path
      "/yogev/report/index.html", // three segments: an asset inside an artifact
      "/yogev/index.html", // a file, not a slug
      "/yogev/style.css",
      "/docs/publishing", // a reserved first segment
      "/-yogev/report", // an address nobody could hold
      "yogev/report", // not a path
    ]) {
      expect(brandedPathParts(path), path).toBeNull();
    }
  });

  it("survives percent-encoding and a mixed-case address without throwing", () => {
    expect(brandedPathParts("/YOGEV/q3-board-report")).toEqual({
      accountSlug: "yogev",
      artifactSlug: "q3-board-report",
    });
    expect(brandedPathParts("/yogev/%2e%2e")).toBeNull();
    expect(brandedPathParts("/yogev/%ZZ")).toBeNull();
  });

  it("builds the advertised URLs, on whatever origin this instance runs on", () => {
    expect(brandedArtifactUrl("https://rtfx.pro", "yogev", "q3-board-report")).toBe(
      "https://rtfx.pro/yogev/q3-board-report"
    );
    expect(brandedArtifactUrl("https://rtfx.pro/", "maya", "client-proposal")).toBe(
      "https://rtfx.pro/maya/client-proposal"
    );
    expect(brandedArtifactUrl("https://artifacts.example.com", "acme", "deck")).toBe(
      "https://artifacts.example.com/acme/deck"
    );
  });
});

// --- the API ----------------------------------------------------------------

describe("claiming an address", () => {
  beforeEach(async () => {
    await initDb();
    await clearR2();
  });

  it("lets a Pro owner claim one, and reports where their links now start", async () => {
    await publish("q3-board-report", OWNER);
    const account = await setPlan(OWNER, "pro");

    const res = await appReq(`/api/workspace/${account.id}/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug: "Yogev" }),
      ...as(OWNER),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.public_slug).toBe("yogev");
    expect(body.branded_base).toBe(`${APP}/yogev`);
    expect(body.account.public_slug).toBe("yogev");

    expect((await getAccountByPublicSlug(env as any, "yogev"))?.id).toBe(account.id);
  });

  it("refuses a free workspace, and says what would change that", async () => {
    await publish("report", OWNER);
    const account = await personalAccountFor(env as any, OWNER);
    const res = await appReq(`/api/workspace/${account!.id}/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug: "yogev" }),
      ...as(OWNER),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe("plan_required");
    expect(body.detail).toContain("Pro");
    expect(await getAccountByPublicSlug(env as any, "yogev")).toBeNull();
  });

  it("refuses a reserved word and a malformed one with 400, before touching the row", async () => {
    await publish("report", OWNER);
    const account = await setPlan(OWNER, "pro");
    for (const [slug, detail] of [
      ["docs", "reserved"],
      ["-nope", "lowercase"],
      ["ab", "characters"],
    ] as const) {
      const res = await appReq(`/api/workspace/${account.id}/slug`, {
        method: "PUT",
        body: JSON.stringify({ slug }),
        ...as(OWNER),
      });
      expect(res.status, slug).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error).toBe("bad_request");
      expect(body.detail).toContain(detail);
    }
  });

  it("is globally unique across accounts — the second claim is a 409", async () => {
    await publish("q3-board-report", OWNER);
    await publish("client-proposal", OTHER);
    const mine = await setPlan(OWNER, "pro");
    const theirs = await setPlan(OTHER, "pro");

    const first = await appReq(`/api/workspace/${mine.id}/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug: "yogev" }),
      ...as(OWNER),
    });
    expect(first.status).toBe(200);

    const second = await appReq(`/api/workspace/${theirs.id}/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug: "yogev" }),
      ...as(OTHER),
    });
    expect(second.status).toBe(409);
    expect((await second.json() as any).error).toBe("conflict");
    // …and the first holder still holds it.
    expect((await getAccountByPublicSlug(env as any, "yogev"))?.id).toBe(mine.id);
  });

  it("enforces uniqueness in the database, not only in the read-before-write", async () => {
    await publish("q3-board-report", OWNER);
    await publish("client-proposal", OTHER);
    const mine = await setPlan(OWNER, "pro");
    const theirs = await setPlan(OTHER, "pro");
    expect(await setAccountPublicSlug(env as any, mine.id, "yogev", "2026-08-28T00:00:00.000Z")).toMatchObject({ ok: true });
    // Straight at the writer, bypassing every route-level check: the partial
    // UNIQUE index has to be what refuses this, or two workspaces share a
    // namespace the first time two claims race.
    const clash = await env.DB.prepare("UPDATE accounts SET public_slug = ? WHERE id = ?")
      .bind("yogev", theirs.id)
      .run()
      .then(() => null)
      .catch((err: unknown) => err);
    expect(clash, "the database allowed a duplicate address").not.toBeNull();
  });

  it("re-claiming the address you already hold is a no-op, not a conflict", async () => {
    await publish("q3-board-report", OWNER);
    const account = await setPlan(OWNER, "pro");
    for (const _ of [1, 2]) {
      const res = await appReq(`/api/workspace/${account.id}/slug`, {
        method: "PUT",
        body: JSON.stringify({ slug: "yogev" }),
        ...as(OWNER),
      });
      expect(res.status).toBe(200);
    }
  });

  it("releases the address on DELETE, and on an empty submission", async () => {
    await publish("q3-board-report", OWNER);
    const account = await setPlan(OWNER, "pro");
    await appReq(`/api/workspace/${account.id}/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug: "yogev" }),
      ...as(OWNER),
    });
    const res = await appReq(`/api/workspace/${account.id}/slug`, { method: "DELETE", ...as(OWNER) });
    expect(res.status).toBe(200);
    expect((await res.json() as any).public_slug).toMatch(AUTO_ACCOUNT_SLUG_RE);
    expect(await getAccountByPublicSlug(env as any, "yogev")).toBeNull();
    // …and it is claimable again by somebody else.
    await publish("client-proposal", OTHER);
    const theirs = await setPlan(OTHER, "pro");
    const reclaim = await appReq(`/api/workspace/${theirs.id}/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug: "yogev" }),
      ...as(OTHER),
    });
    expect(reclaim.status).toBe(200);
  });

  it("lets a downgraded workspace release an address, but not claim a new one", async () => {
    await publish("q3-board-report", OWNER);
    const account = await setPlan(OWNER, "pro");
    expect(await setAccountPublicSlug(env as any, account.id, "yogev", "2026-08-28T00:00:00.000Z")).toMatchObject({ ok: true });
    await env.DB.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(account.id).run();

    const denied = await appReq(`/api/workspace/${account.id}/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug: "maya" }),
      ...as(OWNER),
    });
    expect(denied.status).toBe(403);
    expect((await denied.json() as any).error).toBe("plan_required");
    expect((await getAccountByPublicSlug(env as any, "yogev"))?.id).toBe(account.id);

    const released = await appReq(`/api/workspace/${account.id}/slug`, { method: "DELETE", ...as(OWNER) });
    expect(released.status).toBe(200);
    expect((await released.json() as any).public_slug).toMatch(AUTO_ACCOUNT_SLUG_RE);
    expect(await getAccountByPublicSlug(env as any, "yogev")).toBeNull();
  });

  it("takes owner or admin — a member who can publish cannot rename the namespace", async () => {
    await publish("q3-board-report", OWNER);
    const account = await setPlan(OWNER, "pro");
    await env.DB.prepare(
      `INSERT INTO account_members (account_id, email, role, status, invited_by, created_at, updated_at)
       VALUES (?, ?, 'member', 'active', NULL, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`
    )
      .bind(account.id, OTHER)
      .run();

    const res = await appReq(`/api/workspace/${account.id}/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug: "maya" }),
      ...as(OTHER),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe("forbidden");
  });

  it("enforces API-token manage scope on the JSON address API", async () => {
    await publish("q3-board-report", OWNER);
    const account = await setPlan(OWNER, "pro");
    const readOnly = await createApiToken(env as unknown as AppEnv, {
      name: "read-only",
      ownerEmail: OWNER,
      accountId: account.id,
      isAdmin: false,
      scopes: ["read"],
      createdBy: OWNER,
      expiresAt: null,
      now: "2026-08-28T00:00:00.000Z",
    });
    const manager = await createApiToken(env as unknown as AppEnv, {
      name: "manager",
      ownerEmail: OWNER,
      accountId: account.id,
      isAdmin: false,
      scopes: ["manage"],
      createdBy: OWNER,
      expiresAt: null,
      now: "2026-08-28T00:00:00.000Z",
    });

    const denied = await appReq(`/api/workspace/${account.id}/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug: "yogev" }),
      ...withToken(readOnly.token),
    });
    expect(denied.status).toBe(403);
    expect((await denied.json() as any).error).toBe("insufficient_scope");
    expect(await getAccountByPublicSlug(env as any, "yogev")).toBeNull();

    const claimed = await appReq(`/api/workspace/${account.id}/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug: "yogev" }),
      ...withToken(manager.token),
    });
    expect(claimed.status).toBe(200);
    expect((await claimed.json() as any).public_slug).toBe("yogev");

    const deleteDenied = await appReq(`/api/workspace/${account.id}/slug`, {
      method: "DELETE",
      ...withToken(readOnly.token),
    });
    expect(deleteDenied.status).toBe(403);
    expect((await deleteDenied.json() as any).error).toBe("insufficient_scope");

    const released = await appReq(`/api/workspace/${account.id}/slug`, {
      method: "DELETE",
      ...withToken(manager.token),
    });
    expect(released.status).toBe(200);
    expect((await released.json() as any).public_slug).toMatch(AUTO_ACCOUNT_SLUG_RE);
  });

  it("answers 404 — never 403 — for a workspace the caller does not belong to", async () => {
    await publish("q3-board-report", OWNER);
    await publish("client-proposal", OTHER);
    const mine = await setPlan(OWNER, "pro");

    const res = await appReq(`/api/workspace/${mine.id}/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug: "maya" }),
      ...as(OTHER),
    });
    expect(res.status).toBe(404);
    // An id nobody has is indistinguishable from one somebody else has.
    const unknown = await appReq(`/api/workspace/acct_deadbeefdeadbeef/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug: "maya" }),
      ...as(OTHER),
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe(await res.text());
  });

  it("refuses an anonymous caller outright", async () => {
    await publish("q3-board-report", OWNER);
    const account = await setPlan(OWNER, "pro");
    const res = await appReq(`/api/workspace/${account.id}/slug`, {
      method: "PUT",
      body: JSON.stringify({ slug: "yogev" }),
      headers: { "X-Dev-Anonymous": "true" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await getAccountByPublicSlug(env as any, "yogev")).toBeNull();
  });
});

describe("the address in the Settings page", () => {
  beforeEach(async () => {
    await initDb();
    await clearR2();
  });

  it("offers the form to a Pro owner, with both advertised examples", async () => {
    await publish("q3-board-report", OWNER);
    await setPlan(OWNER, "pro");
    const html = await (await appReq("/admin/settings", as(OWNER))).text();
    expect(html).toContain('data-setting="workspace-address"');
    expect(html).toContain('action="/admin/workspace/address"');
    // Starts on the generated address, and invites choosing one.
    expect(html).toContain('data-address-state="auto"');
    expect(html).toContain("Pick a custom one below");
    expect(html).not.toContain("data-address-release");
    await setAccountPublicSlug(env as any, (await personalAccountFor(env as any, OWNER))!.id, "yogev", "2026-08-28T09:00:00.000Z");
    const claimed = await (await appReq("/admin/settings", as(OWNER))).text();
    expect(claimed).toContain('data-address-state="claimed"');
    expect(claimed).toContain(`${APP_HOST}/yogev/q3-board-report`);
    expect(claimed).toContain("data-address-release");
  });

  it("shows a free workspace what it would take, and no form", async () => {
    await publish("report", OWNER);
    const html = await (await appReq("/admin/settings", as(OWNER))).text();
    expect(html).toContain("data-address-locked");
    expect(html).not.toContain('action="/admin/workspace/address"');
  });

  it("claims one from the form and says so on the page it lands on", async () => {
    await publish("q3-board-report", OWNER);
    await setPlan(OWNER, "pro");
    const form = new URLSearchParams({ slug: "yogev" });
    const res = await appReq("/admin/workspace/address", {
      method: "POST",
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      ...as(OWNER),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin/settings?address=ok");

    const html = await (await appReq("/admin/settings?address=ok", as(OWNER))).text();
    expect(html).toContain('data-address-state="claimed"');
    expect(html).toContain('data-address-notice="ok"');
    expect(html).toContain(`${APP_HOST}/yogev`);
  });

  it("reports a taken address back on the same page rather than as a raw error", async () => {
    await publish("q3-board-report", OWNER);
    await publish("client-proposal", OTHER);
    await setPlan(OWNER, "pro");
    const theirs = await setPlan(OTHER, "pro");
    await setAccountPublicSlug(env as any, theirs.id, "yogev", "2026-08-28T00:00:00.000Z");

    const res = await appReq("/admin/workspace/address", {
      method: "POST",
      body: new URLSearchParams({ slug: "yogev" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      ...as(OWNER),
    });
    expect(res.headers.get("Location")).toBe("/admin/settings?address=taken");
    const html = await (await appReq("/admin/settings?address=taken", as(OWNER))).text();
    expect(html).toContain('data-address-notice="error"');
  });

  it("releases from the form without touching the slug field", async () => {
    await publish("q3-board-report", OWNER);
    const account = await setPlan(OWNER, "pro");
    await setAccountPublicSlug(env as any, account.id, "yogev", "2026-08-28T00:00:00.000Z");
    const res = await appReq("/admin/workspace/address", {
      method: "POST",
      body: new URLSearchParams({ slug: "yogev", release: "1" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      ...as(OWNER),
    });
    expect(res.headers.get("Location")).toBe("/admin/settings?address=released");
    expect(await getAccountByPublicSlug(env as any, "yogev")).toBeNull();
  });
});
