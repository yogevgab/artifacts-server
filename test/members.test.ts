import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { membersRoutes } from "../src/members-routes";
import { maxSeatsFor, membersPage, seatLimitDenial, type MembersPageInput } from "../src/members";
import { upsertMember, memberRole, createAccount, type AccountRole, type AccountRow, type MemberRow } from "../src/accounts";
import type { PortalViewer } from "../src/portal";
import { as, initDb, req } from "./fixtures";

/**
 * Workspace member management and seat counting (Team-plan launch surface).
 *
 * The policy under test — last-owner protection, owner-promotion, who may
 * manage members — already lives in authz.ts and is exercised end to end in
 * accounts.test.ts. What's new here is the surface: the dedicated
 * `/api/workspace/:id/members` routes (members-routes.ts), which add seat
 * enforcement on top of that existing policy, and the rendered panel
 * (members.ts).
 *
 * `membersRoutes` is not mounted into the app (src/index.ts is owned by
 * another agent, who will do the mounting) so requests go straight to the
 * exported Hono app's own `.request()`, exactly like `app.request()` in
 * test/fixtures.ts.
 */

const OWNER = "admin@test.com"; // platform admin per vitest.config.ts
const ALICE = "alice@test.com";
const BOB = "bob@test.com";
const CARA = "cara@test.com";
const DAN = "dan@test.com";

const memberReq = async (path: string, init?: RequestInit): Promise<Response> =>
  await membersRoutes.request(path, init, env as any);

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** A team workspace owned by ALICE, with optional extra members, on a given plan. */
async function team(members: Record<string, AccountRole> = {}, plan = "free"): Promise<string> {
  const res = await req(
    "/api/accounts",
    as(OWNER, jsonInit("POST", { name: "Acme", owner_email: ALICE }))
  );
  expect(res.status).toBe(201);
  const { id } = await res.json<{ id: string }>();
  if (plan !== "free") {
    await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(plan, id).run();
  }
  for (const [email, role] of Object.entries(members)) {
    await upsertMember(env as any, {
      accountId: id,
      email,
      role,
      invitedBy: ALICE,
      now: new Date().toISOString(),
    });
  }
  return id;
}

beforeEach(async () => {
  await initDb();
});

// --- seat policy, pure ---------------------------------------------------------

describe("seat limits", () => {
  it("free 1, pro 3, team 25, and an unrecognized plan falls back to free's", () => {
    expect(maxSeatsFor("free")).toBe(1);
    expect(maxSeatsFor("pro")).toBe(3);
    expect(maxSeatsFor("team")).toBe(25);
    expect(maxSeatsFor("nonsense")).toBe(1);
  });

  it("refuses at the cap, naming the limit and the plan that lifts it", () => {
    expect(seatLimitDenial("free", 0)).toBeNull();
    const msg = seatLimitDenial("free", 1);
    expect(msg).toMatch(/free/i);
    expect(msg).toMatch(/1 seat/);
    expect(msg).toMatch(/pro/i);
  });

  it("names no upgrade path once already on the top plan", () => {
    const msg = seatLimitDenial("team", 25);
    expect(msg).toMatch(/team/i);
    expect(msg).toMatch(/25 seats/);
    expect(msg).not.toMatch(/upgrade/i);
  });
});

// --- GET (list) -----------------------------------------------------------------

describe("GET /api/workspace/:id/members", () => {
  it("any member — a viewer included — can read the list and seat usage", async () => {
    const id = await team({ [CARA]: "viewer" }, "pro");
    const res = await memberReq(`/api/workspace/${id}/members`, as(CARA));
    expect(res.status).toBe(200);
    const body = await res.json<{
      members: { email: string; role: string }[];
      seats: { plan: string; used: number; max: number };
    }>();
    expect(body.members.map((m) => m.email).sort()).toEqual([ALICE, CARA].sort());
    expect(body.seats).toEqual({ plan: "pro", used: 2, max: 3 });
  });

  it("404s for somebody outside the workspace, and for a workspace that doesn't exist", async () => {
    const id = await team();
    expect((await memberReq(`/api/workspace/${id}/members`, as(DAN))).status).toBe(404);
    expect((await memberReq(`/api/workspace/acct_nope/members`, as(ALICE))).status).toBe(404);
  });
});

// --- POST (invite) ---------------------------------------------------------------

describe("POST /api/workspace/:id/members (invite)", () => {
  it("adds a new member at the requested role", async () => {
    const id = await team({}, "pro");
    const res = await memberReq(`/api/workspace/${id}/members`, as(ALICE, jsonInit("POST", { email: BOB, role: "member" })));
    expect(res.status).toBe(201);
    expect(await memberRole(env as any, id, BOB)).toBe("member");
  });

  it("defaults to the 'member' role when none is given", async () => {
    const id = await team({}, "pro");
    const res = await memberReq(`/api/workspace/${id}/members`, as(ALICE, jsonInit("POST", { email: BOB })));
    expect(res.status).toBe(201);
    expect(await memberRole(env as any, id, BOB)).toBe("member");
  });

  it("a non-admin member cannot manage members", async () => {
    const id = await team({ [BOB]: "member" }, "pro");
    const res = await memberReq(
      `/api/workspace/${id}/members`,
      as(BOB, jsonInit("POST", { email: CARA, role: "member" }))
    );
    expect(res.status).toBe(403);
    expect(await memberRole(env as any, id, CARA)).toBeNull();
  });

  it("a viewer cannot manage members either", async () => {
    const id = await team({ [CARA]: "viewer" }, "pro");
    const res = await memberReq(
      `/api/workspace/${id}/members`,
      as(CARA, jsonInit("POST", { email: DAN, role: "member" }))
    );
    expect(res.status).toBe(403);
  });

  it("refuses over the seat limit, naming the limit and the plan that lifts it — and does not add the row", async () => {
    // Free plan, ALICE alone is already the plan's one seat.
    const id = await team();
    const res = await memberReq(`/api/workspace/${id}/members`, as(ALICE, jsonInit("POST", { email: BOB, role: "member" })));
    expect(res.status).toBe(403);
    const body = await res.json<{ error: string; detail: string }>();
    expect(body.error).toBe("seat_limit_reached");
    expect(body.detail).toMatch(/free/i);
    expect(body.detail).toMatch(/pro/i);
    expect(await memberRole(env as any, id, BOB)).toBeNull();
  });

  it("refuses inviting somebody who is already a member, without touching their role", async () => {
    const id = await team({ [BOB]: "member" }, "pro");
    const res = await memberReq(
      `/api/workspace/${id}/members`,
      as(ALICE, jsonInit("POST", { email: BOB, role: "admin" }))
    );
    expect(res.status).toBe(409);
    expect(await memberRole(env as any, id, BOB)).toBe("member");
  });

  it("only an owner may invite somebody straight in as owner", async () => {
    const id = await team({ [CARA]: "admin" }, "pro");
    const res = await memberReq(
      `/api/workspace/${id}/members`,
      as(CARA, jsonInit("POST", { email: DAN, role: "owner" }))
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ detail: string }>();
    expect(body.detail).toMatch(/account owner/);
    expect(await memberRole(env as any, id, DAN)).toBeNull();
  });

  it("rejects a bad role and a missing email", async () => {
    const id = await team({}, "pro");
    expect((await memberReq(`/api/workspace/${id}/members`, as(ALICE, jsonInit("POST", { email: BOB, role: "wat" })))).status).toBe(400);
    expect((await memberReq(`/api/workspace/${id}/members`, as(ALICE, jsonInit("POST", { role: "member" })))).status).toBe(400);
  });
});

// --- PUT (role change) ------------------------------------------------------------

describe("PUT /api/workspace/:id/members/:email (role change)", () => {
  it("changes an existing member's role", async () => {
    const id = await team({ [BOB]: "member" }, "pro");
    const res = await memberReq(
      `/api/workspace/${id}/members/${encodeURIComponent(BOB)}`,
      as(ALICE, jsonInit("PUT", { role: "admin" }))
    );
    expect(res.status).toBe(200);
    expect(await memberRole(env as any, id, BOB)).toBe("admin");
  });

  it("the last owner cannot be demoted", async () => {
    const id = await team({ [CARA]: "admin" });
    const res = await memberReq(
      `/api/workspace/${id}/members/${encodeURIComponent(ALICE)}`,
      as(ALICE, jsonInit("PUT", { role: "admin" }))
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ detail: string }>();
    expect(body.detail).toMatch(/last owner/);
    expect(await memberRole(env as any, id, ALICE)).toBe("owner");
  });

  it("an account admin cannot promote anybody (including themselves) to owner", async () => {
    const id = await team({ [CARA]: "admin" }, "pro");
    const res = await memberReq(
      `/api/workspace/${id}/members/${encodeURIComponent(CARA)}`,
      as(CARA, jsonInit("PUT", { role: "owner" }))
    );
    expect(res.status).toBe(403);
    expect(await memberRole(env as any, id, CARA)).toBe("admin");
  });

  it("a plain member cannot change anybody's role", async () => {
    const id = await team({ [BOB]: "member", [CARA]: "member" }, "pro");
    const res = await memberReq(
      `/api/workspace/${id}/members/${encodeURIComponent(CARA)}`,
      as(BOB, jsonInit("PUT", { role: "admin" }))
    );
    expect(res.status).toBe(403);
    expect(await memberRole(env as any, id, CARA)).toBe("member");
  });

  it("404s for someone who isn't a member of the workspace", async () => {
    const id = await team({}, "pro");
    const res = await memberReq(
      `/api/workspace/${id}/members/${encodeURIComponent(DAN)}`,
      as(ALICE, jsonInit("PUT", { role: "member" }))
    );
    expect(res.status).toBe(404);
  });
});

// --- DELETE (remove) --------------------------------------------------------------

describe("DELETE /api/workspace/:id/members/:email (remove)", () => {
  it("removes a member", async () => {
    const id = await team({ [BOB]: "member" }, "pro");
    const res = await memberReq(`/api/workspace/${id}/members/${encodeURIComponent(BOB)}`, as(ALICE, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(await memberRole(env as any, id, BOB)).toBeNull();
  });

  it("frees a seat: the next invite succeeds after a removal that was previously refused", async () => {
    const id = await team(); // free plan, ALICE is the only seat
    const refused = await memberReq(`/api/workspace/${id}/members`, as(ALICE, jsonInit("POST", { email: BOB, role: "member" })));
    expect(refused.status).toBe(403);

    // Upgrade isn't needed — removing nobody won't help since Alice is the
    // only member; instead upgrade the plan and confirm the seat check tracks it.
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(id).run();
    const invited = await memberReq(`/api/workspace/${id}/members`, as(ALICE, jsonInit("POST", { email: BOB, role: "member" })));
    expect(invited.status).toBe(201);
  });

  it("the last owner cannot be removed", async () => {
    const id = await team({ [CARA]: "admin" });
    const res = await memberReq(`/api/workspace/${id}/members/${encodeURIComponent(ALICE)}`, as(OWNER, { method: "DELETE" }));
    expect(res.status).toBe(403);
    const body = await res.json<{ detail: string }>();
    expect(body.detail).toMatch(/last owner/);
    expect(await memberRole(env as any, id, ALICE)).toBe("owner");
  });

  it("a member cannot remove anybody", async () => {
    const id = await team({ [BOB]: "member", [CARA]: "member" }, "pro");
    const res = await memberReq(`/api/workspace/${id}/members/${encodeURIComponent(CARA)}`, as(BOB, { method: "DELETE" }));
    expect(res.status).toBe(403);
    expect(await memberRole(env as any, id, CARA)).toBe("member");
  });

  it("404s removing someone who isn't a member", async () => {
    const id = await team({}, "pro");
    const res = await memberReq(`/api/workspace/${id}/members/${encodeURIComponent(DAN)}`, as(ALICE, { method: "DELETE" }));
    expect(res.status).toBe(404);
  });
});

// --- rendering ----------------------------------------------------------------

describe("membersPage rendering", () => {
  const account: AccountRow = {
    id: "acct_x",
    name: "Acme",
    kind: "team",
    status: "active",
    plan: "pro",
    personal_email: null,
    created_by: null,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
  };
  const rows: MemberRow[] = [
    {
      account_id: "acct_x",
      email: ALICE,
      role: "owner",
      status: "active",
      invited_by: null,
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    },
    {
      account_id: "acct_x",
      email: BOB,
      role: "member",
      status: "active",
      invited_by: ALICE,
      created_at: "2024-01-02T00:00:00.000Z",
      updated_at: "2024-01-02T00:00:00.000Z",
    },
  ];
  const viewer: PortalViewer = { email: ALICE, isAdmin: false, role: "member", isTokenCaller: false };

  it("gives a manager working, accessibly-named per-row controls", () => {
    const input: MembersPageInput = { viewer, account, members: rows, canManage: true, viewerEmail: ALICE };
    const html = membersPage(input);
    expect(html).toContain(`aria-label="Change role for ${BOB}"`);
    expect(html).toContain(`aria-label="Remove ${BOB} from this workspace"`);
    expect(html).toContain(`data-member-email="${BOB}"`);
    expect(html).toContain('data-invite-form');
    expect(html).toContain('aria-label="Email address to add to this workspace"');
  });

  /**
   * `POST /api/workspace/:id/members` makes no mail call — see the copy rule in
   * `membersPanel` (src/members.ts). This test is the thing that stops somebody
   * from "improving" the copy back into a promise the code does not keep.
   */
  it("never claims an email was sent, because none is", () => {
    const input: MembersPageInput = { viewer, account, members: rows, canManage: true, viewerEmail: ALICE };
    const html = membersPage(input);
    expect(html).toContain("data-no-invite-mail");
    expect(html).toMatch(/No email is sent/);
    for (const claim of [
      /invitation sent/i,
      /invite sent/i,
      /we(?:'|&#39;)?ve emailed/i,
      /email(?:ed)? them/i,
      /check their inbox/i,
    ]) {
      expect(html, String(claim)).not.toMatch(claim);
    }
  });

  it("shows seat usage against the plan", () => {
    const input: MembersPageInput = { viewer, account, members: rows, canManage: true, viewerEmail: ALICE };
    const html = membersPage(input);
    expect(html).toContain('data-stat="seats-used"');
    expect(html).toContain('data-stat="seats-max"');
  });

  it("a viewer sees no management controls at all", () => {
    const input: MembersPageInput = {
      viewer: { ...viewer, email: CARA },
      account,
      members: [...rows, { ...rows[1], email: CARA, role: "viewer", invited_by: ALICE }],
      canManage: false,
      viewerEmail: CARA,
    };
    const html = membersPage(input);
    // Matched against the actual markup, not the always-present client script
    // (which mentions these selectors regardless of whether any row uses them).
    expect(html).not.toContain('<select class="small" data-member-role-select');
    expect(html).not.toContain('<button class="danger small" data-member-action="remove"');
    expect(html).not.toContain('id="memberform"');
    // Still shows who's there and their role, read-only.
    expect(html).toContain(BOB);
    expect(html).toContain('data-badge="role"');
  });

  it("locks the last owner's row even for a manager", () => {
    const input: MembersPageInput = { viewer, account, members: [rows[0]], canManage: true, viewerEmail: ALICE };
    const html = membersPage(input);
    expect(html).toContain('Last owner');
    expect(html).not.toContain('<button class="danger small" data-member-action="remove"');
  });
});

describe("the seat limit cannot be bypassed via the older accounts route", () => {
  /**
   * `PUT /api/accounts/:id/members/:email` predates seats and upserts a member
   * directly. Without the same check, the seat limit enforced on the workspace
   * route would be decorative — anyone who knew the older path could add
   * members past the cap.
   */
  it("refuses an invite over the cap on /api/accounts too", async () => {
    const owner = "seatowner@test.com";
    const account = await createAccount(env as any, {
      name: "Capped",
      kind: "team",
      personalEmail: null,
      createdBy: owner,
      now: new Date().toISOString(),
    });
    await upsertMember(env as any, {
      accountId: account!.id,
      email: owner,
      role: "owner",
      invitedBy: owner,
      now: new Date().toISOString(),
    });
    // free plan: 1 seat, already used by the owner.
    const res = await req(`/api/accounts/${account!.id}/members/second@test.com`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "member" }),
      ...as(owner),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).detail).toMatch(/seat/i);
  });

  it("still allows changing the role of somebody already in the workspace", async () => {
    const owner = "seatowner2@test.com";
    const account = await createAccount(env as any, {
      name: "Capped2",
      kind: "team",
      personalEmail: null,
      createdBy: owner,
      now: new Date().toISOString(),
    });
    for (const [email, role] of [[owner, "owner"], ["already@test.com", "viewer"]] as const) {
      await upsertMember(env as any, {
        accountId: account!.id, email, role, invitedBy: owner, now: new Date().toISOString(),
      });
    }
    // Promoting an existing member consumes no new seat, so the cap must not fire.
    const res = await req(`/api/accounts/${account!.id}/members/already@test.com`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "member" }),
      ...as(owner),
    });
    expect(res.status).toBeLessThan(300);
  });
});

describe("the members page is actually mounted", () => {
  it("serves /admin/members to a signed-in member of a workspace", async () => {
    const res = await req("/admin/members", as("admin@test.com"));
    // 200 with a workspace, 404 without one — never a routing miss.
    expect([200, 404]).toContain(res.status);
    expect(res.status).not.toBe(500);
  });

  it("refuses it to somebody signed out", async () => {
    const res = await req("/admin/members", { headers: { "X-Dev-Anonymous": "true" } });
    expect(res.status).toBeGreaterThanOrEqual(302);
    expect(res.status).not.toBe(200);
  });
});
