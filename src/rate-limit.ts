/**
 * Fixed-window rate limiting, shared by the waitlist and by sign-in.
 *
 * Extracted from `waitlist.ts` when sign-in needed the same behaviour: two
 * independent implementations of "how many times may this address do this per
 * hour" is exactly the kind of duplication that drifts apart and leaves one of
 * them wrong.
 *
 * The table name stays `waitlist_rate_limits` for continuity — buckets are
 * namespaced by seed, so a rename would cost a migration and buy nothing.
 */

import type { Context } from "hono";
import type { AppBindings } from "./env";

export const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Best-effort client IP. "unknown" collapses everyone behind one bucket, which is deliberate. */
export function clientAddress(c: Context<AppBindings>): string {
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * Count one hit against `bucketSeed` and report whether it is still within
 * `max` for the current window. Returns true when allowed.
 */
export async function incrementRateLimitBucket(
  c: Context<AppBindings>,
  bucketSeed: string,
  max: number
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % RATE_LIMIT_WINDOW_SECONDS);
  const resetAt = windowStart + RATE_LIMIT_WINDOW_SECONDS;
  const id = await sha256Hex(`${bucketSeed}:${windowStart}`);
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS waitlist_rate_limits (
      bucket TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    )`
  ).run();
  await c.env.DB.prepare("DELETE FROM waitlist_rate_limits WHERE reset_at < ?").bind(now).run();
  await c.env.DB.prepare(
    `INSERT INTO waitlist_rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(bucket) DO UPDATE SET count = count + 1, reset_at = excluded.reset_at`
  )
    .bind(id, resetAt)
    .run();
  const row = await c.env.DB.prepare("SELECT count FROM waitlist_rate_limits WHERE bucket = ?")
    .bind(id)
    .first<{ count: number }>();
  return (row?.count ?? 0) <= max;
}
