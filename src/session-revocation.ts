/**
 * Server-side sign-out.
 *
 * Sessions are stateless signed cookies, so clearing the cookie on sign-out
 * used to be the whole story: a copy taken earlier (a shared machine, malware,
 * a leaked HAR file) kept working until it expired, up to 30 days later.
 *
 * Signing out now records "sessions issued before this moment are void" for
 * that address. Every session cookie is checked against it, so sign-out ends
 * the session on every device. One row per address, created on demand; an
 * instance where the table cannot be read simply behaves as before.
 */

import type { Env } from "./env";

async function ensureTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS session_revocations (
       email          TEXT PRIMARY KEY,
       revoked_before TEXT NOT NULL
     )`
  ).run();
}

/** Void every session for `email` issued before `now`. */
export async function revokeSessionsFor(env: Env, email: string, now: string): Promise<void> {
  try {
    await ensureTable(env);
    await env.DB.prepare(
      `INSERT INTO session_revocations (email, revoked_before) VALUES (?, ?)
       ON CONFLICT (email) DO UPDATE SET revoked_before = excluded.revoked_before`
    )
      .bind(email.trim().toLowerCase(), now)
      .run();
  } catch (e) {
    // Never let bookkeeping turn a sign-out into an error page; the cookie is
    // still cleared by the caller.
    console.error("session revocation failed", e);
  }
}

/** True when a session for `email` issued at `iatSeconds` was voided by a later sign-out. */
export async function sessionRevoked(env: Env, email: string, iatSeconds: number | undefined): Promise<boolean> {
  try {
    const row = await env.DB.prepare("SELECT revoked_before FROM session_revocations WHERE email = ?")
      .bind(email.trim().toLowerCase())
      .first<{ revoked_before: string }>();
    if (!row) return false;
    // A session with no issue time predates this check; treat it as voided by
    // any sign-out, since it cannot prove it came after.
    if (iatSeconds === undefined) return true;
    return iatSeconds < Math.floor(Date.parse(row.revoked_before) / 1000);
  } catch {
    return false; // no table yet: nobody has signed out since this shipped
  }
}
