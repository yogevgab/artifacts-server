import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { mintSession } from "../src/session";
import { createShareLink, redeemShareLink, revokeShareLink, listShareLinks } from "../src/share";
import { initDb, clearR2, req, as } from "./fixtures";

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const OWNER = "owner@rtfx.pro";
const AT = "2026-08-14T12:00:00.000Z";
const later = (h: number) => new Date(Date.parse(AT) + h * 3600_000).toISOString();

function e(extra: Record<string, unknown> = {}) {
  return {
    ...(env as any),
    SESSION_SECRET: SECRET,
    DEV_LOGIN: undefined,
    CONTENT_HOSTNAMES: "a.rtfx.pro",
    PUBLIC_BASE_URL: "https://rtfx.pro",
    ADMIN_EMAILS: OWNER,
    ...extra,
  };
}

beforeEach(async () => {
  await initDb();
  await clearR2();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS share_links (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, token_hash TEXT NOT NULL,
      created_by TEXT NOT NULL, expires_at TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL, last_used_at TEXT)`
  ).run();
  await env.DB.prepare("DELETE FROM share_links").run();
  const body = new FormData();
  body.set("slug", "report");
  body.set("title", "Report");
  body.set("visibility", "restricted");
  body.set("file", new File(["<h1>secret</h1>"], "index.html", { type: "text/html" }));
  await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
});

describe("share link lifecycle", () => {
  it("mints a link and stores only a hash of it", async () => {
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: AT });
    expect(link.key).toContain(".");
    const row = await env.DB.prepare("SELECT * FROM share_links").first<any>();
    expect(row.token_hash).not.toBe(link.key);
    expect(JSON.stringify(row)).not.toContain(link.key.split(".")[1]);
  });

  it("redeems a valid key for its slug", async () => {
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: AT });
    expect(await redeemShareLink(env as any, link.key, AT)).toMatchObject({ slug: "report" });
  });

  it("is reusable — a capability URL is not a one-time code", async () => {
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: AT });
    expect(await redeemShareLink(env as any, link.key, AT)).not.toBeNull();
    expect(await redeemShareLink(env as any, link.key, AT)).not.toBeNull();
  });

  it("refuses a revoked link immediately", async () => {
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: AT });
    await revokeShareLink(env as any, "report", link.id, AT);
    expect(await redeemShareLink(env as any, link.key, AT)).toBeNull();
  });

  it("refuses an expired link", async () => {
    const link = await createShareLink(env as any, {
      slug: "report", createdBy: OWNER, now: AT, expiresAt: later(1),
    });
    expect(await redeemShareLink(env as any, link.key, later(2))).toBeNull();
  });

  it("refuses a forged key and one whose id does not exist", async () => {
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: AT });
    const [id] = link.key.split(".");
    expect(await redeemShareLink(env as any, `${id}.wrong-secret`, AT)).toBeNull();
    expect(await redeemShareLink(env as any, "nosuchid.whatever", AT)).toBeNull();
    expect(await redeemShareLink(env as any, "garbage", AT)).toBeNull();
  });

  it("lists links for an artifact without ever exposing the secret", async () => {
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: AT });
    const rows = await listShareLinks(env as any, "report");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(link.key.split(".")[1]);
  });
});

describe("opening an artifact with a share link", () => {
  async function key() {
    return (await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: new Date().toISOString() })).key;
  }

  it("opens the artifact for somebody with no identity at all", async () => {
    // Two steps by design: the key is exchanged for a path-scoped cookie so the
    // frame and every asset inside the artifact are authorized too.
    const first = await app.request(
      `https://a.rtfx.pro/report/?k=${await key()}`,
      { headers: { "Sec-Fetch-Dest": "document" } },
      e()
    );
    expect(first.status).toBe(302);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];

    const res = await app.request(
      "https://a.rtfx.pro/report/",
      { headers: { "Sec-Fetch-Dest": "document", Cookie: cookie } },
      e()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<iframe");
  });

  it("gives that viewer no share banner — a link is not ownership", async () => {
    const res = await app.request(
      `https://a.rtfx.pro/report/?k=${await key()}`,
      { headers: { "Sec-Fetch-Dest": "document" } },
      e()
    );
    expect(await res.text()).not.toContain("data-share-banner");
  });

  it("does not open a different artifact", async () => {
    const body = new FormData();
    body.set("slug", "other");
    body.set("title", "Other");
    body.set("visibility", "restricted");
    body.set("file", new File(["<p>x</p>"], "index.html", { type: "text/html" }));
    await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
    const res = await app.request(
      `https://a.rtfx.pro/other/?k=${await key()}`,
      { headers: { "Sec-Fetch-Dest": "document" } },
      e()
    );
    // A link for one artifact does not open another. It falls through to the
    // ordinary unidentified path — which offers a sign-in rather than a dead
    // end, and reveals nothing about whether the slug exists.
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("<iframe");
  });

  it("refuses a revoked link at the door", async () => {
    const k = await key();
    const [id] = k.split(".");
    await revokeShareLink(env as any, "report", id, new Date().toISOString());
    const res = await app.request(
      `https://a.rtfx.pro/report/?k=${k}`,
      { headers: { "Sec-Fetch-Dest": "document" } },
      e()
    );
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("<iframe");
    // Revocation is immediate: no grace period, no cache.
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("managing share links over the API", () => {
  const owner = async () =>
    `${SESSION_COOKIE}=${await mintSession(SECRET, { email: OWNER, kind: "member" }, new Date().toISOString())}`;

  it("lets an owner create one", async () => {
    const res = await app.request(
      "https://rtfx.pro/api/artifacts/report/links",
      { method: "POST", headers: { Cookie: await owner(), "Content-Type": "application/json" }, body: "{}" },
      e()
    );
    expect(res.status).toBe(201);
    const j = (await res.json()) as any;
    expect(j.url).toContain("a.rtfx.pro/report/?k=");
  });

  it("refuses somebody who cannot manage the artifact", async () => {
    const stranger = `${SESSION_COOKIE}=${await mintSession(SECRET, { email: "nobody@x.com", kind: "member" }, new Date().toISOString())}`;
    const res = await app.request(
      "https://rtfx.pro/api/artifacts/report/links",
      { method: "POST", headers: { Cookie: stranger, "Content-Type": "application/json" }, body: "{}" },
      e()
    );
    expect(res.status).toBe(404);
  });

  it("refuses a guest outright", async () => {
    const guest = `${SESSION_COOKIE}=${await mintSession(SECRET, { email: "g@x.com", kind: "guest", slug: "report" }, new Date().toISOString())}`;
    const res = await app.request(
      "https://rtfx.pro/api/artifacts/report/links",
      { method: "POST", headers: { Cookie: guest, "Content-Type": "application/json" }, body: "{}" },
      e()
    );
    expect(res.status).toBeGreaterThanOrEqual(403);
  });
});

describe("the share panel offers links", () => {
  it("shows the link controls to someone who can manage", async () => {
    const cookie = `${SESSION_COOKIE}=${await mintSession(SECRET, { email: OWNER, kind: "member" }, new Date().toISOString())}`;
    const html = await (
      await app.request(
        "https://a.rtfx.pro/report/",
        { headers: { "Sec-Fetch-Dest": "document", Cookie: cookie } },
        e()
      )
    ).text();
    expect(html).toContain("data-make-link");
    expect(html).toContain("data-link-list");
  });
});

describe("a share link authorizes the whole artifact, not just its entry", () => {
  /**
   * Regression found in a real browser: the shell's frame URL does not carry
   * ?k=, and neither does a relative <img src> inside an artifact. So a link
   * opened index.html and then 404'd on everything it referenced. The key is
   * exchanged once for a cookie scoped to that artifact's path.
   */
  it("sets a path-scoped cookie when the key is presented", async () => {
    const k = (await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: new Date().toISOString() })).key;
    const res = await app.request(
      `https://a.rtfx.pro/report/?k=${k}`,
      { headers: { "Sec-Fetch-Dest": "document" } },
      e()
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/report/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("Path=/report/");
    expect(cookie).toContain("HttpOnly");
  });

  it("authorizes subresources from that cookie alone", async () => {
    const k = (await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: new Date().toISOString() })).key;
    const first = await app.request(`https://a.rtfx.pro/report/?k=${k}`, {}, e());
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];

    // No key in the URL at all — exactly what a relative asset request looks like.
    const asset = await app.request(
      "https://a.rtfx.pro/report/",
      { headers: { Cookie: cookie } },
      e()
    );
    expect(asset.status).toBe(200);
  });

  it("does not let that cookie open a different artifact", async () => {
    const body = new FormData();
    body.set("slug", "other");
    body.set("title", "Other");
    body.set("visibility", "restricted");
    body.set("file", new File(["<p>x</p>"], "index.html", { type: "text/html" }));
    await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });

    const k = (await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: new Date().toISOString() })).key;
    const first = await app.request(`https://a.rtfx.pro/report/?k=${k}`, {}, e());
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];

    const res = await app.request("https://a.rtfx.pro/other/", { headers: { Cookie: cookie } }, e());
    expect(res.status).not.toBe(200);
  });

  it("stops working the moment the link is revoked", async () => {
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: new Date().toISOString() });
    const first = await app.request(`https://a.rtfx.pro/report/?k=${link.key}`, {}, e());
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    await revokeShareLink(env as any, "report", link.id, new Date().toISOString());
    const res = await app.request("https://a.rtfx.pro/report/", { headers: { Cookie: cookie } }, e());
    expect(res.status).not.toBe(200);
  });
});
