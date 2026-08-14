import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { mintSession, mintHandoff } from "../src/session";
import { initDb, clearR2, req, as } from "./fixtures";

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const APP = "https://rtfx.pro";
const CONTENT = "https://a.rtfx.pro";
const NOW = () => new Date().toISOString();

function e(extra: Record<string, unknown> = {}) {
  return {
    ...(env as any),
    SESSION_SECRET: SECRET,
    DEV_LOGIN: undefined,
    CONTENT_HOSTNAMES: "a.rtfx.pro",
    PUBLIC_BASE_URL: APP,
    ADMIN_EMAILS: "owner@rtfx.pro",
    ...extra,
  };
}

beforeEach(async () => {
  await initDb();
  await clearR2();
  const body = new FormData();
  body.set("slug", "demo");
  body.set("title", "Demo");
  body.set("visibility", "everyone");
  body.set("file", new File(["<h1>hi</h1>"], "index.html", { type: "text/html" }));
  await req("/api/artifacts", { method: "POST", body, ...as("owner@rtfx.pro") });
});

const nav = (extra: Record<string, string> = {}) => ({
  headers: { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", ...extra },
});

describe("content-host session handoff", () => {
  it("bounces an unidentified navigation to the app host to be identified", async () => {
    const res = await app.request(`${CONTENT}/demo/`, nav(), e());
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith(`${APP}/auth/content`)).toBe(true);
    expect(loc).toContain(encodeURIComponent(`${CONTENT}/demo/`));
  });

  it("mints a handoff for a signed-in caller and sends them back", async () => {
    const session = await mintSession(SECRET, { email: "owner@rtfx.pro", kind: "member" }, NOW());
    const res = await app.request(
      `${APP}/auth/content?next=${encodeURIComponent(`${CONTENT}/demo/`)}`,
      { headers: { Cookie: `${SESSION_COOKIE}=${session}` } },
      e()
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toMatch(/^https:\/\/a\.rtfx\.pro\/demo\/\?ct=/);
  });

  it("refuses to hand off to anywhere but a configured content host", async () => {
    const session = await mintSession(SECRET, { email: "owner@rtfx.pro", kind: "member" }, NOW());
    for (const evil of ["https://evil.example.com/x", "https://rtfx.pro.evil.com/", "//evil.com"]) {
      const res = await app.request(
        `${APP}/auth/content?next=${encodeURIComponent(evil)}`,
        { headers: { Cookie: `${SESSION_COOKIE}=${session}` } },
        e()
      );
      expect(res.status).toBe(400);
    }
  });

  it("sends a signed-out caller to sign in first", async () => {
    const res = await app.request(
      `${APP}/auth/content?next=${encodeURIComponent(`${CONTENT}/demo/`)}`,
      { headers: { Accept: "text/html" } },
      e()
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("exchanges the handoff for a cookie on the content host, then cleans the URL", async () => {
    const ct = await mintHandoff(SECRET, { email: "owner@rtfx.pro", kind: "member" }, NOW());
    const res = await app.request(`${CONTENT}/demo/?ct=${ct}`, nav(), e());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/demo/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Domain="); // host-only: never shared with the app host
  });

  it("refuses an expired or forged handoff", async () => {
    const stale = await mintHandoff(SECRET, { email: "x@y.com", kind: "member" }, "2020-01-01T00:00:00.000Z");
    expect((await app.request(`${CONTENT}/demo/?ct=${stale}`, nav(), e())).status).toBe(302);
    const forged = await mintHandoff("another-secret-that-is-32-bytes-long!!", { email: "x@y.com", kind: "member" }, NOW());
    const res = await app.request(`${CONTENT}/demo/?ct=${forged}`, nav(), e());
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("renders the artifact once the content cookie exists", async () => {
    const session = await mintSession(SECRET, { email: "owner@rtfx.pro", kind: "member" }, NOW());
    const res = await app.request(
      `${CONTENT}/demo/`,
      { headers: { ...nav().headers, Cookie: `${SESSION_COOKIE}=${session}` } },
      e()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<iframe");
  });

  it("does not bounce a machine client — it still gets 404, not a redirect", async () => {
    const res = await app.request(`${CONTENT}/demo/`, {}, e());
    expect(res.status).toBe(404);
  });
});
