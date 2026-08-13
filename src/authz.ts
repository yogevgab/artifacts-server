import type { Identity } from "./auth";
import type { Visibility } from "./env";
import type { Scope } from "./tokens";
import type { UserRole } from "./users";

/** Just the ownership-relevant part of an artifact row. */
type Owned = { owner_email: string | null };

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

/**
 * Can this identity *manage* an artifact — list it in the dashboard, publish a
 * new version, roll back, change access, read analytics, delete it?
 * Admins can manage every artifact; a beta user only their own. Being granted
 * view access to someone else's artifact never confers management rights.
 */
export function canManage(identity: Identity | null, artifact: Owned): boolean {
  if (!identity) return false;
  return identity.isAdmin || isOwner(identity, artifact);
}

/**
 * May this identity use the management surface (/admin, /api) at all?
 * Admins always may. A beta user may, but only reaches their own artifacts.
 * A non-admin service token may NOT: ownership is keyed on an email, so a token
 * has nothing it could own and would otherwise be able to publish unowned
 * (admin-only) artifacts merely by satisfying the viewer Access policy.
 */
export function canUseDashboard(identity: Identity | null): identity is Identity {
  if (!identity) return false;
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
 * - The owner → yes, regardless of visibility/grants.
 * - visibility 'everyone' → any authenticated identity.
 * - visibility 'restricted' → only if their email is granted (`granted`).
 */
export function canView(
  identity: Identity | null,
  visibility: Visibility,
  granted: boolean,
  owned = false
): boolean {
  if (!identity) return false;
  if (identity.isAdmin) return true;
  if (owned) return true;
  if (visibility === "everyone") return true;
  return granted;
}
