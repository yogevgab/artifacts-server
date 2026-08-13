import type { Env } from "./env";

/**
 * API tokens — long-lived bearer credentials for server-to-server publishing
 * (Hermes Cloud, CI, scripts) that need to reach `/api` without a browser login.
 *
 * Only a SHA-256 hash of the token is ever stored. The plaintext is returned
 * exactly once, at creation, and is unrecoverable afterwards. Because the secret
 * is 256 bits of CSPRNG output (not a user-chosen password), a fast hash is the
 * right primitive: there is nothing to brute-force or dictionary-attack, so a
 * slow KDF would only add per-request latency. The lookup is an indexed equality
 * match on the hash, so no secret is ever compared byte-by-byte in the Worker.
 */

/** What an API token is allowed to do. Access-authenticated humans hold all of them. */
export const SCOPES = ["read", "publish", "manage"] as const;
export type Scope = (typeof SCOPES)[number];

/** Sensible default for a publishing integration: read + publish, no destructive rights. */
export const DEFAULT_SCOPES: Scope[] = ["read", "publish"];

export const MAX_TOKEN_NAME_LENGTH = 80;
export const MAX_EXPIRES_IN_DAYS = 365;

export interface ApiTokenRow {
  /** Public, non-secret identifier — safe to log, display, and revoke by. */
  id: string;
  name: string;
  /** The beta user this token acts as. NULL only for admin tokens. */
  owner_email: string | null;
  /** 1 = the token carries admin rights (manages every artifact). */
  is_admin: number;
  /** Comma-separated {@link Scope} list. */
  scopes: string;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/** An API token as returned by the API — never includes the hash or the secret. */
export type PublicApiToken = Omit<ApiTokenRow, "is_admin" | "scopes"> & {
  is_admin: boolean;
  scopes: Scope[];
};

const TOKEN_PREFIX = "rtfx";
const ID_BYTES = 6; // 12 hex chars — collision-safe as a display/revocation handle
const SECRET_BYTES = 32; // 256 bits of entropy

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * Mint a new token: `rtfx_<id>_<secret>`. The id is embedded so a leaked or
 * misbehaving token can be identified (and revoked) from the string alone,
 * without the secret ever being needed for lookup.
 */
export function generateToken(): { id: string; token: string } {
  const id = hex(randomBytes(ID_BYTES));
  return { id, token: `${TOKEN_PREFIX}_${id}_${base64url(randomBytes(SECRET_BYTES))}` };
}

/** The id embedded in a token string, or null if it isn't one of ours. */
export function tokenId(token: string): string | null {
  const m = new RegExp(`^${TOKEN_PREFIX}_([0-9a-f]{${ID_BYTES * 2}})_[A-Za-z0-9_-]{16,}$`).exec(token);
  return m ? m[1] : null;
}

/** SHA-256 of the full token string, hex-encoded — what we store and look up by. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return hex(new Uint8Array(digest));
}

/** Parse/validate a scope list. Returns null if anything isn't a known scope. */
export function parseScopes(raw: unknown): Scope[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Scope[] = [];
  for (const s of raw) {
    if (typeof s !== "string") return null;
    const scope = s.trim().toLowerCase();
    if (!(SCOPES as readonly string[]).includes(scope)) return null;
    if (!out.includes(scope as Scope)) out.push(scope as Scope);
  }
  return out;
}

/** Scopes stored on a row, ignoring anything unrecognized (forward-compatible). */
export function rowScopes(row: Pick<ApiTokenRow, "scopes">): Scope[] {
  return row.scopes
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
}

/** Is this token still good right now — not revoked, not expired? */
export function isTokenUsable(
  row: Pick<ApiTokenRow, "expires_at" | "revoked_at">,
  now: Date
): boolean {
  if (row.revoked_at) return false;
  if (row.expires_at && Date.parse(row.expires_at) <= now.getTime()) return false;
  return true;
}

export function toPublicToken(row: ApiTokenRow): PublicApiToken {
  const { is_admin, scopes, ...rest } = row;
  return { ...rest, is_admin: is_admin === 1, scopes: rowScopes(row) };
}

export interface CreateTokenInput {
  name: string;
  ownerEmail: string | null;
  isAdmin: boolean;
  scopes: Scope[];
  createdBy: string;
  /** ISO timestamp, or null for a token that never expires. */
  expiresAt: string | null;
  now: string;
}

/**
 * Create a token and return both the row and the one-time plaintext secret.
 * The caller is responsible for having authorized the owner/admin fields.
 */
export async function createApiToken(
  env: Env,
  input: CreateTokenInput
): Promise<{ token: string; row: ApiTokenRow }> {
  const { id, token } = generateToken();
  const row: ApiTokenRow = {
    id,
    name: input.name,
    owner_email: input.ownerEmail ? input.ownerEmail.trim().toLowerCase() : null,
    is_admin: input.isAdmin ? 1 : 0,
    scopes: input.scopes.join(","),
    created_by: input.createdBy,
    created_at: input.now,
    last_used_at: null,
    expires_at: input.expiresAt,
    revoked_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO api_tokens
       (id, token_hash, name, owner_email, is_admin, scopes, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.id,
      await hashToken(token),
      row.name,
      row.owner_email,
      row.is_admin,
      row.scopes,
      row.created_by,
      row.created_at,
      row.expires_at
    )
    .run();
  return { token, row };
}

const TOKEN_COLUMNS =
  "id, name, owner_email, is_admin, scopes, created_by, created_at, last_used_at, expires_at, revoked_at";

/** Look a token up by its plaintext, via the stored hash. Null if unknown. */
export async function findApiToken(env: Env, token: string): Promise<ApiTokenRow | null> {
  return env.DB.prepare(`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE token_hash = ?`)
    .bind(await hashToken(token))
    .first<ApiTokenRow>();
}

/** All tokens (admin view), or just one owner's. Never returns hashes. */
export async function listApiTokens(env: Env, ownerEmail?: string): Promise<ApiTokenRow[]> {
  const stmt = ownerEmail
    ? env.DB.prepare(
        `SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE lower(owner_email) = ? ORDER BY created_at DESC`
      ).bind(ownerEmail.trim().toLowerCase())
    : env.DB.prepare(`SELECT ${TOKEN_COLUMNS} FROM api_tokens ORDER BY created_at DESC`);
  const { results } = await stmt.all<ApiTokenRow>();
  return results ?? [];
}

export async function getApiToken(env: Env, id: string): Promise<ApiTokenRow | null> {
  return env.DB.prepare(`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE id = ?`)
    .bind(id)
    .first<ApiTokenRow>();
}

/**
 * Revoke a token. Revocation is a tombstone rather than a delete so the audit
 * trail (who created it, when it was last used) survives. Already-revoked
 * tokens keep their original revocation time.
 */
export async function revokeApiToken(env: Env, id: string, now: string): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"
  )
    .bind(now, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Only refresh `last_used_at` this often, so auth stays one read for busy tokens. */
export const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function needsTouch(row: ApiTokenRow, now: Date): boolean {
  if (!row.last_used_at) return true;
  const last = Date.parse(row.last_used_at);
  return !Number.isFinite(last) || now.getTime() - last >= TOUCH_INTERVAL_MS;
}

/** Record that a token was used. Never throws — auth must not fail on a write. */
export async function touchApiToken(env: Env, id: string, now: string): Promise<void> {
  try {
    await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(now, id).run();
  } catch {
    // Usage tracking is best-effort.
  }
}

/** Drop every token belonging to an email (when a user is removed from the beta). */
export async function revokeTokensForEmail(env: Env, email: string, now: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE api_tokens SET revoked_at = ? WHERE lower(owner_email) = ? AND revoked_at IS NULL"
  )
    .bind(now, email.trim().toLowerCase())
    .run();
}
