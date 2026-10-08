/**
 * Share links: a URL an owner can paste into Slack, an email, a ticket.
 *
 * Deliberately a different thing from a grant. A grant names a person and
 * survives them changing devices; a link names nobody and works for whoever
 * holds it. Both are legitimate — "send this to the client" and "let Dana in"
 * are different asks — but they must never be confused, which is why they live
 * in separate tables and why a link view is never attributed to a person: it is
 * logged in the view log with `link_id` set and no email (unless the visitor
 * happens to hold a session too), and the owner sees it as "Someone with a
 * link". The read-receipt email is for named people only and never fires for a
 * link. Public copy must say so — see /docs#access and /privacy.
 *
 * The URL *is* the credential. So: only a hash is stored, revocation is
 * immediate, expiry is optional but supported, and a link opens exactly one
 * artifact.
 */

import type { Env } from "./env";
import { hashToken } from "./tokens";

export interface ShareLink {
  id: string;
  slug: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** What `createShareLink` returns. `key` is shown once and never stored. */
export interface IssuedShareLink extends ShareLink {
  /** `<id>.<secret>` — the whole credential. */
  key: string;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

interface Row {
  id: string;
  slug: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

const toLink = (r: Row): ShareLink => ({
  id: r.id,
  slug: r.slug,
  createdBy: r.created_by,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  lastUsedAt: r.last_used_at,
});

export async function createShareLink(
  env: Env,
  o: { slug: string; createdBy: string; now: string; expiresAt?: string | null }
): Promise<IssuedShareLink> {
  const id = hex(crypto.getRandomValues(new Uint8Array(8)));
  const secret = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const key = `${id}.${secret}`;

  await env.DB.prepare(
    `INSERT INTO share_links (id, slug, token_hash, created_by, expires_at, revoked_at, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`
  )
    .bind(id, o.slug, await hashToken(key), o.createdBy, o.expiresAt ?? null, o.now)
    .run();

  return {
    id,
    slug: o.slug,
    createdBy: o.createdBy,
    createdAt: o.now,
    expiresAt: o.expiresAt ?? null,
    revokedAt: null,
    lastUsedAt: null,
    key,
  };
}

/**
 * Resolve a presented key, or null.
 *
 * The id is looked up first and the hash compared second, so a wrong secret for
 * a real id and a fabricated id take the same path and produce the same answer.
 * Reusable by design — this is a capability URL, not a one-time code.
 */
export async function redeemShareLink(
  env: Env,
  key: string,
  now: string
): Promise<ShareLink | null> {
  const dot = key.indexOf(".");
  if (dot <= 0) return null;
  const id = key.slice(0, dot);

  const row = await env.DB.prepare(
    `SELECT id, slug, created_by, created_at, expires_at, revoked_at, last_used_at
       FROM share_links
      WHERE id = ? AND token_hash = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)`
  )
    .bind(id, await hashToken(key), now)
    .first<Row>();

  if (!row) return null;

  // Best-effort, like `api_tokens.last_used_at`: an owner wants to know whether
  // a link they handed out is being used, but not at the cost of a failed view.
  try {
    await env.DB.prepare("UPDATE share_links SET last_used_at = ? WHERE id = ?").bind(now, id).run();
  } catch {
    /* ignore */
  }

  return toLink(row);
}

export type ShareLinkState = "valid" | "expired" | "revoked";

/**
 * Look a presented key up by hash REGARDLESS of validity, so a dead link can be
 * told apart from garbage. Unknown or malformed keys return null. Read-only —
 * unlike `redeemShareLink` it never touches `last_used_at`, and it grants
 * nothing: callers use it only to record an attempt.
 */
export async function inspectShareLink(
  env: Env,
  key: string,
  now: string
): Promise<{ link: ShareLink; state: ShareLinkState } | null> {
  const dot = key.indexOf(".");
  if (dot <= 0) return null;
  const row = await env.DB.prepare(
    `SELECT id, slug, created_by, created_at, expires_at, revoked_at, last_used_at
       FROM share_links WHERE id = ? AND token_hash = ?`
  )
    .bind(key.slice(0, dot), await hashToken(key))
    .first<Row>();
  if (!row) return null;
  const state: ShareLinkState = row.revoked_at
    ? "revoked"
    : row.expires_at && row.expires_at <= now
      ? "expired"
      : "valid";
  return { link: toLink(row), state };
}

export interface ShareLinkStats {
  /** Opens through the link (outcome 'viewed'); link-card previews are not counted. */
  views: number;
  lastViewedAt: string | null;
  /** Attempts after the link expired or was revoked. */
  expiredAttempts: number;
}

/** Per-link view stats for one artifact. Empty before migration 0023. */
export async function shareLinkStats(env: Env, slug: string): Promise<Map<string, ShareLinkStats>> {
  const map = new Map<string, ShareLinkStats>();
  try {
    const { results } = await env.DB.prepare(
      `SELECT link_id,
              SUM(CASE WHEN outcome = 'viewed' THEN 1 ELSE 0 END) AS views,
              MAX(CASE WHEN outcome = 'viewed' THEN viewed_at END) AS last_viewed_at,
              SUM(CASE WHEN outcome IN ('link_expired', 'link_revoked') THEN 1 ELSE 0 END) AS attempts
         FROM artifact_views WHERE slug = ? AND link_id IS NOT NULL GROUP BY link_id`
    )
      .bind(slug)
      .all<{ link_id: string; views: number; last_viewed_at: string | null; attempts: number }>();
    for (const r of results ?? []) {
      map.set(r.link_id, { views: r.views ?? 0, lastViewedAt: r.last_viewed_at, expiredAttempts: r.attempts ?? 0 });
    }
  } catch {
    /* pre-0023: no link_id column, so no stats */
  }
  return map;
}

/** Revoke immediately. Scoped by slug so a caller can only revoke their own artifact's links. */
export async function revokeShareLink(
  env: Env,
  slug: string,
  id: string,
  now: string
): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE share_links SET revoked_at = ? WHERE id = ? AND slug = ? AND revoked_at IS NULL"
  )
    .bind(now, id, slug)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Every link for an artifact. The secret is not stored, so it cannot leak from here. */
export async function listShareLinks(env: Env, slug: string): Promise<ShareLink[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, slug, created_by, created_at, expires_at, revoked_at, last_used_at
       FROM share_links WHERE slug = ? ORDER BY created_at DESC`
  )
    .bind(slug)
    .all<Row>();
  return (results ?? []).map(toLink);
}
