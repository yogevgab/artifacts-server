import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { createAccount, ensurePersonalAccount, getAccount, listMembers, upsertMember } from "../src/accounts";
import { createApiToken } from "../src/tokens";
import { tierCta, UPGRADE_TEAM_PATH } from "../src/plan-copy";
import { as, clearR2, initDb, withToken } from "./fixtures";

/**
 * Self-serve Team: member-invite email, the /admin/join/:id link it carries,
 * and /upgrade/team (sign up → name the team workspace → checkout).
 */

const ALICE = "alice@test.com";
const BOB = "bob@test.com";
const ANON = { headers: { "X-Dev-Anonymous": "true" } };
const HTML = { Accept: "text/html" };
const now = () => new Date().toISOString();

interface Sent {
  to: string;
  subject: string;
  html: string;
  text: string;
}

function harness() {
  const sent: Sent[] = [];
  const e = {
    ...(env as any),
    MAIL_FROM: "no-reply@rtfx.pro",
    PUBLIC_BASE_URL: "https://rtfx.test",
    EMAIL: { send: async (m: Sent) => void sent.push(m) },
    LEMONSQUEEZY_STORE_ID: "test-store",
    LEMONSQUEEZY_VARIANT_PRO: "variant-pro",
    LEMONSQUEEZY_VARIANT_TEAM: "variant-team",
    LEMONSQUEEZY_CHECKOUT_PRO: "slug-pro",
    LEMONSQUEEZY_CHECKOUT_TEAM: "slug-team",
  };
  const call = (path: string, init: RequestInit = {}) => app.request(path, { ...init, redirect: "manual" }, e);
  return { sent, e, call };
}

async function teamOwnedBy(owner: string, plan = "free") {
  const team = await createAccount(env as any, { name: "Acme", kind: "team", personalEmail: null, createdBy: owner, now: now() });
  await upsertMember(env as any, { accountId: team.id, email: owner, role: "owner", invitedBy: null, now: now() });
  if (plan !== "free") await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, team.id).run();
  return team.id;
}

const teamWorkspacesOwnedBy = async (email: string) =>
  (
    await env.DB.prepare(
      `SELECT a.id FROM accounts a JOIN account_members m ON m.account_id = a.id
        WHERE a.kind = 'team' AND m.email = ? AND m.role = 'owner'`
    )
      .bind(email)
      .all<{ id: string }>()
  ).results.map((r) => r.id);

beforeEach(async () => {
  await initDb();
  await clearR2();
});

// --- invite email ----------------------------------------------------------

describe("adding a member emails them", () => {
  const add = (h: ReturnType<typeof harness>, id: string, email: string) =>
    h.call(
      `/api/workspace/${id}/members`,
      as(ALICE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, role: "member" }) })
    );

  it("sends a link into the workspace and reports it", async () => {
    const h = harness();
    const id = await teamOwnedBy(ALICE, "team");
    const res = await add(h, id, BOB);
    expect(res.status).toBe(201);
    expect((await res.json<any>()).invite).toEqual({ sent: true });
    expect(h.sent).toHaveLength(1);
    const mail = h.sent[0];
    expect(mail.to).toBe(BOB);
    expect(mail.subject).toBe(`${ALICE} added you to Acme on rtfx.pro`);
    expect(mail.html).toContain(`https://rtfx.test/admin/join/${encodeURIComponent(id)}`);
    expect(mail.text).toContain(`https://rtfx.test/admin/join/${encodeURIComponent(id)}`);
    const log = await env.DB.prepare("SELECT kind, status FROM mail_log WHERE email = ?").bind(BOB).first<any>();
    expect(log).toEqual({ kind: "member_invite", status: "sent" });
  });

  it("keeps the membership when the email fails, and says so", async () => {
    const h = harness();
    h.e.EMAIL = { send: async () => { throw Object.assign(new Error("nope"), { code: "E_RECIPIENT_SUPPRESSED" }); } };
    const id = await teamOwnedBy(ALICE, "team");
    const res = await add(h, id, BOB);
    expect(res.status).toBe(201);
    expect((await res.json<any>()).invite).toEqual({ sent: false, reason: "mail_failed" });
    expect((await listMembers(env as any, id)).map((m) => m.email)).toContain(BOB);
  });

  it("stops mailing one address after a few add/remove cycles", async () => {
    const h = harness();
    const id = await teamOwnedBy(ALICE, "team");
    // Its own address: rate-limit buckets are hourly and not reset between tests.
    const CAROL = "carol-ratelimit@test.com";
    const results: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await add(h, id, CAROL);
      results.push((await res.json<any>()).invite);
      await h.call(`/api/workspace/${id}/members/${encodeURIComponent(CAROL)}`, as(ALICE, { method: "DELETE" }));
    }
    expect(h.sent).toHaveLength(5);
    expect(results[5]).toEqual({ sent: false, reason: "rate_limited" });
  });
});

// --- /admin/join/:id ----------------------------------------------------------

describe("GET /admin/join/:id", () => {
  it("sends somebody signed out to sign in, coming back here", async () => {
    const h = harness();
    const id = await teamOwnedBy(ALICE);
    const res = await h.call(`/admin/join/${id}`, { headers: { ...ANON.headers, ...HTML } });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/login?next=${encodeURIComponent(`/admin/join/${id}`)}`);
  });

  it("opens the workspace for a member", async () => {
    const h = harness();
    const id = await teamOwnedBy(ALICE);
    await upsertMember(env as any, { accountId: id, email: BOB, role: "member", invitedBy: ALICE, now: now() });
    const res = await h.call(`/admin/join/${id}`, as(BOB, { headers: HTML }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin");
    expect(res.headers.get("Set-Cookie")).toContain(`rtfx_account=${encodeURIComponent(id)}`);
  });

  it("changes nothing for somebody who isn't a member", async () => {
    const h = harness();
    const id = await teamOwnedBy(ALICE);
    const res = await h.call(`/admin/join/${id}`, as(BOB, { headers: HTML }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

// --- /upgrade/team ------------------------------------------------------------

describe("Buy Team CTA", () => {
  it("is self-serve and points at /upgrade/team", () => {
    const cta = tierCta("team");
    expect(cta).toMatchObject({ kind: "self-serve", href: UPGRADE_TEAM_PATH });
    expect(cta.label).toContain("Buy Team");
    expect(cta.label).toContain("$40/mo");
  });

  it("is the primary button on the public /team page", async () => {
    const h = harness();
    const body = await (await h.call("/team", ANON)).text();
    expect(body).toContain(`href="${UPGRADE_TEAM_PATH}" data-cta="team-primary"`);
    expect(body).not.toContain("invite email that would make it self-serve");
  });
});

describe("GET /upgrade/team", () => {
  it("sends somebody signed out to sign up, coming back here", async () => {
    const h = harness();
    const res = await h.call(UPGRADE_TEAM_PATH, { headers: { ...ANON.headers, ...HTML } });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/signup?next=%2Fupgrade%2Fteam");
  });

  it("asks somebody with no team workspace to name one", async () => {
    const h = harness();
    await ensurePersonalAccount(env as any, ALICE, now());
    const res = await h.call(UPGRADE_TEAM_PATH, as(ALICE, { headers: HTML }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("data-team-name-form");
    expect(body).toContain('action="/upgrade/team"');
  });

  it("sends the owner of an unpaid team workspace to its checkout", async () => {
    const h = harness();
    const id = await teamOwnedBy(ALICE);
    const res = await h.call(UPGRADE_TEAM_PATH, as(ALICE, { headers: HTML }));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.pathname).toBe("/checkout/buy/slug-team");
    expect(location.searchParams.get("enabled")).toBe("variant-team");
    expect(location.searchParams.get("checkout[custom][account_id]")).toBe(id);
    expect(res.headers.get("Set-Cookie")).toContain(`rtfx_account=${encodeURIComponent(id)}`);
  });

  it("lets the owner of a PAID team workspace start another one (name form, not Billing)", async () => {
    const h = harness();
    await teamOwnedBy(ALICE, "team");
    const res = await h.call(UPGRADE_TEAM_PATH, as(ALICE, { headers: HTML }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("data-team-name-form");
  });

  it("finds the unpaid team workspace even when a paid one comes first", async () => {
    const h = harness();
    await teamOwnedBy(ALICE, "team");
    const unpaid = await teamOwnedBy(ALICE);
    const res = await h.call(UPGRADE_TEAM_PATH, as(ALICE, { headers: HTML }));
    expect(new URL(res.headers.get("Location")!).searchParams.get("checkout[custom][account_id]")).toBe(unpaid);
  });

  it("does not sell somebody else's workspace to an admin who isn't in it right now", async () => {
    const h = harness();
    const id = await teamOwnedBy(ALICE);
    await upsertMember(env as any, { accountId: id, email: BOB, role: "admin", invitedBy: ALICE, now: now() });
    // Signing in always gives Bob a personal workspace, which is active by default.
    await ensurePersonalAccount(env as any, BOB, now());
    const res = await h.call(UPGRADE_TEAM_PATH, as(BOB, { headers: HTML }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("data-team-name-form");
  });

  it("does let an admin buy for the unpaid team workspace they have open", async () => {
    const h = harness();
    const id = await teamOwnedBy(ALICE);
    await upsertMember(env as any, { accountId: id, email: BOB, role: "admin", invitedBy: ALICE, now: now() });
    const res = await h.call(
      UPGRADE_TEAM_PATH,
      as(BOB, { headers: { ...HTML, Cookie: `rtfx_account=${encodeURIComponent(id)}` } })
    );
    expect(new URL(res.headers.get("Location")!).searchParams.get("checkout[custom][account_id]")).toBe(id);
  });

  it("does not sell a plain member a plan for the workspace they're in", async () => {
    const h = harness();
    const id = await teamOwnedBy(ALICE);
    await upsertMember(env as any, { accountId: id, email: BOB, role: "member", invitedBy: ALICE, now: now() });
    const res = await h.call(UPGRADE_TEAM_PATH, as(BOB, { headers: HTML }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("data-team-name-form");
  });

  it("never hands a bearer token a checkout", async () => {
    const h = harness();
    const id = await teamOwnedBy(ALICE);
    const { token } = await createApiToken(env as any, {
      name: "ci", ownerEmail: ALICE, accountId: id, isAdmin: false, scopes: ["read", "publish"],
      createdBy: ALICE, expiresAt: null, now: now(),
    });
    const res = await h.call(UPGRADE_TEAM_PATH, withToken(token, { headers: HTML }));
    expect(res.headers.get("Location") ?? "").not.toContain("lemonsqueezy");
  });
});

describe("POST /upgrade/team", () => {
  const submit = (h: ReturnType<typeof harness>, who: string, name: string) =>
    h.call(
      UPGRADE_TEAM_PATH,
      as(who, {
        method: "POST",
        headers: { ...HTML, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name }).toString(),
      })
    );

  it("creates the team workspace with the buyer as owner and goes to its checkout", async () => {
    const h = harness();
    await ensurePersonalAccount(env as any, ALICE, now());
    const res = await submit(h, ALICE, "  Acme   design ");
    expect(res.status).toBe(303);
    const [id] = await teamWorkspacesOwnedBy(ALICE);
    expect(id).toBeTruthy();
    const account = await getAccount(env as any, id);
    expect(account).toMatchObject({ name: "Acme design", kind: "team", plan: "free" });
    const location = new URL(res.headers.get("Location")!);
    expect(location.pathname).toBe("/checkout/buy/slug-team");
    expect(location.searchParams.get("checkout[custom][account_id]")).toBe(id);
    expect(location.searchParams.get("checkout[email]")).toBe(ALICE);
    expect(res.headers.get("Set-Cookie")).toContain(`rtfx_account=${encodeURIComponent(id)}`);
  });

  it("reuses the unpaid team workspace on a second submit instead of making another", async () => {
    const h = harness();
    await submit(h, ALICE, "Acme");
    await submit(h, ALICE, "Acme again");
    expect(await teamWorkspacesOwnedBy(ALICE)).toHaveLength(1);
  });

  it("refuses an empty or over-long name", async () => {
    const h = harness();
    expect((await submit(h, ALICE, "   ")).status).toBe(400);
    expect((await submit(h, ALICE, "x".repeat(61))).status).toBe(400);
    expect(await teamWorkspacesOwnedBy(ALICE)).toHaveLength(0);
  });

  it("escapes the name it echoes back", async () => {
    const h = harness();
    const body = await (await submit(h, ALICE, `<script>x</script>${"y".repeat(60)}`)).text();
    expect(body).not.toContain("<script>x</script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("refuses a form posted without a session (cross-site)", async () => {
    const h = harness();
    const res = await h.call(UPGRADE_TEAM_PATH, {
      method: "POST",
      headers: { ...ANON.headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: "name=Evil",
    });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.headers.get("Location") ?? "").not.toContain("lemonsqueezy");
    expect(await teamWorkspacesOwnedBy(ALICE)).toHaveLength(0);
  });
});
