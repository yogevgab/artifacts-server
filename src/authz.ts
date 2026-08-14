import type { Identity } from "./auth";
import type { Visibility } from "./env";
import type { Scope } from "./tokens";
import type { UserRole } from "./users";
import {
  atLeast,
  MANAGE_ARTIFACTS,
  MANAGE_MEMBERS,
  type AccountRole,
  type AccountRoles,
} from "./accounts";

/** Just the ownership-relevant part of an artifact row. */
type Owned = {
  owner_email: string | null;
  /** The owning account (issue #27). Absent/NULL on legacy rows. */
  account_id?: string | null;
};

/**
 * Does this identity own the artifact? Ownership is an exact (case-insensitive)
 * email match. An artifact with no owner_email — legacy rows, or anything
 * published by a service token — is owned by nobody, so only admins manage it.
 */
export function isOwner(identity: Identity | null, artifact: Owned): boolean {
  const owner = artifact.owner_email?.trim().toLowerCase();
  if (!owner || !identity?.email) return false;
  return identity.email.trim().toLowerCase() === owner;
}

// --- platform authority vs account authority (issue #27) ---------------------
//
// Two role systems that must never be confused:
//
//   • **Platform role** — operator authority over the whole instance. Derived
//     from ADMIN_EMAILS / SUPER_ADMIN_EMAILS at request time (`Identity.role`,
//     `Identity.isAdmin`) and never read from D1. No database write and no API
//     payload can produce it.
//   • **Account role** — owner/admin/member/viewer inside one workspace. Stored
//     in `account_members`, i.e. it *is* customer data. It reaches that one
//     workspace's artifacts and members, and nothing else.
//
// The helpers below are named for which system they consult, so a reader of an
// authorization check never has to guess.

/** Platform admin: instance-wide operator rights. Config-derived, never from D1. */
export function isPlatformAdmin(identity: Identity | null): boolean {
  return !!identity?.isAdmin;
}

/**
 * Platform super admin: the operator. Capped at `admin` for every
 * non-interactive caller (API token, Access service token), so a leaked
 * credential can never reach a super-admin-only surface.
 */
export function isPlatformSuperAdmin(identity: Identity | null): boolean {
  return identity?.role === "super_admin";
}

/**
 * The caller's role in one account, or null. Platform admins are deliberately
 * NOT synthesized into an account role here: they reach a workspace's data
 * through platform authority, which every caller checks separately, so an
 * operator never looks like a member of a customer's organization in the UI or
 * in an audit trail.
 */
export function accountRole(accounts: AccountRoles | null | undefined, accountId: string | null | undefined): AccountRole | null {
  if (!accountId || !accounts) return null;
  return accounts.get(accountId) ?? null;
}

/** Does the caller hold at least `min` in the artifact's owning account? */
function hasAccountRights(
  artifact: Owned,
  accounts: AccountRoles | null | undefined,
  min: AccountRole
): boolean {
  return atLeast(accountRole(accounts, artifact.account_id), min);
}

/**
 * Can this identity *manage* an artifact — list it in the dashboard, publish a
 * new version, roll back, change access, read analytics, delete it?
 *
 * Three independent paths, checked in order of authority:
 *
 * 1. **Platform admin** — manages every artifact on the instance.
 * 2. **Legacy owner** — `owner_email` matches. Unchanged from before #27, and
 *    checked before any account lookup, which is what guarantees an artifact
 *    whose `account_id` was never backfilled keeps working exactly as it did.
 * 3. **Account member** — the artifact belongs to an account where the caller
 *    holds `member` or better. A `viewer` falls below this line: they see the
 *    workspace's artifacts but cannot change them.
 *
 * `accounts` is optional throughout. Omitting it (or passing an empty map)
 * yields precisely the pre-#27 behavior, so every call site that has not been
 * given account context is safe by default rather than broken.
 *
 * Being granted *view* access to someone else's artifact still never confers
 * management rights.
 */
export function canManage(
  identity: Identity | null,
  artifact: Owned,
  accounts?: AccountRoles | null
): boolean {
  if (!identity) return false;
  if (isPlatformAdmin(identity)) return true;
  if (isOwner(identity, artifact)) return true;
  return hasAccountRights(artifact, accounts, MANAGE_ARTIFACTS);
}

/**
 * May this identity see the artifact at all by virtue of *belonging to it* —
 * as its owner, or as any member (including a `viewer`) of its account?
 *
 * This is the `owned` argument `canView` takes: the read side is one rung wider
 * than the write side, which is the whole point of the `viewer` role.
 */
export function belongsToCaller(
  identity: Identity | null,
  artifact: Owned,
  accounts?: AccountRoles | null
): boolean {
  if (!identity) return false;
  if (isOwner(identity, artifact)) return true;
  return hasAccountRights(artifact, accounts, "viewer");
}

/**
 * May this identity change an account's membership list — add somebody, remove
 * somebody, or change a role?
 *
 * Platform admins may (they administer the instance). Otherwise it takes
 * `admin` or `owner` *in that account*: a plain member of a workspace cannot
 * invite people into it, and a viewer certainly cannot.
 */
export function canManageMembers(
  identity: Identity | null,
  accounts: AccountRoles | null | undefined,
  accountId: string
): boolean {
  if (!identity) return false;
  if (isPlatformAdmin(identity)) return true;
  return atLeast(accountRole(accounts, accountId), MANAGE_MEMBERS);
}

/** May this identity read an account's settings and member list? Any member may. */
export function canReadAccount(
  identity: Identity | null,
  accounts: AccountRoles | null | undefined,
  accountId: string
): boolean {
  if (!identity) return false;
  if (isPlatformAdmin(identity)) return true;
  return atLeast(accountRole(accounts, accountId), "viewer");
}

/**
 * Why `actor` may NOT set `target`'s role in an account, or null when allowed.
 *
 * Two rules, both about not stranding a workspace:
 *
 * 1. Only an account `owner` may create or demote another `owner` — an `admin`
 *    can manage members but cannot promote themselves past their own ceiling.
 * 2. The last `owner` cannot be removed or demoted, or the account would have
 *    nobody who can administer it.
 *
 * A platform admin bypasses rule 1 (they administer the instance) but NOT rule
 * 2 — orphaning an account is a mistake regardless of who makes it.
 */
export function memberChangeDenial(
  identity: Identity | null,
  actorRole: AccountRole | null,
  change: { targetCurrentRole: AccountRole | null; nextRole: AccountRole | null; ownerCount: number }
): string | null {
  const platform = isPlatformAdmin(identity);
  const touchesOwner = change.targetCurrentRole === "owner" || change.nextRole === "owner";
  if (touchesOwner && !platform && actorRole !== "owner") {
    return "only an account owner can add or change another owner";
  }
  if (change.targetCurrentRole === "owner" && change.nextRole !== "owner" && change.ownerCount <= 1) {
    return "this is the account's last owner — promote somebody else first";
  }
  return null;
}

/**
 * May this identity use the management surface (/admin, /api) at all?
 * Admins always may. A member may, but only reaches their own artifacts.
 * A non-admin service token may NOT: ownership is keyed on an email, so a token
 * has nothing it could own and would otherwise be able to publish unowned
 * (admin-only) artifacts merely by satisfying the viewer Access policy.
 */
export function canUseDashboard(identity: Identity | null): identity is Identity {
  if (!identity) return false;
  // Checked before anything else, including isAdmin. A guest session cannot set
  // isAdmin — that is config-derived — but the ordering must not depend on that
  // staying true forever. A guest reaches granted artifact content and nothing
  // else, ever.
  if (identity.kind === "guest") return false;
  return identity.isAdmin || !!identity.email;
}

/**
 * Does this identity hold a given API scope?
 * A caller authenticated through Cloudflare Access (a human, or an admin
 * service token) holds every scope — scopes exist to *narrow* an API token
 * below its owner's rights, never to widen anyone's. Scope is checked in
 * addition to ownership: a `manage`-scoped token still only reaches artifacts
 * its owner owns.
 */
export function hasScope(identity: Identity | null, scope: Scope): boolean {
  if (!identity) return false;
  if (!identity.token) return true;
  return identity.token.scopes.includes(scope);
}

// --- user directory policy --------------------------------------------------

/** What an admin is trying to do to somebody's directory entry. */
export type UserAction = "invite" | "edit" | "disable" | "enable" | "remove";

/** The part of a directory entry the policy cares about. */
export interface UserTarget {
  email: string;
  role: UserRole;
}

function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Why `actor` may NOT perform `action` on `target`, or null when it is allowed.
 * Pure policy, so every rule below is directly testable.
 *
 * The rules, in order, exist to make three kinds of accident impossible:
 *
 * 1. **The operator can't be removed.** A super admin can never be disabled or
 *    removed — by anyone, including themselves. Combined with `effectiveStatus`
 *    (which refuses to read a super admin as disabled) and `privilegedEmails`
 *    (which keeps them in the Access allow-list), there is no path that ends
 *    with nobody able to administer the instance.
 * 2. **Admins don't fight.** Only a super admin may act on another admin, so one
 *    admin cannot lock out a peer. Because `Identity.role` is capped at `admin`
 *    for API tokens and Access service tokens, this also means a leaked
 *    non-interactive credential can never touch an admin account.
 * 3. **No self-lockout.** Nobody may disable or remove their own account, so the
 *    common slip of disabling the row you're signed in as just fails.
 */
export function userActionDenial(
  actor: Identity | null,
  target: UserTarget,
  action: UserAction
): string | null {
  if (!actor?.isAdmin) return "admin access required";

  if (target.role === "super_admin" && action !== "edit") {
    return "the super admin is protected — it cannot be invited, disabled, or removed from here";
  }
  if (target.role !== "member" && actor.role !== "super_admin") {
    return "only a super admin can manage another admin";
  }
  if ((action === "disable" || action === "remove") && sameEmail(actor.email, target.email)) {
    return "you cannot disable or remove your own account";
  }
  return null;
}

/**
 * Can this identity view an artifact?
 * - Unauthenticated → no.
 * - Admin (or service token) → yes.
 * - The owner, or a member of the owning workspace (`owned`) → yes, regardless
 *   of visibility and grants.
 * - visibility 'everyone' → anybody in the artifact's workspace (`inWorkspace`).
 * - visibility 'restricted' → only if their email is granted (`granted`).
 *
 * ## What 'everyone' means, and what it used to mean
 *
 * It used to mean *every authenticated identity on the instance*: this function
 * returned true for `visibility === "everyone"` before it looked at anything
 * else. On a single-tenant deployment, where everybody who can sign in is a
 * colleague, that was defensible. On rtfx.pro — where signup is self-serve and
 * anybody in the world can hold an identity in thirty seconds — it meant a
 * setting labelled "Everyone" in the dashboard silently published the artifact
 * to every stranger who had ever created an account. Not to the open web (the
 * URL still 404s without a session) but to an unbounded, self-service audience,
 * which is not a distinction anybody picking that option was making.
 *
 * It now means "everyone in this artifact's workspace" — which is what the
 * word means to the person choosing it, and what the copy on every surface now
 * says. Sharing *outside* the workspace is what grants and share links are for,
 * and both still work on an 'everyone' artifact: `granted` is checked here for
 * both visibilities, so a named guest is unaffected by the narrowing.
 *
 * `inWorkspace` defaults to `false`, which is the fail-closed default this
 * needs: a caller that has not looked up membership must not accidentally get
 * the old, wider behaviour. The two call sites that matter (src/index.ts) do
 * look it up.
 *
 * **Known consequence:** an artifact whose `account_id` is NULL has no
 * workspace to be "everyone" within, so nobody reaches it through this branch —
 * only its owner, its grantees and platform admins. Migration 0010 backfills
 * `account_id` for every artifact that has an `owner_email`, so the rows this
 * can affect are the ones that were already owner-less and therefore already
 * admin-only by the `isOwner` path. See docs/ARCHITECTURE.md § Data model.
 */
export function canView(
  identity: Identity | null,
  visibility: Visibility,
  granted: boolean,
  owned = false,
  inWorkspace = false
): boolean {
  if (!identity) return false;
  if (identity.isAdmin) return true;
  if (owned) return true;
  if (visibility === "everyone" && inWorkspace) return true;
  return granted;
}
