/**
 * Workspace member management: `/api/workspace/:id/members`.
 *
 * Kept out of `src/api.ts` (owned by another agent, mid-edit) and mounted
 * separately, the same way share-routes.ts and billing-routes.ts are — a
 * self-contained surface with its own routes, exported for the caller to
 * `app.route("/", membersRoutes)`.
 *
 * Deliberately a different base path than the existing (also real)
 * `/api/accounts/:id/members` in api.ts: that generic upsert-or-create PUT
 * predates seat limits and this module must not fight it for the same route.
 * `canManageMembers` and `memberChangeDenial` (src/authz.ts) are the same
 * policy both surfaces share — the last-owner and owner-promotion rules live
 * in exactly one place, and this file only ever calls them, never
 * reimplements them.
 */

import { Hono, type Context } from "hono";
import type { Env } from "./env";
import { requireUser, accountsFor, type AuthVars } from "./auth";
import { canManageMembers, canReadAccount, memberChangeDenial } from "./authz";
import {
  effectivePlan,
  getAccount,
  isAccountRole,
  listMembers,
  memberRole,
  ownerCount,
  removeMember,
  toPublicAccount,
  toPublicMember,
  upsertMember,
  type AccountRole,
  type AccountRow,
} from "./accounts";
import { normalizeEmail } from "./waitlist";
import { maxSeatsFor, seatLimitDenial } from "./members";
import { accountRoleLabel } from "./accounts";
import { sendMail } from "./mail";
import { memberInviteMail } from "./mail-templates";
import { incrementRateLimitBucket } from "./rate-limit";
import { siteOrigin } from "./seo";
import type { AppBindings } from "./env";

type MembersApp = { Bindings: Env; Variables: AuthVars };
type MembersContext = Context<MembersApp>;

export const membersRoutes = new Hono<MembersApp>();

const LIST_PATH = "/api/workspace/:id/members";
const MEMBER_PATH = "/api/workspace/:id/members/:email";

membersRoutes.use(LIST_PATH, requireUser);
membersRoutes.use(MEMBER_PATH, requireUser);

/**
 * The workspace, if the caller may at least read it (any member, viewer
 * included, or a platform admin). 404 for both a missing id and one the
 * caller doesn't belong to — never 403 — so an account id can't be probed by
 * watching the status code change.
 */
async function readableAccount(
  c: MembersContext,
  id: string
): Promise<{ account: AccountRow; roles: Awaited<ReturnType<typeof accountsFor>>["roles"] } | null> {
  const account = await getAccount(c.env, id);
  if (!account) return null;
  const ctx = await accountsFor(c);
  return canReadAccount(c.get("identity"), ctx.roles, id) ? { account, roles: ctx.roles } : null;
}

/**
 * Seats are counted against the EFFECTIVE plan (src/accounts.ts), so a
 * workspace an operator comped onto Team gets Team's seats immediately —
 * without which the comp would be visible in the platform UI and inert
 * everywhere it mattered.
 */
function seatSummary(account: AccountRow, memberCount: number) {
  const plan = effectivePlan(account);
  return { plan, used: memberCount, max: maxSeatsFor(plan) };
}

membersRoutes.get(LIST_PATH, async (c) => {
  const id = c.req.param("id");
  const found = await readableAccount(c, id);
  if (!found) return c.json({ error: "not_found" }, 404);
  const members = await listMembers(c.env, id);
  return c.json({
    account: toPublicAccount(found.account, found.roles.get(id) ?? null),
    members: members.map(toPublicMember),
    seats: seatSummary(found.account, members.length),
  });
});

/**
 * Add somebody new to the workspace. Distinct from the role-change route below:
 * an email that is already a member costs no seat and is refused here with a
 * pointer at the route that actually changes a role, rather than silently
 * upserting.
 *
 * Writes the membership row and then emails the person a link to the
 * workspace (`memberInviteMail`, linking to `/admin/join/<id>`). The mail is
 * best-effort: the membership stands either way, and the response says whether
 * the email went out (`invite.sent`) so the panel can tell the adder to pass it
 * on themselves. Sends are rate-limited per workspace and per recipient so the
 * add/remove buttons cannot be turned into a mail cannon.
 */
membersRoutes.post(LIST_PATH, async (c) => {
  const id = c.req.param("id");
  const found = await readableAccount(c, id);
  if (!found) return c.json({ error: "not_found" }, 404);
  if (!canManageMembers(c.get("identity"), found.roles, id)) {
    return c.json({ error: "forbidden", detail: "you cannot manage members of this workspace" }, 403);
  }

  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail((body as { email?: unknown } | null)?.email);
  if (!email) return c.json({ error: "bad_request", detail: "valid email required" }, 400);
  const role: unknown = (body as { role?: unknown } | null)?.role ?? "member";
  if (!isAccountRole(role)) {
    return c.json(
      { error: "bad_request", detail: "role must be 'owner' | 'admin' | 'member' | 'viewer'" },
      400
    );
  }

  if (await memberRole(c.env, id, email)) {
    return c.json(
      {
        error: "already_member",
        detail: `${email} is already a member of this workspace — change their role instead of adding them again`,
      },
      409
    );
  }

  const denial = memberChangeDenial(c.get("identity"), found.roles.get(id) ?? null, {
    targetCurrentRole: null,
    nextRole: role,
    ownerCount: await ownerCount(c.env, id),
  });
  if (denial) return c.json({ error: "forbidden", detail: denial }, 403);

  const before = await listMembers(c.env, id);
  const seatDenial = seatLimitDenial(effectivePlan(found.account), before.length);
  if (seatDenial) return c.json({ error: "seat_limit_reached", detail: seatDenial }, 403);

  const now = new Date().toISOString();
  await upsertMember(c.env, {
    accountId: id,
    email,
    role,
    invitedBy: c.get("email"),
    now,
  });
  const invite = await sendInvite(c, found.account, email, role, now);
  const members = await listMembers(c.env, id);
  return c.json(
    {
      account: toPublicAccount(found.account, found.roles.get(id) ?? null),
      members: members.map(toPublicMember),
      seats: seatSummary(found.account, members.length),
      invite,
    },
    201
  );
});

/** Change the role somebody already holds. Never touches seat count. */
membersRoutes.put(MEMBER_PATH, async (c) => {
  const id = c.req.param("id");
  const found = await readableAccount(c, id);
  if (!found) return c.json({ error: "not_found" }, 404);
  if (!canManageMembers(c.get("identity"), found.roles, id)) {
    return c.json({ error: "forbidden", detail: "you cannot manage members of this workspace" }, 403);
  }

  const email = normalizeEmail(c.req.param("email"));
  if (!email) return c.json({ error: "bad_request", detail: "valid email required" }, 400);
  const body = await c.req.json().catch(() => null);
  const nextRole: unknown = (body as { role?: unknown } | null)?.role;
  if (!isAccountRole(nextRole)) {
    return c.json(
      { error: "bad_request", detail: "role must be 'owner' | 'admin' | 'member' | 'viewer'" },
      400
    );
  }

  const current = await memberRole(c.env, id, email);
  if (!current) return c.json({ error: "not_found" }, 404);

  const denial = memberChangeDenial(c.get("identity"), found.roles.get(id) ?? null, {
    targetCurrentRole: current,
    nextRole,
    ownerCount: await ownerCount(c.env, id),
  });
  if (denial) return c.json({ error: "forbidden", detail: denial }, 403);

  await upsertMember(c.env, {
    accountId: id,
    email,
    role: nextRole,
    invitedBy: c.get("email"),
    now: new Date().toISOString(),
  });
  const members = await listMembers(c.env, id);
  return c.json({
    account: toPublicAccount(found.account, found.roles.get(id) ?? null),
    members: members.map(toPublicMember),
    seats: seatSummary(found.account, members.length),
  });
});

/** Remove somebody from the workspace. The last owner cannot be removed — memberChangeDenial refuses it. */
membersRoutes.delete(MEMBER_PATH, async (c) => {
  const id = c.req.param("id");
  const found = await readableAccount(c, id);
  if (!found) return c.json({ error: "not_found" }, 404);
  if (!canManageMembers(c.get("identity"), found.roles, id)) {
    return c.json({ error: "forbidden", detail: "you cannot manage members of this workspace" }, 403);
  }

  const email = normalizeEmail(c.req.param("email"));
  if (!email) return c.json({ error: "bad_request", detail: "valid email required" }, 400);
  const current = await memberRole(c.env, id, email);
  if (!current) return c.json({ error: "not_found" }, 404);

  const denial = memberChangeDenial(c.get("identity"), found.roles.get(id) ?? null, {
    targetCurrentRole: current,
    nextRole: null,
    ownerCount: await ownerCount(c.env, id),
  });
  if (denial) return c.json({ error: "forbidden", detail: denial }, 403);

  await removeMember(c.env, id, email);
  const members = await listMembers(c.env, id);
  return c.json({
    account: toPublicAccount(found.account, found.roles.get(id) ?? null),
    members: members.map(toPublicMember),
    seats: seatSummary(found.account, members.length),
  });
});

/** Invite emails a workspace may send per hour, and how many one address may receive. */
const INVITES_PER_WORKSPACE = 50;
const INVITES_PER_RECIPIENT = 5;

/**
 * Email the person just added. Never throws and never undoes the membership:
 * the row is the access, the email is only the news of it.
 */
async function sendInvite(
  c: MembersContext,
  account: AccountRow,
  email: string,
  role: AccountRole,
  now: string
): Promise<{ sent: boolean; reason?: "rate_limited" | "mail_failed" }> {
  const rc = c as unknown as Context<AppBindings>;
  const [perWorkspace, perRecipient] = await Promise.all([
    incrementRateLimitBucket(rc, `member-invite:account:${account.id}`, INVITES_PER_WORKSPACE),
    incrementRateLimitBucket(rc, `member-invite:to:${email}`, INVITES_PER_RECIPIENT),
  ]);
  if (!perWorkspace || !perRecipient) return { sent: false, reason: "rate_limited" };

  const origin = (c.env.PUBLIC_BASE_URL || siteOrigin(c.env)).replace(/\/+$/, "");
  const message = memberInviteMail({
    inviterEmail: c.get("email"),
    workspaceName: account.name,
    roleLabel: accountRoleLabel(role),
    inviteeEmail: email,
    joinUrl: `${origin}/admin/join/${encodeURIComponent(account.id)}`,
  });
  try {
    const result = await sendMail(c.env, { to: email, kind: "member_invite", message, now });
    return result.ok ? { sent: true } : { sent: false, reason: "mail_failed" };
  } catch {
    return { sent: false, reason: "mail_failed" };
  }
}
