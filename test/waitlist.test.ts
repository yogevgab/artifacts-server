import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { normalizeEmail } from "../src/waitlist";

async function initDb() {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS waitlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`
  ).run();
  await env.DB.prepare("DELETE FROM waitlist").run();
}

beforeEach(async () => {
  await initDb();
});

const req = (path: string, init?: RequestInit) => app.request(path, init, env as any);

const postEmail = (body: unknown, init?: RequestInit) =>
  req("/waitlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });

describe("normalizeEmail", () => {
  it("trims and lowercases valid emails", () => {
    expect(normalizeEmail(" Foo@Bar.com ")).toBe("foo@bar.com");
  });
  it("rejects non-string input", () => {
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });
  it("rejects empty or missing", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
  });
  it("rejects malformed addresses", () => {
    expect(normalizeEmail("no-at-sign.com")).toBeNull();
    expect(normalizeEmail("foo@bar")).toBeNull();
    expect(normalizeEmail("foo@bar.")).toBeNull();
    expect(normalizeEmail("@bar.com")).toBeNull();
    expect(normalizeEmail("foo @bar.com")).toBeNull();
  });
  it("rejects addresses over 254 chars", () => {
    const long = `${"a".repeat(250)}@b.co`;
    expect(long.length).toBeGreaterThan(254);
    expect(normalizeEmail(long)).toBeNull();
  });
});

describe("POST /waitlist", () => {
  it("joins a new email", async () => {
    const res = await postEmail({ email: "new@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "joined" });
  });

  it("reports already for a repeat submission and does not duplicate the row", async () => {
    await postEmail({ email: "dup@example.com" });
    const res = await postEmail({ email: "dup@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "already" });

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE email = ?")
      .bind("dup@example.com")
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("collides case/whitespace variants with the canonical email", async () => {
    await postEmail({ email: "foo@bar.com" });
    const res = await postEmail({ email: " Foo@Bar.com " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "already" });

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("rejects missing email", async () => {
    const res = await postEmail({});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
  });

  it("rejects empty email", async () => {
    const res = await postEmail({ email: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
  });

  it("rejects an email with no @", async () => {
    const res = await postEmail({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
  });

  it("rejects an email with no dot in the domain", async () => {
    const res = await postEmail({ email: "foo@bar" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
  });

  it("rejects an email over 254 chars", async () => {
    const long = `${"a".repeat(250)}@b.co`;
    const res = await postEmail({ email: long });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
  });

  it("rejects a non-JSON body with 400, not 500", async () => {
    const res = await postEmail("not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
  });

  it("rejects a missing body with 400, not 500", async () => {
    const res = await app.request(
      "/waitlist",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      env as any
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
  });
});

describe("GET /waitlist", () => {
  it("redirects to /#waitlist", async () => {
    const res = await req("/waitlist", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/#waitlist");
  });
});
