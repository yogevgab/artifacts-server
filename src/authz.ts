import type { Identity } from "./auth";
import type { Visibility } from "./env";

/**
 * Can this identity view an artifact?
 * - Unauthenticated → no.
 * - Admin (or service token) → yes.
 * - visibility 'everyone' → any authenticated identity.
 * - visibility 'restricted' → only if their email is granted (`granted`).
 */
export function canView(
  identity: Identity | null,
  visibility: Visibility,
  granted: boolean
): boolean {
  if (!identity) return false;
  if (identity.isAdmin) return true;
  if (visibility === "everyone") return true;
  return granted;
}
