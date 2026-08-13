import type { Env } from "./env";

/**
 * The local user directory — product state layered *above* the Cloudflare Access
 * allow-list (issue #24).
 *
 * Two sources of truth, deliberately split:
 *
 * - **Cloudflare Access** decides who can authenticate at all. `src/access-api.ts`
 *   reads and writes that allow-list. Nothing here can grant a login.
 * - **This table** holds what the product needs to know about each person:
 *   lifecycle `status`, display name, operator notes, and timestamps. `status`
 *   IS authoritative — a `disabled` row is refused by the Worker on every
 *   request, so disabling somebody takes effect immediately even if the Access
 *   write fails or Access isn't configured at all.
 *
 * Privilege is a third thing again, and comes from configuration only:
 * `SUPER_ADMIN_EMAILS` and `ADMIN_EMAILS`. The `role` column merely *records*
 * that configuration so the panel can show it — a write to this table can never
 * escalate anyone, and `effectiveRole()` always re-derives from config so a
 * stale row can never be believed.
 */

/** Recorded/derived role. Privilege comes from env config, never from the row. */
export const USER_ROLES = ["member", "admin", "super_admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Lifecycle status.
 * - `invited` — on the allow-list, has never signed in.
 * - `active`  — has signed in at least once.
 * - `disabled` — access paused. Refused by the Worker; artifacts are untouched.
 */
export const USER_STATUSES = ["invited", "active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface UserRow {
  email: string;
  role: UserRole;
  status: UserStatus;
  display_name: string | null;
  notes: string | null;
  invited_by: string | null;
  invited_at: string | null;
  created_at: string;
  last_seen_at: string | null;
  disabled_at: string | null;
}

export const MAX_DISPLAY_NAME_LENGTH = 80;
export const MAX_NOTES_LENGTH = 500;

/** Only refresh `last_seen_at` this often, so a busy session isn't one write per request. */
export const SEEN_INTERVAL_MS = 5 * 60 * 1000;

const COLUMNS =
  "email, role, status, display_name, notes, invited_by, invited_at, created_at, last_seen_at, disabled_at";

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function normalize(email: string): string {
  return email.trim().toLowerCase();
}

export function adminEmails(env: Env): string[] {
  return list(env.ADMIN_EMAILS);
}

/**
 * The operator(s): the owner role, configured out-of-band and never editable
 * from the product. Falls back to the first `ADMIN_EMAILS` entry when
 * `SUPER_ADMIN_EMAILS` is unset, so an existing deployment always has exactly
 * one protected operator without needing a config change — the invariant that
 * makes lockout impossible.
 */
export function superAdminEmails(env: Env): string[] {
  const configured = list(env.SUPER_ADMIN_EMAILS);
  if (configured.length) return configured;
  const admins = adminEmails(env);
  return admins.length ? [admins[0]] : [];
}

export function isSuperAdminEmail(env: Env, email: string | null | undefined): boolean {
  return !!email && superAdminEmails(env).includes(normalize(email));
}

/**
 * Every email that must always be able to sign in: admins plus super admins.
 * The Access allow-list is always merged with this set, so no edit — from the
 * panel, the CLI, or a bug — can lock the operator out of their own instance.
 */
export function privilegedEmails(env: Env): string[] {
  return [...new Set([...superAdminEmails(env), ...adminEmails(env)])].sort();
}

/**
 * The role configuration assigns this email, or null for an ordinary member.
 * A super admin is always also an admin, even if they were left out of
 * `ADMIN_EMAILS`.
 */
export function configuredRole(env: Env, email: string | null | undefined): UserRole | null {
  if (!email) return null;
  const clean = normalize(email);
  if (superAdminEmails(env).includes(clean)) return "super_admin";
  if (adminEmails(env).includes(clean)) return "admin";
  return null;
}

/**
 * The role that actually applies. Derived from configuration *only* — the stored
 * `role` column is never read back as a grant, so a stale row (or one edited
 * straight in D1) can never make somebody an admin.
 */
export function effectiveRole(env: Env, email: string | null | undefined): UserRole {
  return configuredRole(env, email) ?? "member";
}

/**
 * The status that actually applies.
 *
 * A super admin can never read as disabled — not even if their row says so —
 * which is what guarantees the operator cannot be locked out of their own
 * instance by a bad edit or a hand-written row.
 *
 * With no row at all the answer is `invited`: this is somebody Cloudflare Access
 * allows but who has never used the product, which is exactly what `invited`
 * means. The distinction is presentational — what matters for enforcement is
 * that it isn't `disabled`, so a missing row still lets them in (see the
 * fail-open note on `getUser`).
 */
export function effectiveStatus(
  env: Env,
  email: string | null | undefined,
  row: Pick<UserRow, "status"> | null | undefined
): UserStatus {
  if (isSuperAdminEmail(env, email)) return "active";
  if (!row) return "invited";
  return row.status;
}

/** Is this person's access paused right now? Never true for a super admin. */
export function isDisabled(
  env: Env,
  email: string | null | undefined,
  row: Pick<UserRow, "status"> | null | undefined
): boolean {
  return effectiveStatus(env, email, row) === "disabled";
}

// --- queries ----------------------------------------------------------------

/**
 * One user's row, or null. Never throws: the directory is an *additive* layer,
 * so a missing table (code deployed ahead of the migration) or a transient D1
 * error must not break authentication. Failing open here is safe by
 * construction — with no row nobody is disabled, and Cloudflare Access is still
 * the gate that decides who reaches the Worker at all.
 */
export async function getUser(env: Env, email: string): Promise<UserRow | null> {
  try {
    return await env.DB.prepare(`SELECT ${COLUMNS} FROM users WHERE email = ?`)
      .bind(normalize(email))
      .first<UserRow>();
  } catch {
    return null;
  }
}

export async function listUsers(env: Env): Promise<UserRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM users ORDER BY email`
  ).all<UserRow>();
  return results ?? [];
}

export interface InviteInput {
  email: string;
  displayName?: string | null;
  notes?: string | null;
  invitedBy: string;
  role: UserRole;
  now: string;
}

/**
 * Invite somebody, or re-invite an existing person. Re-inviting a disabled user
 * lifts the pause (an explicit admin action), which is why `disabled_at` is
 * cleared here. `created_at` and `invited_at` are preserved so the history of a
 * long-standing member survives a re-invite.
 */
export async function upsertInvite(env: Env, input: InviteInput): Promise<UserRow> {
  const email = normalize(input.email);
  const existing = await getUser(env, email);
  const displayName = input.displayName ?? existing?.display_name ?? null;
  const notes = input.notes ?? existing?.notes ?? null;

  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO users (email, role, status, display_name, notes, invited_by, invited_at, created_at)
       VALUES (?, ?, 'invited', ?, ?, ?, ?, ?)`
    )
      .bind(email, input.role, displayName, notes, input.invitedBy, input.now, input.now)
      .run();
  } else {
    // Somebody who already signed in stays 'active'; anyone else reads as invited.
    const status: UserStatus = existing.last_seen_at ? "active" : "invited";
    await env.DB.prepare(
      `UPDATE users SET role = ?, status = ?, display_name = ?, notes = ?,
         invited_at = COALESCE(invited_at, ?), disabled_at = NULL
       WHERE email = ?`
    )
      .bind(input.role, status, displayName, notes, input.now, email)
      .run();
  }
  return (await getUser(env, email))!;
}

/** Edit the human-facing metadata only — never role or status. */
export async function updateProfile(
  env: Env,
  email: string,
  patch: { displayName?: string | null; notes?: string | null }
): Promise<UserRow | null> {
  const clean = normalize(email);
  const existing = await getUser(env, clean);
  if (!existing) return null;
  await env.DB.prepare("UPDATE users SET display_name = ?, notes = ? WHERE email = ?")
    .bind(
      patch.displayName === undefined ? existing.display_name : patch.displayName,
      patch.notes === undefined ? existing.notes : patch.notes,
      clean
    )
    .run();
  return getUser(env, clean);
}

/**
 * Pause access. Creates the row if the person only existed in the Access
 * allow-list, so an admin can disable somebody the directory hasn't met yet.
 */
export async function disableUser(
  env: Env,
  email: string,
  role: UserRole,
  now: string
): Promise<UserRow> {
  const clean = normalize(email);
  const existing = await getUser(env, clean);
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO users (email, role, status, created_at, disabled_at) VALUES (?, ?, 'disabled', ?, ?)`
    )
      .bind(clean, role, now, now)
      .run();
  } else {
    await env.DB.prepare(
      "UPDATE users SET status = 'disabled', disabled_at = ?, role = ? WHERE email = ?"
    )
      .bind(now, role, clean)
      .run();
  }
  return (await getUser(env, clean))!;
}

/** Lift a pause. Somebody who has signed in before goes straight back to active. */
export async function enableUser(
  env: Env,
  email: string,
  role: UserRole,
  now: string
): Promise<UserRow> {
  const clean = normalize(email);
  const existing = await getUser(env, clean);
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO users (email, role, status, invited_at, created_at) VALUES (?, ?, 'invited', ?, ?)`
    )
      .bind(clean, role, now, now)
      .run();
  } else {
    await env.DB.prepare(
      "UPDATE users SET status = ?, disabled_at = NULL, role = ? WHERE email = ?"
    )
      .bind(existing.last_seen_at ? "active" : "invited", role, clean)
      .run();
  }
  return (await getUser(env, clean))!;
}

/**
 * Delete the directory entry. Artifacts, versions, files and the views log are
 * deliberately untouched — removing a person must never destroy published work.
 */
export async function deleteUser(env: Env, email: string): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM users WHERE email = ?").bind(normalize(email)).run();
  return (res.meta?.changes ?? 0) > 0;
}

export function needsSeenTouch(row: UserRow | null, now: Date): boolean {
  if (!row) return true;
  if (!row.last_seen_at) return true;
  const last = Date.parse(row.last_seen_at);
  return !Number.isFinite(last) || now.getTime() - last >= SEEN_INTERVAL_MS;
}

/**
 * Record that somebody used the product, promoting `invited` → `active`, and
 * self-provisioning a row for an Access-allowed person the directory hasn't met
 * yet (which is how existing deployments populate without an import step).
 *
 * A `disabled` row is never revived: callers only reach this after the disabled
 * check, and the CASE below is a second guard in case that ever changes.
 * Never throws — presence tracking must not be able to fail a request.
 */
export async function touchLastSeen(
  env: Env,
  email: string,
  role: UserRole,
  now: string
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO users (email, role, status, created_at, last_seen_at)
       VALUES (?, ?, 'active', ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         role = excluded.role,
         status = CASE WHEN users.status = 'invited' THEN 'active' ELSE users.status END`
    )
      .bind(normalize(email), role, now, now)
      .run();
  } catch {
    // Best-effort, exactly like API-token `last_used_at`.
  }
}

// --- presentation -----------------------------------------------------------

/** A directory entry as the API and dashboard see it. */
export interface PublicUser {
  email: string;
  role: UserRole;
  status: UserStatus;
  display_name: string | null;
  notes: string | null;
  invited_by: string | null;
  invited_at: string | null;
  created_at: string | null;
  last_seen_at: string | null;
  disabled_at: string | null;
  /**
   * Whether Cloudflare Access currently lets this email log in: true/false when
   * the allow-list could be read, null when Access isn't configured or errored.
   * A `false` here is the drift an operator needs to see — the directory says
   * they're a member but they can't actually get in.
   */
  allowlisted: boolean | null;
  /** False for an email that exists only in the Access allow-list, with no row here. */
  in_directory: boolean;
  /** True when this entry cannot be disabled or removed (the super admin). */
  is_protected: boolean;
}

export function toPublicUser(
  env: Env,
  row: UserRow | null,
  email: string,
  allowlist: Set<string> | null
): PublicUser {
  const clean = normalize(email);
  const role = effectiveRole(env, clean);
  return {
    email: clean,
    role,
    status: effectiveStatus(env, clean, row),
    display_name: row?.display_name ?? null,
    notes: row?.notes ?? null,
    invited_by: row?.invited_by ?? null,
    invited_at: row?.invited_at ?? null,
    created_at: row?.created_at ?? null,
    last_seen_at: row?.last_seen_at ?? null,
    disabled_at: row?.disabled_at ?? null,
    allowlisted: allowlist ? allowlist.has(clean) : null,
    in_directory: row !== null,
    is_protected: role === "super_admin",
  };
}

/**
 * The directory as one list: every row, plus any email that Cloudflare Access
 * allows but this table has never seen (so an operator can adopt or disable it),
 * plus every configured admin — an admin always belongs in the panel even
 * before their first sign-in. Sorted operators first, then admins, then by email,
 * so the people who can change things are never buried in a long list.
 */
export function describeUsers(
  env: Env,
  rows: UserRow[],
  allowlist: string[] | null
): PublicUser[] {
  const set = allowlist ? new Set(allowlist.map(normalize)) : null;
  const byEmail = new Map<string, UserRow | null>();
  for (const row of rows) byEmail.set(normalize(row.email), row);
  for (const email of [...(allowlist ?? []), ...privilegedEmails(env)]) {
    const clean = normalize(email);
    if (!byEmail.has(clean)) byEmail.set(clean, null);
  }
  const rank: Record<UserRole, number> = { super_admin: 0, admin: 1, member: 2 };
  return [...byEmail.entries()]
    .map(([email, row]) => toPublicUser(env, row, email, set))
    .sort((a, b) => rank[a.role] - rank[b.role] || a.email.localeCompare(b.email));
}

/** Validate an optional free-text field, returning the cleaned value or `undefined` if invalid. */
export function cleanText(raw: unknown, max: number): string | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length > max) return undefined;
  return trimmed || null;
}
