import type { Env } from "./env";

/**
 * The operator audit trail (`admin_audit`, migration 0018).
 *
 * The feature plan moved this ahead of the rest of the operator control plane
 * deliberately: an override or a suspension that leaves no trace is worse than
 * one that cannot be made at all, and "audited" is a claim the product may only
 * make once the rows actually exist.
 *
 * Two rules shape this module, and both are structural rather than
 * aspirational:
 *
 *  1. **Append-only.** Nothing here writes an UPDATE or a DELETE, and no route
 *     in the product reaches this table any other way. There is no surface that
 *     can rewrite history, so history cannot be rewritten.
 *  2. **The audit row lands with the change, or neither lands.** Operator
 *     writes never call `recordAudit` as a follow-up step — they compose
 *     {@link auditStatement} into the same `env.DB.batch(...)` as the mutation
 *     (D1 runs a batch as one transaction). An audited action whose audit row
 *     failed to write is therefore not a state this code can reach, which is
 *     what a "best-effort logging" call could never guarantee.
 *
 * {@link recordAudit} exists for the one caller that genuinely is best-effort:
 * the billing webhook, which is noting something that *happened to* an account
 * rather than performing an operator action, and which must return 200 to Lemon
 * Squeezy even if this table is missing on an un-migrated deployment.
 */

/** What `target_id` names. */
export type AuditTargetType = "account" | "user" | "artifact";

/**
 * The actions this codebase writes. A union rather than free text so a typo is
 * a compile error and the audit viewer's filter list can be exhaustive — an
 * action nobody can search for is an action nobody will find.
 */
export const AUDIT_ACTIONS = [
  "account.plan_override_set",
  "account.plan_override_cleared",
  "account.suspended",
  "account.unsuspended",
  "account.notes_updated",
  "billing.plan_change_under_override",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The human-facing name of an action, for the viewer's filter and its rows. */
export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  "account.plan_override_set": "Plan override set",
  "account.plan_override_cleared": "Plan override cleared",
  "account.suspended": "Account suspended",
  "account.unsuspended": "Account unsuspended",
  "account.notes_updated": "Operator notes updated",
  "billing.plan_change_under_override": "Billing changed under an override",
};

export interface AuditRow {
  id: number;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  summary: string | null;
  /** JSON, or null. Parse with {@link auditDetail} — never with a bare JSON.parse. */
  detail: string | null;
  created_at: string;
}

/** Who performed an action. `role` is the PLATFORM role, or "system" for the webhook. */
export interface AuditActor {
  email: string | null;
  role: string;
}

/** The webhook's actor: nobody signed in, and it must never look like a person. */
export const SYSTEM_ACTOR: AuditActor = { email: null, role: "system" };

export interface AuditInput {
  actor: AuditActor;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string | null;
  /** One line an operator can read six months from now without decoding `detail`. */
  summary: string;
  /** Structured context. Serialized to JSON; `undefined` values are dropped. */
  detail?: Record<string, unknown>;
  now: string;
}

const COLUMNS =
  "id, actor_email, actor_role, action, target_type, target_id, summary, detail, created_at";

/**
 * The INSERT for one audit row, as a statement rather than an executed write.
 *
 * Returning the statement is the whole point: an operator write batches this
 * with its own UPDATE so D1 applies both or neither. A helper that ran the
 * INSERT itself would leave a window — however small — in which the account
 * changed and the trail did not.
 */
export function auditStatement(env: Env, input: AuditInput) {
  return env.DB.prepare(
    `INSERT INTO admin_audit
       (actor_email, actor_role, action, target_type, target_id, summary, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    input.actor.email,
    input.actor.role,
    input.action,
    input.targetType,
    input.targetId,
    input.summary,
    input.detail ? JSON.stringify(input.detail) : null,
    input.now
  );
}

/**
 * Write one audit row on its own, swallowing a database error.
 *
 * For observers, not actors — today that is only the billing webhook, which is
 * recording something that happened *to* an account and must still return 200
 * to Lemon Squeezy on a deployment where migration 0018 has not run. Operator
 * controls must NOT use this: they compose {@link auditStatement} into their own
 * batch instead, so the trail cannot fall behind the change.
 */
export async function recordAudit(env: Env, input: AuditInput): Promise<void> {
  try {
    await auditStatement(env, input).run();
  } catch {
    // An un-migrated database has no trail to append to. Never a reason to fail
    // the request that was merely being observed.
  }
}

export interface AuditQuery {
  /** Most recent first. Clamped to 1..500. */
  limit?: number;
  /** Only rows about this target id. */
  targetId?: string;
  /** Only rows with this exact action. */
  action?: string;
}

/**
 * Recent audit rows, newest first. Fails soft to an empty list: a viewer that
 * renders "no entries" on an un-migrated instance is strictly better than a
 * platform page that 500s, and nothing authorizes off this read.
 */
export async function listAudit(env: Env, query: AuditQuery = {}): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (query.targetId) {
    where.push("target_id = ?");
    binds.push(query.targetId);
  }
  if (query.action) {
    where.push("action = ?");
    binds.push(query.action);
  }
  try {
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM admin_audit
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
      .bind(...binds, limit)
      .all<AuditRow>();
    return results ?? [];
  } catch {
    return [];
  }
}

/** How many rows the trail holds in total. 0 on an un-migrated instance. */
export async function countAudit(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit").first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * A row's `detail` as an object, or null.
 *
 * Total by construction: the column is written by this module alone, but it is
 * still read back from a database that a human can edit, so a malformed value
 * must render as "no detail" rather than throwing inside a page renderer.
 */
export function auditDetail(row: Pick<AuditRow, "detail">): Record<string, unknown> | null {
  if (!row.detail) return null;
  try {
    const parsed: unknown = JSON.parse(row.detail);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
