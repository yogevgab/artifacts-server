import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { verifySession, mintSession } from "../src/session";

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

/**
 * The sign-in detour that `claude mcp login` depends on.
 *
 * `/oauth/authorize` bounces a signed-out visitor to `/login?next=…`. Until this
 * wiring existed the bounce was one-way: the person signed in and landed on
 * `/admin` while the MCP client waited for a callback that never came. These
 * tests pin the round trip *and* the open-redirect refusals, because the thing
 * on the other side of it is a freshly minted session.
 */
describe("?next= round trip", () => {
  const AUTHZ = "/oauth/authorize?client_id=abc&response_type=code&state=xyz";
  const parked = (res: Response) =>
    (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("rtfx_next=")) ?? "";

  async function signedIn() {
    const token = await mintSession(SECRET, { email: "dana@acme.com", kind: "member" }, NOW());
    return { Cookie: `${SESSION_COOKIE}=${token}` };
  }

  it("parks a local next in a short-lived host-only cookie", async () => {
    const res = await app.request(`/login?next=${encodeURIComponent(AUTHZ)}`, {}, testEnv());
    expect(res.status).toBe(200);
    const cookie = parked(res);
    expect(cookie).toContain(encodeURIComponent(AUTHZ));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    // No Domain attribute: it must not reach the content host, and on a
    // multi-host instance it belongs to the host the sign-in started on.
    expect(cookie.toLowerCase()).not.toContain("domain=");
  });

  /** An abandoned authorization must not hijack an ordinary sign-in later. */
  it("clears a stale parked destination when /login is opened without one", async () => {
    const res = await app.request("/login", {}, testEnv());
    expect(parked(res)).toContain("Max-Age=0");
  });

  it("refuses to park anything that could name another host", async () => {
    for (const hostile of ["https://evil.example.com/", "//evil.example.com", "/\\evil.example.com"]) {
      const res = await app.request(`/login?next=${encodeURIComponent(hostile)}`, {}, testEnv());
      expect(res.status, hostile).toBe(200);
      expect(parked(res), hostile).toContain("Max-Age=0");
    }
  });

  it("sends an already-signed-in visitor straight on, rather than to a dead-end sheet", async () => {
    const res = await app.request(
      `/login?next=${encodeURIComponent(AUTHZ)}`,
      { headers: await signedIn() },
      testEnv()
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(AUTHZ);
  });

  it("will not redirect a signed-in visitor off-origin", async () => {
    const res = await app.request(
      `/login?next=${encodeURIComponent("https://evil.example.com/")}`,
      { headers: await signedIn() },
      testEnv()
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("returns the parked destination from the typed-code sign-in, and clears it", async () => {
    await post("/auth/start", { email: "dana@acme.com" });
    const res = await app.request(
      "/auth/verify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `rtfx_next=${encodeURIComponent(AUTHZ)}`,
        },
        body: JSON.stringify({ email: "dana@acme.com", code: mailedCode() }),
      },
      testEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, redirect: AUTHZ });

    const cookies = res.headers.getSetCookie?.() ?? [];
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith("rtfx_next=") && c.includes("Max-Age=0"))).toBe(true);
  });

  /**
   * The emailed link has nowhere to carry a destination — it is a bare token —
   * which is the whole reason the cookie exists rather than a challenge column.
   */
  it("returns the parked destination from the magic link too", async () => {
    await post("/auth/start", { email: "dana@acme.com" });
    const res = await app.request(
      `/auth/m/${mailedToken()}`,
      { method: "POST", headers: { Cookie: `rtfx_next=${encodeURIComponent(AUTHZ)}` } },
      testEnv()
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(AUTHZ);
  });

  /** Re-validated on the way out: a tampered cookie is worth no more than none. */
  it("ignores a parked destination that names another host", async () => {
    await post("/auth/start", { email: "dana@acme.com" });
    const res = await app.request(
      "/auth/verify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `rtfx_next=${encodeURIComponent("https://evil.example.com/")}`,
        },
        body: JSON.stringify({ email: "dana@acme.com", code: mailedCode() }),
      },
      testEnv()
    );
    expect(await res.json()).toMatchObject({ redirect: "/admin" });
  });
});

/**
 * Which origin a sign-in email points back at.
 *
 * The session cookie is host-only, so a sign-in started on `mcp.rtfx.pro` — mid
 * `claude mcp login` — has to finish there. A link to `rtfx.pro` would sign the
 * person in somewhere their consent screen cannot see.
 */
describe("sign-in email origin", () => {
  const mailedOrigin = () =>
    new URL(/https?:\/\/\S+\/auth\/m\/[A-Za-z0-9_-]+/.exec(sent[0]?.text ?? "")![0]).origin;

  const startOn = (url: string) =>
    app.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "dana@acme.com" }) },
      testEnv({ PUBLIC_BASE_URL: "https://rtfx.pro" })
    );

  it("points back at the app host the sign-in started on", async () => {
    await startOn("https://mcp.rtfx.pro/auth/start");
    expect(mailedOrigin()).toBe("https://mcp.rtfx.pro");
  });

  it("uses the canonical origin for the canonical host", async () => {
    await startOn("https://rtfx.pro/auth/start");
    expect(mailedOrigin()).toBe("https://rtfx.pro");
  });

  /**
   * The guard that keeps an outgoing email boring: a host outside the canonical
   * site's domain never gets its own address into a message we send.
   */
  it("falls back to the canonical origin for a host outside the site's domain", async () => {
    await startOn("https://preview.example.com/auth/start");
    expect(mailedOrigin()).toBe("https://rtfx.pro");
  });

  it("never mails a link to the content host", async () => {
    await app.request(
      "https://a.rtfx.pro/auth/start",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "dana@acme.com" }) },
      testEnv({ PUBLIC_BASE_URL: "https://rtfx.pro", CONTENT_HOSTNAMES: "a.rtfx.pro" })
    );
    // The content host does not serve /auth at all, so nothing is sent — the
    // origin guard in `signinOrigin` is the second line, not the first.
    expect(sent).toHaveLength(0);
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

describe("GET /logout", () => {
  /**
   * Regression: /logout predates app-owned sessions and only expired
   * Cloudflare's cookies, so after the Plan 2 sign-in it left you signed in.
   * Reported from production.
   */
  it("expires the app session cookie, not just Cloudflare's", async () => {
    const res = await app.request("/logout", {}, testEnv());
    expect(res.status).toBe(302);

    const cookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
    const joined = cookies.join(" | ");

    expect(joined).toContain(`${SESSION_COOKIE}=`);
    const ours = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    expect(ours).toContain("Max-Age=0");
    expect(ours).toContain("HttpOnly");

    // Still clears the Access cookies — dual-accept means both must go.
    expect(joined).toContain("CF_Authorization=");
  });

  it("actually de-authenticates: the cleared cookie no longer resolves", async () => {
    const res = await app.request("/logout", {}, testEnv());
    const ours =
      (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    const value = /rtfx_session=([^;]*)/.exec(ours)?.[1] ?? "x";
    expect(value).toBe("");
    expect(await verifySession(SECRET, value, NOW())).toBeNull();
  });
});

describe("signed-out access to a dashboard page", () => {
  const browser = { headers: { Accept: "text/html,application/xhtml+xml" } };

  /**
   * Regression exposed by the Cloudflare Access cutover: Access used to bounce
   * anonymous visitors to a login screen before the Worker saw them. With Access
   * gone, /admin answered raw JSON to a person typing the URL.
   */
  it("sends a signed-out browser to /login, not a JSON 403", async () => {
    const res = await app.request("/admin", browser, testEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("still answers JSON to a machine client", async () => {
    const res = await app.request("/admin", {}, testEnv());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
  });

  it("does not redirect a caller who IS signed in but may not be here", async () => {
    // A guest holds a valid session. Sending them to /login would loop forever,
    // because signing in again changes nothing about what they may reach.
    const token = await mintSession(SECRET, { email: "g@x.com", kind: "guest" }, NOW());
    const res = await app.request(
      "/admin",
      { headers: { ...browser.headers, Cookie: `${SESSION_COOKIE}=${token}` } },
      testEnv()
    );
    expect(res.status).toBe(403);
  });
});
