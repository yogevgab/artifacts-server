import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  accountIdsWithAtLeast,
  atLeast,
  ensurePersonalAccount,
  listMemberships,
  memberRole,
  personalAccountFor,
  resolveAccountContext,
  upsertMember,
  MANAGE_ARTIFACTS,
  type AccountRole,
  type AccountRoles,
} from "../src/accounts";
import {
  belongsToCaller,
  canManage,
  canManageMembers,
  canReadAccount,
  isPlatformAdmin,
  isPlatformSuperAdmin,
  memberChangeDenial,
} from "../src/authz";
import { canSeeSection } from "../src/portal";
import type { Identity } from "../src/auth";
import { as, dropAccountIdColumns, dropAccountTables, htmlForm, initDb, req, withToken } from "./fixtures";

/**
 * Accounts, memberships, and the boundary between an ACCOUNT role and a PLATFORM
 * role (issue #27).
 *
 * The single most important property under test is negative: no value that can be
 * written to D1 — a `users.role`, an `account_members.role`, an API payload —
 * may ever produce platform authority. Platform authority comes from
 * ADMIN_EMAILS / SUPER_ADMIN_EMAILS and nothing else. Several tests below exist
 * purely to fail loudly if that ever stops being true.
 */

// vitest.config.ts: admin@test.com is the super admin, admin2@test.com a plain
// admin. Everybody else is an ordinary member at platform level.
const OWNER = "admin@test.com";
const PLATFORM_ADMIN = "admin2@test.com";
const ALICE = "alice@test.com";
const BOB = "bob@test.com";
const CARA = "cara@test.com";
const DAN = "dan@test.com";

const html = new TextEncoder().encode("<h1>hi</h1>");

const identity = (email: string | null, over: Partial<Identity> = {}): Identity => ({
  email,
  commonName: null,
  isAdmin: false,
  role: "member",
  ...over,
});

const roles = (entries: Record<string, AccountRole>): AccountRoles => new Map(Object.entries(entries));

/** Publish an artifact as `email`, returning the API payload. */
async function publish(email: string, slug: string, title = slug) {
  const res = await req(
    "/api/artifacts",
    as(email, { method: "POST", body: htmlForm({ title, slug }, "index.html", html) })
  );
  expect(res.status).toBe(200);
  return res.json<{ slug: string }>();
}

/** The `account_id` D1 actually holds for a slug. */
async function accountOf(slug: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT account_id FROM artifacts WHERE slug = ?")
    .bind(slug)
    .first<{ account_id: string | null }>();
  return row?.account_id ?? null;
}

beforeEach(async () => {
  await initDb();
});

// --- pure policy: account roles ---------------------------------------------

describe("account role ordering", () => {
  it("ranks owner > admin > member > viewer", () => {
    expect(atLeast("owner", "viewer")).toBe(true);
    expect(atLeast("admin", "member")).toBe(true);
    expect(atLeast("member", "member")).toBe(true);
    expect(atLeast("viewer", "member")).toBe(false);
    expect(atLeast("member", "admin")).toBe(false);
    expect(atLeast(null, "viewer")).toBe(false);
  });

  it("selects only the accounts where a role clears the bar", () => {
    const map = roles({ a: "owner", b: "member", c: "viewer" });
    expect(accountIdsWithAtLeast(map, MANAGE_ARTIFACTS).sort()).toEqual(["a", "b"]);
    expect(accountIdsWithAtLeast(map, "viewer").sort()).toEqual(["a", "b", "c"]);
  });
});

describe("canManage across the three authorization paths", () => {
  const platformAdmin = identity(OWNER, { isAdmin: true, role: "super_admin" });
  const alice = identity(ALICE);
  const legacy = { owner_email: ALICE, account_id: null };
  const teamArtifact = { owner_email: BOB, account_id: "acct_team" };

  it("a platform admin manages everything, account or not", () => {
    expect(canManage(platformAdmin, legacy)).toBe(true);
    expect(canManage(platformAdmin, teamArtifact)).toBe(true);
    expect(canManage(platformAdmin, { owner_email: null, account_id: null })).toBe(true);
  });

  it("the legacy owner_email path still works with no account context at all", () => {
    // This is the backwards-compatibility guarantee: an artifact migration 0010
    // never adopted behaves exactly as it did before #27.
    expect(canManage(alice, legacy)).toBe(true);
    expect(canManage(alice, legacy, undefined)).toBe(true);
    expect(canManage(alice, legacy, new Map())).toBe(true);
  });

  it("an account member manages the account's artifacts, whoever published them", () => {
    expect(canManage(alice, teamArtifact, roles({ acct_team: "member" }))).toBe(true);
    expect(canManage(alice, teamArtifact, roles({ acct_team: "admin" }))).toBe(true);
    expect(canManage(alice, teamArtifact, roles({ acct_team: "owner" }))).toBe(true);
  });

  it("a viewer may see but not manage", () => {
    expect(canManage(alice, teamArtifact, roles({ acct_team: "viewer" }))).toBe(false);
    expect(belongsToCaller(alice, teamArtifact, roles({ acct_team: "viewer" }))).toBe(true);
  });

  it("membership of another account reaches nothing", () => {
    expect(canManage(alice, teamArtifact, roles({ acct_other: "owner" }))).toBe(false);
    expect(belongsToCaller(alice, teamArtifact, roles({ acct_other: "owner" }))).toBe(false);
  });

  it("an unowned, account-less artifact stays platform-admin-only", () => {
    const orphan = { owner_email: null, account_id: null };
    expect(canManage(alice, orphan, roles({ acct_team: "owner" }))).toBe(false);
  });
});

describe("account role is never platform authority", () => {
  it("an account owner is not a platform admin", () => {
    const alice = identity(ALICE);
    // Owner of their workspace, top account role there…
    expect(canManage(alice, { owner_email: ALICE, account_id: "acct_a" }, roles({ acct_a: "owner" }))).toBe(
      true
    );
    // …and still nobody at platform level.
    expect(isPlatformAdmin(alice)).toBe(false);
    expect(isPlatformSuperAdmin(alice)).toBe(false);
    expect(canManage(alice, { owner_email: BOB, account_id: "acct_b" }, roles({ acct_a: "owner" }))).toBe(
      false
    );
  });

  it("the Platform section is gated on the platform role alone", () => {
    const base = { email: ALICE, isTokenCaller: false } as const;
    // An account owner with no platform role: no Platform section.
    expect(
      canSeeSection(
        { ...base, isAdmin: false, role: "member", workspace: { id: "a", name: "A", kind: "personal", role: "owner", count: 1 } },
        "platform"
      )
    ).toBe(false);
    // The platform super admin sees it regardless of any workspace role.
    expect(
      canSeeSection(
        { ...base, isAdmin: true, role: "super_admin", workspace: { id: "a", name: "A", kind: "team", role: "viewer", count: 1 } },
        "platform"
      )
    ).toBe(true);
  });
});

describe("member-change policy", () => {
  const accountAdmin = identity(ALICE);
  const platformAdmin = identity(PLATFORM_ADMIN, { isAdmin: true, role: "admin" });

  it("only an account owner may create or demote another owner", () => {
    expect(
      memberChangeDenial(accountAdmin, "admin", { targetCurrentRole: "member", nextRole: "owner", ownerCount: 1 })
    ).toMatch(/account owner/);
    expect(
      memberChangeDenial(accountAdmin, "owner", { targetCurrentRole: "member", nextRole: "owner", ownerCount: 1 })
    ).toBeNull();
  });

  it("a platform admin bypasses that, because they administer the instance", () => {
    expect(
      memberChangeDenial(platformAdmin, null, { targetCurrentRole: "member", nextRole: "owner", ownerCount: 1 })
    ).toBeNull();
  });

  it("nobody may strand an account without an owner — not even a platform admin", () => {
    const lastOwner = { targetCurrentRole: "owner" as const, nextRole: null, ownerCount: 1 };
    expect(memberChangeDenial(platformAdmin, null, lastOwner)).toMatch(/last owner/);
    expect(memberChangeDenial(accountAdmin, "owner", lastOwner)).toMatch(/last owner/);
    // With a second owner in place it is fine.
    expect(memberChangeDenial(accountAdmin, "owner", { ...lastOwner, ownerCount: 2 })).toBeNull();
  });

  it("managing members needs account admin, or platform rights", () => {
    expect(canManageMembers(accountAdmin, roles({ a: "admin" }), "a")).toBe(true);
    expect(canManageMembers(accountAdmin, roles({ a: "member" }), "a")).toBe(false);
    expect(canManageMembers(accountAdmin, roles({ a: "viewer" }), "a")).toBe(false);
    expect(canManageMembers(platformAdmin, new Map(), "a")).toBe(true);
    expect(canManageMembers(null, roles({ a: "owner" }), "a")).toBe(false);
  });

  it("any member — viewer included — may read their account", () => {
    expect(canReadAccount(accountAdmin, roles({ a: "viewer" }), "a")).toBe(true);
    expect(canReadAccount(accountAdmin, roles({ b: "owner" }), "a")).toBe(false);
  });
});

// --- provisioning -----------------------------------------------------------

describe("ensurePersonalAccount", () => {
  it("creates the workspace and an owner membership", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, "2024-01-01T00:00:00.000Z");
    expect(account).not.toBeNull();
    expect(account!.kind).toBe("personal");
    expect(account!.personal_email).toBe(ALICE);
    expect(await memberRole(env as any, account!.id, ALICE)).toBe("owner");
  });

  it("is idempotent — a second call returns the same account, not a second one", async () => {
    const first = await ensurePersonalAccount(env as any, ALICE, "2024-01-01T00:00:00.000Z");
    const second = await ensurePersonalAccount(env as any, "  ALICE@TEST.com ", "2024-06-01T00:00:00.000Z");
    expect(second!.id).toBe(first!.id);
    const { results } = await env.DB.prepare("SELECT id FROM accounts WHERE personal_email = ?")
      .bind(ALICE)
      .all();
    expect(results).toHaveLength(1);
  });

  it("survives concurrent first-use without minting two workspaces", async () => {
    const now = "2024-01-01T00:00:00.000Z";
    const all = await Promise.all([
      ensurePersonalAccount(env as any, BOB, now),
      ensurePersonalAccount(env as any, BOB, now),
      ensurePersonalAccount(env as any, BOB, now),
    ]);
    const ids = new Set(all.map((a) => a?.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
  });

  it("fails soft when the tables do not exist yet", async () => {
    await dropAccountTables();
    expect(await ensurePersonalAccount(env as any, ALICE, "2024-01-01T00:00:00.000Z")).toBeNull();
    expect(await personalAccountFor(env as any, ALICE)).toBeNull();
    expect(await listMemberships(env as any, ALICE)).toEqual([]);
    expect(await memberRole(env as any, "acct_x", ALICE)).toBeNull();
    const ctx = await resolveAccountContext(env as any, { email: ALICE });
    expect(ctx.active).toBeNull();
    expect(ctx.roles.size).toBe(0);
  });
});

describe("resolveAccountContext", () => {
  it("provisions a personal workspace on first use and makes it active", async () => {
    const ctx = await resolveAccountContext(env as any, { email: ALICE });
    expect(ctx.active?.personal_email).toBe(ALICE);
    expect(ctx.role).toBe("owner");
    expect(ctx.pinned).toBe(false);
    expect(ctx.memberships).toHaveLength(1);
  });

  it("never provisions when asked not to", async () => {
    const ctx = await resolveAccountContext(env as any, { email: CARA }, { ensure: false });
    expect(ctx.active).toBeNull();
    expect(await personalAccountFor(env as any, CARA)).toBeNull();
  });

  it("prefers the personal workspace when somebody is in several", async () => {
    const personal = await ensurePersonalAccount(env as any, ALICE, "2024-01-01T00:00:00.000Z");
    await env.DB.prepare(
      `INSERT INTO accounts (id, name, kind, status, plan, created_by, created_at, updated_at)
       VALUES ('acct_team1', 'Acme', 'team', 'active', 'free', ?, ?, ?)`
    )
      .bind(OWNER, "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
      .run();
    await upsertMember(env as any, {
      accountId: "acct_team1",
      email: ALICE,
      role: "member",
      invitedBy: OWNER,
      now: "2024-01-01T00:00:00.000Z",
    });
    const ctx = await resolveAccountContext(env as any, { email: ALICE });
    expect(ctx.active?.id).toBe(personal!.id);
    expect(ctx.memberships).toHaveLength(2);
    expect(ctx.roles.get("acct_team1")).toBe("member");
  });
});

// --- end to end: artifacts are account-scoped -------------------------------

describe("publishing attaches the artifact to a workspace", () => {
  it("stamps account_id with the publisher's personal account", async () => {
    await publish(ALICE, "alice-one");
    const personal = await personalAccountFor(env as any, ALICE);
    expect(personal).not.toBeNull();
    expect(await accountOf("alice-one")).toBe(personal!.id);
  });

  it("does not re-home an artifact when somebody else publishes a new version", async () => {
    await publish(ALICE, "shared-slug");
    const alicesAccount = await accountOf("shared-slug");
    // The platform admin republishes: ownership and workspace must both survive.
    await publish(OWNER, "shared-slug");
    expect(await accountOf("shared-slug")).toBe(alicesAccount);
    const row = await env.DB.prepare("SELECT owner_email FROM artifacts WHERE slug = ?")
      .bind("shared-slug")
      .first<{ owner_email: string }>();
    expect(row!.owner_email).toBe(ALICE);
  });

  it("still publishes when the accounts tables are missing", async () => {
    await dropAccountTables();
    await publish(ALICE, "no-accounts-yet");
    // Owner still manages it, purely through owner_email. accountOf cannot run
    // after account tables are dropped only because this test has not dropped the
    // artifacts.account_id column.
    const res = await req("/api/artifacts", as(ALICE));
    const body = await res.json<{ artifacts: { slug: string }[] }>();
    expect(body.artifacts.map((a) => a.slug)).toContain("no-accounts-yet");
  });

  it("still publishes/lists/mints tokens when account_id columns are not migrated yet", async () => {
    await ensurePersonalAccount(env as any, ALICE, "2024-01-01T00:00:00.000Z");
    await dropAccountIdColumns();

    await publish(ALICE, "no-account-columns-yet");
    const listed = await req("/api/artifacts", as(ALICE));
    expect(listed.status).toBe(200);
    expect((await listed.json<{ artifacts: { slug: string }[] }>()).artifacts.map((a) => a.slug)).toContain(
      "no-account-columns-yet"
    );

    const minted = await req(
      "/api/tokens",
      as(ALICE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "pre-0009 token" }),
      })
    );
    expect(minted.status).toBe(201);
    const { token } = await minted.json<{ token: string }>();
    const viaToken = await req("/api/artifacts", withToken(token));
    expect(viaToken.status).toBe(200);
    expect((await viaToken.json<{ artifacts: { slug: string }[] }>()).artifacts.map((a) => a.slug)).toContain(
      "no-account-columns-yet"
    );
  });
});

describe("team workspaces", () => {
  /** A team account owned by ALICE, with the given extra members. */
  async function team(members: Record<string, AccountRole> = {}) {
    const res = await req(
      "/api/accounts",
      as(OWNER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Acme", owner_email: ALICE }),
      })
    );
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();
    // Seats are enforced per plan, and a free workspace has exactly one. These
    // tests are about roles and authorization, not billing, so the workspace is
    // put on a plan with room rather than each test working around the cap.
    await env.DB.prepare("UPDATE accounts SET plan = 'team' WHERE id = ?").bind(id).run();
    for (const [email, role] of Object.entries(members)) {
      const put = await req(
        `/api/accounts/${id}/members/${encodeURIComponent(email)}`,
        as(ALICE, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
        })
      );
      expect(put.status).toBe(200);
    }
    return id;
  }

  /** Move an existing artifact into an account, as migration 0010 would. */
  async function adopt(slug: string, accountId: string) {
    await env.DB.prepare("UPDATE artifacts SET account_id = ? WHERE slug = ?")
      .bind(accountId, slug)
      .run();
  }

  it("the creating platform admin is not made a member", async () => {
    const id = await team();
    expect(await memberRole(env as any, id, OWNER)).toBeNull();
    expect(await memberRole(env as any, id, ALICE)).toBe("owner");
  });

  it("a member manages the workspace's artifacts even though they don't own them", async () => {
    const id = await team({ [BOB]: "member" });
    await publish(ALICE, "team-artifact");
    await adopt("team-artifact", id);

    const list = await req("/api/artifacts", as(BOB));
    const body = await list.json<{ artifacts: { slug: string }[] }>();
    expect(body.artifacts.map((a) => a.slug)).toContain("team-artifact");

    // And can actually act on it, not merely see it.
    const versions = await req("/api/artifacts/team-artifact/versions", as(BOB));
    expect(versions.status).toBe(200);
  });

  it("a viewer gets neither the management list nor management actions", async () => {
    const id = await team({ [CARA]: "viewer" });
    await publish(ALICE, "viewer-test");
    await adopt("viewer-test", id);

    const list = await req("/api/artifacts", as(CARA));
    const body = await list.json<{ artifacts: { slug: string }[] }>();
    expect(body.artifacts.map((a) => a.slug)).not.toContain("viewer-test");

    // 404, not 403: refusing must never confirm the slug exists.
    expect((await req("/api/artifacts/viewer-test/versions", as(CARA))).status).toBe(404);
    expect((await req("/api/artifacts/viewer-test", as(CARA, { method: "DELETE" }))).status).toBe(404);
  });

  it("a viewer can still open the artifact itself — that is what viewer means", async () => {
    const id = await team({ [CARA]: "viewer" });
    await publish(ALICE, "viewer-read");
    await adopt("viewer-read", id);
    // Restricted by default, and Cara holds no grant — membership is what lets her in.
    const res = await req("/viewer-read/", as(CARA));
    expect(res.status).toBe(200);
    // Somebody outside the workspace still gets 404.
    expect((await req("/viewer-read/", as(DAN))).status).toBe(404);
  });

  it("somebody outside the workspace reaches nothing", async () => {
    const id = await team({ [BOB]: "member" });
    await publish(ALICE, "private-team");
    await adopt("private-team", id);

    const list = await req("/api/artifacts", as(DAN));
    const body = await list.json<{ artifacts: { slug: string }[] }>();
    expect(body.artifacts.map((a) => a.slug)).not.toContain("private-team");
    expect((await req("/api/artifacts/private-team/versions", as(DAN))).status).toBe(404);
    expect((await req("/v/private-team/1/index.html", as(DAN))).status).toBe(404);
  });

  it("a member cannot manage the member list; an admin can", async () => {
    const id = await team({ [BOB]: "member", [CARA]: "admin" });
    const asBob = await req(
      `/api/accounts/${id}/members/${encodeURIComponent(DAN)}`,
      as(BOB, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      })
    );
    expect(asBob.status).toBe(403);

    const asCara = await req(
      `/api/accounts/${id}/members/${encodeURIComponent(DAN)}`,
      as(CARA, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      })
    );
    expect(asCara.status).toBe(200);
    expect(await memberRole(env as any, id, DAN)).toBe("member");
  });

  it("an account admin cannot promote anybody (including themselves) to owner", async () => {
    const id = await team({ [CARA]: "admin" });
    const res = await req(
      `/api/accounts/${id}/members/${encodeURIComponent(CARA)}`,
      as(CARA, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "owner" }),
      })
    );
    expect(res.status).toBe(403);
    expect(await memberRole(env as any, id, CARA)).toBe("admin");
  });

  it("the last owner cannot be removed", async () => {
    const id = await team({ [CARA]: "admin" });
    const res = await req(
      `/api/accounts/${id}/members/${encodeURIComponent(ALICE)}`,
      as(OWNER, { method: "DELETE" })
    );
    expect(res.status).toBe(403);
    expect(await memberRole(env as any, id, ALICE)).toBe("owner");
  });

  it("a workspace nobody belongs to is a 404, not a 403", async () => {
    const id = await team();
    expect((await req(`/api/accounts/${id}/members`, as(DAN))).status).toBe(404);
    expect((await req(`/api/accounts/acct_nope/members`, as(OWNER))).status).toBe(404);
  });

  it("membership does not widen who may sign in", async () => {
    // Adding somebody to a workspace must not touch the user directory: the
    // login allow-list stays an admin-only concern via /api/users.
    const id = await team({ [DAN]: "member" });
    expect(id).toBeTruthy();
    const row = await env.DB.prepare("SELECT email FROM users WHERE email = ?").bind(DAN).first();
    expect(row).toBeNull();
  });

  it("only a platform admin may create a workspace", async () => {
    const res = await req(
      "/api/accounts",
      as(ALICE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Sneaky", owner_email: ALICE }),
      })
    );
    expect(res.status).toBe(403);
  });
});

// --- API tokens are account-scoped ------------------------------------------

describe("API tokens and workspaces", () => {
  async function mint(email: string, body: Record<string, unknown> = {}) {
    const res = await req(
      "/api/tokens",
      as(email, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test token", ...body }),
      })
    );
    expect(res.status).toBe(201);
    return res.json<{ token: string; account_id: string | null }>();
  }

  it("pins a member's token to their own workspace", async () => {
    await publish(ALICE, "alice-token-art");
    const personal = await personalAccountFor(env as any, ALICE);
    const { token, account_id } = await mint(ALICE);
    expect(account_id).toBe(personal!.id);

    // And the token acts inside that workspace.
    const res = await req("/api/artifacts", withToken(token));
    const body = await res.json<{ artifacts: { slug: string }[] }>();
    expect(body.artifacts.map((a) => a.slug)).toEqual(["alice-token-art"]);
  });

  it("pins an admin-minted token to the OWNER's workspace, not the admin's", async () => {
    const { account_id } = await mint(OWNER, { owner_email: BOB });
    const bobs = await personalAccountFor(env as any, BOB);
    const admins = await personalAccountFor(env as any, OWNER);
    expect(account_id).toBe(bobs!.id);
    expect(account_id).not.toBe(admins?.id ?? null);
  });

  it("leaves a platform (admin) token account-less", async () => {
    const { account_id } = await mint(OWNER, { is_admin: true });
    expect(account_id).toBeNull();
  });

  it("a token cannot reach a workspace its owner joined later", async () => {
    // Bob's token is pinned to Bob's personal account at mint time…
    const { token } = await mint(BOB);
    // …then Bob joins a team account that owns an artifact.
    const created = await req(
      "/api/accounts",
      as(OWNER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Later", owner_email: ALICE }),
      })
    );
    const { id } = await created.json<{ id: string }>();
    await upsertMember(env as any, {
      accountId: id,
      email: BOB,
      role: "member",
      invitedBy: OWNER,
      now: new Date().toISOString(),
    });
    await publish(ALICE, "later-artifact");
    await env.DB.prepare("UPDATE artifacts SET account_id = ? WHERE slug = ?")
      .bind(id, "later-artifact")
      .run();

    // Bob himself reaches it; his pinned token does not.
    const asBob = await req("/api/artifacts", as(BOB));
    expect((await asBob.json<{ artifacts: { slug: string }[] }>()).artifacts.map((a) => a.slug)).toContain(
      "later-artifact"
    );
    const asToken = await req("/api/artifacts", withToken(token));
    expect(
      (await asToken.json<{ artifacts: { slug: string }[] }>()).artifacts.map((a) => a.slug)
    ).not.toContain("later-artifact");
  });

  it("GET /api/accounts reports the token's single pinned workspace", async () => {
    await publish(ALICE, "pinned-art");
    const personal = await personalAccountFor(env as any, ALICE);
    const { token } = await mint(ALICE);

    const res = await req("/api/accounts", withToken(token));
    expect(res.status).toBe(200);
    const body = await res.json<{
      accounts: { id: string; your_role: string }[];
      active: string;
      pinned: boolean;
    }>();
    expect(body.pinned).toBe(true);
    expect(body.active).toBe(personal!.id);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].your_role).toBe("owner");
  });

  it("an API token cannot change a workspace's members", async () => {
    const created = await req(
      "/api/accounts",
      as(OWNER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Locked", owner_email: ALICE }),
      })
    );
    const { id } = await created.json<{ id: string }>();
    const { token } = await mint(ALICE);
    const res = await req(
      `/api/accounts/${id}/members/${encodeURIComponent(DAN)}`,
      withToken(token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "owner" }),
      })
    );
    expect(res.status).toBe(403);
    expect(await memberRole(env as any, id, DAN)).toBeNull();
  });
});

// --- the escalation boundary, end to end ------------------------------------

describe("no D1 role escalation", () => {
  it("writing account_members.role = 'owner' grants nothing at platform level", async () => {
    // Dan hand-writes himself owner of every workspace that exists.
    await publish(ALICE, "alices-artifact");
    const alices = await personalAccountFor(env as any, ALICE);
    await upsertMember(env as any, {
      accountId: alices!.id,
      email: DAN,
      role: "owner",
      invitedBy: null,
      now: new Date().toISOString(),
    });

    // He reaches that one workspace's artifacts — by design…
    const list = await req("/api/artifacts", as(DAN));
    expect((await list.json<{ artifacts: { slug: string }[] }>()).artifacts.map((a) => a.slug)).toContain(
      "alices-artifact"
    );

    // …and nothing that is platform authority.
    expect((await req("/api/users", as(DAN))).status).toBe(403);
    expect((await req("/admin/platform", as(DAN))).status).toBe(404);
    expect((await req("/admin/people", as(DAN))).status).toBe(404);
    const whoami = await req("/admin/settings", as(DAN));
    expect(await whoami.text()).toContain('data-badge="role">Member<');
  });

  it("writing users.role = 'super_admin' grants nothing either", async () => {
    await env.DB.prepare(
      `INSERT INTO users (email, role, status, created_at) VALUES (?, 'super_admin', 'active', ?)`
    )
      .bind(DAN, new Date().toISOString())
      .run();
    expect((await req("/api/users", as(DAN))).status).toBe(403);
    expect((await req("/admin/platform", as(DAN))).status).toBe(404);
  });

  it("a platform admin is not silently made a member of the accounts they administer", async () => {
    await publish(ALICE, "audit-trail");
    const alices = await personalAccountFor(env as any, ALICE);
    // The operator can manage it (platform authority) but is not in the workspace,
    // so an audit trail never shows them as one of the customer's members.
    expect(await memberRole(env as any, alices!.id, OWNER)).toBeNull();
    expect((await req("/api/artifacts/audit-trail/versions", as(OWNER))).status).toBe(200);
  });
});

// --- backwards compatibility -------------------------------------------------

describe("legacy compatibility", () => {
  it("an artifact with only owner_email is still fully manageable by its owner", async () => {
    await env.DB.prepare(
      `INSERT INTO artifacts (slug, title, type, entry, file_count, size_bytes, created_by,
         created_at, updated_at, visibility, current_version, owner_email, account_id)
       VALUES ('legacy', 'Legacy', 'single', 'index.html', 1, 10, ?, ?, ?, 'restricted', 1, ?, NULL)`
    )
      .bind(ALICE, "2023-01-01T00:00:00.000Z", "2023-01-01T00:00:00.000Z", ALICE)
      .run();

    const list = await req("/api/artifacts", as(ALICE));
    expect((await list.json<{ artifacts: { slug: string }[] }>()).artifacts.map((a) => a.slug)).toContain(
      "legacy"
    );
    expect((await req("/api/artifacts/legacy/versions", as(ALICE))).status).toBe(200);
    // …and invisible to everybody else, exactly as before.
    expect((await req("/api/artifacts/legacy/versions", as(BOB))).status).toBe(404);
  });

  it("a legacy token with no account_id still acts as its owner", async () => {
    await publish(ALICE, "legacy-token-art");
    const res = await req(
      "/api/tokens",
      as(ALICE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "legacy" }),
      })
    );
    const { token, id } = await res.json<{ token: string; id: string }>();
    // Simulate a token minted before #27.
    await env.DB.prepare("UPDATE api_tokens SET account_id = NULL WHERE id = ?").bind(id).run();

    const list = await req("/api/artifacts", withToken(token));
    expect((await list.json<{ artifacts: { slug: string }[] }>()).artifacts.map((a) => a.slug)).toEqual([
      "legacy-token-art",
    ]);
  });

  it("the whole portal still renders with the accounts tables missing", async () => {
    await publish(ALICE, "portal-legacy");
    await dropAccountTables();
    for (const path of ["/admin", "/admin/artifacts", "/admin/settings", "/admin/integrations"]) {
      const res = await req(path, as(ALICE));
      expect(res.status, path).toBe(200);
    }
    const settings = await req("/admin/settings", as(ALICE));
    expect(await settings.text()).toContain('data-workspace-state="none"');
  });
});

// --- portal surface ----------------------------------------------------------

describe("portal shows workspace context", () => {
  it("names the workspace in the header and the settings panel", async () => {
    await publish(ALICE, "context-art");
    const settings = await req("/admin/settings", as(ALICE));
    const html = await settings.text();
    expect(html).toContain("data-viewer-workspace");
    expect(html).toContain('data-workspace-state="active"');
    expect(html).toContain('data-badge="workspace-role">Owner<');
    // The two role systems are shown as separate facts.
    expect(html).toContain('data-badge="role">Member<');
  });

  it("shows a team workspace with the viewer's account role", async () => {
    const created = await req(
      "/api/accounts",
      as(OWNER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Acme Inc", owner_email: ALICE }),
      })
    );
    const { id } = await created.json<{ id: string }>();
    await upsertMember(env as any, {
      accountId: id,
      email: DAN,
      role: "member",
      invitedBy: OWNER,
      now: new Date().toISOString(),
    });
    const res = await req("/admin/settings", as(DAN));
    const html = await res.text();
    expect(html).toContain("Acme Inc");
    expect(html).toContain('data-badge="workspace-role">Member<');
    expect(html).toContain('data-badge="workspace-kind">Team<');
  });

  it("GET /api/accounts lists the caller's workspaces", async () => {
    await publish(ALICE, "accounts-api");
    const res = await req("/api/accounts", as(ALICE));
    expect(res.status).toBe(200);
    const body = await res.json<{
      accounts: { id: string; kind: string; your_role: string }[];
      active: string;
      pinned: boolean;
    }>();
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].kind).toBe("personal");
    expect(body.accounts[0].your_role).toBe("owner");
    expect(body.active).toBe(body.accounts[0].id);
    expect(body.pinned).toBe(false);
  });
});
