import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { mintSession, mintFrameToken, verifyFrameToken, readFrameToken } from "../src/session";
import { personalAccountFor } from "../src/accounts";
import { GUEST_COOKIE } from "../src/viewing";
import { FRAME_TOKEN_SEGMENT } from "../src/shell";
import {
  checkHostname,
  classifyHost,
  clearCustomDomainCache,
  customDomainLimit,
  getActiveDomain,
  planAllowsCustomDomain,
  primaryDomainFor,
  registerDomain,
  removeDomain,
} from "../src/custom-domains";
import { frameAncestorsDirective } from "../src/canonical";
import { initDb, clearR2, viewerPath } from "./fixtures";

/**
 * Custom domains, phase 1 (docs/CUSTOM_DOMAINS.md). Production-shaped: real
 * signing secret, no dev-login shortcut, two hostnames, the flag on.
 */

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const APP = "https://rtfx.pro";
const CONTENT = "https://a.rtfx.pro";
const DOMAIN = "docs.acme.com";
const CUSTOM = `https://${DOMAIN}`;
const OWNER = "owner@acme.com";
const OTHER = "other@evil.example";
const GUEST = "dana@partner.example";
const OPERATOR = "admin@test.com"; // SUPER_ADMIN_EMAILS in vitest.config.ts
const NOW = () => new Date().toISOString();
const NAV = { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const BYTES = "<h1>top-secret-artifact-bytes</h1>";

let sent: any[] = [];

function e(extra: Record<string, unknown> = {}) {
  return {
    ...(env as any),
    SESSION_SECRET: SECRET,
    DEV_LOGIN: undefined,
    CONTENT_HOSTNAMES: "a.rtfx.pro",
    PUBLIC_BASE_URL: APP,
    ADMIN_EMAILS: "ops@rtfx.pro",
    CUSTOM_DOMAINS_ENABLED: "true",
    EMAIL: {
      send: async (m: any) => {
        sent.push(m);
        return { messageId: "m" };
      },
    },
    ...extra,
  };
}

const cookie = async (email: string, kind: "member" | "guest" = "member", slug?: string) =>
  `${kind === "guest" ? GUEST_COOKIE : SESSION_COOKIE}=${await mintSession(SECRET, { email, kind, slug }, NOW())}`;

/** A request to any origin with the flag on (override `extra` to change env). */
async function call(
  url: string,
  o: { who?: string | null; headers?: Record<string, string>; method?: string; body?: unknown; extra?: Record<string, unknown> } = {}
) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.who) headers.Cookie = [headers.Cookie, await cookie(o.who)].filter(Boolean).join("; ");
  let body: BodyInit | undefined;
  if (o.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(o.body);
  }
  return app.request(url, { method: o.method ?? "GET", headers, body }, e(o.extra));
}

const browse = (url: string, who?: string | null, headers: Record<string, string> = {}) =>
  call(url, { who, headers: { ...NAV, ...headers } });

async function publish(slug: string, who: string, visibility = "restricted") {
  const body = new FormData();
  body.set("slug", slug);
  body.set("title", `Title of ${slug}`);
  body.set("visibility", visibility);
  body.set("file", new File([`<!doctype html><body>${BYTES}</body>`], "index.html", { type: "text/html" }));
  const res = await app.request(
    `${APP}/api/artifacts`,
    { method: "POST", body, headers: { Cookie: await cookie(who) } },
    e()
  );
  expect(res.status).toBe(200);
  return res;
}

async function setPlan(email: string, plan: string) {
  const account = await personalAccountFor(env as any, email);
  await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, account!.id).run();
  return account!;
}

async function activate(accountId: string, hostname = DOMAIN, primary = true, status: any = "active") {
  const out = await registerDomain(env as any, {
    hostname,
    accountId,
    status,
    primary,
    actor: { email: OPERATOR, role: "super_admin" },
    now: NOW(),
  });
  expect(out.ok).toBe(true);
  return out;
}

let acme: { id: string };
let evil: { id: string };

beforeEach(async () => {
  sent = [];
  await initDb();
  await clearR2();
  await publish("report", OWNER);
  await publish("other-doc", OTHER);
  acme = await setPlan(OWNER, "team");
  evil = await setPlan(OTHER, "team");
  clearCustomDomainCache();
});

// --- pure rules ------------------------------------------------------------------

describe("hostname validation", () => {
  const ok = (h: string) => checkHostname(e(), h);

  it("accepts and normalises a customer hostname", () => {
    expect(ok("Docs.Acme.com")).toEqual({ ok: true, hostname: "docs.acme.com" });
    expect(ok("docs.acme.com.")).toEqual({ ok: true, hostname: "docs.acme.com" });
    expect(ok("a-b.c-d.example.co.uk")).toMatchObject({ ok: true });
  });

  it.each([
    ["rtfx.pro", "reserved"],
    ["www.rtfx.pro", "reserved"],
    ["a.rtfx.pro", "reserved"],
    ["mcp.rtfx.pro", "reserved"],
    ["evil.a.rtfx.pro", "reserved"],
    ["RTFX.PRO", "reserved"],
    ["127.0.0.1", "ip"],
    ["10.1.2.3", "ip"],
    ["[::1]", "ip"],
    ["::1", "ip"],
    ["localhost", "local"],
    ["app.localhost", "local"],
    ["printer.local", "local"],
    ["acme", "shape"],
    ["", "shape"],
    ["-bad.example.com", "shape"],
    ["bad_name.example.com", "shape"],
    ["https://docs.acme.com", "shape"],
    ["docs.acme.com/path", "shape"],
    ["docs.acme.com:8443", "shape"],
    ["*.acme.com", "shape"],
    ["a..b.com", "shape"],
  ])("rejects %s", (host, reason) => {
    expect(ok(host)).toEqual({ ok: false, reason });
  });

  it("rejects a configured content host and APP_ORIGINS hosts too", () => {
    const env2 = e({ CONTENT_HOSTNAMES: "content.example.net", APP_ORIGINS: "https://app.example.org" });
    expect(checkHostname(env2, "content.example.net")).toEqual({ ok: false, reason: "reserved" });
    expect(checkHostname(env2, "x.app.example.org")).toEqual({ ok: false, reason: "reserved" });
    expect(checkHostname(env2, "docs.acme.com")).toMatchObject({ ok: true });
  });
});

describe("plan gate", () => {
  it("is Team and Enterprise only", () => {
    expect(planAllowsCustomDomain("free")).toBe(false);
    expect(planAllowsCustomDomain("pro")).toBe(false);
    expect(planAllowsCustomDomain("team")).toBe(true);
    expect(planAllowsCustomDomain("enterprise")).toBe(true);
    expect(planAllowsCustomDomain("nonsense")).toBe(false);
    expect(customDomainLimit("team")).toBe(1);
    expect(customDomainLimit("enterprise")).toBe(Infinity);
    expect(customDomainLimit("pro")).toBe(0);
  });
});

describe("domain registry", () => {
  it("serves only ACTIVE rows, and caches briefly", async () => {
    await activate(acme.id, DOMAIN, false, "pending");
    expect(await getActiveDomain(e(), DOMAIN)).toBeNull();
    await activate(acme.id, DOMAIN, true, "active");
    expect(await getActiveDomain(e(), DOMAIN)).toMatchObject({ account_id: acme.id });
    expect(await getActiveDomain(e(), "DOCS.ACME.COM")).toMatchObject({ hostname: DOMAIN });
    expect(await primaryDomainFor(e(), acme.id)).toBe(DOMAIN);
    // Written behind the cache's back: still served until the TTL / a write clears it.
    await env.DB.prepare("UPDATE custom_domains SET status = 'removed'").run();
    expect(await getActiveDomain(e(), DOMAIN)).not.toBeNull();
    clearCustomDomainCache();
    expect(await getActiveDomain(e(), DOMAIN)).toBeNull();
    expect(await primaryDomainFor(e(), acme.id)).toBeNull();
  });

  it("answers nothing with the flag off, and does not fail without the table", async () => {
    await activate(acme.id);
    expect(await getActiveDomain(e({ CUSTOM_DOMAINS_ENABLED: undefined }), DOMAIN)).toBeNull();
    expect(await primaryDomainFor(e({ CUSTOM_DOMAINS_ENABLED: "yes" }), acme.id)).toBeNull();
    clearCustomDomainCache();
    await env.DB.prepare("DROP TABLE custom_domains").run();
    expect(await getActiveDomain(e(), DOMAIN)).toBeNull();
    expect(await primaryDomainFor(e(), acme.id)).toBeNull();
  });

  it("enforces plan, ownership, limit and one primary per workspace", async () => {
    const reg = (accountId: string, hostname: string, extra: Record<string, unknown> = {}) =>
      registerDomain(env as any, {
        hostname,
        accountId,
        status: "active",
        primary: false,
        actor: { email: OPERATOR, role: "super_admin" },
        now: NOW(),
        ...extra,
      });
    await setPlan(OTHER, "pro");
    expect(await reg(evil.id, "docs.evil.example")).toEqual({ ok: false, reason: "plan_required" });
    await setPlan(OTHER, "team");

    expect(await reg(acme.id, "rtfx.pro")).toEqual({ ok: false, reason: "bad_hostname" });
    expect((await reg(acme.id, DOMAIN)).ok).toBe(true);
    expect(await reg(evil.id, DOMAIN)).toEqual({ ok: false, reason: "taken" });
    // Team includes one domain.
    expect(await reg(acme.id, "second.acme.com")).toEqual({ ok: false, reason: "limit_reached" });
    // Pending cannot be primary.
    expect(await reg(evil.id, "x.evil.example", { status: "pending", primary: true })).toEqual({
      ok: false,
      reason: "primary_requires_active",
    });
    // Enterprise: many domains, and promoting a new primary demotes the old one.
    await setPlan(OWNER, "enterprise");
    await reg(acme.id, DOMAIN, { primary: true });
    await reg(acme.id, "second.acme.com", { primary: true });
    const rows = await env.DB.prepare("SELECT hostname, is_primary FROM custom_domains ORDER BY hostname").all<any>();
    expect(rows.results.filter((r: any) => r.is_primary === 1).map((r: any) => r.hostname)).toEqual(["second.acme.com"]);
    // The unique index is the backstop.
    await expect(
      env.DB.prepare("UPDATE custom_domains SET is_primary = 1 WHERE hostname = ?").bind(DOMAIN).run()
    ).rejects.toThrow();
    // A removed hostname can be claimed by someone else.
    expect(await removeDomain(env as any, DOMAIN, { email: OPERATOR, role: "super_admin" }, NOW())).toBe(true);
    expect((await reg(evil.id, DOMAIN)).ok).toBe(true);
  });
});

// --- host classification ----------------------------------------------------------

describe("host classification", () => {
  const klass = async (url: string, extra: Record<string, unknown> = {}) => (await classifyHost(e(extra), url)).kind;

  it("tells content, app, customer and unknown apart", async () => {
    await activate(acme.id);
    expect(await klass("https://a.rtfx.pro/x")).toBe("content");
    expect(await klass("https://rtfx.pro/x")).toBe("app");
    expect(await klass("https://mcp.rtfx.pro/mcp")).toBe("app");
    expect(await klass(`${CUSTOM}/report`)).toBe("customer");
    expect(await klass("https://nope.example.com/")).toBe("unknown");
  });

  it("does not treat a pending or removed domain as a customer host", async () => {
    await activate(acme.id, DOMAIN, false, "pending");
    expect(await klass(`${CUSTOM}/`)).toBe("unknown");
    await removeDomain(env as any, DOMAIN, { email: OPERATOR, role: "super_admin" }, NOW());
    expect(await klass(`${CUSTOM}/`)).toBe("unknown");
  });

  it("a single-host deployment (no content host) keeps treating other hosts as the app", async () => {
    expect(await klass("http://localhost:8787/", { CONTENT_HOSTNAMES: "" })).toBe("app");
  });

  it("flag off: every non-content host is the app, exactly as before", async () => {
    await activate(acme.id);
    expect(await klass(`${CUSTOM}/`, { CUSTOM_DOMAINS_ENABLED: undefined })).toBe("app");
    expect(await klass("https://a.rtfx.pro/", { CUSTOM_DOMAINS_ENABLED: undefined })).toBe("content");
  });
});

// --- the customer-host allowlist ----------------------------------------------------

describe("what a customer host serves", () => {
  beforeEach(async () => {
    await activate(acme.id);
  });

  it.each([
    "/admin",
    "/admin/artifacts",
    "/admin/platform",
    "/api/artifacts",
    "/api/whoami",
    "/oauth/authorize",
    "/oauth/token",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/.well-known/security.txt",
    "/mcp",
    "/u/sometoken",
    "/share/report",
    "/upgrade/team",
    "/pro",
    "/team",
    "/enterprise",
    "/contact",
    "/privacy",
    "/terms",
    "/signup",
    "/guide",
    "/answers",
    "/llms.txt",
    "/llms-full.txt",
    "/sitemap.xml",
    "/health",
    "/whoami",
    "/gallery",
    "/v/report/1",
    "/media/x.mp4",
    "/og.png",
    "/_access-request/report",
  ])("GET %s is a 404", async (path) => {
    const res = await call(`${CUSTOM}${path}`, { who: OWNER, headers: NAV });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).not.toContain("top-secret");
  });

  it.each([
    ["POST", "/api/artifacts"],
    ["POST", "/mcp"],
    ["POST", "/oauth/token"],
    ["POST", "/oauth/register"],
    ["PUT", "/api/artifacts/report/access"],
    ["DELETE", "/api/artifacts/report"],
    ["POST", "/contact"],
    ["POST", "/waitlist"],
    ["POST", "/upgrade/team"],
    ["POST", "/report"],
  ])("%s %s is a 404", async (method, path) => {
    const res = await call(`${CUSTOM}${path}`, { who: OWNER, method, body: {} });
    expect(res.status).toBe(404);
  });

  it("answers the root with a small page and no artifact listing", async () => {
    const res = await call(`${CUSTOM}/`, { who: OWNER });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("documents shared by");
    expect(html).toContain("/login");
    expect(html).not.toContain("report");
    expect(html).not.toContain("other-doc");
  });

  it("robots.txt disallows everything", async () => {
    const res = await call(`${CUSTOM}/robots.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Disallow: \//);
  });

  it("serves the favicon and sign-in pages", async () => {
    expect((await call(`${CUSTOM}/favicon.ico`)).status).toBe(200);
    const login = await call(`${CUSTOM}/login`);
    expect(login.status).toBe(200);
    const html = await login.text();
    expect(html).toContain('data-step="email"');
    expect(html).not.toContain("rtfx.pro"); // minimal, not the marketing chrome
    expect(html).not.toContain("/signup");
  });

  it("keeps the beacon, access-request form and chat socket reachable", async () => {
    const stall = await call(`${CUSTOM}/_frame-stall`, { method: "POST", body: { slug: "report" } });
    expect(stall.status).toBe(204);
    const ask = await call(`${CUSTOM}/_access-request/report`, { method: "POST", body: { email: "x@y.example" } });
    expect(ask.status).toBe(202);
    const chat = await call(`${CUSTOM}/_chat/report`);
    expect(chat.status).toBe(426); // got to the real route (no websocket upgrade)
  });

  it("does not canonicalise a customer host (no http->https, no trailing-slash redirect)", async () => {
    const plain = await call(`http://${DOMAIN}/login`);
    expect(plain.status).toBe(200);
    const slashed = await call(`${CUSTOM}/pro/`);
    expect(slashed.status).toBe(404);
    expect(slashed.headers.get("location")).toBeNull();
  });

  it("an unknown host serves nothing", async () => {
    for (const path of ["/", "/report", "/login", "/robots.txt"]) {
      const res = await call(`https://other.example.com${path}`, { who: OWNER, headers: NAV });
      expect(res.status).toBe(404);
    }
  });
});

// --- the viewer ---------------------------------------------------------------------

describe("viewer on a customer host", () => {
  beforeEach(async () => {
    await activate(acme.id);
  });

  it("renders the shell for the owner, framing the content host, staying on the customer host", async () => {
    const res = await browse(`${CUSTOM}/report`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<iframe");
    expect(html).toContain(`${CONTENT}/report/${FRAME_TOKEN_SEGMENT}/`);
    expect(html).not.toContain(BYTES);
    // The shown/copyable address is the customer's; management links stay on rtfx.pro.
    expect(html).toContain(`${CUSTOM}/report`);
    expect(html).toContain(`href="${APP}/share/report"`);
    expect(res.headers.get("content-security-policy")).toContain(`frame-src ${CONTENT}`);
  });

  it("another workspace's slug is the same 404 as a missing slug", async () => {
    const cross = await browse(`${CUSTOM}/other-doc`, OWNER);
    const missing = await browse(`${CUSTOM}/no-such-doc`, OWNER);
    expect(cross.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await cross.text()).toBe((await missing.text()).replace(/no-such-doc/g, "other-doc"));
    // Signed out, a browser gets the same sign-in bounce for both.
    const crossOut = await browse(`${CUSTOM}/other-doc`);
    const missingOut = await browse(`${CUSTOM}/no-such-doc`);
    expect(crossOut.status).toBe(302);
    expect(missingOut.status).toBe(302);
    expect(crossOut.headers.get("location")).toBe(
      missingOut.headers.get("location")!.replaceAll("no-such-doc", "other-doc")
    );
    // Not even a platform admin sees another workspace's artifact through this domain.
    expect((await browse(`${CUSTOM}/other-doc`, OTHER)).status).toBe(404);
  });

  it("the other workspace's artifact is unaffected on rtfx.pro", async () => {
    const res = await browse(`${APP}${await viewerPath("other-doc")}`, OTHER);
    expect(res.status).toBe(200);
  });

  it("a private artifact needs sign-in, and sends the visitor to sign in on THIS host", async () => {
    const res = await browse(`${CUSTOM}/report`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/shared/report?next=%2Freport");
    const page = await call(`${CUSTOM}/shared/report?next=%2Freport`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("data-guest-form");
    expect(html).toContain('href="/login?next=%2Freport"');
  });

  it("a signed-in member who is not granted gets the 404", async () => {
    expect((await browse(`${CUSTOM}/report`, GUEST)).status).toBe(404);
  });

  it("machine clients are bounced to the content host's raw path, not served bytes", async () => {
    const res = await call(`${CUSTOM}/report`, { who: OWNER });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${CONTENT}/report/`);
  });

  it("an 'everyone' artifact is open to workspace members signed in on the customer host", async () => {
    await publish("team-doc", OWNER, "everyone");
    expect((await browse(`${CUSTOM}/team-doc`, OWNER)).status).toBe(200);
  });
});

describe("sign-in completes on the customer host", () => {
  beforeEach(async () => {
    await activate(acme.id);
  });

  it("emails a code and a magic link that point at the customer host; no cookie leaves the host", async () => {
    const start = await call(`${CUSTOM}/auth/start`, { method: "POST", body: { email: OWNER } });
    expect(start.status).toBe(202);
    expect(sent).toHaveLength(1);
    const link = /(https:\/\/[^\s"<]+\/auth\/m\/[A-Za-z0-9_-]+)/.exec(sent[0].text)![1];
    expect(link.startsWith(`${CUSTOM}/auth/m/`)).toBe(true);

    // GET is inert (scanners), POST consumes. Lands on the customer root by default.
    const scan = await call(link);
    expect(scan.status).toBe(200);
    expect(await scan.text()).toContain(`action="/auth/m/`);
    const go = await call(link, { method: "POST" });
    expect(go.status).toBe(302);
    expect(go.headers.get("location")).toBe("/");
    const setCookie = go.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  it("returns to the document after /login?next=, using the typed code", async () => {
    const login = await call(`${CUSTOM}/login?next=%2Freport`);
    const next = /rtfx_next=[^;]+/.exec(login.headers.get("set-cookie") ?? "")![0];
    await call(`${CUSTOM}/auth/start`, { method: "POST", body: { email: OWNER }, headers: { Cookie: next } });
    const code = /\b(\d{6})\b/.exec(sent[0].text)![1];
    const verify = await call(`${CUSTOM}/auth/verify`, {
      method: "POST",
      body: { email: OWNER, code },
      headers: { Cookie: next },
    });
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ ok: true, redirect: "/report" });
    const session = /rtfx_session=([^;]+)/.exec(verify.headers.get("set-cookie")!)![1];
    const view = await browse(`${CUSTOM}/report`, null, { Cookie: `${SESSION_COOKIE}=${session}` });
    expect(view.status).toBe(200);
  });

  it("without a parked destination the verify redirect is the customer root, never /admin", async () => {
    await call(`${CUSTOM}/auth/start`, { method: "POST", body: { email: OWNER } });
    const code = /\b(\d{6})\b/.exec(sent[0].text)![1];
    const verify = await call(`${CUSTOM}/auth/verify`, { method: "POST", body: { email: OWNER, code } });
    expect(await verify.json()).toEqual({ ok: true, redirect: "/" });
  });

  it("on rtfx.pro the mail and redirect are unchanged", async () => {
    await call(`${APP}/auth/start`, { method: "POST", body: { email: OWNER } });
    expect(sent[0].text).toContain(`${APP}/auth/m/`);
    const code = /\b(\d{6})\b/.exec(sent[0].text)![1];
    const verify = await call(`${APP}/auth/verify`, { method: "POST", body: { email: OWNER, code } });
    expect(await verify.json()).toEqual({ ok: true, redirect: "/admin" });
  });

  it("signed in, /logout clears and goes to /login on the same host", async () => {
    const res = await call(`${CUSTOM}/logout`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});

describe("guests and share links on the customer host", () => {
  beforeEach(async () => {
    await activate(acme.id);
    await app.request(
      `${APP}/api/artifacts/report/access`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: await cookie(OWNER) },
        body: JSON.stringify({ visibility: "restricted", emails: [GUEST] }),
      },
      e()
    );
  });

  it("a guest invitation requested on the customer host links back to it and lands on the document", async () => {
    const res = await call(`${CUSTOM}/auth/guest?slug=report`, { method: "POST", body: { email: GUEST } });
    expect(res.status).toBe(202);
    const link = /(https:\/\/[^\s"<]+\/auth\/m\/[A-Za-z0-9_-]+)/.exec(sent[0].text)![1];
    expect(link.startsWith(`${CUSTOM}/auth/m/`)).toBe(true);

    const go = await call(link, { method: "POST" });
    expect(go.status).toBe(302);
    expect(go.headers.get("location")).toBe("/report");
    const setCookie = go.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${GUEST_COOKIE}=`);
    expect(setCookie).not.toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).not.toMatch(/Domain=/i);

    const guestCookie = /rtfx_guest=[^;]+/.exec(setCookie)![0];
    const view = await browse(`${CUSTOM}/report`, null, { Cookie: guestCookie });
    expect(view.status).toBe(200);
    expect(await view.text()).toContain("<iframe");
    // The guest credential is for that one document.
    await publish("second", OWNER);
    expect((await browse(`${CUSTOM}/second`, null, { Cookie: guestCookie })).status).toBe(302);
  });

  it("a guest request for ANOTHER workspace's slug on this host links to rtfx.pro", async () => {
    await app.request(
      `${APP}/api/artifacts/other-doc/access`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: await cookie(OTHER) },
        body: JSON.stringify({ visibility: "restricted", emails: [GUEST] }),
      },
      e()
    );
    await call(`${CUSTOM}/auth/guest?slug=other-doc`, { method: "POST", body: { email: GUEST } });
    expect(sent[0].text).toContain(`${APP}/auth/m/`);
    expect(sent[0].text).not.toContain(DOMAIN);
  });

  it("on rtfx.pro the guest link is still rtfx.pro", async () => {
    await call(`${APP}/auth/guest?slug=report`, { method: "POST", body: { email: GUEST } });
    expect(sent[0].text).toContain(`${APP}/auth/m/`);
  });

  it("a share link minted for the workspace opens on the customer host", async () => {
    const made = await app.request(
      `${APP}/api/artifacts/report/links`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: await cookie(OWNER) },
        body: JSON.stringify({ name: "for Dana" }),
      },
      e()
    );
    expect(made.status).toBe(201);
    const { url } = (await made.json()) as { url: string };
    expect(url.startsWith(`${CUSTOM}/report?k=`)).toBe(true);

    const first = await browse(url);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/report");
    const linkCookie = /rtfx_link_report=[^;]+/.exec(first.headers.get("set-cookie") ?? "")![0];
    const open = await browse(`${CUSTOM}/report`, null, { Cookie: linkCookie });
    expect(open.status).toBe(200);
    expect(await open.text()).not.toContain("data-share-banner");
  });

  it("a share key for another workspace's artifact does not open through this domain", async () => {
    const made = await app.request(
      `${APP}/api/artifacts/other-doc/links`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: await cookie(OTHER) },
        body: JSON.stringify({}),
      },
      e()
    );
    const key = new URL(((await made.json()) as { url: string }).url).searchParams.get("k")!;
    const res = await browse(`${CUSTOM}/other-doc?k=${encodeURIComponent(key)}`);
    expect([302, 404]).toContain(res.status);
    if (res.status === 302) expect(res.headers.get("location") ?? "").not.toContain("rtfx.pro/");
    const cookieRes = await browse(`${CUSTOM}/other-doc`, null, { Cookie: `rtfx_link_other-doc=${encodeURIComponent(key)}` });
    expect(cookieRes.status).not.toBe(200);
  });
});

// --- content isolation / frame-ancestors -----------------------------------------------

describe("frame-ancestors is per request", () => {
  const frame = async (token: string, extra: Record<string, unknown> = {}) =>
    app.request(
      `${CONTENT}/report/${FRAME_TOKEN_SEGMENT}/${token}/index.html`,
      { headers: { "Sec-Fetch-Dest": "iframe" } },
      e(extra)
    );
  const csp = (res: Response) => res.headers.get("content-security-policy") ?? "";

  it("a token without anc keeps today's static list", async () => {
    await activate(acme.id);
    const res = await frame(await mintFrameToken(SECRET, "report", NOW()));
    expect(res.status).toBe(200);
    expect(csp(res)).toContain(`frame-ancestors 'self' ${APP};`);
    expect(csp(res)).not.toContain(DOMAIN);
    expect(await verifyFrameToken(SECRET, await mintFrameToken(SECRET, "report", NOW()), "report", NOW())).toBe(true);
  });

  it("anc is honoured for an active domain of the artifact's workspace", async () => {
    await activate(acme.id);
    const res = await frame(await mintFrameToken(SECRET, "report", NOW(), CUSTOM));
    expect(res.status).toBe(200);
    expect(csp(res)).toContain(`frame-ancestors 'self' ${APP} ${CUSTOM};`);
  });

  it("anc is ignored for a domain that is not active, not registered, or another workspace's", async () => {
    await activate(acme.id);
    await activate(evil.id, "docs.evil.example");
    for (const anc of ["https://docs.evil.example", "https://unregistered.example.com", "http://docs.acme.com", `${CUSTOM}/x`, CONTENT, "javascript:alert(1)", "null"]) {
      const res = await frame(await mintFrameToken(SECRET, "report", NOW(), anc));
      expect(res.status).toBe(200);
      expect(csp(res), anc).toContain(`frame-ancestors 'self' ${APP};`);
    }
  });

  it("anc stops working the moment the domain is deactivated", async () => {
    await activate(acme.id);
    const token = await mintFrameToken(SECRET, "report", NOW(), CUSTOM);
    expect(csp(await frame(token))).toContain(CUSTOM);
    await removeDomain(env as any, DOMAIN, { email: OPERATOR, role: "super_admin" }, NOW());
    expect(csp(await frame(token))).not.toContain(DOMAIN);
  });

  it("anc is ignored entirely with the flag off", async () => {
    await activate(acme.id);
    const res = await frame(await mintFrameToken(SECRET, "report", NOW(), CUSTOM), { CUSTOM_DOMAINS_ENABLED: undefined });
    expect(csp(res)).not.toContain(DOMAIN);
  });

  it("the token still verifies for the right slug only, and carries anc", async () => {
    const token = await mintFrameToken(SECRET, "report", NOW(), CUSTOM);
    expect(await readFrameToken(SECRET, token, "report", NOW())).toEqual({ anc: CUSTOM });
    expect(await readFrameToken(SECRET, token, "other-doc", NOW())).toBeNull();
    expect(await readFrameToken(SECRET, "garbage", "report", NOW())).toBeNull();
  });

  it("end to end: the frame the customer-host viewer points at is allowed to be framed by it", async () => {
    await activate(acme.id);
    const html = await (await browse(`${CUSTOM}/report`, OWNER)).text();
    const src = /<iframe[^>]*src="([^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
    expect(src.startsWith(`${CONTENT}/report/${FRAME_TOKEN_SEGMENT}/`)).toBe(true);
    const res = await app.request(src, { headers: { "Sec-Fetch-Dest": "iframe" } }, e());
    expect(res.status).toBe(200);
    expect(csp(res)).toContain(`frame-ancestors 'self' ${APP} ${CUSTOM};`);
  });

  it("frameAncestorsDirective refuses to add a content host or a non-https origin", () => {
    expect(frameAncestorsDirective(e(), "http://docs.acme.com")).not.toContain("docs.acme.com");
    expect(frameAncestorsDirective(e(), CONTENT)).not.toContain(CONTENT);
    expect(frameAncestorsDirective(e(), CUSTOM)).toContain(CUSTOM);
  });
});

// --- canonical URLs ------------------------------------------------------------------------

describe("canonical URLs follow the primary domain", () => {
  const ws = async () => (await viewerPath("report")).split("/")[1];
  const details = async (who = OWNER) => {
    const res = await app.request(`${APP}/api/artifacts`, { headers: { Cookie: await cookie(who) } }, e());
    expect(res.status).toBe(200);
    return ((await res.json()) as any).artifacts.find((a: any) => a.slug === "report");
  };

  it("uses rtfx.pro until a primary domain is active", async () => {
    expect((await details()).url).toBe(`${APP}/${await ws()}/report`);
    await activate(acme.id, DOMAIN, false, "pending");
    expect((await details()).url).toBe(`${APP}/${await ws()}/report`);
    await removeDomain(env as any, DOMAIN, { email: OPERATOR, role: "super_admin" }, NOW());
    await activate(acme.id, DOMAIN, false, "active"); // active but not primary
    expect((await details()).url).toBe(`${APP}/${await ws()}/report`);
  });

  it("switches publish results, details and share links to the primary domain, and reverts on removal", async () => {
    const before = await ws();
    await activate(acme.id);
    expect((await details()).url).toBe(`${CUSTOM}/report`);
    const published = await publish("another", OWNER);
    expect(((await published.json()) as any).url).toBe(`${CUSTOM}/another`);

    const made = await app.request(
      `${APP}/api/artifacts/report/links`,
      { method: "POST", headers: { "Content-Type": "application/json", Cookie: await cookie(OWNER) }, body: "{}" },
      e()
    );
    expect(((await made.json()) as any).url).toMatch(/^https:\/\/docs\.acme\.com\/report\?k=/);

    await removeDomain(env as any, DOMAIN, { email: OPERATOR, role: "super_admin" }, NOW());
    expect((await details()).url).toBe(`${APP}/${before}/report`);
  });

  it("MCP publish/details results use the custom domain too", async () => {
    await activate(acme.id);
    const token = (await (
      await app.request(
        `${APP}/api/tokens`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: await cookie(OWNER) },
          body: JSON.stringify({ name: "t", scopes: ["read", "publish", "manage"] }),
        },
        e()
      )
    ).json()) as any;
    const secret = token.token ?? token.secret;
    expect(secret).toBeTruthy();
    const res = await app.request(
      `${APP}/mcp`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "artifact_details", arguments: { slug: "report" } } }),
      },
      e()
    );
    const text = await res.text();
    expect(text).toContain(`${CUSTOM}/report`);
  });

  it("browser GETs of the rtfx.pro address 301 to the custom domain; machines are untouched", async () => {
    await activate(acme.id);
    const path = await viewerPath("report");
    const browser = await browse(`${APP}${path}`, OWNER);
    expect(browser.status).toBe(301);
    expect(browser.headers.get("location")).toBe(`${CUSTOM}/report`);
    // The share key rides along so an existing link keeps working.
    const keyed = await browse(`${APP}${path}?k=abc`, null);
    expect(keyed.status).toBe(301);
    expect(keyed.headers.get("location")).toBe(`${CUSTOM}/report?k=abc`);
    // API / machine request: not a navigation, so no redirect to the domain.
    const machine = await call(`${APP}${path}`, { who: OWNER });
    expect(machine.status).toBe(302);
    expect(machine.headers.get("location")).toContain(CONTENT);
    const api = await app.request(`${APP}/api/artifacts`, { headers: { Cookie: await cookie(OWNER) } }, e());
    expect(api.status).toBe(200);
    // Removing the domain reverts the browser address to the viewer.
    await removeDomain(env as any, DOMAIN, { email: OPERATOR, role: "super_admin" }, NOW());
    expect((await browse(`${APP}${path}`, OWNER)).status).toBe(200);
  });
});

// --- flag off ----------------------------------------------------------------------------------

describe("flag off changes nothing", () => {
  const off = { CUSTOM_DOMAINS_ENABLED: undefined };

  it("links stay on rtfx.pro even with an active primary row", async () => {
    await activate(acme.id);
    const res = await app.request(`${APP}/api/artifacts`, { headers: { Cookie: await cookie(OWNER) } }, e(off));
    const row = ((await res.json()) as any).artifacts.find((a: any) => a.slug === "report");
    expect(row.url).toBe(`${APP}${await viewerPath("report")}`);
  });

  it("rtfx.pro browser views are not redirected", async () => {
    await activate(acme.id);
    const res = await call(`${APP}${await viewerPath("report")}`, { who: OWNER, headers: NAV, extra: off });
    expect(res.status).toBe(200);
  });

  it("a would-be customer host is just another non-canonical app host (old redirect to rtfx.pro)", async () => {
    await activate(acme.id);
    const res = await call(`${CUSTOM}${await viewerPath("report")}`, { who: OWNER, headers: NAV, extra: off });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP}${await viewerPath("report")}`);
    // ...and it does NOT get the customer allowlist: /login is the normal app page.
    const login = await call(`${CUSTOM}/login`, { extra: off });
    expect(await login.text()).toContain("Welcome");
  });

  it("the operator endpoints do not exist", async () => {
    const res = await call(`${APP}/api/platform/custom-domains`, { who: OPERATOR, extra: off });
    expect(res.status).toBe(404);
  });

  it("an unregistered host is not 404'd outright", async () => {
    const res = await call("https://nope.example.com/health", { extra: off });
    expect(res.status).not.toBe(404);
  });

  it("sign-in mail stays on the request's rtfx.pro origin", async () => {
    await activate(acme.id);
    await call(`${APP}/auth/start`, { method: "POST", body: { email: OWNER }, extra: off });
    expect(sent[0].text).toContain(`${APP}/auth/m/`);
  });
});

// --- operator endpoints --------------------------------------------------------------------------

describe("operator registration endpoints", () => {
  const put = (host: string, body: unknown, who: string | null = OPERATOR) =>
    call(`${APP}/api/platform/custom-domains/${host}`, { method: "PUT", body, who });

  it("lets a platform super admin register, list, switch primary and remove", async () => {
    const created = await put(DOMAIN, { account_id: acme.id, status: "active", primary: true, cf_hostname_id: "cf-123" });
    expect(created.status).toBe(200);
    expect(((await created.json()) as any).domain).toMatchObject({
      hostname: DOMAIN,
      account_id: acme.id,
      status: "active",
      is_primary: 1,
      cf_hostname_id: "cf-123",
    });
    // Live immediately on this isolate.
    expect((await browse(`${CUSTOM}/report`, OWNER)).status).toBe(200);

    const list = await call(`${APP}/api/platform/custom-domains?account_id=${acme.id}`, { who: OPERATOR });
    expect(((await list.json()) as any).domains).toHaveLength(1);

    const del = await call(`${APP}/api/platform/custom-domains/${DOMAIN}`, { method: "DELETE", who: OPERATOR });
    expect(del.status).toBe(200);
    expect((await browse(`${CUSTOM}/report`, OWNER)).status).toBe(404);
    const row = await env.DB.prepare("SELECT status, is_primary FROM custom_domains").first<any>();
    expect(row).toEqual({ status: "removed", is_primary: 0 });
    const audit = await env.DB.prepare("SELECT action FROM admin_audit ORDER BY id").all<any>();
    expect(audit.results.map((r: any) => r.action)).toEqual(["domain.registered", "domain.removed"]);
  });

  it("refuses bad hostnames, free/pro workspaces, taken names and the plan's limit", async () => {
    expect((await put("rtfx.pro", { account_id: acme.id })).status).toBe(400);
    expect((await put("a.rtfx.pro", { account_id: acme.id })).status).toBe(400);
    expect((await put("127.0.0.1", { account_id: acme.id })).status).toBe(400);
    expect((await put(DOMAIN, { account_id: "nope" })).status).toBe(404);
    expect((await put(DOMAIN, { account_id: acme.id, status: "weird" })).status).toBe(400);
    expect((await put(DOMAIN, {})).status).toBe(400);

    await setPlan(OTHER, "pro");
    const free = await put("docs.evil.example", { account_id: evil.id });
    expect(free.status).toBe(409);
    expect(((await free.json()) as any).error).toBe("plan_required");

    expect((await put(DOMAIN, { account_id: acme.id })).status).toBe(200);
    await setPlan(OTHER, "team");
    expect(((await (await put(DOMAIN, { account_id: evil.id })).json()) as any).error).toBe("taken");
    expect(((await (await put("two.acme.com", { account_id: acme.id })).json()) as any).error).toBe("limit_reached");
  });

  it("is invisible to everyone else: members, plain admins, anonymous, tokens, cross-origin", async () => {
    expect((await put(DOMAIN, { account_id: acme.id }, OWNER)).status).toBe(404);
    expect((await put(DOMAIN, { account_id: acme.id }, "ops@rtfx.pro")).status).toBe(404);
    expect((await put(DOMAIN, { account_id: acme.id }, null)).status).toBeGreaterThanOrEqual(401);
    const cross = await call(`${APP}/api/platform/custom-domains/${DOMAIN}`, {
      method: "PUT",
      who: OPERATOR,
      body: { account_id: acme.id },
      headers: { Origin: "https://evil.example" },
    });
    expect(cross.status).toBe(404);
    expect((await call(`${APP}/api/platform/custom-domains`, { who: OWNER })).status).toBe(404);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM custom_domains").first<any>()).n).toBe(0);
  });

  it("is not reachable on a customer host", async () => {
    await activate(acme.id);
    const res = await call(`${CUSTOM}/api/platform/custom-domains`, { who: OPERATOR });
    expect(res.status).toBe(404);
  });
});
