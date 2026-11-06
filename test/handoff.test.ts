import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { mintSession, verifySession } from "../src/session";
import { registerDomain, clearCustomDomainCache } from "../src/custom-domains";
import { personalAccountFor } from "../src/accounts";
import { hashToken } from "../src/tokens";
import { HANDOFF_COOKIE, issueHandoff, nextOnHost } from "../src/handoff";
import { initDb } from "./fixtures";

/**
 * Cross-host sign-in handoff (src/handoff.ts): a sign-in on mcp.rtfx.pro also
 * signs the browser in on rtfx.pro, with host-only cookies throughout.
 */

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const APP = "rtfx.pro";
const MCP = "mcp.rtfx.pro";
const CONTENT = "a.rtfx.pro";
const EMAIL = "dana@acme.com";
const AUTHORIZE = "/oauth/authorize?client_id=c1&response_type=code&state=xyz";

let sent: any[] = [];

const e = () => ({
  ...(env as any),
  SESSION_SECRET: SECRET,
  DEV_LOGIN: undefined,
  MAIL_FROM: "no-reply@rtfx.pro",
  CONTENT_HOSTNAMES: CONTENT,
  PUBLIC_BASE_URL: `https://${APP}`,
  CUSTOM_DOMAINS_ENABLED: "true",
  EMAIL: {
    send: async (m: any) => {
      sent.push(m);
      return { messageId: "m" };
    },
  },
});

/** A minimal browser: one cookie jar per host (host-only cookies), manual redirects. */
class Browser {
  jars = new Map<string, Map<string, string>>();
  trail: string[] = [];

  jar(host: string) {
    if (!this.jars.has(host)) this.jars.set(host, new Map());
    return this.jars.get(host)!;
  }
  cookieHeader(host: string) {
    return [...this.jar(host)].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  store(host: string, res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";").map((s) => s.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      // Host-only means a Domain attribute would be a bug in this product.
      expect(attrs.some((a) => /^domain=/i.test(a))).toBe(false);
      if (!value || attrs.some((a) => /^max-age=0$/i.test(a))) this.jar(host).delete(name);
      else this.jar(host).set(name, value);
    }
  }
  async send(url: string, init: RequestInit = {}, env = e()): Promise<Response> {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    // Browsers always send this; every real chain here is same-site.
    if (!headers.has("Sec-Fetch-Site")) headers.set("Sec-Fetch-Site", "same-site");
    const ck = this.cookieHeader(u.hostname);
    if (ck) headers.set("Cookie", ck);
    const res = await app.request(url, { ...init, headers, redirect: "manual" }, env);
    this.store(u.hostname, res);
    return res;
  }
  /** Follow redirects like a browser navigation; returns the final response and URL. */
  async navigate(url: string, env = e()): Promise<{ res: Response; url: string }> {
    let current = url;
    for (let i = 0; i < 12; i++) {
      this.trail.push(current);
      const res = await this.send(current, { headers: { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" } }, env);
      const loc = res.headers.get("Location");
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString();
        continue;
      }
      return { res, url: current };
    }
    throw new Error("redirect loop: " + this.trail.join(" -> "));
  }
  async whoami(host: string): Promise<string | null> {
    const res = await this.send(`https://${host}/whoami`);
    return ((await res.json()) as { email: string | null }).email;
  }
  /** Sign in on `host` with the emailed code, parking `next` the way /login does. */
  async signIn(host: string, next: string | null, email = EMAIL): Promise<Response> {
    if (next) await this.send(`https://${host}/login?next=${encodeURIComponent(next)}`);
    sent = [];
    await this.send(`https://${host}/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const code = /\b(\d{6})\b/.exec(sent[0].text)![1];
    return this.send(`https://${host}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
  }
}

beforeEach(async () => {
  sent = [];
  await initDb();
  await env.DB.prepare("DROP TABLE IF EXISTS waitlist_rate_limits").run();
  clearCustomDomainCache();
});

describe("OAuth sign-in on the MCP host", () => {
  it("code sign-in: lands back on authorize and is signed in on both app hosts", async () => {
    const b = new Browser();
    const verify = await b.signIn(MCP, AUTHORIZE);
    expect(verify.status).toBe(200);
    const { redirect } = (await verify.json()) as { redirect: string };

    // The client is sent through the handoff, not straight to authorize.
    expect(new URL(redirect).origin).toBe(`https://${APP}`);
    expect(new URL(redirect).pathname).toBe("/auth/handoff/begin");
    expect(b.cookieHeader(APP)).toBe("");

    const { url } = await b.navigate(redirect);
    expect(url).toBe(`https://${MCP}${AUTHORIZE}`);
    expect(await b.whoami(MCP)).toBe(EMAIL);
    expect(await b.whoami(APP)).toBe(EMAIL);
    // The handoff nonce cookie is gone once it has been used.
    expect(b.jar(APP).has(HANDOFF_COOKIE)).toBe(false);
  });

  it("magic-link sign-in: same result", async () => {
    const b = new Browser();
    await b.send(`https://${MCP}/login?next=${encodeURIComponent(AUTHORIZE)}`);
    sent = [];
    await b.send(`https://${MCP}/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL }),
    });
    const link = /https:\/\/mcp\.rtfx\.pro\/auth\/m\/([A-Za-z0-9_-]+)/.exec(sent[0].text)!;
    const confirm = await b.send(link[0], { method: "POST" });
    expect(confirm.status).toBe(302);
    const { url } = await b.navigate(confirm.headers.get("Location")!);
    expect(url).toBe(`https://${MCP}${AUTHORIZE}`);
    expect(await b.whoami(APP)).toBe(EMAIL);
    expect(await b.whoami(MCP)).toBe(EMAIL);
  });

  it("the session minted on the other host has the same identity and kind, and no aud", async () => {
    const b = new Browser();
    const { redirect } = (await (await b.signIn(MCP, AUTHORIZE)).json()) as { redirect: string };
    await b.navigate(redirect);
    const a = await verifySession(SECRET, b.jar(APP).get(SESSION_COOKIE)!, new Date().toISOString(), null);
    const m = await verifySession(SECRET, b.jar(MCP).get(SESSION_COOKIE)!, new Date().toISOString(), null);
    expect(a).toMatchObject({ email: EMAIL, kind: "member" });
    expect(a?.aud).toBeUndefined();
    expect(m).toMatchObject({ email: EMAIL, kind: "member" });
  });

  it("a sign-in on the canonical host is unchanged (no handoff)", async () => {
    const b = new Browser();
    const verify = await b.signIn(APP, "/admin/artifacts");
    expect(((await verify.json()) as { redirect: string }).redirect).toBe("/admin/artifacts");
  });
});

describe("revocation parity", () => {
  async function signedInEverywhere() {
    const b = new Browser();
    const { redirect } = (await (await b.signIn(MCP, AUTHORIZE)).json()) as { redirect: string };
    await b.navigate(redirect);
    // Session iat has one-second resolution; sign out strictly later.
    await new Promise((r) => setTimeout(r, 1100));
    return b;
  }

  it("signing out on rtfx.pro voids the handed-off and the original session", async () => {
    const b = await signedInEverywhere();
    const mcpCookie = b.cookieHeader(MCP);
    await b.send(`https://${APP}/auth/signout`, { method: "POST" });
    expect(await b.whoami(APP)).toBeNull();
    // A copy of the mcp cookie taken earlier no longer works either.
    const res = await app.request(`https://${MCP}/whoami`, { headers: { Cookie: mcpCookie } }, e());
    expect(((await res.json()) as any).email).toBeNull();
  });

  it("signing out on mcp.rtfx.pro voids the rtfx.pro session", async () => {
    const b = await signedInEverywhere();
    const appCookie = b.cookieHeader(APP);
    await b.send(`https://${MCP}/auth/signout`, { method: "POST" });
    const res = await app.request(`https://${APP}/whoami`, { headers: { Cookie: appCookie } }, e());
    expect(((await res.json()) as any).email).toBeNull();
  });

  it("a sign-out between issue and redeem stops the handoff from minting a session", async () => {
    const b = new Browser();
    await b.signIn(MCP, AUTHORIZE);
    const begin = await b.send(
      `https://${APP}/auth/handoff/begin?next=${encodeURIComponent(`https://${MCP}${AUTHORIZE}`)}`
    );
    const issue = await b.send(begin.headers.get("Location")!);
    const redeemUrl = issue.headers.get("Location")!;
    expect(redeemUrl).toContain("/auth/handoff?t=");
    await env.DB.prepare(
      "INSERT INTO session_revocations (email, revoked_before) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET revoked_before = excluded.revoked_before"
    )
      .bind(EMAIL, new Date(Date.now() + 5000).toISOString())
      .run()
      .catch(async () => {
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS session_revocations (email TEXT PRIMARY KEY, revoked_before TEXT NOT NULL)").run();
        await env.DB.prepare("INSERT INTO session_revocations VALUES (?, ?)")
          .bind(EMAIL, new Date(Date.now() + 5000).toISOString())
          .run();
      });
    const redeem = await b.send(redeemUrl);
    // No session, but no dead end either: back to the consent screen.
    expect(redeem.status).toBe(302);
    expect(redeem.headers.get("Location")).toBe(`https://${MCP}${AUTHORIZE}`);
    expect(b.jar(APP).has(SESSION_COOKIE)).toBe(false);
  });
});

/** Run begin and issue by hand so a test can poke at the token. */
async function startHandoff(b: Browser, next = `https://${MCP}${AUTHORIZE}`) {
  const begin = await b.send(`https://${APP}/auth/handoff/begin?next=${encodeURIComponent(next)}`);
  const issue = await b.send(begin.headers.get("Location")!);
  return { begin, issue, redeemUrl: issue.headers.get("Location")! };
}

describe("token rules", () => {
  let b: Browser;
  beforeEach(async () => {
    b = new Browser();
    await b.signIn(MCP, AUTHORIZE);
  });

  it("is single use: a replay fails, and mints nothing", async () => {
    const { redeemUrl } = await startHandoff(b);
    const nonce = b.jar(APP).get(HANDOFF_COOKIE)!;
    const first = await b.send(redeemUrl);
    expect(first.status).toBe(302);
    // Replay with the same nonce cookie (an attacker who captured the whole URL
    // and also holds the cookie still gets nothing the second time).
    const replay = await app.request(
      redeemUrl,
      { headers: { Cookie: `${HANDOFF_COOKIE}=${nonce}`, "Sec-Fetch-Site": "same-site" }, redirect: "manual" },
      e()
    );
    expect(replay.status).toBe(302);
    expect(replay.headers.get("Location")).toBe(`https://${MCP}${AUTHORIZE}`);
    expect(replay.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !/Max-Age=0/.test(c))).toBe(false);
  });

  it("expires after 60 seconds", async () => {
    const { redeemUrl } = await startHandoff(b);
    await env.DB.prepare("UPDATE auth_handoffs SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    const res = await b.send(redeemUrl);
    expect(res.headers.get("Location")).toBe(`https://${MCP}${AUTHORIZE}`);
    expect(b.jar(APP).has(SESSION_COOKIE)).toBe(false);
  });

  it("has a TTL of at most 60 seconds and is stored hashed", async () => {
    const { redeemUrl } = await startHandoff(b);
    const token = new URL(redeemUrl).searchParams.get("t")!;
    const row = await env.DB.prepare("SELECT * FROM auth_handoffs").first<any>();
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBeLessThanOrEqual(60_000);
    expect(row.token_hash).toBe(await hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row).toMatchObject({ email: EMAIL, source_host: MCP, target_host: APP, next_path: AUTHORIZE });
  });

  it("only runs mcp -> rtfx.pro: the reverse direction is not reachable", async () => {
    const { redeemUrl } = await startHandoff(b);
    const token = new URL(redeemUrl).searchParams.get("t")!;
    const h = "a".repeat(64);
    expect((await b.send(`https://${MCP}/auth/handoff?t=${token}`)).status).toBe(404);
    expect((await b.send(`https://${MCP}/auth/handoff/begin?next=${encodeURIComponent(`https://${APP}/`)}`)).status).toBe(404);
    expect((await b.send(`https://${APP}/auth/handoff/issue?h=${h}&next=/`)).status).toBe(404);
    // Refused before the database is touched, so the real token is intact.
    await b.send(redeemUrl);
    expect(b.jar(APP).has(SESSION_COOKIE)).toBe(true);
  });

  it("is bound to the browser that started it (login CSRF), and a wrong redeem burns the token", async () => {
    // The attacker signs in as themselves and captures their redeem URL...
    const attacker = new Browser();
    await attacker.signIn(MCP, AUTHORIZE, "attacker@evil.com");
    const { redeemUrl } = await startHandoff(attacker);

    // ...then lures a victim, who has no nonce cookie, to it.
    const noCookie = await app.request(redeemUrl, { redirect: "manual", headers: { "Sec-Fetch-Site": "same-site" } }, e());
    expect(noCookie.status).toBe(302);
    expect(noCookie.headers.getSetCookie().some((c) => /^rtfx_session=[^;]+/.test(c))).toBe(false);

    // That failed redeem destroyed the token; even the attacker's own browser
    // (matching nonce) cannot use it now.
    await attacker.send(redeemUrl);
    expect(attacker.jar(APP).has(SESSION_COOKIE)).toBe(false);

    // Fresh token, victim with a different nonce: fails and is burned too.
    const { redeemUrl: second } = await startHandoff(attacker);
    const victim = new Browser();
    await victim.send(`https://${APP}/auth/handoff/begin?next=${encodeURIComponent(`https://${MCP}/`)}`);
    const victimHit = await victim.send(second);
    expect(victimHit.status).toBe(302);
    expect(victim.jar(APP).has(SESSION_COOKIE)).toBe(false);
    await attacker.send(second);
    expect(attacker.jar(APP).has(SESSION_COOKIE)).toBe(false);
  });

  it("an attacker-chosen h is refused cross-site, and a token minted for it dies on first use", async () => {
    // Attacker gets h = sha256(their nonce) from their own /begin.
    const attacker = new Browser();
    const abegin = await attacker.send(
      `https://${APP}/auth/handoff/begin?next=${encodeURIComponent(`https://${MCP}/`)}`
    );
    const h = new URL(abegin.headers.get("Location")!).searchParams.get("h")!;
    // A victim signed in on mcp is sent to issue with that h from the attacker's
    // page: cross-site, refused, nothing minted.
    const crossSite = await b.send(`https://${MCP}/auth/handoff/issue?h=${h}&next=/`, {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSite.headers.get("Location")).toBe("/");
    // Even if a token were minted for it, the victim's own failed redeem burns it.
    const minted = await b.send(`https://${MCP}/auth/handoff/issue?h=${h}&next=/`);
    const redeemUrl = minted.headers.get("Location")!;
    expect(redeemUrl).toContain("/auth/handoff?t=");
    const victimHit = await b.send(redeemUrl);
    expect(victimHit.status).toBe(302);
    expect(b.jar(APP).has(SESSION_COOKIE)).toBe(false);
    await attacker.send(redeemUrl);
    expect(attacker.jar(APP).has(SESSION_COOKIE)).toBe(false);
  });

  it("the nonce cookie is a __Host- cookie, so a sibling host cannot toss one over it", async () => {
    const begin = await b.send(
      `https://${APP}/auth/handoff/begin?next=${encodeURIComponent(`https://${MCP}${AUTHORIZE}`)}`
    );
    const line = begin.headers.getSetCookie().find((c) => c.startsWith(HANDOFF_COOKIE))!;
    expect(line).toMatch(/^__Host-/);
    expect(line).toMatch(/Secure/);
    expect(line).toMatch(/Path=\//);
    expect(line).toMatch(/HttpOnly/);
    expect(line).not.toMatch(/Domain=/i);
  });

  it("is not issued without a member session on the source host", async () => {
    const anon = new Browser();
    const { issue } = await startHandoff(anon);
    // No token: the flow just continues to `next` on the source host.
    expect(issue.headers.get("Location")).toBe(AUTHORIZE);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_handoffs").first<any>().catch(() => ({ n: 0 }));
    expect(row.n).toBe(0);
  });

  it("is not issued for a guest session", async () => {
    const guest = new Browser();
    const tok = await mintSession(SECRET, { email: EMAIL, kind: "guest", slug: "report" }, new Date().toISOString());
    guest.jar(MCP).set(SESSION_COOKIE, tok);
    const { issue } = await startHandoff(guest);
    expect(issue.headers.get("Location")).toBe(AUTHORIZE);
  });
});

describe("host rules", () => {
  it("is not served by the content host", async () => {
    for (const path of ["/auth/handoff/begin?next=x", "/auth/handoff/issue?h=x&next=/", "/auth/handoff?t=x"]) {
      const res = await app.request(`https://${CONTENT}${path}`, { redirect: "manual" }, e());
      expect(res.status).not.toBe(302);
      expect(res.headers.get("Location") ?? "").not.toContain("handoff");
    }
  });

  it("refuses the content host as a next target and as a token target", async () => {
    const b = new Browser();
    const res = await b.send(`https://${APP}/auth/handoff/begin?next=${encodeURIComponent(`https://${CONTENT}/x`)}`);
    expect(res.status).toBe(400);
    // A token addressed to the content host can never be redeemed there, and the
    // app host refuses a token whose target is not itself.
    const now = new Date().toISOString();
    const token = await issueHandoff(env as any, {
      email: EMAIL,
      sourceHost: MCP,
      targetHost: CONTENT,
      nextPath: "/",
      nonceHash: await hashToken("n"),
      now,
    });
    const redeem = await app.request(
      `https://${APP}/auth/handoff?t=${token}`,
      { headers: { Cookie: `${HANDOFF_COOKIE}=n`, "Sec-Fetch-Site": "same-site" }, redirect: "manual" },
      e()
    );
    expect(redeem.status).toBe(302);
    expect(redeem.headers.getSetCookie().some((c) => /^rtfx_session=[^;]+/.test(c))).toBe(false);
  });

  it("is not served by a customer custom domain, and customer sessions keep their aud", async () => {
    const owner = await mintSession(SECRET, { email: EMAIL, kind: "member" }, new Date(Date.now() - 60_000).toISOString());
    const body = new FormData();
    body.set("slug", "report");
    body.set("title", "Report");
    body.set("visibility", "restricted");
    body.set("file", new File(["<h1>x</h1>"], "index.html", { type: "text/html" }));
    await app.request(`https://${APP}/api/artifacts`, { method: "POST", body, headers: { Cookie: `${SESSION_COOKIE}=${owner}` } }, e());
    const account = await personalAccountFor(env as any, EMAIL);
    await env.DB.prepare("UPDATE accounts SET plan = 'team' WHERE id = ?").bind(account!.id).run();
    const out = await registerDomain(env as any, {
      hostname: "docs.acme.com",
      accountId: account!.id,
      status: "active",
      primary: true,
      actor: { email: EMAIL, role: "member" },
      now: new Date().toISOString(),
    } as any);
    expect(out.ok).toBe(true);

    for (const path of ["/auth/handoff/begin?next=" + encodeURIComponent("https://docs.acme.com/x"), "/auth/handoff?t=" + "a".repeat(64)]) {
      const res = await app.request(`https://docs.acme.com${path}`, { redirect: "manual" }, e());
      expect(res.status).toBe(404);
    }

    // A customer-domain sign-in does not hand off anywhere: it stays on its host.
    const customer = new Browser();
    sent = [];
    await customer.send("https://docs.acme.com/auth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL }),
    });
    const code = /\b(\d{6})\b/.exec(sent[0].text)![1];
    const verify = await customer.send("https://docs.acme.com/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, code }),
    });
    expect(((await verify.json()) as any).redirect).toBe("/");
    const claims = await verifySession(SECRET, customer.jar("docs.acme.com").get(SESSION_COOKIE)!, new Date().toISOString(), "docs.acme.com");
    expect(claims?.aud).toBe("docs.acme.com");
    // And that customer cookie is worthless on the app hosts.
    const res = await app.request(
      `https://${APP}/whoami`,
      { headers: { Cookie: `${SESSION_COOKIE}=${customer.jar("docs.acme.com").get(SESSION_COOKIE)}` } },
      e()
    );
    expect(((await res.json()) as any).email).toBeNull();
  });

  it("is not served from an unrelated host or plain http", async () => {
    for (const base of ["https://preview.example.com", "https://evil.rtfx.pro", "http://rtfx.pro"]) {
      const res = await app.request(`${base}/auth/handoff/begin?next=${encodeURIComponent("https://mcp.rtfx.pro/")}`, { redirect: "manual" }, e());
      expect(res.headers.get("Location") ?? "").not.toContain("/auth/handoff/issue");
    }
  });
});

describe("open redirect", () => {
  it("only accepts absolute https URLs on exactly the source host", () => {
    expect(nextOnHost(`https://${MCP}/oauth/authorize?a=b`, MCP)).toBe("/oauth/authorize?a=b");
    for (const bad of [
      "https://evil.com/",
      `https://${MCP}.evil.com/`,
      `https://evil.com@${MCP}/`,
      `https://${MCP}@evil.com/`,
      `http://${MCP}/`,
      `https://${MCP}:8443/`,
      `https://user:pw@${MCP}/`,
      `https://${CONTENT}/`,
      `https://${APP}/`,
      "//evil.com/",
      "/relative",
      "javascript:alert(1)",
      "",
    ]) {
      expect(nextOnHost(bad, MCP), bad).toBeNull();
    }
  });

  it("begin and issue refuse hostile next values", async () => {
    const b = new Browser();
    for (const bad of ["https://evil.com/", `https://${APP}/`, "//evil.com", "/path"]) {
      const res = await b.send(`https://${APP}/auth/handoff/begin?next=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
    }
    const h = "a".repeat(64);
    for (const bad of ["https://evil.com/", "//evil.com", "\\\\evil.com"]) {
      const res = await b.send(`https://${MCP}/auth/handoff/issue?h=${h}&next=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
    }
  });

  it("the final redirect only ever goes to the stored path on the source host", async () => {
    const b = new Browser();
    await b.signIn(MCP, AUTHORIZE);
    const { redeemUrl } = await startHandoff(b);
    const res = await b.send(redeemUrl);
    expect(res.headers.get("Location")).toBe(`https://${MCP}${AUTHORIZE}`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});

describe("Sec-Fetch-Site gate", () => {
  for (const site of ["cross-site", "none", undefined]) {
    it(`refuses to run the chain when Sec-Fetch-Site is ${site ?? "absent"}, and still lands on authorize`, async () => {
      const b = new Browser();
      await b.signIn(MCP, AUTHORIZE);
      const hdr: Record<string, string> = site ? { "Sec-Fetch-Site": site } : {};
      const call = (url: string, cookie = "") =>
        app.request(url, { headers: { ...hdr, Cookie: cookie }, redirect: "manual" }, e());

      const begin = await call(`https://${APP}/auth/handoff/begin?next=${encodeURIComponent(`https://${MCP}${AUTHORIZE}`)}`);
      expect(begin.headers.get("Location")).toBe(`https://${MCP}${AUTHORIZE}`);
      expect(begin.headers.getSetCookie()).toHaveLength(0);

      const issue = await call(
        `https://${MCP}/auth/handoff/issue?h=${"a".repeat(64)}&next=${encodeURIComponent(AUTHORIZE)}`,
        b.cookieHeader(MCP)
      );
      expect(issue.headers.get("Location")).toBe(AUTHORIZE);

      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_handoffs").first<any>().catch(() => ({ n: 0 }));
      expect(n.n).toBe(0);

      const redeem = await call(`https://${APP}/auth/handoff?t=${"b".repeat(64)}`);
      expect(redeem.status).toBe(302);
      expect(redeem.headers.getSetCookie().some((c) => /^rtfx_session=[^;]+/.test(c))).toBe(false);
    });
  }
});

describe("no dead ends", () => {
  let b: Browser;
  beforeEach(async () => {
    b = new Browser();
    await b.signIn(MCP, AUTHORIZE);
  });

  it("parallel handoffs: the one whose nonce was overwritten fails but still ends on authorize", async () => {
    const first = await startHandoff(b, `https://${MCP}${AUTHORIZE}&n=1`);
    const second = await startHandoff(b, `https://${MCP}${AUTHORIZE}&n=2`);
    // The second begin replaced the nonce cookie, so the first token no longer fits.
    const r1 = await b.send(first.redeemUrl);
    expect(r1.status).toBe(302);
    expect(r1.headers.get("Location")).toBe(`https://${MCP}${AUTHORIZE}&n=1`);
    expect(b.jar(APP).has(SESSION_COOKIE)).toBe(false);
    // The failure cleared the cookie; the second still lands on its own page.
    const r2 = await b.send(second.redeemUrl);
    expect(r2.status).toBe(302);
    expect(r2.headers.get("Location")).toBe(`https://${MCP}${AUTHORIZE}&n=2`);
  });

  it("missing cookie: lands on authorize, no session", async () => {
    const { redeemUrl } = await startHandoff(b);
    b.jar(APP).delete(HANDOFF_COOKIE);
    const res = await b.send(redeemUrl);
    expect(res.headers.get("Location")).toBe(`https://${MCP}${AUTHORIZE}`);
    expect(b.jar(APP).has(SESSION_COOKIE)).toBe(false);
  });

  it("unknown token with the cookie: lands on authorize from the cookie", async () => {
    await startHandoff(b);
    const res = await b.send(`https://${APP}/auth/handoff?t=${"c".repeat(64)}`);
    expect(res.headers.get("Location")).toBe(`https://${MCP}${AUTHORIZE}`);
  });

  it("no cookie and no token: lands on the mcp host root, never on /login", async () => {
    const res = await b.send(`https://${APP}/auth/handoff?t=nope`);
    expect(res.headers.get("Location")).toBe(`https://${MCP}/`);
  });

  it("a rate-limited issue continues to next instead of returning 429", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 62; i++) {
      last = await b.send(`https://${MCP}/auth/handoff/issue?h=${"a".repeat(64)}&next=${encodeURIComponent(AUTHORIZE)}`);
    }
    expect(last!.status).toBe(302);
    expect(last!.headers.get("Location")).toBe(AUTHORIZE);
  });

  it("duplicate handoff cookies are refused, and a non-member identity is not handed off", async () => {
    const { redeemUrl } = await startHandoff(b);
    const nonce = b.jar(APP).get(HANDOFF_COOKIE)!;
    const res = await app.request(
      redeemUrl,
      {
        headers: { Cookie: `${HANDOFF_COOKIE}=${nonce}; ${HANDOFF_COOKIE}=${nonce}`, "Sec-Fetch-Site": "same-site" },
        redirect: "manual",
      },
      e()
    );
    expect(res.headers.getSetCookie().some((c) => /^rtfx_session=[^;]+/.test(c))).toBe(false);

    // DEV_LOGIN-style identity (no session cookie) is not a member session.
    const dev = await app.request(
      `https://${MCP}/auth/handoff/issue?h=${"a".repeat(64)}&next=${encodeURIComponent(AUTHORIZE)}`,
      { headers: { "X-Dev-Email": EMAIL, "Sec-Fetch-Site": "same-site" }, redirect: "manual" },
      { ...e(), DEV_LOGIN: "true" }
    );
    expect(dev.headers.get("Location")).toBe(AUTHORIZE);
  });
});
