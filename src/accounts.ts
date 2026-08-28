import type { Env } from "./env";
import { normalize, type UserRole } from "./users";

/**
 * Accounts, workspaces, organizations — the product container that OWNS things
 * (issue #27).
 *
 * The product model has four distinct concepts, and conflating any two of them is
 * the bug this module exists to prevent:
 *
 * | Concept | Where it lives | What it answers |
 * |---|---|---|
 * | **Identity / user** | `users` + `rtfx_session` | who you are |
 * | **Account** | `accounts` (this file) | whose stuff it is |
 * | **Membership** | `account_members` (this file) | what you may do *inside* one account |
 * | **Platform role** | `ADMIN_EMAILS` / `SUPER_ADMIN_EMAILS` **only** | operator authority over the *instance* |
 *
 * The load-bearing rule: **an account role is not platform authority.** Account
 * roles are customer data, stored in and read from D1, and anybody who can write
 * to `account_members` can hand themselves `owner` there. That is fine, because
 * `owner` reaches exactly one workspace's artifacts and nothing else. Platform
 * authority is never read from D1 at all: it is re-derived from configuration on
 * every request by `effectiveRole` (users.ts), and nothing in this file — no
 * query, no write, no API payload it serves — feeds into it. So there is no bug
 * here that can escalate somebody to admin or super admin.
 *
 * Everything here fails *soft*. A missing table (code deployed ahead of the
 * migration), a D1 blip, or an un-backfilled row resolves to "no account
 * context", and every caller then falls back to the legacy `owner_email` path,
 * which is exactly the pre-#27 behavior. Accounts can only ever *widen* what
 * somebody reaches, never narrow it, so failing soft is also failing closed.
 */

// --- platform role (config only — never D1) ---------------------------------

/**
 * Platform authority: operator rights over the whole instance.
 *
 * A deliberate re-export of {@link UserRole} under the name the product model
 * uses, so a reader of an authorization check can tell at a glance which of the
 * two role systems is in play. It is derived only from `ADMIN_EMAILS` /
 * `SUPER_ADMIN_EMAILS` (see `effectiveRole` in users.ts) and is never stored as
 * a grant.
 */
export type PlatformRole = UserRole;

// --- account role (D1 — customer data) --------------------------------------

/** Roles inside one account, most powerful first. Purely workspace-scoped. */
export const ACCOUNT_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/**
 * Rank, ascending in power-loss: `owner` (0) outranks `viewer` (3). Compared with
 * `<=` everywhere, so a new role can be slotted in by editing this table alone.
 */
const ROLE_RANK: Record<AccountRole, number> = { owner: 0, admin: 1, member: 2, viewer: 3 };

export function isAccountRole(raw: unknown): raw is AccountRole {
  return typeof raw === "string" && (ACCOUNT_ROLES as readonly string[]).includes(raw);
}

/** Parse a stored/submitted role, defaulting to the least-powerful useful one. */
export function toAccountRole(raw: unknown, fallback: AccountRole = "member"): AccountRole {
  return isAccountRole(raw) ? raw : fallback;
}

/** Does `role` carry at least the rights of `min`? `owner` satisfies everything. */
export function atLeast(role: AccountRole | null | undefined, min: AccountRole): boolean {
  return !!role && ROLE_RANK[role] <= ROLE_RANK[min];
}

/**
 * The account role needed to publish, republish, roll back, delete, or change
 * access on an artifact. `viewer` deliberately falls below this line: a viewer
 * sees the workspace's artifacts but cannot change them.
 */
export const MANAGE_ARTIFACTS: AccountRole = "member";

/** The account role needed to add, remove, or re-role a member. */
export const MANAGE_MEMBERS: AccountRole = "admin";

/** The word for an account role, as the product says it. */
export function accountRoleLabel(role: AccountRole): string {
  return role === "owner" ? "Owner" : role === "admin" ? "Admin" : role === "member" ? "Member" : "Viewer";
}

// --- rows -------------------------------------------------------------------

export type AccountKind = "personal" | "team";
export type AccountStatus = "active" | "suspended";

export interface AccountRow {
  id: string;
  name: string;
  kind: AccountKind;
  status: AccountStatus;
  /**
   * What BILLING says this account is on. Lemon Squeezy writes it (see
   * `processWebhookEvent`), and it is deliberately NOT the answer to "what may
   * this account do" — {@link effectivePlan} is. Read this only when you
   * specifically mean the subscription's plan.
   */
  plan: string;
  /** Set only for `kind: 'personal'` — the one identity this workspace is for. */
  personal_email: string | null;
  /**
   * The workspace's BRANDED ADDRESS (migration 0020): the `yogev` in
   * `rtfx.pro/yogev/q3-board-report`. Globally unique across accounts, lowercase,
   * and null for the overwhelming majority — nothing backfills it, because an
   * address nobody asked for is a namespace published by accident.
   *
   * Optional rather than `| null` for the same reason the operator columns below
   * are: a Worker deployed ahead of migration 0020 reads rows that have no such
   * column, and absent means exactly what NULL means — "no branded address".
   * See src/account-slugs.ts for every rule about what it may say.
   */
  public_slug?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;

  // --- operator control plane (migration 0018) ------------------------------
  //
  // Every field below is optional rather than `| null`, and that is load-
  // bearing rather than lazy: a Worker deployed ahead of migration 0018 reads
  // rows that have no such columns at all, and a caller constructing an
  // `AccountRow` in a test or a fixture should not have to name nine fields it
  // does not care about. Absent and NULL mean the same thing everywhere —
  // "no override, never suspended" — so there is no third state to handle.

  /**
   * What the OPERATOR says this account is on, overriding `plan` while it is
   * live. A separate column from `plan` on purpose: that is what makes a
   * billing webhook structurally incapable of clobbering a comp.
   */
  plan_override?: string | null;
  /** NULL means "until an operator removes it". A past timestamp is simply inert. */
  plan_override_expires_at?: string | null;
  /** Why the override exists, in the operator's own words. */
  plan_override_note?: string | null;
  plan_override_by?: string | null;
  plan_override_at?: string | null;
  /** Internal operator notes about this account. Never shown to the customer. */
  notes?: string | null;
  suspended_at?: string | null;
  suspended_by?: string | null;
  suspended_reason?: string | null;
}

export interface MemberRow {
  account_id: string;
  email: string;
  role: AccountRole;
  status: string;
  invited_by: string | null;
  created_at: string;
  updated_at: string;
}

/** One account plus the caller's role in it. */
export interface Membership {
  account: AccountRow;
  role: AccountRole;
}

// --- entitlement: what the account may actually do ---------------------------

/** Just the plan-bearing fields, so pure callers need no full row. */
export type PlanBearing = Pick<
  AccountRow,
  "plan" | "plan_override" | "plan_override_expires_at"
>;

/**
 * Is an operator plan override in force right now?
 *
 * An override with no expiry runs until an operator removes it; one whose
 * expiry has passed is simply inert. That second case is why nothing schedules
 * a job to "expire" overrides: an expired comp stops applying by being read,
 * not by being cleaned up, so a Worker that never ran housekeeping still
 * charges the customer the right thing.
 *
 * ISO-8601 UTC strings compare correctly as strings, which is why this is a
 * `>` and not a `Date.parse` — every timestamp in this database is written by
 * `new Date().toISOString()`.
 */
export function overrideActive(account: PlanBearing, now = new Date().toISOString()): boolean {
  if (!account.plan_override) return false;
  const expires = account.plan_override_expires_at;
  return !expires || expires > now;
}

/**
 * **The** answer to "what is this account entitled to" — the operator's
 * override while it is live, otherwise what billing says.
 *
 * Every entitlement decision reads this and never `account.plan` directly:
 * quota at publish time, the seat cap, the monthly view limit, the plan shown
 * in Settings. `account.plan` continues to record the *subscription*, which is
 * what makes the two independent — a Lemon Squeezy webhook writes `plan`, an
 * operator writes `plan_override`, and neither can silently undo the other.
 */
export function effectivePlan(account: PlanBearing, now?: string): string {
  return overrideActive(account, now) ? account.plan_override! : account.plan;
}

/**
 * Is this workspace suspended? `status` (migration 0008) is authoritative; the
 * `suspended_*` columns only record who, why and when.
 */
export function isSuspended(account: Pick<AccountRow, "status">): boolean {
  return account.status === "suspended";
}

/**
 * `*`, not an explicit list — the one place in this file where that is the
 * careful choice rather than the lazy one.
 *
 * Migration 0018 added nine operator columns, and this Worker can be deployed
 * before that migration runs. Naming them explicitly would make every read in
 * this module throw "no such column" on such an instance, and because all of
 * these readers fail soft to null/[], the visible symptom would be *every
 * account disappearing* — strictly worse than today. With `*` the new fields
 * simply come back `undefined`, which {@link AccountRow} already treats as
 * "no override, never suspended". The table's shape is owned by this repo, so
 * there is no third party who can widen it under us.
 */
const ACCOUNT_COLUMNS = "*";
const MEMBER_COLUMNS = "account_id, email, role, status, invited_by, created_at, updated_at";

export const MAX_ACCOUNT_NAME_LENGTH = 80;

/** An opaque, non-guessable account id. Never derived from an email. */
export function newAccountId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `acct_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// --- queries (all fail soft — see the module note) ---------------------------

export async function getAccount(env: Env, id: string): Promise<AccountRow | null> {
  try {
    return await env.DB.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`)
      .bind(id)
      .first<AccountRow>();
  } catch {
    return null;
  }
}

export async function listAccounts(env: Env): Promise<AccountRow[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY kind, name`
    ).all<AccountRow>();
    return results ?? [];
  } catch {
    return [];
  }
}

/** The personal workspace for one identity, or null if it hasn't been created yet. */
export async function personalAccountFor(env: Env, email: string): Promise<AccountRow | null> {
  try {
    return await env.DB.prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE personal_email = ?`
    )
      .bind(normalize(email))
      .first<AccountRow>();
  } catch {
    return null;
  }
}

/** This identity's role in one account, or null when they are not a member. */
export async function memberRole(
  env: Env,
  accountId: string,
  email: string | null | undefined
): Promise<AccountRole | null> {
  if (!email) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT role FROM account_members WHERE account_id = ? AND email = ?"
    )
      .bind(accountId, normalize(email))
      .first<{ role: string }>();
    return row ? toAccountRole(row.role) : null;
  } catch {
    return null;
  }
}

export async function listMembers(env: Env, accountId: string): Promise<MemberRow[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT ${MEMBER_COLUMNS} FROM account_members WHERE account_id = ? ORDER BY email`
    )
      .bind(accountId)
      .all<MemberRow>();
    return (results ?? []).map((r) => ({ ...r, role: toAccountRole(r.role) }));
  } catch {
    return [];
  }
}

/** Every account this identity belongs to, with their role, personal one first. */
export async function listMemberships(env: Env, email: string | null | undefined): Promise<Membership[]> {
  if (!email) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT m.role AS member_role, ${ACCOUNT_COLUMNS
        .split(", ")
        .map((c) => `a.${c}`)
        .join(", ")}
       FROM account_members m JOIN accounts a ON a.id = m.account_id
       WHERE m.email = ?
       ORDER BY CASE WHEN a.kind = 'personal' THEN 0 ELSE 1 END, a.name`
    )
      .bind(normalize(email))
      .all<AccountRow & { member_role: string }>();
    return (results ?? []).map(({ member_role, ...account }) => ({
      account: account as AccountRow,
      role: toAccountRole(member_role),
    }));
  } catch {
    return [];
  }
}

/** How many members hold `owner` — the guard against orphaning an account. */
export async function ownerCount(env: Env, accountId: string): Promise<number> {
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM account_members WHERE account_id = ? AND role = 'owner'"
    )
      .bind(accountId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The account holding one branded address, or null.
 *
 * The whole of the branded route's namespace check (src/index.ts): an artifact
 * is reachable at `/:accountSlug/:artifactSlug` only when its `account_id`
 * equals this row's id, so one workspace's address can never front another
 * workspace's artifact.
 *
 * Fails soft like every other reader here. On an instance whose database is
 * behind migration 0020 there is no `public_slug` column, so no address exists,
 * so no branded link resolves — which is precisely the pre-feature behavior
 * rather than a 500 on a path anybody can hit unauthenticated.
 */
export async function getAccountByPublicSlug(env: Env, slug: string): Promise<AccountRow | null> {
  const clean = slug.trim().toLowerCase();
  if (!clean) return null;
  try {
    return await env.DB.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE public_slug = ?`)
      .bind(clean)
      .first<AccountRow>();
  } catch {
    return null;
  }
}

// --- writes -----------------------------------------------------------------

export interface CreateAccountInput {
  name: string;
  kind: AccountKind;
  /** Set for a personal account; must be null for a team account. */
  personalEmail: string | null;
  createdBy: string;
  now: string;
}

/**
 * Create an account and return it. Throws on a real database error (unlike the
 * readers): a caller asking to create a workspace must be told when it didn't
 * happen, rather than silently getting nothing.
 */
export async function createAccount(env: Env, input: CreateAccountInput): Promise<AccountRow> {
  const id = newAccountId();
  await env.DB.prepare(
    `INSERT INTO accounts (id, name, kind, status, plan, personal_email, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'active', 'free', ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.name,
      input.kind,
      input.personalEmail ? normalize(input.personalEmail) : null,
      input.createdBy,
      input.now,
      input.now
    )
    .run();
  return (await getAccount(env, id))!;
}

export interface UpsertMemberInput {
  accountId: string;
  email: string;
  role: AccountRole;
  invitedBy: string | null;
  now: string;
}

/** Add somebody to an account, or change the role they already hold there. */
export async function upsertMember(env: Env, input: UpsertMemberInput): Promise<MemberRow | null> {
  const email = normalize(input.email);
  await env.DB.prepare(
    `INSERT INTO account_members (account_id, email, role, status, invited_by, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(account_id, email) DO UPDATE SET
       role = excluded.role, status = 'active', updated_at = excluded.updated_at`
  )
    .bind(input.accountId, email, input.role, input.invitedBy, input.now, input.now)
    .run();
  const rows = await listMembers(env, input.accountId);
  return rows.find((r) => r.email === email) ?? null;
}

export async function removeMember(env: Env, accountId: string, email: string): Promise<boolean> {
  const res = await env.DB.prepare(
    "DELETE FROM account_members WHERE account_id = ? AND email = ?"
  )
    .bind(accountId, normalize(email))
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Drop somebody from every account (when their identity is removed entirely). */
export async function removeMemberEverywhere(env: Env, email: string): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM account_members WHERE email = ?").bind(normalize(email)).run();
  } catch {
    // Best-effort: an un-migrated database has nothing to clean up.
  }
}

/**
 * The identity's personal workspace, creating it (and their `owner` membership)
 * on first use.
 *
 * Race-safe without a transaction: two concurrent requests both attempt the
 * INSERT, the UNIQUE constraint on `personal_email` lets exactly one win, and
 * `ON CONFLICT DO NOTHING` turns the loser into a no-op that then reads back the
 * winner's row. This is also precisely what migration 0010 does in bulk, so a
 * deployment that skips the backfill converges to the same state.
 *
 * Returns null rather than throwing when the tables aren't there yet — the
 * caller then runs on the legacy `owner_email` path.
 */
export async function ensurePersonalAccount(
  env: Env,
  email: string,
  now: string
): Promise<AccountRow | null> {
  const clean = normalize(email);
  if (!clean.includes("@")) return null;
  try {
    let account = await personalAccountFor(env, clean);
    if (!account) {
      await env.DB.prepare(
        `INSERT INTO accounts (id, name, kind, status, plan, personal_email, created_by, created_at, updated_at)
         VALUES (?, ?, 'personal', 'active', 'free', ?, ?, ?, ?)
         ON CONFLICT(personal_email) DO NOTHING`
      )
        .bind(newAccountId(), clean, clean, clean, now, now)
        .run();
      account = await personalAccountFor(env, clean);
    }
    if (!account) return null;
    // Idempotent, and repairs a hand-edited row that lost its owner membership.
    if (!(await memberRole(env, account.id, clean))) {
      await upsertMember(env, {
        accountId: account.id,
        email: clean,
        role: "owner",
        invitedBy: null,
        now,
      });
    }
    return account;
  } catch {
    return null;
  }
}

/**
 * What happened when a workspace tried to claim an address.
 *
 * `taken` is a 409 and `unavailable` is a 503: the difference matters to the
 * person, because one is answered by picking another name and the other is
 * answered by trying again later (it is what an un-migrated database returns).
 */
export type PublicSlugResult =
  | { ok: true; account: AccountRow }
  | { ok: false; reason: "taken" | "unavailable" };

/**
 * Claim, change, or (with `null`) release this workspace's branded address.
 *
 * Validation is NOT done here — `checkAccountSlug` (src/account-slugs.ts) owns
 * the shape and the reserved list, and the caller runs it first. This function
 * owns exactly the part that needs the database: uniqueness.
 *
 * Uniqueness is enforced by the partial UNIQUE index, not by the read below.
 * The read exists only to turn the common case into a clean "that address is
 * taken" instead of a raw constraint failure; two requests claiming the same
 * name in the same instant still both go to the INSERT, and the loser is caught
 * by the constraint. Getting that backwards — trusting the read — is how two
 * workspaces end up sharing a namespace.
 */
export async function setAccountPublicSlug(
  env: Env,
  accountId: string,
  slug: string | null,
  now: string
): Promise<PublicSlugResult> {
  const value = slug ? slug.trim().toLowerCase() : null;
  try {
    if (value) {
      const holder = await getAccountByPublicSlug(env, value);
      // Re-claiming the address you already hold is a no-op, not a conflict.
      if (holder && holder.id !== accountId) return { ok: false, reason: "taken" };
    }
    const res = await env.DB.prepare(
      "UPDATE accounts SET public_slug = ?, updated_at = ? WHERE id = ?"
    )
      .bind(value, now, accountId)
      .run();
    if ((res.meta?.changes ?? 0) === 0) return { ok: false, reason: "unavailable" };
  } catch (err) {
    // The UNIQUE index firing means somebody claimed it between the read and
    // the write. Anything else — no such column on an un-migrated instance, a
    // D1 blip — is not the customer's fault and must not read as "taken".
    return { ok: false, reason: /UNIQUE|constraint/i.test(String(err)) ? "taken" : "unavailable" };
  }
  const account = await getAccount(env, accountId);
  return account ? { ok: true, account } : { ok: false, reason: "unavailable" };
}

// --- request-scoped context -------------------------------------------------

/**
 * Account ids the caller may act in, mapped to their role there. This is the
 * value every authorization check consumes — see `canManage` in authz.ts.
 */
export type AccountRoles = ReadonlyMap<string, AccountRole>;

/** Which accounts this request may touch, and which one it is acting in. */
export interface AccountContext {
  /** The workspace this request acts in, or null when the caller has none. */
  active: AccountRow | null;
  /** The caller's role in `active`. Null when there is no active account. */
  role: AccountRole | null;
  /** Every account the caller belongs to. Empty for a token pinned to one. */
  memberships: Membership[];
  /** account id → the caller's role there. The scoping key for artifact queries. */
  roles: AccountRoles;
  /**
   * True when the account came from the API token itself, so this request cannot
   * switch workspaces: a bearer credential is issued *for* one workspace and must
   * never reach another, even if the person who owns it belongs to several.
   */
  pinned: boolean;
  /**
   * True when `active` came from an explicit selection the caller made (the
   * `rtfx_account` cookie), rather than from the default "your personal
   * workspace first" ordering.
   *
   * Deliberately reported rather than inferred: a stale selection — a workspace
   * that was deleted, or one the caller was removed from — resolves to `false`
   * here *and* to the default active account, which is exactly what makes an
   * ignored selection indistinguishable from never having made one.
   */
  selected: boolean;
}

/**
 * The accounts in which the caller holds at least `min`.
 *
 * The management surfaces (`/api/artifacts`, the portal's artifact list) pass
 * `MANAGE_ARTIFACTS`, which is what keeps a `viewer` out of them: a viewer reads
 * the workspace's published artifacts through the gallery and their public URLs,
 * and has nothing to do in a console whose every control they would be refused.
 */
export function accountIdsWithAtLeast(roles: AccountRoles, min: AccountRole): string[] {
  return [...roles].filter(([, role]) => atLeast(role, min)).map(([id]) => id);
}

/** No accounts resolved — every caller falls back to the legacy owner_email path. */
export const EMPTY_ACCOUNT_CONTEXT: AccountContext = {
  active: null,
  role: null,
  memberships: [],
  roles: new Map(),
  pinned: false,
  selected: false,
};

/** Just the identity fields the account resolver needs (an `Identity` satisfies it). */
export interface AccountSubject {
  email: string | null;
  /** Set when the caller authenticated with an API token pinned to an account. */
  accountId?: string | null;
  /** True when this is a bearer-token caller. */
  isToken?: boolean;
}

/**
 * Resolve which workspaces this request may act in.
 *
 * Deliberately NOT part of `resolveAuth`: authentication happens on every request
 * including the artifact-serving hot path, and account context is only needed by
 * the management surfaces (`/admin`, `/api`). Keeping it out of the auth path
 * means #27 adds zero database reads to serving a page view.
 *
 * A token caller is pinned to the token's account and gets no membership list —
 * it cannot be asked to enumerate the workspaces of the person it acts as.
 *
 * `ensure` provisions the personal account on the spot when the identity has no
 * memberships at all, which is how an instance that skipped migration 0010
 * converges. Pass `false` from read-only paths that must not write.
 *
 * `selected` is the workspace an interactive caller picked (the `rtfx_account`
 * cookie — see `accountsFor` in src/auth.ts). It is honored *only* when it names
 * an account the caller is currently a member of, so it can never widen reach:
 * an unknown id, a deleted workspace, or one they were removed from all fall
 * back to the default active account rather than erroring. Token callers ignore
 * it entirely, which is what keeps a bearer credential pinned.
 */
export async function resolveAccountContext(
  env: Env,
  subject: AccountSubject | null,
  opts: { ensure?: boolean; now?: string; selected?: string | null } = {}
): Promise<AccountContext> {
  if (!subject) return EMPTY_ACCOUNT_CONTEXT;
  const now = opts.now ?? new Date().toISOString();

  if (subject.isToken) {
    const id = subject.accountId ?? null;
    if (!id) return EMPTY_ACCOUNT_CONTEXT;
    const account = await getAccount(env, id);
    if (!account) return EMPTY_ACCOUNT_CONTEXT;
    // The token's rights inside its account are its owner's rights. A token with
    // no owner_email (an admin/platform token) is not a workspace member at all;
    // it reaches artifacts through platform authority instead, never through here.
    const role = await memberRole(env, id, subject.email);
    if (!role) return { ...EMPTY_ACCOUNT_CONTEXT, pinned: true };
    return {
      active: account,
      role,
      memberships: [{ account, role }],
      roles: new Map([[id, role]]),
      pinned: true,
      selected: false,
    };
  }

  if (!subject.email) return EMPTY_ACCOUNT_CONTEXT;

  let memberships = await listMemberships(env, subject.email);
  if (!memberships.length && opts.ensure !== false) {
    const created = await ensurePersonalAccount(env, subject.email, now);
    if (created) memberships = await listMemberships(env, subject.email);
  }
  if (!memberships.length) return EMPTY_ACCOUNT_CONTEXT;

  // `listMemberships` sorts the personal workspace first, so the default is
  // "your own workspace unless you only belong to team ones". An explicit
  // selection wins over that default — but only if it is still a membership,
  // which is the check that makes a stale cookie inert rather than dangerous.
  const chosen = opts.selected ? memberships.find((m) => m.account.id === opts.selected) : undefined;
  const active = chosen ?? memberships[0];
  return {
    active: active.account,
    role: active.role,
    memberships,
    roles: new Map(memberships.map((m) => [m.account.id, m.role])),
    pinned: false,
    selected: !!chosen,
  };
}

// --- presentation -----------------------------------------------------------

/** An account as the API and portal see it, with the caller's own role folded in. */
export interface PublicAccount {
  id: string;
  name: string;
  kind: AccountKind;
  status: AccountStatus;
  /**
   * What this account is entitled to right now — {@link effectivePlan}, not the
   * raw `plan` column. Identical to `billed_plan` for the overwhelming majority
   * of accounts (nobody has an override), and when they differ, this is the one
   * a customer-facing caller means: it is what their quota, seats and view
   * limit are actually computed from.
   */
  plan: string;
  /** What billing says, when an override is making that different from `plan`. */
  billed_plan?: string;
  /** True while an operator override is in force. Deliberately no note/expiry: those are operator-facing. */
  plan_overridden?: boolean;
  created_at: string;
  /**
   * The workspace's branded address, present only once one has been claimed.
   * Additive on purpose: an account without one serializes byte-for-byte as it
   * did before migration 0020, so no existing consumer sees a new null field.
   */
  public_slug?: string;
  /** The requesting caller's role here, or null when they are not a member. */
  your_role: AccountRole | null;
}

export function toPublicAccount(account: AccountRow, role: AccountRole | null): PublicAccount {
  const plan = effectivePlan(account);
  return {
    id: account.id,
    name: account.name,
    kind: account.kind,
    status: account.status,
    plan,
    // Only present when it says something `plan` doesn't, so an ordinary
    // account's payload is byte-identical to what it was before overrides.
    ...(plan === account.plan ? {} : { billed_plan: account.plan, plan_overridden: true }),
    ...(account.public_slug ? { public_slug: account.public_slug } : {}),
    created_at: account.created_at,
    your_role: role,
  };
}

export interface PublicMember {
  account_id: string;
  email: string;
  role: AccountRole;
  status: string;
  invited_by: string | null;
  created_at: string;
}

export function toPublicMember(row: MemberRow): PublicMember {
  return {
    account_id: row.account_id,
    email: row.email,
    role: row.role,
    status: row.status,
    invited_by: row.invited_by,
    created_at: row.created_at,
  };
}
