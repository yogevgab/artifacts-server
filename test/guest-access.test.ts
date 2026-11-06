import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { mintSession } from "../src/session";
import { createChallenge } from "../src/otp";
import { GUEST_COOKIE } from "../src/viewing";
import { initDb, clearR2, req, as, viewerPath } from "./fixtures";

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const CONTENT = "https://a.rtfx.pro";
const APP = "https://rtfx.pro";
const OWNER = "owner@rtfx.pro";
const GUEST = "dana@acme.com";
const NOW = () => new Date().toISOString();

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
const nav = (cookie?: string) => ({
  headers: {
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    ...(cookie ? { Cookie: cookie } : {}),
  },
});

beforeEach(async () => {
  await initDb();
  await clearR2();
  const body = new FormData();
  body.set("slug", "report");
  body.set("title", "Report");
  body.set("visibility", "restricted");
  body.set("file", new File(["<h1>secret</h1>"], "index.html", { type: "text/html" }));
  await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
  await req("/api/artifacts/report/access", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visibility: "restricted", emails: [GUEST] }),
    ...as(OWNER),
  });
});

/** The canonical viewer URL for `report`. */
const viewerUrl = async () => `${APP}${await viewerPath("report")}`;

async function guestSession(email = GUEST, slug = "report") {
  return mintSession(SECRET, { email, kind: "guest", slug }, NOW());
}

describe("guests view what they were granted", () => {
  it("lets a granted guest open the artifact, on the app host", async () => {
    const res = await app.request(await viewerUrl(), nav(`${GUEST_COOKIE}=${await guestSession()}`), e());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<iframe");
  });

  it("refuses a guest credential minted for a different artifact", async () => {
    const other = await mintSession(SECRET, { email: GUEST, kind: "guest", slug: "something-else" }, NOW());
    const res = await app.request(await viewerUrl(), nav(`${GUEST_COOKIE}=${other}`), e());
    // Not a credential for THIS artifact, so it is no credential: the visitor is sent to sign in.
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/shared/report");
    const inSession = await app.request(await viewerUrl(), nav(`${SESSION_COOKIE}=${other}`), e());
    expect(inSession.status).toBe(404);
  });

  it("refuses a guest whose grant was revoked", async () => {
    await req("/api/artifacts/report/access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "restricted", emails: [] }),
      ...as(OWNER),
    });
    const res = await app.request(await viewerUrl(), nav(`${GUEST_COOKIE}=${await guestSession()}`), e());
    expect(res.status).toBe(404);
  });

  it("does not replace a signed-in member: the guest cookie is separate", async () => {
    const member = await mintSession(SECRET, { email: OWNER, kind: "member" }, NOW());
    const res = await app.request(
      await viewerUrl(),
      nav(`${SESSION_COOKIE}=${member}; ${GUEST_COOKIE}=${await guestSession()}`),
      e()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("data-share-banner"); // the member (owner) won
  });

  it("falls back to the guest credential when the signed-in member has no access", async () => {
    const member = await mintSession(SECRET, { email: "stranger@example.com", kind: "member" }, NOW());
    const res = await app.request(
      await viewerUrl(),
      nav(`${SESSION_COOKIE}=${member}; ${GUEST_COOKIE}=${await guestSession()}`),
      e()
    );
    expect(res.status).toBe(200);
  });

  it("never lets a guest reach the dashboard", async () => {
    const res = await app.request(
      "https://rtfx.pro/admin",
      { headers: { Accept: "text/html", Cookie: `${SESSION_COOKIE}=${await guestSession()}` } },
      e()
    );
    expect(res.status).toBe(403);
  });

  it("shows a guest no share banner", async () => {
    const html = await (
      await app.request(await viewerUrl(), nav(`${GUEST_COOKIE}=${await guestSession()}`), e())
    ).text();
    expect(html).not.toContain("data-share-banner");
  });
});

describe("guest sign-in", () => {
  it("sends an unknown visitor to a guest sign-in that returns to the canonical address", async () => {
    const res = await app.request(await viewerUrl(), nav(), e());
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("/shared/report?next=")).toBe(true);
    expect(decodeURIComponent(loc.split("next=")[1])).toBe(await viewerPath("report"));
  });

  it("redeeming the emailed link sets a guest cookie on the app host and lands on the canonical address", async () => {
    const issued = await createChallenge(env as any, { email: GUEST, purpose: "guest", slug: "report", now: NOW() });
    const res = await app.request(`${APP}/auth/m/${issued.token}`, { method: "POST" }, e());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(await viewerPath("report"));
    const cookies = res.headers.getSetCookie();
    const guest = cookies.find((c) => c.startsWith(`${GUEST_COOKIE}=`)) ?? "";
    expect(guest).toContain("HttpOnly");
    expect(guest).toContain("Secure");
    expect(guest).toContain("SameSite=Lax");
    // Never a member session: redeeming an invitation does not create an account.
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);

    const opened = await app.request(await viewerUrl(), nav(guest.split(";")[0]), e());
    expect(opened.status).toBe(200);
  });

  it("retired the content-host handoff", async () => {
    const res = await app.request(`${APP}/auth/content?next=${encodeURIComponent(`${CONTENT}/report/`)}`, {}, e());
    expect(res.status).toBe(404);
  });

  it("mints a guest session for someone holding a grant but no account", async () => {
    const res = await app.request(
      `https://rtfx.pro/auth/guest?slug=report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: GUEST }),
      },
      e()
    );
    expect(res.status).toBe(202);
  });

  it("answers the same for an address with no grant, so it is not an oracle", async () => {
    const granted = await app.request(
      `https://rtfx.pro/auth/guest?slug=report`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: GUEST }) },
      e()
    );
    const not = await app.request(
      `https://rtfx.pro/auth/guest?slug=report`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "nobody@x.com" }) },
      e()
    );
    expect(granted.status).toBe(not.status);
    expect(await granted.json()).toEqual(await not.json());
  });
});

describe("the shared-link landing page", () => {
  it("asks an unknown visitor for the address it was shared with", async () => {
    const res = await app.request("https://rtfx.pro/shared/report", { headers: { Accept: "text/html" } }, e());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("data-guest-form");
    expect(html).toContain("/auth/guest");
  });

  it("looks identical for an artifact that does not exist", async () => {
    const real = await (await app.request("https://rtfx.pro/shared/report", {}, e())).text();
    const fake = await (await app.request("https://rtfx.pro/shared/no-such-thing", {}, e())).text();
    expect(fake.replace(/no-such-thing/g, "report")).toBe(real);
  });

  it("sends a signed-in member straight to the artifact's canonical address", async () => {
    const session = await mintSession(SECRET, { email: OWNER, kind: "member" }, NOW());
    const res = await app.request(
      "https://rtfx.pro/shared/report",
      { headers: { Cookie: `${SESSION_COOKIE}=${session}` } },
      e()
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(await viewerUrl());
  });

  it("honours ?next= for a signed-in member, but only a local path", async () => {
    const session = await mintSession(SECRET, { email: OWNER, kind: "member" }, NOW());
    const headers = { Cookie: `${SESSION_COOKIE}=${session}` };
    const ok = await app.request("https://rtfx.pro/shared/report?next=%2Fabc%2Freport", { headers }, e());
    expect(ok.headers.get("location")).toBe("/abc/report");
    const evil = await app.request("https://rtfx.pro/shared/report?next=https%3A%2F%2Fevil.example", { headers }, e());
    expect(evil.headers.get("location")).toBe(await viewerUrl());
  });

  it("carries next into the guest page's sign-in link", async () => {
    const html = await (
      await app.request("https://rtfx.pro/shared/report?next=%2Fabc%2Freport", {}, e())
    ).text();
    expect(html).toContain("/login?next=%2Fabc%2Freport");
  });
});

/**
 * The gate form is the only door a signed-out owner sees on their own page. A
 * grant is how *other* people get in, so an owner or a workspace member never
 * holds one — before this, typing their address here sent nothing at all while
 * the page said a link was on its way.
 */
describe("the gate recognises people who belong to the artifact", () => {
  const MEMBER = "mia@rtfx.pro";
  const STRANGER = "nobody@x.com";
  const ADMIN = "ops@rtfx.pro";
  let mailbox: any[] = [];
  const ge = (extra: Record<string, unknown> = {}) =>
    e({
      // The owner is deliberately NOT a platform admin here.
      ADMIN_EMAILS: ADMIN,
      EMAIL: { send: async (m: any) => (mailbox.push(m), { messageId: "m" }) },
      ...extra,
    });
  const gate = (email: string, host = APP, extra: Record<string, unknown> = {}) =>
    app.request(
      `${host}/auth/guest?slug=report`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) },
      ge(extra)
    );
  const rows = async (table: string, email: string) =>
    (await (env as any).DB.prepare(`SELECT * FROM ${table} WHERE email = ?`).bind(email).all()).results as any[];
  const verify = (email: string, code: string, extra: Record<string, unknown> = {}) =>
    app.request(
      `${APP}/auth/verify`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, code }) },
      ge(extra)
    );

  beforeEach(async () => {
    mailbox = [];
    await (env as any).DB.prepare("DELETE FROM waitlist_rate_limits").run().catch(() => {});
    await (env as any).DB.prepare("DELETE FROM mail_log").run().catch(() => {});
    await (env as any).DB.prepare("DELETE FROM auth_challenges").run().catch(() => {});
  });

  it("sends the owner a member sign-in (code + link) that names the artifact", async () => {
    expect((await gate(OWNER)).status).toBe(202);
    const ch = await rows("auth_challenges", OWNER);
    expect(ch.map((r) => [r.purpose, r.slug])).toEqual([["signin", "report"]]);
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0].text).toMatch(/\b\d{6}\b/);
    expect(mailbox[0].text).toContain("/auth/m/");
  });

  it("sends a workspace member (any role) a member sign-in too", async () => {
    const art = (await (env as any).DB.prepare("SELECT account_id FROM artifacts WHERE slug = 'report'").first()) as {
      account_id: string;
    };
    await (env as any).DB.prepare(
      "INSERT INTO account_members (account_id, email, role, created_at, updated_at) VALUES (?, ?, 'viewer', ?, ?)"
    )
      .bind(art.account_id, MEMBER, NOW(), NOW())
      .run();
    expect((await gate(MEMBER)).status).toBe(202);
    expect((await rows("auth_challenges", MEMBER)).map((r) => [r.purpose, r.slug])).toEqual([["signin", "report"]]);
    expect(mailbox).toHaveLength(1);
  });

  it("an admin gets a member sign-in only for an ownerless artifact, as the viewer decides", async () => {
    await gate(ADMIN);
    expect(await rows("auth_challenges", ADMIN)).toEqual([]);
    await (env as any).DB.prepare("UPDATE artifacts SET owner_email = NULL, account_id = NULL WHERE slug = 'report'").run();
    await (env as any).DB.prepare("DELETE FROM waitlist_rate_limits").run();
    await gate(ADMIN);
    expect((await rows("auth_challenges", ADMIN)).map((r) => [r.purpose, r.slug])).toEqual([["signin", "report"]]);
  });

  it("still gives a grantee the scoped guest link, and a stranger nothing", async () => {
    await gate(GUEST);
    await gate(STRANGER);
    expect((await rows("auth_challenges", GUEST)).map((r) => [r.purpose, r.slug])).toEqual([["guest", "report"]]);
    expect(await rows("auth_challenges", STRANGER)).toEqual([]);
    expect(await rows("mail_log", STRANGER)).toEqual([]);
    expect(mailbox.map((m) => m.to)).toEqual([GUEST]);
  });

  it("answers owner, grantee and stranger identically", async () => {
    const bodies = [];
    for (const who of [OWNER, GUEST, STRANGER]) {
      const res = await gate(who);
      bodies.push([res.status, await res.text()]);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("is rate limited per address", async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await gate(OWNER)).status;
    expect(last).toBe(429);
  });

  it("refuses a cross-site POST", async () => {
    const res = await app.request(
      `${APP}/auth/guest?slug=report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ email: OWNER }),
      },
      ge()
    );
    expect(res.status).toBe(403);
    expect(await rows("auth_challenges", OWNER)).toEqual([]);
  });

  it("a reviewer address gets a challenge but no email and no link", async () => {
    const reviewer = "reviewer@rtfx.pro";
    await (env as any).DB.prepare("UPDATE artifacts SET owner_email = ? WHERE slug = 'report'").bind(reviewer).run();
    await gate(reviewer, APP, { REVIEWER_EMAIL: reviewer, REVIEWER_CODE: "424242" });
    expect(mailbox).toEqual([]);
    expect(await rows("mail_log", reviewer)).toEqual([]);
    expect(await rows("auth_challenges", reviewer)).toHaveLength(1);
  });

  it("round trip: owner asks at the gate, types the emailed code, lands on the artifact", async () => {
    await gate(OWNER);
    const code = /\b(\d{6})\b/.exec(mailbox[0].text)![1];
    const res = await verify(OWNER, code);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { redirect: string }).redirect).toBe(await viewerPath("report"));
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    const view = await app.request(await viewerUrl(), nav(cookie.split(";")[0]), ge());
    expect(view.status).toBe(200);
    expect(await view.text()).toContain("<iframe");
  });

  it("round trip: the emailed link lands on the artifact, even from another device", async () => {
    await gate(OWNER);
    const token = /\/auth\/m\/([A-Za-z0-9_-]+)/.exec(mailbox[0].text)![1];
    const res = await app.request(`${APP}/auth/m/${token}`, { method: "POST" }, ge());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(await viewerPath("report"));
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
  });

  it("a guest challenge's code never opens a member session", async () => {
    const issued = await createChallenge(env as any, { email: GUEST, purpose: "guest", slug: "report", now: NOW() });
    expect((await verify(GUEST, issued.code)).status).toBe(401);
  });

  it("an ordinary sign-in still lands on the dashboard", async () => {
    const issued = await createChallenge(env as any, { email: OWNER, purpose: "signin", now: NOW() });
    const res = await app.request(`${APP}/auth/m/${issued.token}`, { method: "POST" }, ge());
    expect(res.headers.get("location")).toBe("/admin");
  });

  it("the gate page shows a code field after submit and posts it to /auth/verify", async () => {
    const html = await (await app.request("https://rtfx.pro/shared/report", {}, e())).text();
    expect(html).toContain("data-guest-code");
    expect(html).toContain('name="code"');
    expect(html).toContain("/auth/verify");
    expect(html).toContain("Too many attempts");
    expect(html).toContain("Something went wrong");
  });
});
