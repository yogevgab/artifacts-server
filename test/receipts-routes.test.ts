import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { receiptsRoutes } from "../src/receipts-routes";
import { SESSION_COOKIE } from "../src/auth";
import { mintSession } from "../src/session";
import { initDb, clearR2, req, as } from "./fixtures";

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const OWNER = "owner@rtfx.pro";
const STRANGER = "nobody@x.com";
const AT = "2026-08-14T12:00:00.000Z";

function e(extra: Record<string, unknown> = {}) {
  return {
    ...(env as any),
    SESSION_SECRET: SECRET,
    DEV_LOGIN: undefined,
    ADMIN_EMAILS: "admin@rtfx.pro",
    ...extra,
  };
}

async function cookieFor(email: string) {
  return `${SESSION_COOKIE}=${await mintSession(SECRET, { email, kind: "member" }, AT)}`;
}

beforeEach(async () => {
  await initDb();
  await clearR2();
  const body = new FormData();
  body.set("slug", "report");
  body.set("title", "Q3 Report");
  body.set("visibility", "restricted");
  body.set("file", new File(["<h1>secret</h1>"], "index.html", { type: "text/html" }));
  await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
});

describe("GET /api/artifacts/:slug/receipts", () => {
  it("defaults to enabled", async () => {
    const res = await receiptsRoutes.request(
      "/api/artifacts/report/receipts",
      { headers: { Cookie: await cookieFor(OWNER) } },
      e()
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
  });

  it("404s for somebody who cannot manage the artifact", async () => {
    const res = await receiptsRoutes.request(
      "/api/artifacts/report/receipts",
      { headers: { Cookie: await cookieFor(STRANGER) } },
      e()
    );
    expect(res.status).toBe(404);
  });

  it("404s for an unknown slug", async () => {
    const res = await receiptsRoutes.request(
      "/api/artifacts/nosuchslug/receipts",
      { headers: { Cookie: await cookieFor(OWNER) } },
      e()
    );
    expect(res.status).toBe(404);
  });

  it("requires a signed-in caller", async () => {
    const res = await receiptsRoutes.request("/api/artifacts/report/receipts", {}, e());
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/artifacts/:slug/receipts", () => {
  it("lets the owner turn it off and back on", async () => {
    const off = await receiptsRoutes.request(
      "/api/artifacts/report/receipts",
      {
        method: "PUT",
        headers: { Cookie: await cookieFor(OWNER), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
      e()
    );
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ enabled: false });

    const row = await env.DB.prepare("SELECT read_receipts FROM artifacts WHERE slug = ?")
      .bind("report")
      .first<any>();
    expect(row.read_receipts).toBe(0);

    const on = await receiptsRoutes.request(
      "/api/artifacts/report/receipts",
      {
        method: "PUT",
        headers: { Cookie: await cookieFor(OWNER), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
      e()
    );
    expect(await on.json()).toEqual({ enabled: true });
  });

  it("refuses a stranger", async () => {
    const res = await receiptsRoutes.request(
      "/api/artifacts/report/receipts",
      {
        method: "PUT",
        headers: { Cookie: await cookieFor(STRANGER), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
      e()
    );
    expect(res.status).toBe(404);
  });

  it("rejects a non-boolean body", async () => {
    const res = await receiptsRoutes.request(
      "/api/artifacts/report/receipts",
      {
        method: "PUT",
        headers: { Cookie: await cookieFor(OWNER), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: "yes" }),
      },
      e()
    );
    expect(res.status).toBe(400);
  });
});
