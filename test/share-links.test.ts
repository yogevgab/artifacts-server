import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { mintSession } from "../src/session";
import { createShareLink, redeemShareLink, revokeShareLink, listShareLinks } from "../src/share";
import type { Env } from "../src/env";
import { createApiToken } from "../src/tokens";
import { initDb, clearR2, req, as, withToken } from "./fixtures";

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

  it("enforces API-token scopes on link management", async () => {
    const readOnly = await createApiToken(env as unknown as Env, {
      name: "read-only",
      ownerEmail: OWNER,
      accountId: null,
      isAdmin: false,
      scopes: ["read"],
      createdBy: OWNER,
      expiresAt: null,
      now: AT,
    });
    const manage = await createApiToken(env as unknown as Env, {
      name: "manager",
      ownerEmail: OWNER,
      accountId: null,
      isAdmin: false,
      scopes: ["manage"],
      createdBy: OWNER,
      expiresAt: null,
      now: AT,
    });

    const listed = await app.request("https://rtfx.pro/api/artifacts/report/links", withToken(readOnly.token), e());
    expect(listed.status).toBe(200);

    const refusedCreate = await app.request(
      "https://rtfx.pro/api/artifacts/report/links",
      withToken(readOnly.token, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
      e()
    );
    expect(refusedCreate.status).toBe(403);
    expect(await refusedCreate.json()).toMatchObject({ error: "insufficient_scope" });

    const created = await app.request(
      "https://rtfx.pro/api/artifacts/report/links",
      withToken(manage.token, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
      e()
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const refusedDelete = await app.request(
      `https://rtfx.pro/api/artifacts/report/links/${id}`,
      withToken(readOnly.token, { method: "DELETE" }),
      e()
    );
    expect(refusedDelete.status).toBe(403);

    const deleted = await app.request(
      `https://rtfx.pro/api/artifacts/report/links/${id}`,
      withToken(manage.token, { method: "DELETE" }),
      e()
    );
    expect(deleted.status).toBe(200);
  });
});

describe("the share panel offers links", () => {
  it("shows the link controls to someone who can manage", async () => {
    const cookie = `${SESSION_COOKIE}=${await mintSession(SECRET, { email: OWNER, kind: "member" }, new Date().toISOString())}`;
    const html = await (
      await app.request(
        "https://rtfx.pro/share/report",
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
    // Named per slug rather than pathed per slug: the chat socket lives at
    // /_chat/<slug>, which a cookie pathed to /<slug>/ can never reach.
    expect(cookie).toContain("rtfx_link_report=");
    expect(cookie).toContain("Path=/");
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

  /** Somebody who came by link is a reader of one artifact: no rtfx chrome. */
  it("shows a link visitor the artifact alone, with no rtfx bar", async () => {
    const k = (await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: new Date().toISOString() })).key;
    const first = await app.request(`https://a.rtfx.pro/report/?k=${k}`, {}, e());
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    const html = await (
      await app.request(
        "https://a.rtfx.pro/report/",
        { headers: { "Sec-Fetch-Dest": "document", Cookie: cookie } },
        e()
      )
    ).text();
    for (const hook of ["data-bar", "data-open-chat", "data-copy-link", "data-share-banner", "rtfx<span"]) {
      expect(html, `${hook} should not be shown to a link visitor`).not.toContain(hook);
    }
    const frame = /<iframe[^>]*>/.exec(html)?.[0] ?? "";
    expect(frame).toContain("sandbox=");
    expect(frame).not.toContain("allow-same-origin");
    expect(frame).toMatch(/src="\/report\/~t\/[^/]+\/\?raw=1"/);
  });

  it("keeps the rtfx bar for a signed-in viewer who did not come by link", async () => {
    const cookie = `${SESSION_COOKIE}=${await mintSession(SECRET, { email: OWNER, kind: "member" }, new Date().toISOString())}`;
    const html = await (
      await app.request(
        "https://a.rtfx.pro/report/",
        { headers: { "Sec-Fetch-Dest": "document", Cookie: cookie } },
        e()
      )
    ).text();
    expect(html).toContain("data-bar");
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

describe("deleting an artifact takes its share links with it", () => {
  /**
   * Otherwise a revoked-by-deletion artifact leaves live link rows in D1. They
   * cannot open anything (the artifact is gone), but a slug republished later
   * under the same name would inherit somebody else's old links.
   */
  it("leaves no orphaned links behind", async () => {
    await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: AT });
    expect(await listShareLinks(env as any, "report")).toHaveLength(1);

    const res = await req("/api/artifacts/report", { method: "DELETE", ...as(OWNER) });
    expect(res.status).toBeLessThan(300);

    expect(await listShareLinks(env as any, "report")).toHaveLength(0);
  });
})

/**
 * Pasting a share link into X / WhatsApp / iMessage / Slack used to preview as a
 * bare URL: the crawler got a redirect and a cookie it never keeps.
 */
describe("share-link previews for link-card crawlers", () => {
  const CRAWLERS = [
    "Twitterbot/1.0",
    "facebookexternalhit/1.1 Facebot Twitterbot/1.0", // iMessage
    "WhatsApp/2.23.20.0",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "LinkedInBot/1.0 (compatible; Mozilla/5.0)",
  ];
  const describeArtifact = (text: string) =>
    env.DB.prepare("UPDATE artifacts SET title = ?, description = ? WHERE slug = 'report'")
      .bind("Dorai <Raz> Portfolio", text)
      .run();

  it("gives each crawler the artifact's title and description", async () => {
    await describeArtifact('Product work & "drawings"');
    const k = (await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: new Date().toISOString() })).key;
    for (const ua of CRAWLERS) {
      const res = await app.request(`https://a.rtfx.pro/report/?k=${k}`, { headers: { "User-Agent": ua } }, e());
      expect(res.status, ua).toBe(200);
      const html = await res.text();
      expect(html, ua).toContain('<meta property="og:title" content="Dorai &lt;Raz&gt; Portfolio">');
      expect(html, ua).toContain('<meta name="twitter:description" content="Product work &amp; &quot;drawings&quot;">');
      expect(html, ua).toContain('<meta name="twitter:card" content="summary">');
      expect(html, ua).toContain("/logo-128.png");
      expect(html, ua).toContain('<meta property="og:image:width" content="128">');
      // The key is already in the message; it is not repeated as a canonical URL.
      expect(html, ua).not.toContain("og:url");
      expect(html, ua).not.toContain(k);
    }
  });

  it("falls back to a neutral description when the artifact has none", async () => {
    await env.DB.prepare("UPDATE artifacts SET description = NULL WHERE slug = 'report'").run();
    const k = (await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: new Date().toISOString() })).key;
    const html = await (
      await app.request(`https://a.rtfx.pro/report/?k=${k}`, { headers: { "User-Agent": "Twitterbot/1.0" } }, e())
    ).text();
    expect(html).toContain('content="Shared with you on rtfx.pro."');
  });

  it("keeps the redirect for a browser and for a non-crawler client", async () => {
    const k = (await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: new Date().toISOString() })).key;
    const browser = await app.request(
      `https://a.rtfx.pro/report/?k=${k}`,
      { headers: { "Sec-Fetch-Dest": "document", "User-Agent": "Mozilla/5.0 Twitterbot-lookalike" } },
      e()
    );
    expect(browser.status).toBe(302);
    const cli = await app.request(`https://a.rtfx.pro/report/?k=${k}`, { headers: { "User-Agent": "curl/8.4" } }, e());
    expect(cli.status).toBe(302);
  });

  it("reveals nothing without a valid key", async () => {
    await describeArtifact("secret plans");
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: new Date().toISOString() });
    await revokeShareLink(env as any, "report", link.id, new Date().toISOString());
    for (const url of [
      `https://a.rtfx.pro/report/?k=${link.key}`,
      "https://a.rtfx.pro/report/",
      "https://a.rtfx.pro/report/?k=not-a-real-key",
    ]) {
      const res = await app.request(url, { headers: { "User-Agent": "Twitterbot/1.0" } }, e());
      const html = await res.text();
      expect(res.status, url).not.toBe(200);
      expect(html, url).not.toContain("secret plans");
      expect(html, url).not.toContain("Dorai");
    }
  });
});
