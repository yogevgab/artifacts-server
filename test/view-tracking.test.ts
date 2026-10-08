import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { mintSession } from "../src/session";
import { createShareLink, revokeShareLink, inspectShareLink } from "../src/share";
import { eraseOldIps, listViewEvents, logView, ipCutoff } from "../src/db";
import { IP_RETENTION_DAYS, parseUserAgent, captureViewContext } from "../src/view-context";
import { initDb, clearR2, req, as } from "./fixtures";

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const OWNER = "owner@rtfx.pro";
const DAY = 86_400_000;

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

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const NOW = () => new Date().toISOString();
const cookieFor = async (email: string) =>
  `${SESSION_COOKIE}=${await mintSession(SECRET, { email, kind: "member" }, NOW())}`;

async function mint(opts: { expiresAt?: string | null } = {}) {
  return createShareLink(env as any, { slug: "report", createdBy: OWNER, now: NOW(), expiresAt: opts.expiresAt ?? null });
}

/** Open a link the way a browser does: the ?k= hop, then the clean URL with the cookie. */
async function openLink(key: string, headers: Record<string, string> = {}) {
  const h = { "Sec-Fetch-Dest": "document", "User-Agent": IPHONE, "CF-Connecting-IP": "203.0.113.7", ...headers };
  const first = await app.request(`https://a.rtfx.pro/report/?k=${key}`, { headers: h }, e());
  const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
  const second = cookie
    ? await app.request("https://a.rtfx.pro/report/", { headers: { ...h, Cookie: cookie } }, e())
    : null;
  return { first, second };
}

const rows = async (where = "1=1") =>
  (await env.DB.prepare(`SELECT * FROM artifact_views WHERE ${where} ORDER BY id`).all<any>()).results ?? [];

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

describe("user-agent parsing", () => {
  const cases: [string, string, string | null, string | null, string | null][] = [
    ["iPhone Safari", IPHONE, "mobile", "iOS", "Safari"],
    [
      "iPad Safari",
      "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      "tablet", "iOS", "Safari",
    ],
    [
      "Android Chrome phone",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
      "mobile", "Android", "Chrome",
    ],
    [
      "Android Chrome tablet",
      "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "tablet", "Android", "Chrome",
    ],
    [
      "Mac Chrome",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "desktop", "macOS", "Chrome",
    ],
    [
      "Mac Safari",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      "desktop", "macOS", "Safari",
    ],
    [
      "Mac Firefox",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0",
      "desktop", "macOS", "Firefox",
    ],
    [
      "Windows Edge",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
      "desktop", "Windows", "Edge",
    ],
    ["WhatsApp", "WhatsApp/2.23.20.0 A", "bot", null, "WhatsApp"],
    ["Twitterbot", "Twitterbot/1.0", "bot", null, "Twitterbot"],
    ["facebookexternalhit", "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "bot", null, "Facebook"],
    ["empty", "", null, null, null],
  ];
  for (const [name, ua, device, os, browser] of cases) {
    it(name, () => expect(parseUserAgent(ua)).toEqual({ device, os, browser }));
  }

  it("reads the IP from CF-Connecting-IP, then the first X-Forwarded-For hop, and tolerates no request.cf", () => {
    const a = captureViewContext(new Request("https://x/", { headers: { "CF-Connecting-IP": "1.2.3.4", "User-Agent": IPHONE } }));
    expect(a).toMatchObject({ ip: "1.2.3.4", country: null, city: null, device: "mobile" });
    const b = captureViewContext(new Request("https://x/", { headers: { "X-Forwarded-For": "9.9.9.9, 8.8.8.8" } }));
    expect(b.ip).toBe("9.9.9.9");
    const c = captureViewContext(new Request("https://x/"));
    expect(c.ip).toBeNull();
  });

  it("truncates the stored user agent", () => {
    const c = captureViewContext(new Request("https://x/", { headers: { "User-Agent": "A".repeat(2000) } }));
    expect(c.user_agent!.length).toBe(300);
  });
});

describe("share-link views", () => {
  it("records one 'viewed' row at the shell render, with link, ip and device, and no email", async () => {
    const link = await mint();
    const { first, second } = await openLink(link.key);
    expect(first.status).toBe(302);
    expect(second!.status).toBe(200);
    const r = await rows();
    expect(r).toHaveLength(1); // the ?k= hop is not a second row
    expect(r[0]).toMatchObject({
      slug: "report",
      outcome: "viewed",
      email: null,
      link_id: link.id,
      ip: "203.0.113.7",
      device: "mobile",
      os: "iOS",
      browser: "Safari",
    });
    expect(r[0].user_agent).toBe(IPHONE);
  });

  /** Sec-Fetch-Dest is client-controlled: a link holder looping requests must not flood the log. */
  it("counts reloads of a link from the same IP within the window as one view", async () => {
    const link = await mint();
    const { first } = await openLink(link.key);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    for (let i = 0; i < 5; i++) {
      await app.request(
        "https://a.rtfx.pro/report/",
        { headers: { Cookie: cookie, "Sec-Fetch-Dest": "document", "CF-Connecting-IP": "203.0.113.7", "User-Agent": IPHONE } },
        e()
      );
    }
    expect(await rows()).toHaveLength(1);
  });

  it("does not log the framed raw request again, only the top-level document", async () => {
    const link = await mint();
    const { first } = await openLink(link.key);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    await app.request("https://a.rtfx.pro/report/?raw=1", { headers: { Cookie: cookie } }, e());
    expect(await rows()).toHaveLength(1); // still just the shell render from openLink
  });

  it("records the signed-in email when the visitor also holds a session, and sends no mail", async () => {
    const link = await mint();
    const { first } = await openLink(link.key);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    await app.request(
      "https://a.rtfx.pro/report/",
      { headers: { "Sec-Fetch-Dest": "document", Cookie: `${cookie}; ${await cookieFor("dana@x.com")}` } },
      e()
    );
    const r = await rows("email = 'dana@x.com'");
    expect(r).toHaveLength(1);
    expect(await rows()).toHaveLength(2); // plus the anonymous open from openLink
    expect(r[0]).toMatchObject({ email: "dana@x.com", link_id: link.id });
    const mail = await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_log").first<any>().catch(() => ({ n: 0 }));
    expect(mail.n).toBe(0);
  });

  it("does not meter link views against the view count, previews or attempts included", async () => {
    const link = await mint();
    await openLink(link.key);
    const res = await app.request(
      "https://rtfx.pro/api/artifacts/report/views",
      { headers: { Cookie: await cookieFor(OWNER) } },
      e()
    );
    const j = (await res.json()) as any;
    expect(j.total).toBe(1); // owner-facing total counts real opens only
    expect(j.views).toHaveLength(1);
    expect(j.views[0]).toMatchObject({ outcome: "viewed", link_id: link.id, ip: "203.0.113.7", device: "mobile" });
  });
});

describe("link-card previews", () => {
  it("records 'preview' as a bot, once per window", async () => {
    const link = await mint();
    const h = { "User-Agent": "WhatsApp/2.23.20.0 A", "CF-Connecting-IP": "198.51.100.9" };
    for (let i = 0; i < 3; i++) {
      const res = await app.request(`https://a.rtfx.pro/report/?k=${link.key}`, { headers: h }, e());
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("og:title");
    }
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ outcome: "preview", device: "bot", link_id: link.id, email: null });
  });
});

describe("attempts with a dead link", () => {
  const nav = { "Sec-Fetch-Dest": "document", "User-Agent": IPHONE, "CF-Connecting-IP": "203.0.113.50" };

  it("records 'link_expired' with the link id, and the visitor's experience is unchanged", async () => {
    const link = await mint({ expiresAt: new Date(Date.now() - DAY).toISOString() });
    const res = await app.request(`https://a.rtfx.pro/report/?k=${link.key}`, { headers: nav }, e());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/content"); // still the sign-in bounce
    expect(res.headers.get("set-cookie")).toBeNull();
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ outcome: "link_expired", link_id: link.id, email: null, ip: "203.0.113.50" });
  });

  it("records 'link_revoked'", async () => {
    const link = await mint();
    await revokeShareLink(env as any, "report", link.id, NOW());
    await app.request(`https://a.rtfx.pro/report/?k=${link.key}`, { headers: nav }, e());
    expect((await rows())[0]).toMatchObject({ outcome: "link_revoked", link_id: link.id });
  });

  it("records a crawler hitting an expired link, too", async () => {
    const link = await mint({ expiresAt: new Date(Date.now() - DAY).toISOString() });
    await app.request(
      `https://a.rtfx.pro/report/?k=${link.key}`,
      { headers: { "User-Agent": "Twitterbot/1.0", "CF-Connecting-IP": "192.0.2.1" } },
      e()
    );
    expect((await rows())[0]).toMatchObject({ outcome: "link_expired", device: "bot" });
  });

  it("records nothing for an unknown key, a wrong secret on a real id, or a key for another artifact", async () => {
    const link = await mint({ expiresAt: new Date(Date.now() - DAY).toISOString() });
    const [id] = link.key.split(".");
    await app.request(`https://a.rtfx.pro/report/?k=garbage`, { headers: nav }, e());
    await app.request(`https://a.rtfx.pro/report/?k=${id}.wrongsecret`, { headers: nav }, e());
    await app.request(`https://a.rtfx.pro/report/?k=nodot`, { headers: nav }, e());
    expect(await rows()).toHaveLength(0);
    expect(await inspectShareLink(env as any, `${id}.wrongsecret`, NOW())).toBeNull();
    // Right key, wrong artifact.
    const body = new FormData();
    body.set("slug", "other");
    body.set("title", "Other");
    body.set("visibility", "restricted");
    body.set("file", new File(["<p>x</p>"], "index.html", { type: "text/html" }));
    await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
    await app.request(`https://a.rtfx.pro/other/?k=${link.key}`, { headers: nav }, e());
    expect(await rows()).toHaveLength(0);
  });

  it("ignores a plain machine request (no Sec-Fetch-Dest, not a crawler)", async () => {
    const link = await mint({ expiresAt: new Date(Date.now() - DAY).toISOString() });
    await app.request(`https://a.rtfx.pro/report/?k=${link.key}`, { headers: { "User-Agent": "curl/8.4" } }, e());
    expect(await rows()).toHaveLength(0);
  });

  it("dedupes the same link + ip + outcome inside the window, but not a different ip", async () => {
    const link = await mint({ expiresAt: new Date(Date.now() - DAY).toISOString() });
    for (let i = 0; i < 5; i++) {
      await app.request(`https://a.rtfx.pro/report/?k=${link.key}`, { headers: nav }, e());
    }
    expect(await rows()).toHaveLength(1);
    await app.request(
      `https://a.rtfx.pro/report/?k=${link.key}`,
      { headers: { ...nav, "CF-Connecting-IP": "203.0.113.99" } },
      e()
    );
    expect(await rows()).toHaveLength(2);
  });

  it("records again once the dedupe window has passed", async () => {
    const link = await mint();
    const base = {
      slug: "report", version: 1, email: null, path: "", country: null, referrer: null,
      ip: "1.1.1.1", link_id: link.id, outcome: "link_expired" as const,
    };
    const t0 = Date.now();
    await logView(env as any, { ...base, viewed_at: new Date(t0 - 11 * 60_000).toISOString() });
    await logView(env as any, { ...base, viewed_at: new Date(t0 - 5 * 60_000).toISOString() }); // within 10 min of the first? no: 6 min later
    // 11 min and 5 min ago are 6 minutes apart: the second is a duplicate.
    expect(await rows()).toHaveLength(1);
    await logView(env as any, { ...base, viewed_at: new Date(t0 + 6 * 60_000).toISOString() });
    expect(await rows()).toHaveLength(2);
  });
});

describe("signed-in views", () => {
  it("carry ip and device, and still notify only for named first views", async () => {
    await req("/api/artifacts/report/access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "restricted", emails: ["dana@x.com"] }),
      ...as(OWNER),
    });
    const res = await app.request(
      "https://a.rtfx.pro/report/",
      {
        headers: {
          "Sec-Fetch-Dest": "document",
          Cookie: await cookieFor("dana@x.com"),
          "User-Agent": IPHONE,
          "CF-Connecting-IP": "203.0.113.8",
        },
      },
      e()
    );
    expect(res.status).toBe(200);
    const r = await rows("email = 'dana@x.com'");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ ip: "203.0.113.8", device: "mobile", browser: "Safari", outcome: "viewed", link_id: null });
  });
});

describe("IP retention", () => {
  const old = new Date(Date.now() - (IP_RETENTION_DAYS + 5) * DAY).toISOString();
  const fresh = new Date(Date.now() - 2 * DAY).toISOString();
  async function seed() {
    for (const [at, ip] of [[old, "10.0.0.1"], [fresh, "10.0.0.2"]] as const) {
      await env.DB.prepare(
        "INSERT INTO artifact_views (slug, version, email, viewed_at, ip, outcome) VALUES ('report', 1, 'a@x.com', ?, ?, 'viewed')"
      ).bind(at, ip).run();
    }
  }

  it("never returns an IP older than the window, even before it has been erased", async () => {
    await seed();
    const ev = await listViewEvents(env as any, "report");
    expect(ev.find((v) => v.viewed_at === old)!.ip).toBeNull();
    expect(ev.find((v) => v.viewed_at === fresh)!.ip).toBe("10.0.0.2");
    const res = await app.request(
      "https://rtfx.pro/api/artifacts/report/views",
      { headers: { Cookie: await cookieFor(OWNER) } },
      e()
    );
    expect(JSON.stringify(await res.json())).not.toContain("10.0.0.1");
  });

  it("erases old IPs in place and leaves the rest of the row", async () => {
    await seed();
    expect(await eraseOldIps(env as any, "report")).toBe(1);
    const r = await rows();
    expect(r.find((x) => x.viewed_at === old)).toMatchObject({ ip: null, email: "a@x.com" });
    expect(r.find((x) => x.viewed_at === fresh)!.ip).toBe("10.0.0.2");
  });

  it("uses a 90 day cutoff", () => {
    expect(IP_RETENTION_DAYS).toBe(90);
    const now = new Date("2026-10-08T00:00:00.000Z");
    expect(ipCutoff(now)).toBe("2026-07-10T00:00:00.000Z");
  });
});

describe("owner-facing endpoints", () => {
  it("/views and /links are gated: a stranger gets 404, no data", async () => {
    const link = await mint();
    await openLink(link.key);
    const stranger = await cookieFor("nobody@x.com");
    for (const path of ["views", "links"]) {
      const res = await app.request(`https://rtfx.pro/api/artifacts/report/${path}`, { headers: { Cookie: stranger } }, e());
      expect(res.status, path).toBe(404);
    }
    const anon = await app.request("https://rtfx.pro/api/artifacts/report/views", {}, e());
    expect(anon.status).toBeGreaterThanOrEqual(401);
  });

  it("/links reports per-link views, last viewed and attempts after expiry", async () => {
    const live = await mint();
    await openLink(live.key);
    await openLink(live.key, { "CF-Connecting-IP": "203.0.113.20" });
    const dead = await mint({ expiresAt: new Date(Date.now() - DAY).toISOString() });
    await app.request(
      `https://a.rtfx.pro/report/?k=${dead.key}`,
      { headers: { "Sec-Fetch-Dest": "document", "CF-Connecting-IP": "203.0.113.30" } },
      e()
    );
    const res = await app.request(
      "https://rtfx.pro/api/artifacts/report/links",
      { headers: { Cookie: await cookieFor(OWNER) } },
      e()
    );
    const { links } = (await res.json()) as any;
    const a = links.find((l: any) => l.id === live.id);
    const b = links.find((l: any) => l.id === dead.id);
    expect(a).toMatchObject({ views: 2, expiredAttempts: 0 });
    expect(a.lastViewedAt).toBeTruthy();
    expect(b).toMatchObject({ views: 0, expiredAttempts: 1, lastViewedAt: null });
  });

  it("/views pages with limit and before", async () => {
    const link = await mint();
    // Three different visitors: one IP reloading inside the window is one view.
    for (let i = 0; i < 3; i++) await openLink(link.key, { "CF-Connecting-IP": `203.0.113.${10 + i}` });
    const get = async (qs: string) =>
      (await (
        await app.request(`https://rtfx.pro/api/artifacts/report/views${qs}`, { headers: { Cookie: await cookieFor(OWNER) } }, e())
      ).json()) as any;
    const p1 = await get("?limit=2");
    expect(p1.views).toHaveLength(2);
    expect(p1.next_before).toBe(p1.views[1].id);
    const p2 = await get(`?limit=2&before=${p1.next_before}`);
    expect(p2.views).toHaveLength(1);
    expect(p2.next_before).toBeNull();
  });

  it("renders the share page with the stats UI built from textContent, not innerHTML", async () => {
    const res = await app.request(
      "https://rtfx.pro/share/report",
      { headers: { "Sec-Fetch-Dest": "document", Cookie: await cookieFor(OWNER) } },
      e()
    );
    const html = await res.text();
    expect(html).toContain("data-view-list");
    expect(html).toContain("Recent views");
    expect(html).toContain("attempt");
    const script = html.slice(html.indexOf("<script>"));
    expect(script).not.toMatch(/innerHTML\s*\+?=\s*[^'"]/); // only ever cleared with ''
    expect(script).not.toContain("insertAdjacentHTML");
    expect(script).not.toContain("document.write");
  });

  it("escapes recorded values on the dashboard artifact page", async () => {
    await env.DB.prepare(
      `INSERT INTO artifact_views (slug, version, email, viewed_at, city, country, browser, os, device, ip, link_id, outcome)
       VALUES ('report', 1, NULL, ?, '<img src=x onerror=alert(1)>', 'NL', '<script>alert(2)</script>', 'iOS', 'mobile', '1.2.3.4', 'abc', 'viewed')`
    ).bind(NOW()).run();
    const res = await app.request(
      "https://rtfx.pro/admin/artifacts/report",
      { headers: { "Sec-Fetch-Dest": "document", Cookie: await cookieFor(OWNER) } },
      e()
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Someone with a link");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>alert(2)</script>");
  });
});

describe("before migration 0023 (fail soft)", () => {
  async function dropColumns() {
    await env.DB.prepare("DROP TABLE artifact_views").run();
    await env.DB.prepare(
      `CREATE TABLE artifact_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, version INTEGER NOT NULL,
        email TEXT, path TEXT, country TEXT, referrer TEXT, viewed_at TEXT NOT NULL)`
    ).run();
  }

  it("still serves a share link, a dead link, a preview and a signed-in view", async () => {
    await dropColumns();
    const live = await mint();
    const { first, second } = await openLink(live.key);
    expect(first.status).toBe(302);
    expect(second!.status).toBe(200);

    const dead = await mint({ expiresAt: new Date(Date.now() - DAY).toISOString() });
    const d = await app.request(
      `https://a.rtfx.pro/report/?k=${dead.key}`,
      { headers: { "Sec-Fetch-Dest": "document" } },
      e()
    );
    expect(d.status).toBe(302);

    const p = await app.request(
      `https://a.rtfx.pro/report/?k=${live.key}`,
      { headers: { "User-Agent": "WhatsApp/2.23" } },
      e()
    );
    expect(p.status).toBe(200);

    const s = await app.request(
      "https://a.rtfx.pro/report/",
      { headers: { "Sec-Fetch-Dest": "document", Cookie: await cookieFor(OWNER) } },
      e()
    );
    expect(s.status).toBe(200);
    // The signed-in view fell back to the old insert; nothing else was written.
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0].email).toBe(OWNER);
  });

  it("still serves the owner endpoints and the dashboard page", async () => {
    await dropColumns();
    await env.DB.prepare("INSERT INTO artifact_views (slug, version, email, viewed_at) VALUES ('report', 1, 'a@x.com', ?)")
      .bind(NOW()).run();
    const cookie = await cookieFor(OWNER);
    const v = await app.request("https://rtfx.pro/api/artifacts/report/views", { headers: { Cookie: cookie } }, e());
    expect(v.status).toBe(200);
    expect(((await v.json()) as any).total).toBe(1);
    const l = await app.request("https://rtfx.pro/api/artifacts/report/links", { headers: { Cookie: cookie } }, e());
    expect(l.status).toBe(200);
    const page = await app.request(
      "https://rtfx.pro/admin/artifacts/report",
      { headers: { "Sec-Fetch-Dest": "document", Cookie: cookie } },
      e()
    );
    expect(page.status).toBe(200);
  });
});
