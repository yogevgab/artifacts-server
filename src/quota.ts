import type { Env } from "./env";

/** Same check db.ts uses for the same reason: a deploy that predates migration 0009. */
function isMissingAccountColumn(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /no such column: account_id|table artifacts has no column named account_id/i.test(message);
}

/**
 * Per-account quotas and metering (issue #27 follow-on; design spec §8).
 *
 * Open signup without limits is an unbounded storage/bandwidth liability, so
 * limits are enforced from day one rather than bolted on after launch. Values
 * live in one place — {@link PLANS} — which is the seam billing (P3) will
 * later drive: a paid plan is just another key in this table.
 *
 * `maxViewsPerMonth` is part of the plan shape per the spec but is
 * deliberately NOT enforced here. Enforcing it needs a windowed aggregate
 * over `artifact_views`, cached in the isolate for ~60s (views are frequent;
 * publishes are not), and a "friendly over-limit page" instead of the usual
 * 404 for content requests — that is separate, out-of-scope work. The field
 * stays in the table so the shape doesn't need to change when it lands.
 */
const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * `keepVersions` is the retention window, and it exists because storage counts
 * every immutable version. Without it a storage cap is really a cap on LIFETIME
 * PUBLISHES — republish a 5MB page twenty times and a 100MB account is full
 * with a single artifact live, which is not what anybody would expect a
 * "100MB" limit to mean. `null` means unlimited history.
 *
 * This narrows a promise the product makes in several places ("nothing is
 * deleted"), so those had to change in the same release. See the docs updates
 * alongside this commit.
 */
export const PLANS = {
  free: { maxArtifacts: 10, maxStorageBytes: 100 * MB, maxViewsPerMonth: 5_000, keepVersions: 5 as number | null },
  pro: { maxArtifacts: 100, maxStorageBytes: 5 * GB, maxViewsPerMonth: 100_000, keepVersions: null as number | null },
  team: { maxArtifacts: 10_000, maxStorageBytes: 50 * GB, maxViewsPerMonth: 1_000_000, keepVersions: null as number | null },
} as const;

export type PlanName = keyof typeof PLANS;
export type PlanLimits = (typeof PLANS)[PlanName];

/** An account's current usage against the two limits enforced at publish time. */
export interface Usage {
  artifacts: number;
  storageBytes: number;
}

export type QuotaLimit = "artifacts" | "storage";

/** The named plan's limits, falling back to `free` for an unrecognized or legacy value. */
export function limitsFor(plan: string): PlanLimits {
  return (PLANS as Record<string, PlanLimits>)[plan] ?? PLANS.free;
}

/**
 * Which limit `usage` exceeds under `limits`, or null when both are within
 * bounds. Deliberately pure — no D1, no env — so the boundary behavior is
 * exhaustively table-testable. Usage exactly *at* a limit is not exceeding
 * it: the cap is inclusive.
 *
 * Artifacts is checked before storage, so a publish that would blow both caps
 * at once reports the more legible reason first (an account that just hit its
 * Nth artifact, rather than a byte count nobody asked about).
 */
export function exceeds(usage: Usage, limits: PlanLimits): QuotaLimit | null {
  if (usage.artifacts > limits.maxArtifacts) return "artifacts";
  if (usage.storageBytes > limits.maxStorageBytes) return "storage";
  return null;
}

/**
 * Current usage for one account: how many artifacts it owns, and the total
 * size of every version ever published to them.
 *
 * Sums `artifact_versions`, not `artifacts.size_bytes` — versions are
 * immutable and never deleted, so the live size alone would undercount an
 * account that has republished the same artifact many times, which is
 * exactly the case a storage cap needs to bound (spec §8.3).
 *
 * One D1 aggregate, run only at publish time: publishes are infrequent, so
 * this needs no maintained counter and cannot drift from reality. Throws on a
 * real database error rather than failing soft — unlike the readers in
 * accounts.ts, an error here must not silently resolve to "no usage" and let
 * a quota check through.
 *
 * The one deliberate exception: a deploy that predates migration 0009 has no
 * `account_id` column on `artifacts` at all, even though the `accounts`
 * tables themselves exist and callers can resolve an active account. That is
 * the same "Worker ahead of its migration" gap `listArtifactsForCaller` in
 * db.ts already tolerates, and this is not a case to invent enforcement for:
 * before this feature shipped, such an instance had no quota at all, so
 * reporting zero usage here only preserves that, never widens it.
 */
export async function usageFor(env: Env, accountId: string): Promise<Usage> {
  try {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM artifacts WHERE account_id = ?1) AS artifacts,
         (SELECT COALESCE(SUM(v.size_bytes), 0)
            FROM artifact_versions v
            JOIN artifacts a ON a.slug = v.slug
            WHERE a.account_id = ?1) AS storage_bytes`
    )
      .bind(accountId)
      .first<{ artifacts: number; storage_bytes: number }>();
    return { artifacts: row?.artifacts ?? 0, storageBytes: row?.storage_bytes ?? 0 };
  } catch (e) {
    if (isMissingAccountColumn(e)) return { artifacts: 0, storageBytes: 0 };
    throw e;
  }
}


/**
 * Which versions fall outside the retention window.
 *
 * The live version is never expired, even when it sits outside the window: a
 * rollback can make an old version current, and deleting it would break the
 * artifact outright — worse than briefly exceeding the window.
 *
 * Pure so the rule is testable at its boundaries without a database.
 */
export function versionsToExpire(
  versions: number[],
  keep: number | null,
  currentVersion: number
): number[] {
  if (keep === null || keep <= 0) return [];
  const sorted = [...versions].sort((a, b) => b - a);
  return sorted.slice(keep).filter((v) => v !== currentVersion);
}
