import type { Env } from "./env";

/**
 * Same check db.ts uses for the same reason: a deploy that predates migration
 * 0009. Widened (vs. db.ts's copy) to also match an aliased reference —
 * `loadViewStatus` below queries `artifacts a`, so SQLite reports the missing
 * column as `a.account_id`, not `account_id`.
 */
function isMissingAccountColumn(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /no such column: (\w+\.)?account_id|table artifacts has no column named account_id/i.test(message);
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

// --- monthly view-limit enforcement ------------------------------------------
//
// `maxViewsPerMonth` (see PLANS above) is enforced here. Two things shaped the
// design:
//
// 1. Views are frequent — every artifact page load — and publishes are not.
//    A per-view D1 read would put an aggregate query on the single hottest
//    path in the app, so the answer for an account ({plan, views this month})
//    is cached in the isolate for VIEW_LIMIT_CACHE_TTL_MS (~60s). That has a
//    real cost: an account that crosses its limit can still serve up to
//    (traffic rate × ~60s) extra views before enforcement catches up, and,
//    the opposite direction, an isolate that cached "under limit" just before
//    the account crossed it keeps answering "under limit" for up to another
//    60s. Both are accepted — this is a soft, best-effort product cap meant
//    to stop runaway abuse and nudge an account toward upgrading, not a
//    metering system with billing-grade precision. `artifact_views` itself
//    remains the source of truth; anything that needs an exact count (an
//    invoice, a dispute) reads that table directly rather than this cache.
// 2. The cache lives in a plain isolate-local Map — no KV, no Durable Object,
//    no new dependency. That means it is NOT shared across isolates: a
//    high-traffic account spread across many concurrent isolates (multiple
//    Cloudflare PoPs, or many warm instances in one) gets one D1 read per
//    isolate per ~60s rather than one globally. Worst case that is still a
//    small, bounded multiple of "one read per minute per account" — nothing
//    close to "one read per view" — so it was not worth spending a shared
//    store on.

export const VIEW_LIMIT_CACHE_TTL_MS = 60_000;

interface CachedViewStatus {
  plan: string;
  views: number;
  monthStart: string;
  cachedAtMs: number;
}

/** Isolate-local. See the design note above for why this is not shared storage. */
const viewStatusCache = new Map<string, CachedViewStatus>();

function isMissingAccountsTable(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /no such table: accounts/i.test(message);
}

/** The current UTC calendar month as a half-open [start, end) ISO range. */
function monthWindow(now: Date): { start: string; end: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1)).toISOString(),
    end: new Date(Date.UTC(y, m + 1, 1)).toISOString(),
  };
}

/**
 * One combined query for both numbers a cache refresh needs — the account's
 * plan (to look up its limit) and its view count this calendar month, summed
 * across every artifact it owns — so a refresh costs exactly one D1 round
 * trip, not two. LEFT JOINs throughout so an account with no artifacts, or no
 * views this month, still returns a row: COUNT() over an all-NULL join is 0,
 * not "no row", which is what makes GROUP BY acc.plan safe to rely on here.
 *
 * Returns null when there is nothing to enforce against: no such account, or
 * (same tolerance `usageFor` and `listArtifactsForCaller` already apply) a
 * database that predates the accounts tables or the account_id column
 * entirely. Callers must treat null as "never block".
 */
async function loadViewStatus(
  env: Env,
  accountId: string,
  now: Date
): Promise<{ plan: string; views: number } | null> {
  const { start, end } = monthWindow(now);
  try {
    const row = await env.DB.prepare(
      `SELECT acc.plan AS plan, COUNT(v.id) AS n
         FROM accounts acc
         LEFT JOIN artifacts a ON a.account_id = acc.id
         LEFT JOIN artifact_views v ON v.slug = a.slug AND v.viewed_at >= ?2 AND v.viewed_at < ?3
        WHERE acc.id = ?1
        GROUP BY acc.plan`
    )
      .bind(accountId, start, end)
      .first<{ plan: string; n: number }>();
    if (!row) return null;
    return { plan: row.plan, views: row.n ?? 0 };
  } catch (e) {
    if (isMissingAccountColumn(e) || isMissingAccountsTable(e)) return null;
    throw e;
  }
}

/** Same boundary rule as {@link exceeds}: exactly at the limit is not over it. */
export function overMonthlyViewLimit(views: number, limit: number): boolean {
  return views > limit;
}

export interface ViewLimitStatus {
  plan: string;
  views: number;
  limit: number;
  overLimit: boolean;
}

/**
 * This account's plan and monthly view count, cached in the isolate for
 * {@link VIEW_LIMIT_CACHE_TTL_MS} — see the design note above. Returns null
 * when there is nothing to enforce against (see {@link loadViewStatus}).
 *
 * `now` and `wallClockMs` are both injectable, and deliberately not the same
 * knob: `now` picks the calendar month being measured (defaults to the real
 * date), `wallClockMs` drives cache freshness (defaults to the real clock).
 * A test can hold the month fixed while advancing only the cache clock, which
 * is what makes the ~60s cache behavior testable without waiting 60s.
 */
export async function viewLimitStatus(
  env: Env,
  accountId: string,
  now: Date = new Date(),
  wallClockMs: number = Date.now()
): Promise<ViewLimitStatus | null> {
  const { start } = monthWindow(now);
  const cached = viewStatusCache.get(accountId);
  let plan: string;
  let views: number;
  if (cached && cached.monthStart === start && wallClockMs - cached.cachedAtMs < VIEW_LIMIT_CACHE_TTL_MS) {
    ({ plan, views } = cached);
  } else {
    const fresh = await loadViewStatus(env, accountId, now);
    if (!fresh) return null;
    ({ plan, views } = fresh);
    viewStatusCache.set(accountId, { plan, views, monthStart: start, cachedAtMs: wallClockMs });
  }
  const limit = limitsFor(plan).maxViewsPerMonth;
  return { plan, views, limit, overLimit: overMonthlyViewLimit(views, limit) };
}

/**
 * Should a content request for an artifact be answered with the over-limit
 * page instead of its content?
 *
 * `bypass` is the caller's own "may see this regardless of the limit"
 * decision — the artifact's owner and platform admins, per the spec — passed
 * in as a plain boolean rather than an `Identity` so this stays pure and
 * table-testable without any auth/session machinery. The content route
 * already computes exactly this (the `owned` it derives from `isOwner` /
 * workspace membership, OR'd with `identity?.isAdmin`) for its own `canView`
 * check, so wiring this in costs it nothing extra to compute.
 */
export function blocksOnViewLimit(status: ViewLimitStatus | null, bypass: boolean): boolean {
  if (bypass) return false;
  return !!status?.overLimit;
}
