import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  createChallenge,
  redeemCode,
  redeemToken,
  CHALLENGE_TTL_MINUTES,
  MAX_ATTEMPTS,
} from "../src/otp";

const AT = "2026-08-14T12:00:00.000Z";
const later = (min: number) => new Date(Date.parse(AT) + min * 60_000).toISOString();

async function initDb() {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS auth_challenges (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL,
      token_hash TEXT NOT NULL, purpose TEXT NOT NULL, slug TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL,
      consumed_at TEXT, created_at TEXT NOT NULL)`
  ).run();
  await env.DB.prepare("DELETE FROM auth_challenges").run();
}

beforeEach(initDb);

const make = (email = "dana@acme.com") =>
  createChallenge(env as any, { email, purpose: "signin", now: AT });

describe("createChallenge", () => {
  it("returns a 6-digit code and an opaque token", async () => {
    const c = await make();
    expect(c.code).toMatch(/^\d{6}$/);
    expect(c.token.length).toBeGreaterThanOrEqual(32);
  });

  it("stores neither the code nor the token in plaintext", async () => {
    const c = await make();
    const row = await env.DB.prepare("SELECT * FROM auth_challenges").first<any>();
    expect(row.code_hash).not.toBe(c.code);
    expect(row.token_hash).not.toBe(c.token);
    expect(JSON.stringify(row)).not.toContain(c.code);
    expect(JSON.stringify(row)).not.toContain(c.token);
  });

  it("normalizes the email", async () => {
    await createChallenge(env as any, { email: " Dana@ACME.com ", purpose: "signin", now: AT });
    const row = await env.DB.prepare("SELECT email FROM auth_challenges").first<any>();
    expect(row.email).toBe("dana@acme.com");
  });

  it("issues distinct codes across challenges", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      await initDb();
      seen.add((await make()).code);
    }
    // Not a randomness proof — just a guard against a constant or a counter.
    expect(seen.size).toBeGreaterThan(10);
  });
});

describe("redeemCode", () => {
  it("accepts the right code once", async () => {
    const c = await make();
    expect(await redeemCode(env as any, "dana@acme.com", c.code, AT)).toMatchObject({
      email: "dana@acme.com",
      purpose: "signin",
    });
  });

  it("refuses the same code a second time", async () => {
    const c = await make();
    await redeemCode(env as any, "dana@acme.com", c.code, AT);
    expect(await redeemCode(env as any, "dana@acme.com", c.code, AT)).toBeNull();
  });

  it("refuses a code after it expires", async () => {
    const c = await make();
    expect(
      await redeemCode(env as any, "dana@acme.com", c.code, later(CHALLENGE_TTL_MINUTES + 1))
    ).toBeNull();
  });

  it("refuses a code presented for a different address", async () => {
    const c = await make("dana@acme.com");
    expect(await redeemCode(env as any, "mallory@evil.com", c.code, AT)).toBeNull();
  });

  it("burns the challenge after MAX_ATTEMPTS wrong codes", async () => {
    const c = await make();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(await redeemCode(env as any, "dana@acme.com", "000000", AT)).toBeNull();
    }
    // The real code must no longer work — brute force is bounded.
    expect(await redeemCode(env as any, "dana@acme.com", c.code, AT)).toBeNull();
  });

  it("does not burn the challenge before the limit", async () => {
    const c = await make();
    await redeemCode(env as any, "dana@acme.com", "000000", AT);
    expect(await redeemCode(env as any, "dana@acme.com", c.code, AT)).not.toBeNull();
  });
});

describe("redeemToken", () => {
  it("accepts the magic-link token once", async () => {
    const c = await make();
    expect(await redeemToken(env as any, c.token, AT)).toMatchObject({ email: "dana@acme.com" });
    expect(await redeemToken(env as any, c.token, AT)).toBeNull();
  });

  it("refuses an expired token", async () => {
    const c = await make();
    expect(await redeemToken(env as any, c.token, later(CHALLENGE_TTL_MINUTES + 1))).toBeNull();
  });

  it("refuses an unknown token", async () => {
    await make();
    expect(await redeemToken(env as any, "totally-made-up-token-value", AT)).toBeNull();
  });

  it("is closed once the code path already consumed the challenge", async () => {
    const c = await make();
    await redeemCode(env as any, "dana@acme.com", c.code, AT);
    expect(await redeemToken(env as any, c.token, AT)).toBeNull();
  });

  it("carries the slug through for a guest challenge", async () => {
    const c = await createChallenge(env as any, {
      email: "dana@acme.com",
      purpose: "guest",
      slug: "q3-report",
      now: AT,
    });
    expect(await redeemToken(env as any, c.token, AT)).toMatchObject({
      purpose: "guest",
      slug: "q3-report",
    });
  });
});
