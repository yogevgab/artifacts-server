import { Hono, type Context } from "hono";
import type { AppBindings } from "./env";
import { addToWaitlist } from "./db";

export const waitlist = new Hono<AppBindings>();

const MAX_EMAIL_LENGTH = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WAITLIST_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const WAITLIST_RATE_LIMIT_MAX = 12;
const WAITLIST_EMAIL_RATE_LIMIT_MAX = 3;

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clientAddress(c: Context<AppBindings>): string {
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

async function incrementRateLimitBucket(c: Context<AppBindings>, bucketSeed: string, max: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % WAITLIST_RATE_LIMIT_WINDOW_SECONDS);
  const resetAt = windowStart + WAITLIST_RATE_LIMIT_WINDOW_SECONDS;
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

async function checkWaitlistRateLimit(c: Context<AppBindings>, email: string): Promise<boolean> {
  const [ipOk, emailOk] = await Promise.all([
    incrementRateLimitBucket(c, `waitlist:ip:${clientAddress(c)}`, WAITLIST_RATE_LIMIT_MAX),
    incrementRateLimitBucket(c, `waitlist:email:${email}`, WAITLIST_EMAIL_RATE_LIMIT_MAX),
  ]);
  return ipOk && emailOk;
}

/** Trim/lowercase and validate an email; returns the cleaned value or null. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim().toLowerCase();
  if (!clean || clean.length > MAX_EMAIL_LENGTH) return null;
  if (!EMAIL_RE.test(clean)) return null;
  return clean;
}

waitlist.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_email" }, 400);
  }
  const email = normalizeEmail((body as { email?: unknown } | null)?.email);
  if (!email) return c.json({ error: "invalid_email" }, 400);
  if (!(await checkWaitlistRateLimit(c, email))) {
    return c.json({ error: "rate_limited" }, 429, { "Retry-After": String(WAITLIST_RATE_LIMIT_WINDOW_SECONDS) });
  }

  const joined = await addToWaitlist(c.env, email, new Date().toISOString());
  return c.json({ status: joined ? "joined" : "already" }, 200);
});

// A bookmarked/shared waitlist link should still land somewhere sensible.
waitlist.get("/", (c) => c.redirect("/#waitlist", 302));
