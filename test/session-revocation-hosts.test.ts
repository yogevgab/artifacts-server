import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { mintSession } from "../src/session";
import { clearCustomDomainCache, registerDomain } from "../src/custom-domains";
import { personalAccountFor } from "../src/accounts";
import { initDb, clearR2 } from "./fixtures";

/**
 * Server-side sign-out (src/session-revocation.ts) must cover host-bound
 * sessions: a cookie minted for a customer domain (`aud`) is voided by a
 * sign-out on that domain, and by a sign-out on the app host, and vice versa.
 */

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const APP = "https://rtfx.pro";
const DOMAIN = "docs.acme.com";
const CUSTOM = `https://${DOMAIN}`;
const OWNER = "owner@acme.com";
const NAV = { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };

const e = () => ({
  ...(env as any),
  SESSION_SECRET: SECRET,
  DEV_LOGIN: undefined,
  CONTENT_HOSTNAMES: "a.rtfx.pro",
  PUBLIC_BASE_URL: APP,
  CUSTOM_DOMAINS_ENABLED: "true",
});

/** A session cookie issued a minute ago, so a sign-out "now" is strictly after it. */
const ago = () => new Date(Date.now() - 60_000).toISOString();
const cookie = async (aud?: string) =>
  `${SESSION_COOKIE}=${await mintSession(SECRET, { email: OWNER, kind: "member", aud }, ago())}`;

const get = (url: string, ck: string) => app.request(url, { headers: { Cookie: ck, ...NAV } }, e());
const post = (url: string, ck: string) =>
  app.request(url, { method: "POST", headers: { Cookie: ck, "Content-Type": "application/json" }, body: "{}" }, e());

beforeEach(async () => {
  await initDb();
  await clearR2();
  clearCustomDomainCache();
  const body = new FormData();
  body.set("slug", "report");
  body.set("title", "Report");
  body.set("visibility", "restricted");
  body.set("file", new File(["<h1>x</h1>"], "index.html", { type: "text/html" }));
  const ownerCookie = `${SESSION_COOKIE}=${await mintSession(SECRET, { email: OWNER, kind: "member" }, ago())}`;
  expect(
    (await app.request(`${APP}/api/artifacts`, { method: "POST", body, headers: { Cookie: ownerCookie } }, e())).status
  ).toBe(200);
  const account = await personalAccountFor(env as any, OWNER);
  await env.DB.prepare("UPDATE accounts SET plan = 'team' WHERE id = ?").bind(account!.id).run();
  const out = await registerDomain(env as any, {
    hostname: DOMAIN,
    accountId: account!.id,
    status: "active",
    primary: true,
    actor: { email: "admin@test.com", role: "super_admin" },
    now: new Date().toISOString(),
  });
  expect(out.ok).toBe(true);
  clearCustomDomainCache();
});

describe("session revocation and host-bound sessions", () => {
  it("a customer-host session works before sign-out and is void after a sign-out on that host", async () => {
    const ck = await cookie(DOMAIN);
    expect((await get(`${CUSTOM}/report`, ck)).status).toBe(200);
    expect((await post(`${CUSTOM}/auth/signout`, ck)).status).toBe(200);
    expect((await get(`${CUSTOM}/report`, ck)).status).not.toBe(200);
  });

  it("a sign-out on the app host also voids a customer-host cookie for that address", async () => {
    const appCk = await cookie();
    const custCk = await cookie(DOMAIN);
    expect((await get(`${CUSTOM}/report`, custCk)).status).toBe(200);
    expect((await post(`${APP}/auth/signout`, appCk)).status).toBe(200);
    expect((await get(`${CUSTOM}/report`, custCk)).status).not.toBe(200);
    expect((await get(`${APP}/report`, appCk)).status).not.toBe(200);
  });

  it("a sign-out on the customer host voids the app-host cookie too", async () => {
    const appCk = await cookie();
    const custCk = await cookie(DOMAIN);
    expect((await post(`${CUSTOM}/auth/signout`, custCk)).status).toBe(200);
    expect((await get(`${APP}/report`, appCk)).status).not.toBe(200);
  });
});
