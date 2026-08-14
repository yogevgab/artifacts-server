import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { verifySession } from "../src/session";

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const NOW = () => new Date().toISOString();

let sent: any[] = [];

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    ...(env as any),
    SESSION_SECRET: SECRET,
    MAIL_FROM: "no-reply@rtfx.pro",
    DEV_LOGIN: undefined,
    ADMIN_EMAILS: "admin@rtfx.pro",
    EMAIL: {
      send: async (m: any) => {
        sent.push(m);
        return { messageId: "m" };
      },
    },
    ...overrides,
  };
}

async function initDb() {
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
}

beforeEach(initDb);

const post = (path: string, body: unknown, e = testEnv()) =>
  app.request(
    path,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    e
  );

/** The code we just mailed, read out of the captured message. */
function mailedCode(): string {
  const m = /\b(\d{6})\b/.exec(sent[0]?.text ?? "");
  if (!m) throw new Error("no code in mailed message");
  return m[1];
}

function mailedToken(): string {
  const m = /\/auth\/m\/([A-Za-z0-9_-]+)/.exec(sent[0]?.text ?? "");
  if (!m) throw new Error("no magic link in mailed message");
  return m[1];
}

describe("POST /auth/start", () => {
  it("accepts a valid address and mails a code", async () => {
    const res = await post("/auth/start", { email: "dana@acme.com" });
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("dana@acme.com");
    expect(mailedCode()).toMatch(/^\d{6}$/);
  });

  it("answers identically for an address that has never been seen", async () => {
    const a = await post("/auth/start", { email: "known@acme.com" });
    await initDb();
    const b = await post("/auth/start", { email: "never-heard-of@nowhere.example" });
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  });

  it("still answers 202 when the mail fails, so delivery is not an oracle", async () => {
    const e = testEnv({
      EMAIL: {
        send: async () => {
          const err: any = new Error("suppressed");
          err.code = "E_RECIPIENT_SUPPRESSED";
          throw err;
        },
      },
    });
    const res = await post("/auth/start", { email: "bounced@acme.com" }, e);
    expect(res.status).toBe(202);
    const row = await env.DB.prepare("SELECT * FROM mail_log").first<any>();
    expect(row.error_code).toBe("E_RECIPIENT_SUPPRESSED");
  });

  it("rejects a malformed address", async () => {
    const res = await post("/auth/start", { email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("rate-limits repeated requests for one address", async () => {
    let last = 202;
    for (let i = 0; i < 8; i++) {
      last = (await post("/auth/start", { email: "dana@acme.com" })).status;
    }
    expect(last).toBe(429);
  });
});

describe("POST /auth/verify", () => {
  it("sets a hardened session cookie on the right code", async () => {
    await post("/auth/start", { email: "dana@acme.com" });
    const res = await post("/auth/verify", { email: "dana@acme.com", code: mailedCode() });
    expect(res.status).toBe(200);

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");

    const token = /rtfx_session=([^;]+)/.exec(cookie)![1];
    expect(await verifySession(SECRET, token, NOW())).toMatchObject({
      email: "dana@acme.com",
      kind: "member",
    });
  });

  it("refuses a wrong code and sets no cookie", async () => {
    await post("/auth/start", { email: "dana@acme.com" });
    const res = await post("/auth/verify", { email: "dana@acme.com", code: "000000" });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("creates the directory row and marks them active", async () => {
    await post("/auth/start", { email: "dana@acme.com" });
    await post("/auth/verify", { email: "dana@acme.com", code: mailedCode() });
    const row = await env.DB.prepare("SELECT * FROM users WHERE email = ?")
      .bind("dana@acme.com")
      .first<any>();
    expect(row.status).toBe("active");
    expect(row.last_seen_at).not.toBeNull();
  });

  it("cannot be replayed", async () => {
    await post("/auth/start", { email: "dana@acme.com" });
    const code = mailedCode();
    await post("/auth/verify", { email: "dana@acme.com", code });
    const second = await post("/auth/verify", { email: "dana@acme.com", code });
    expect(second.status).toBe(401);
  });
});

describe("GET /auth/m/:token", () => {
  /**
   * Gmail, Outlook Safe Links and corporate mail filters all fetch every URL in
   * a message before a human sees it. A GET that consumed the token meant the
   * scanner signed in and the recipient got "this link has expired" — observed
   * in production, 14 seconds after the first real send. GET must be inert.
   */
  it("does NOT consume the token — mail scanners prefetch links", async () => {
    await post("/auth/start", { email: "dana@acme.com" });
    const token = mailedToken();

    const scan = await app.request(`/auth/m/${token}`, {}, testEnv());
    expect(scan.status).toBe(200);
    expect(scan.headers.get("set-cookie")).toBeNull();

    const row = await env.DB.prepare("SELECT consumed_at FROM auth_challenges").first<any>();
    expect(row.consumed_at).toBeNull();

    // The human, arriving after the scanner, still gets in.
    const confirm = await app.request(`/auth/m/${token}`, { method: "POST" }, testEnv());
    expect(confirm.status).toBe(302);
    expect(confirm.headers.get("set-cookie") ?? "").toContain(`${SESSION_COOKIE}=`);
  });

  it("serves a confirm page a person can act on", async () => {
    await post("/auth/start", { email: "dana@acme.com" });
    const res = await app.request(`/auth/m/${mailedToken()}`, {}, testEnv());
    const body = await res.text();
    expect(body).toContain("<form");
    expect(body).toContain('method="post"');
  });

  it("refuses a link already confirmed", async () => {
    await post("/auth/start", { email: "dana@acme.com" });
    const token = mailedToken();
    await app.request(`/auth/m/${token}`, { method: "POST" }, testEnv());
    const again = await app.request(`/auth/m/${token}`, { method: "POST" }, testEnv());
    expect(again.status).toBe(401);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("refuses an unknown link", async () => {
    const res = await app.request("/auth/m/made-up-token", { method: "POST" }, testEnv());
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/signout", () => {
  it("clears the cookie", async () => {
    const res = await post("/auth/signout", {});
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("content host isolation", () => {
  it("never serves the auth endpoints", async () => {
    const e = testEnv({ CONTENT_HOSTNAMES: "a.rtfx.pro" });
    const res = await app.request(
      "https://a.rtfx.pro/auth/start",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      e
    );
    expect(res.status).toBe(404);
  });
});
