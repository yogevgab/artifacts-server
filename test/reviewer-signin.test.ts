import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { createChallenge } from "../src/otp";
import { initDb } from "./fixtures";

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const REVIEWER = "reviewer@rtfx.pro";
const CODE = "424242";
const AUTHZ = "/oauth/authorize?client_id=abc&response_type=code&state=xyz";

let sent: any[] = [];

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    ...(env as any),
    SESSION_SECRET: SECRET,
    MAIL_FROM: "no-reply@rtfx.pro",
    DEV_LOGIN: undefined,
    ADMIN_EMAILS: "admin@rtfx.pro",
    REVIEWER_EMAIL: REVIEWER,
    REVIEWER_CODE: CODE,
    EMAIL: {
      send: async (m: any) => {
        sent.push(m);
        return { messageId: "m" };
      },
    },
    ...overrides,
  };
}

beforeEach(async () => {
  sent = [];
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS auth_challenges (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL,
      token_hash TEXT NOT NULL, purpose TEXT NOT NULL, slug TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL,
      consumed_at TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, error_code TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'invited', display_name TEXT, notes TEXT,
      invited_by TEXT, invited_at TEXT, created_at TEXT NOT NULL,
      last_seen_at TEXT, disabled_at TEXT)`,
  ]) {
    await env.DB.prepare(sql).run();
  }
  for (const t of ["auth_challenges", "mail_log", "users", "waitlist_rate_limits"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run().catch(() => {});
  }
});

const post = (path: string, body: unknown, e = testEnv(), headers: Record<string, string> = {}) =>
  app.request(
    path,
    { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
    e
  );

const start = (email: string, e = testEnv()) => post("/auth/start", { email }, e);
const verify = (email: string, code: string, e = testEnv(), headers: Record<string, string> = {}) =>
  post("/auth/verify", { email, code }, e, headers);
const hasSession = (res: Response) =>
  (res.headers.getSetCookie?.() ?? []).some((c) => c.startsWith(`${SESSION_COOKIE}=`));

describe("reviewer sign-in", () => {
  it("is off by default: reviewer code does nothing without config", async () => {
    const off = testEnv({ REVIEWER_EMAIL: undefined, REVIEWER_CODE: undefined });
    await start(REVIEWER, off);
    expect(sent.length).toBe(1); // normal emailed flow
    const res = await verify(REVIEWER, CODE, off);
    expect(res.status).toBe(401);
  });

  it("start sends no mail, writes no mail_log, and returns the same 202 body", async () => {
    const normal = await start("dana@acme.com");
    const normalBody = await normal.text();
    sent = [];
    const res = await start(REVIEWER);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe(normalBody);
    expect(sent.length).toBe(0);
    const log = await env.DB.prepare(`SELECT COUNT(*) n FROM mail_log WHERE email = ?`).bind(REVIEWER).first<{ n: number }>();
    expect(log!.n).toBe(0);
    const ch = await env.DB.prepare(`SELECT COUNT(*) n FROM auth_challenges WHERE email = ?`).bind(REVIEWER).first<{ n: number }>();
    expect(ch!.n).toBe(1);
  });

  it("matches the reviewer email case-insensitively", async () => {
    await start("Reviewer@RTFX.pro");
    expect(sent.length).toBe(0);
    const res = await verify("REVIEWER@rtfx.pro", CODE);
    expect(res.status).toBe(200);
  });

  it("right code after start signs in as an ordinary member, once, and logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await start(REVIEWER);
    const res = await verify(REVIEWER, CODE, testEnv(), { "User-Agent": "ReviewerBrowser/1.0" });
    expect(res.status).toBe(200);
    expect(hasSession(res)).toBe(true);
    expect(await res.json()).toMatchObject({ ok: true, redirect: "/admin" });
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("reviewer_signin"));
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: "reviewer_signin", ua: "ReviewerBrowser/1.0" });
    log.mockRestore();
    const user = await env.DB.prepare(`SELECT role FROM users WHERE email = ?`).bind(REVIEWER).first<{ role: string }>();
    expect(user?.role ?? "member").toBe("member");
    // challenge consumed: replay fails
    expect((await verify(REVIEWER, CODE)).status).toBe(401);
  });

  it("right code WITHOUT a prior start fails", async () => {
    const res = await verify(REVIEWER, CODE);
    expect(res.status).toBe(401);
    expect(hasSession(res)).toBe(false);
  });

  it("wrong code x5 burns the challenge, even for the right code", async () => {
    await start(REVIEWER);
    for (let i = 0; i < 5; i++) {
      expect((await verify(REVIEWER, "111111")).status).toBe(401);
    }
    const res = await verify(REVIEWER, CODE);
    expect(res.status).toBe(401);
    expect(hasSession(res)).toBe(false);
  });

  /**
   * The cap must hold under concurrency: parallel guesses used to all read
   * attempts=0 before any of them incremented. Each guess now reserves its
   * attempt atomically before the compare, so at most MAX_ATTEMPTS (5) are
   * ever evaluated per challenge.
   */
  it("parallel guesses cannot exceed the 5-attempt cap", async () => {
    await start(REVIEWER);
    const guesses = Array.from({ length: 40 }, (_, i) => String(100000 + i));
    await Promise.all(guesses.map((g) => verify(REVIEWER, g)));
    const row = await env.DB.prepare(
      `SELECT attempts FROM auth_challenges WHERE email = ? ORDER BY created_at DESC LIMIT 1`
    )
      .bind(REVIEWER)
      .first<{ attempts: number }>();
    expect(row!.attempts).toBeLessThanOrEqual(5);
    // The challenge is spent: even the right code is refused now.
    expect((await verify(REVIEWER, CODE)).status).toBe(401);
  });

  it("an expired challenge does not accept the code", async () => {
    await start(REVIEWER);
    await env.DB.prepare(`UPDATE auth_challenges SET expires_at = ?`).bind("2000-01-01T00:00:00.000Z").run();
    expect((await verify(REVIEWER, CODE)).status).toBe(401);
  });

  it("magic link cannot sign the reviewer in", async () => {
    const issued = await createChallenge(env as any, { email: REVIEWER, purpose: "signin", now: new Date().toISOString() });
    const res = await app.request(`/auth/m/${issued.token}`, { method: "POST" }, testEnv());
    expect(res.status).toBe(401);
    expect(hasSession(res)).toBe(false);
  });

  it("non-reviewer emails still need their real emailed code, not the reviewer code", async () => {
    await start("dana@acme.com");
    expect(sent.length).toBe(1);
    const res = await verify("dana@acme.com", CODE);
    expect(res.status).toBe(401);
  });

  it("REVIEWER_CODE that is not 6 digits turns the feature off", async () => {
    for (const bad of ["12345", "1234567", "abcdef", "12 456"]) {
      sent = [];
      const e = testEnv({ REVIEWER_CODE: bad });
      await start(REVIEWER, e);
      expect(sent.length).toBe(1); // mailed as normal
    }
  });

  it("a reviewer email that is an admin turns the feature off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = testEnv({ REVIEWER_EMAIL: "admin@rtfx.pro" });
    await start("admin@rtfx.pro", e);
    expect(sent.length).toBe(1);
    expect((await verify("admin@rtfx.pro", CODE, e)).status).toBe(401);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    const sup = testEnv({ REVIEWER_EMAIL: "boss@rtfx.pro", SUPER_ADMIN_EMAILS: "boss@rtfx.pro" });
    sent = [];
    await start("boss@rtfx.pro", sup);
    expect(sent.length).toBe(1);
  });

  it("OAuth round trip: parked next is returned after reviewer verify", async () => {
    const login = await app.request(`/login?next=${encodeURIComponent(AUTHZ)}`, {}, testEnv());
    const parked = (login.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("rtfx_next=")) ?? "";
    expect(parked).not.toBe("");
    const cookie = parked.split(";")[0];
    await post("/auth/start", { email: REVIEWER }, testEnv(), { Cookie: cookie });
    const res = await verify(REVIEWER, CODE, testEnv(), { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, redirect: AUTHZ });
    expect(hasSession(res)).toBe(true);
  });

  it("guest sign-in is unaffected", async () => {
    await initDb();
    const res = await app.request(
      `/auth/guest?slug=nope`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: REVIEWER }) },
      testEnv()
    );
    expect(res.status).toBe(202);
  });
});
