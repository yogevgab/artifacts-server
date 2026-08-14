import type { Env } from "./env";
import { auditStatement, type AuditActor, type AuditInput } from "./audit";
import { effectivePlan, getAccount, overrideActive, type AccountRow } from "./accounts";
import { invalidateAccountStatus, PLANS } from "./quota";

/**
 * The operator control plane's write side, plus the reads the `/admin/platform`
 * pages are built from (Production SaaS plan, Phase 1).
 *
 * This is the module that gives the operator a manual escape hatch — comp a
 * customer, suspend an abusive workspace, leave a note for future-you — before
 * the self-serve flows that would otherwise be prerequisites exist. Everything
 * it can change is commercial, so two rules apply to every function here:
 *
 *  1. **A change and its audit row are one D1 batch.** D1 runs a batch as a
 *     transaction, so "the account changed but the trail didn't" is not a state
 *     this module can produce. See src/audit.ts for why `auditStatement`
 *     returns a statement instead of writing one.
 *  2. **Nothing here decides *who* may call it.** Authorization lives in
 *     src/platform-routes.ts, which gates the whole surface on the platform
 *     super admin. These functions assume that already happened, exactly as
 *     `upsertMember` assumes `canManageMembers` did.
 *
 * What is deliberately NOT here: per-limit overrides (artifacts, storage,
 * views, seats). The plan lists them as launch-critical, and they are not
 * implemented — an operator moves an account between plans instead. The
 * platform UI says so in as many words rather than showing a form that does
 * nothing; see `plannedRow` in src/platform.ts.
 */

/** The plans an operator may override an account onto. Exactly the enforceable ones. */
export const OVERRIDABLE_PLANS = Object.keys(PLANS) as string[];

export function isOverridablePlan(raw: unknown): raw is string {
  return typeof raw === "string" && OVERRIDABLE_PLANS.includes(raw);
}

/** The account as it stands after a write, re-read rather than assumed. */
type Written = Promise<AccountRow | null>;

/**
 * Apply the batch, drop this isolate's cached view of the account, and read the
 * row back.
 *
 * Re-reading rather than patching the caller's copy is the same discipline
 * `upsertMember` follows: the response a caller renders comes from the database
 * that was actually written, so a UI can never show a state D1 does not hold.
 */
async function commit(
  env: Env,
  accountId: string,
  update: D1PreparedStatement,
  audit: AuditInput
): Written {
  await env.DB.batch([update, auditStatement(env, audit)]);
  // The monthly-view cache holds the effective plan and the status, both of
  // which may have just changed. See `invalidateAccountStatus` for how far this
  // reaches (this isolate) and what bounds the rest (the TTL).
  invalidateAccountStatus(accountId);
  return getAccount(env, accountId);
}

export interface PlanOverrideInput {
  plan: string;
  /** ISO timestamp, or null for "until an operator removes it". */
  expiresAt: string | null;
  note: string | null;
  actor: AuditActor;
  now: string;
}

/**
 * Put an account on a plan regardless of what it is paying for.
 *
 * Writes `plan_override`, never `plan`: the subscription's own plan stays
 * exactly where billing left it, so removing the override later returns the
 * account to what it is actually paying for rather than to whatever it happened
 * to be on when the override was applied. That is the property that makes a
 * comp reversible without anybody having to remember what came before it.
 */
export async function setPlanOverride(
  env: Env,
  account: AccountRow,
  input: PlanOverrideInput
): Written {
  const before = effectivePlan(account, input.now);
  const update = env.DB.prepare(
    `UPDATE accounts SET plan_override = ?, plan_override_expires_at = ?, plan_override_note = ?,
       plan_override_by = ?, plan_override_at = ?, updated_at = ?
     WHERE id = ?`
  ).bind(
    input.plan,
    input.expiresAt,
    input.note,
    input.actor.email,
    input.now,
    input.now,
    account.id
  );
  return commit(env, account.id, update, {
    actor: input.actor,
    action: "account.plan_override_set",
    targetType: "account",
    targetId: account.id,
    summary:
      `${account.name} put on ${input.plan}` +
      (input.expiresAt ? ` until ${input.expiresAt}` : " with no expiry") +
      (before === input.plan ? " (no change to what it was already getting)" : ` (was ${before})`),
    detail: {
      account_name: account.name,
      effective_plan_before: before,
      effective_plan_after: input.plan,
      billed_plan: account.plan,
      expires_at: input.expiresAt,
      note: input.note,
    },
    now: input.now,
  });
}

/** Drop the override, returning the account to whatever billing says it is on. */
export async function clearPlanOverride(
  env: Env,
  account: AccountRow,
  opts: { actor: AuditActor; now: string }
): Written {
  const before = effectivePlan(account, opts.now);
  const update = env.DB.prepare(
    `UPDATE accounts SET plan_override = NULL, plan_override_expires_at = NULL,
       plan_override_note = NULL, plan_override_by = NULL, plan_override_at = NULL, updated_at = ?
     WHERE id = ?`
  ).bind(opts.now, account.id);
  return commit(env, account.id, update, {
    actor: opts.actor,
    action: "account.plan_override_cleared",
    targetType: "account",
    targetId: account.id,
    summary: `${account.name} returned to its billed plan (${account.plan}), was on ${before}`,
    detail: {
      account_name: account.name,
      effective_plan_before: before,
      effective_plan_after: account.plan,
      cleared_override: account.plan_override ?? null,
    },
    now: opts.now,
  });
}

/**
 * Suspend a workspace: it stops publishing and stops serving (see
 * `blocksOnSuspension` in src/quota.ts and the publish gate in src/api.ts).
 *
 * Nothing is deleted. Suspension is a switch, and un-suspending restores
 * precisely what was there — which is what makes it usable for a payment
 * dispute or a suspected-abuse hold, not only for a permanent ending.
 */
export async function suspendAccount(
  env: Env,
  account: AccountRow,
  opts: { reason: string | null; actor: AuditActor; now: string }
): Written {
  const update = env.DB.prepare(
    `UPDATE accounts SET status = 'suspended', suspended_at = ?, suspended_by = ?,
       suspended_reason = ?, updated_at = ?
     WHERE id = ?`
  ).bind(opts.now, opts.actor.email, opts.reason, opts.now, account.id);
  return commit(env, account.id, update, {
    actor: opts.actor,
    action: "account.suspended",
    targetType: "account",
    targetId: account.id,
    summary: `${account.name} suspended${opts.reason ? `: ${opts.reason}` : ""}`,
    detail: { account_name: account.name, reason: opts.reason, status_before: account.status },
    now: opts.now,
  });
}

/**
 * Lift a suspension. `suspended_reason` is kept rather than cleared: the reason
 * an account was once suspended is history, and history is the thing this whole
 * subsystem exists to preserve. `suspended_at` is cleared, because that field
 * answers "is it suspended, and since when" and the answer is now no.
 */
export async function unsuspendAccount(
  env: Env,
  account: AccountRow,
  opts: { actor: AuditActor; now: string }
): Written {
  const update = env.DB.prepare(
    "UPDATE accounts SET status = 'active', suspended_at = NULL, updated_at = ? WHERE id = ?"
  ).bind(opts.now, account.id);
  return commit(env, account.id, update, {
    actor: opts.actor,
    action: "account.unsuspended",
    targetType: "account",
    targetId: account.id,
    summary: `${account.name} unsuspended${
      account.suspended_reason ? ` (was: ${account.suspended_reason})` : ""
    }`,
    detail: {
      account_name: account.name,
      previous_reason: account.suspended_reason ?? null,
      suspended_at: account.suspended_at ?? null,
    },
    now: opts.now,
  });
}

export const MAX_ACCOUNT_NOTES_LENGTH = 2000;

/** Replace the internal note on an account. Audited like everything else here. */
export async function setAccountNotes(
  env: Env,
  account: AccountRow,
  opts: { notes: string | null; actor: AuditActor; now: string }
): Written {
  const update = env.DB.prepare("UPDATE accounts SET notes = ?, updated_at = ? WHERE id = ?").bind(
    opts.notes,
    opts.now,
    account.id
  );
  return commit(env, account.id, update, {
    actor: opts.actor,
    action: "account.notes_updated",
    targetType: "account",
    targetId: account.id,
    // The note's TEXT is not copied into the trail: it can be long, it is
    // free-form, and the audit row exists to say that it changed and by whom.
    summary: `Operator notes on ${account.name} ${opts.notes ? "updated" : "cleared"}`,
    detail: { account_name: account.name, length: opts.notes?.length ?? 0 },
    now: opts.now,
  });
}

// --- reads for the platform pages -------------------------------------------

/** One account as the platform accounts list shows it. */
export interface AccountSummary {
  account: AccountRow;
  /** The first `owner` in the workspace, which for a personal one is its person. */
  ownerEmail: string | null;
  memberCount: number;
  artifactCount: number;
  storageBytes: number;
  /** The most recent publish/update across the workspace's artifacts. */
  lastPublishAt: string | null;
}

type SummaryRow = AccountRow & {
  owner_email: string | null;
  member_count: number;
  artifact_count: number;
  storage_bytes: number;
  last_publish_at: string | null;
};

/**
 * The accounts list, newest activity first, with the four numbers an operator
 * asks about before doing anything: who owns it, how many people are in it, how
 * much it holds, and when it was last used.
 *
 * One query with correlated subselects rather than four joins-plus-GROUP BY:
 * the joins would multiply rows against each other (members × artifacts ×
 * versions) and every count would be wrong in a way that looks plausible.
 *
 * `q` is matched case-insensitively against id, name and the personal email.
 * Filtering in SQL rather than in the page keeps `limit` meaningful — a
 * client-side filter over the first 200 rows silently cannot find the 201st.
 */
export async function listAccountSummaries(
  env: Env,
  opts: { q?: string; limit?: number } = {}
): Promise<AccountSummary[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 500);
  const q = (opts.q ?? "").trim().toLowerCase();
  const like = `%${q}%`;
  try {
    const stmt = env.DB.prepare(
      `SELECT a.*,
         (SELECT m.email FROM account_members m
           WHERE m.account_id = a.id AND m.role = 'owner'
           ORDER BY m.created_at LIMIT 1) AS owner_email,
         (SELECT COUNT(*) FROM account_members m WHERE m.account_id = a.id) AS member_count,
         (SELECT COUNT(*) FROM artifacts ar WHERE ar.account_id = a.id) AS artifact_count,
         (SELECT COALESCE(SUM(v.size_bytes), 0) FROM artifact_versions v
            JOIN artifacts ar ON ar.slug = v.slug
           WHERE ar.account_id = a.id) AS storage_bytes,
         (SELECT MAX(ar.updated_at) FROM artifacts ar WHERE ar.account_id = a.id) AS last_publish_at
       FROM accounts a
       ${q ? `WHERE LOWER(a.id) LIKE ?1 OR LOWER(a.name) LIKE ?1 OR LOWER(COALESCE(a.personal_email,'')) LIKE ?1` : ""}
       ORDER BY a.updated_at DESC, a.created_at DESC
       LIMIT ${q ? "?2" : "?1"}`
    );
    const { results } = await (q ? stmt.bind(like, limit) : stmt.bind(limit)).all<SummaryRow>();
    return (results ?? []).map((r) => {
      const { owner_email, member_count, artifact_count, storage_bytes, last_publish_at, ...account } =
        r;
      return {
        account: account as AccountRow,
        ownerEmail: owner_email,
        memberCount: member_count ?? 0,
        artifactCount: artifact_count ?? 0,
        storageBytes: storage_bytes ?? 0,
        lastPublishAt: last_publish_at,
      };
    });
  } catch {
    // Same fail-soft rule as the rest of the accounts layer: an un-migrated or
    // unavailable database renders an empty operator page, never a 500.
    return [];
  }
}

/** One account's summary numbers, for its detail page. */
export async function accountSummary(env: Env, id: string): Promise<AccountSummary | null> {
  const rows = await listAccountSummaries(env, { limit: 500 });
  return rows.find((r) => r.account.id === id) ?? null;
}

export interface BillingEventRow {
  id: string;
  event_name: string;
  account_id: string | null;
  processed_at: string;
}

/** Lemon Squeezy webhook history, newest first. Empty on an un-migrated instance. */
export async function listBillingEvents(
  env: Env,
  opts: { accountId?: string; limit?: number } = {}
): Promise<BillingEventRow[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500);
  try {
    const stmt = opts.accountId
      ? env.DB.prepare(
          `SELECT id, event_name, account_id, processed_at FROM billing_events
            WHERE account_id = ? ORDER BY processed_at DESC LIMIT ?`
        ).bind(opts.accountId, limit)
      : env.DB.prepare(
          `SELECT id, event_name, account_id, processed_at FROM billing_events
            ORDER BY processed_at DESC LIMIT ?`
        ).bind(limit);
    const { results } = await stmt.all<BillingEventRow>();
    return results ?? [];
  } catch {
    return [];
  }
}

export interface MailLogRow {
  id: number;
  email: string;
  kind: string;
  status: string;
  error_code: string | null;
  created_at: string;
}

/** Transactional-mail delivery outcomes, newest first — "why didn't they get it". */
export async function listMailLog(env: Env, limit = 100): Promise<MailLogRow[]> {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 500);
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, email, kind, status, error_code, created_at FROM mail_log
        ORDER BY created_at DESC, id DESC LIMIT ?`
    )
      .bind(capped)
      .all<MailLogRow>();
    return results ?? [];
  } catch {
    return [];
  }
}

export interface ContactRequestRow {
  id: number;
  email: string;
  plan: string | null;
  message: string | null;
  created_at: string;
}

/**
 * "Talk to us" enquiries (src/contact.ts), newest first.
 *
 * src/contact.ts carried an explicit warning that nothing showed an operator
 * these rows and that no further surface should point at /contact until
 * something did. This read, and the page built on it, are that something.
 */
export async function listContactRequests(env: Env, limit = 100): Promise<ContactRequestRow[]> {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 500);
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, email, plan, message, created_at FROM contact_requests
        ORDER BY created_at DESC, id DESC LIMIT ?`
    )
      .bind(capped)
      .all<ContactRequestRow>();
    return results ?? [];
  } catch {
    return [];
  }
}

/** Re-exported so callers of this module don't need two imports for one decision. */
export { effectivePlan, overrideActive };
