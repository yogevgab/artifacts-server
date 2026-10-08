/**
 * Upload sessions: the single-use, 30-minute credential behind the remote MCP
 * `create_upload_link` tool (migration 0022).
 *
 * The URL path token IS the credential for exactly one upload to exactly one
 * destination that the creator was already allowed to publish to. Only its
 * SHA-256 is stored, exactly like `api_tokens` and `share_links`, so a read of
 * the table can not be replayed as an upload.
 */

import type { Env } from "./env";
import { hashToken } from "./tokens";

/** How long a link stays usable. Long enough to find the zip, short enough to forget about. */
export const UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000;

export interface UploadSessionRow {
  id: string;
  token_hash: string;
  account_id: string | null;
  email: string;
  is_admin: number;
  slug: string;
  title: string;
  description: string | null;
  note: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes, hex: 64 chars, URL-safe, nothing to escape. */
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Cheap shape check so a junk path costs no database read. */
export function isUploadTokenShape(token: string): boolean {
  return TOKEN_RE.test(token);
}

export interface NewUploadSession {
  accountId: string | null;
  email: string;
  isAdmin: boolean;
  slug: string;
  title: string;
  description?: string;
  note?: string;
}

/** Create a session. The raw token is returned once and never stored. */
export async function createUploadSession(
  env: Env,
  input: NewUploadSession,
  now = new Date()
): Promise<{ id: string; token: string; expiresAt: string }> {
  const id = hex(crypto.getRandomValues(new Uint8Array(8)));
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(now.getTime() + UPLOAD_SESSION_TTL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO upload_sessions
       (id, token_hash, account_id, email, is_admin, slug, title, description, note, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      await hashToken(token),
      input.accountId,
      input.email,
      input.isAdmin ? 1 : 0,
      input.slug,
      input.title,
      input.description || null,
      input.note || null,
      now.toISOString(),
      expiresAt
    )
    .run();
  // Housekeeping: rows are useless a day after expiry. Best effort.
  try {
    await env.DB.prepare("DELETE FROM upload_sessions WHERE expires_at < ?")
      .bind(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())
      .run();
  } catch {
    /* never a reason to fail creating a link */
  }
  return { id, token, expiresAt };
}

export type SessionLookup =
  | { state: "ok"; session: UploadSessionRow }
  | { state: "expired" | "used"; session: UploadSessionRow }
  | { state: "unknown" };

/** Look a token up. Never throws: an unreadable table reads as "unknown". */
export async function lookupUploadSession(env: Env, token: string, now = new Date()): Promise<SessionLookup> {
  if (!isUploadTokenShape(token)) return { state: "unknown" };
  let row: UploadSessionRow | null;
  try {
    row = await env.DB.prepare("SELECT * FROM upload_sessions WHERE token_hash = ?")
      .bind(await hashToken(token))
      .first<UploadSessionRow>();
  } catch {
    return { state: "unknown" };
  }
  if (!row) return { state: "unknown" };
  if (row.used_at) return { state: "used", session: row };
  if (row.expires_at <= now.toISOString()) return { state: "expired", session: row };
  return { state: "ok", session: row };
}

/**
 * Claim the link for this upload. Conditional, so of two racing uploads exactly
 * one gets `true` and the other is told the link is spent — claimed BEFORE the
 * store, because "mark after" would let both write a version. A claim that does
 * not end in a successful store is handed back with {@link releaseUploadSession},
 * so a typo'd folder or a quota refusal does not cost the person their link.
 */
export async function claimUploadSession(env: Env, id: string, now = new Date()): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE upload_sessions SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?"
  )
    .bind(now.toISOString(), id, now.toISOString())
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Hand a claim back after a failed upload. Best effort: worst case the person asks for a new link. */
export async function releaseUploadSession(env: Env, id: string): Promise<void> {
  try {
    await env.DB.prepare("UPDATE upload_sessions SET used_at = NULL WHERE id = ?").bind(id).run();
  } catch {
    /* see above */
  }
}
