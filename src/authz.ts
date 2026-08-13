import type { Identity } from "./auth";
import type { Visibility } from "./env";

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
