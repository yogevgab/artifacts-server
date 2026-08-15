/**
 * OAuth 2.1 authorization-server primitives for the remote MCP endpoint.
 *
 * This module is the *logic and storage* half of `claude mcp login`; the HTTP
 * surface is `src/oauth-routes.ts`. See docs/REMOTE_MCP_OAUTH.md for the design
 * and for exactly how far it has got.
 *
 * Three rules hold everything else together:
 *
 *  1. **The access token is an ordinary `api_tokens` row.** An OAuth grant ends
 *     in `createApiToken` with a short expiry and the consented scopes, so
 *     `requireApiToken`, `requireScope`, the paused-account check and
 *     revoke-on-user-removal all apply with no second authorization path to keep
 *     in step. A leaked OAuth token is exactly as dangerous as a leaked
 *     dashboard token, and no more.
 *  2. **Only hashes are stored.** Authorization codes and refresh tokens are
 *     256 bits of CSPRNG output, stored as SHA-256 hex exactly the way
 *     `api_tokens` stores its secret (src/tokens.ts). Nothing here can hand back
 *     a credential it was given.
 *  3. **A registration grants nothing.** `POST /oauth/register` is necessarily
 *     unauthenticated, so a `client_id` is a name and not a permission: every
 *     credential this module issues passes through a human consent POST first.
 */

import type { Env } from "./env";
import type { Scope } from "./tokens";

// --- Well-known paths --------------------------------------------------------

/**
 * RFC 9728 protected-resource metadata for `/mcp`.
 *
 * The path is the resource's path inserted after the well-known segment, which
 * is what a client derives from the resource identifier `https://<host>/mcp`.
 * Declared here rather than in `oauth-routes.ts` so `src/mcp.ts` can name it in
 * its `WWW-Authenticate` challenge without importing the route module — the
 * challenge and the document must never be able to drift apart.
 */
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource/mcp";

/** RFC 8414 authorization-server metadata. */
export const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";

// --- Scopes ------------------------------------------------------------------

/**
 * The OAuth scope vocabulary, mapped onto the three internal scopes that already
 * exist rather than inventing a parallel one. The mapping is total and
 * one-directional: an OAuth scope this table does not name cannot be consented
 * to, and therefore cannot reach a token row.
 */
export const OAUTH_SCOPE_MAP = {
  "rtfx:read": "read",
  "rtfx:publish": "publish",
  "rtfx:manage": "manage",
} as const satisfies Record<string, Scope>;

export type OAuthScope = keyof typeof OAUTH_SCOPE_MAP;

export const OAUTH_SCOPES_SUPPORTED = Object.keys(OAUTH_SCOPE_MAP) as OAuthScope[];

/**
 * What a client gets when it asks for nothing. `rtfx:manage` is deliberately
 * absent — it is never in a default and always gets its own line on the consent
 * screen, matching why the stdio server keeps `update_access` behind a flag.
 */
export const DEFAULT_OAUTH_SCOPES: OAuthScope[] = ["rtfx:read", "rtfx:publish"];

/**
 * How each scope is described to the person granting it. Product terms, never
 * bare tokens: somebody clicking "Allow" has to be able to tell what they just
 * agreed to without reading this file.
 */
export const OAUTH_SCOPE_COPY: Record<OAuthScope, { title: string; detail: string }> = {
  "rtfx:read": {
    title: "See your artifacts",
    detail: "List the artifacts and versions your account can already open.",
  },
  "rtfx:publish": {
    title: "Publish and update artifacts",
    detail: "Create new artifacts and add versions to ones you own.",
  },
  "rtfx:manage": {
    title: "Manage access and delete artifacts",
    detail: "Change who can open an artifact, roll versions back, and delete artifacts.",
  },
};

export function isOAuthScope(raw: unknown): raw is OAuthScope {
  return typeof raw === "string" && (OAUTH_SCOPES_SUPPORTED as string[]).includes(raw);
}

/**
 * Parse a space-delimited `scope` parameter. Returns null when anything in it is
 * not a scope we support — never a filtered subset, because silently dropping a
 * scope would show the person a consent screen that does not describe what the
 * client asked for.
 */
export function parseOAuthScopes(raw: unknown): OAuthScope[] | null {
  if (raw === undefined || raw === null || raw === "") return [...DEFAULT_OAUTH_SCOPES];
  if (typeof raw !== "string") return null;
  const parts = raw.split(/[\s+]+/).filter(Boolean);
  if (!parts.length) return null;
  const out: OAuthScope[] = [];
  for (const part of parts) {
    if (!isOAuthScope(part)) return null;
    if (!out.includes(part)) out.push(part);
  }
  return out;
}

/** The internal scopes an OAuth scope list maps to. */
export function toInternalScopes(scopes: OAuthScope[]): Scope[] {
  return scopes.map((s) => OAUTH_SCOPE_MAP[s]);
}

// --- Random values, hashes, PKCE ---------------------------------------------

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** SHA-256, hex-encoded — what every secret in this module is stored as. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return hex(new Uint8Array(digest));
}

/** SHA-256, base64url-encoded — the PKCE `S256` transform (RFC 7636 §4.2). */
export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** A `code_challenge` is 43–128 characters of the unreserved URI set (RFC 7636 §4.2). */
const PKCE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeChallenge(raw: unknown): raw is string {
  return typeof raw === "string" && PKCE_RE.test(raw);
}

/** Same alphabet and length bounds as the challenge (RFC 7636 §4.1). */
export function isValidCodeVerifier(raw: unknown): raw is string {
  return typeof raw === "string" && PKCE_RE.test(raw);
}

/**
 * Constant-time-ish string comparison. Both operands here are hex/base64url
 * digests of the same length, so the early length exit leaks nothing an attacker
 * does not already know.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newClientId(): string {
  return `oc_${hex(randomBytes(16))}`;
}

/** An authorization code: 256 bits, opaque, never stored in plaintext. */
export function newAuthorizationCode(): string {
  return base64url(randomBytes(32));
}

/**
 * A refresh token. Prefixed so an operator finding one in a log can tell what it
 * is — and so it can never be confused with an `rtfx_…` access token, which has
 * an entirely different verification path.
 */
export function newRefreshToken(): string {
  return `rtfxr_${base64url(randomBytes(32))}`;
}

export function isRefreshTokenShape(raw: string): boolean {
  return /^rtfxr_[A-Za-z0-9_-]{16,}$/.test(raw);
}

// --- Redirect URIs -----------------------------------------------------------

export const MAX_REDIRECT_URIS = 5;
export const MAX_REDIRECT_URI_LENGTH = 512;
export const MAX_CLIENT_NAME_LENGTH = 120;

/** Loopback hosts a native/CLI client may listen on (RFC 8252 §7.3). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Normalize one redirect URI, or return null if it is not one we will ever
 * redirect to.
 *
 * This is the function this whole feature's safety rests on, so it is a
 * *allow-list of two shapes* rather than a list of things to reject:
 *
 *  - `https://…` — anything else on the web is refused outright, so `http://`
 *    to a public host (which would put an authorization code on the wire in
 *    clear) cannot be registered.
 *  - `http://` to a loopback host — the only way a CLI like Claude Code can
 *    receive a callback, and safe precisely because the request never leaves the
 *    machine.
 *
 * A wildcard, a fragment, embedded credentials, or any other scheme
 * (`javascript:`, `data:`, `file:`, a custom app scheme) is refused. There is no
 * prefix or substring matching anywhere: the normalized string returned here is
 * what gets stored, and `/oauth/authorize` compares the presented URI to it with
 * `===`.
 */
export function normalizeRedirectUri(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_REDIRECT_URI_LENGTH) return null;
  // A wildcard is never legal here, in any position — checked on the raw string
  // so an encoded one cannot slip past the URL parser's normalization.
  if (/[*\s]/.test(value)) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hash) return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;

  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return url.toString();
  return null;
}

/**
 * Validate a whole `redirect_uris` array. Returns the normalized list, or an
 * RFC 7591 error code describing why it was refused.
 */
export function normalizeRedirectUris(
  raw: unknown
): { uris: string[] } | { error: string; detail: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "invalid_redirect_uri", detail: "redirect_uris must be a non-empty array" };
  }
  if (raw.length > MAX_REDIRECT_URIS) {
    return {
      error: "invalid_redirect_uri",
      detail: `at most ${MAX_REDIRECT_URIS} redirect_uris may be registered`,
    };
  }
  const uris: string[] = [];
  for (const entry of raw) {
    const normalized = normalizeRedirectUri(entry);
    if (!normalized) {
      return {
        error: "invalid_redirect_uri",
        detail:
          "each redirect_uri must be an absolute https URL, or an http URL on 127.0.0.1/localhost, " +
          "with no wildcard, fragment or embedded credentials",
      };
    }
    if (!uris.includes(normalized)) uris.push(normalized);
  }
  return { uris };
}

// --- Storage -----------------------------------------------------------------

/** How long an authorization code is good for. Long enough for one redirect. */
export const AUTH_CODE_TTL_SECONDS = 60;

/** Access-token lifetime. Short, because a refresh token exists to extend it. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** Refresh-token lifetime. Rotated on every use; this is the outer bound. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface OAuthClientRow {
  client_id: string;
  client_name: string;
  /** JSON array of exact-match redirect URIs. */
  redirect_uris: string;
  scope: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface OAuthClient extends Omit<OAuthClientRow, "redirect_uris"> {
  redirectUris: string[];
}

/**
 * True when D1 reports the OAuth tables are missing — i.e. the Worker is ahead
 * of migration 0019. Every caller turns this into a clean `503 not_configured`
 * rather than a 500, the same way `tokens.ts` degrades when `account_id` has not
 * been added yet.
 */
export function isMissingOAuthTable(e: unknown): boolean {
  return e instanceof Error && /no such table: oauth_/i.test(e.message);
}

function parseClient(row: OAuthClientRow): OAuthClient | null {
  let redirectUris: unknown;
  try {
    redirectUris = JSON.parse(row.redirect_uris);
  } catch {
    return null;
  }
  if (!Array.isArray(redirectUris) || !redirectUris.every((u) => typeof u === "string")) return null;
  const { redirect_uris: _ignored, ...rest } = row;
  return { ...rest, redirectUris: redirectUris as string[] };
}

export async function createOAuthClient(
  env: Env,
  input: { clientName: string; redirectUris: string[]; scope: string | null; now: string }
): Promise<OAuthClient> {
  const clientId = newClientId();
  await env.DB.prepare(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, scope, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(clientId, input.clientName, JSON.stringify(input.redirectUris), input.scope, input.now)
    .run();
  return {
    client_id: clientId,
    client_name: input.clientName,
    redirectUris: input.redirectUris,
    scope: input.scope,
    created_at: input.now,
    last_used_at: null,
  };
}

export async function getOAuthClient(env: Env, clientId: string): Promise<OAuthClient | null> {
  if (!clientId) return null;
  const row = await env.DB.prepare(
    `SELECT client_id, client_name, redirect_uris, scope, created_at, last_used_at
       FROM oauth_clients WHERE client_id = ?`
  )
    .bind(clientId)
    .first<OAuthClientRow>();
  return row ? parseClient(row) : null;
}

/** Best-effort usage stamp. Never throws — a grant must not fail on a write. */
export async function touchOAuthClient(env: Env, clientId: string, now: string): Promise<void> {
  try {
    await env.DB.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?")
      .bind(now, clientId)
      .run();
  } catch {
    // Usage tracking is best-effort.
  }
}

export interface AuthorizationCodeInput {
  clientId: string;
  email: string;
  accountId: string | null;
  scopes: OAuthScope[];
  resource: string;
  redirectUri: string;
  codeChallenge: string;
  now: string;
}

export interface OAuthCodeRow {
  code_hash: string;
  client_id: string;
  email: string;
  account_id: string | null;
  scopes: string;
  resource: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

/** Mint an authorization code, storing only its hash. Returns the plaintext once. */
export async function createAuthorizationCode(
  env: Env,
  input: AuthorizationCodeInput
): Promise<string> {
  const code = newAuthorizationCode();
  const expiresAt = new Date(
    Date.parse(input.now) + AUTH_CODE_TTL_SECONDS * 1000
  ).toISOString();
  await env.DB.prepare(
    `INSERT INTO oauth_codes
       (code_hash, client_id, email, account_id, scopes, resource, redirect_uri,
        code_challenge, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      await sha256Hex(code),
      input.clientId,
      input.email,
      input.accountId,
      input.scopes.join(" "),
      input.resource,
      input.redirectUri,
      input.codeChallenge,
      expiresAt,
      input.now
    )
    .run();
  // Opportunistic sweep: codes live 60 seconds, so this keeps the table from
  // growing without a scheduled job. Cheap — the rows are gone almost as soon as
  // they appear.
  await env.DB.prepare("DELETE FROM oauth_codes WHERE expires_at < ?")
    .bind(new Date(Date.parse(input.now) - 60 * 60 * 1000).toISOString())
    .run();
  return code;
}

/**
 * Claim an authorization code: look it up by hash and mark it consumed in one
 * conditional UPDATE, so two simultaneous redemptions cannot both succeed.
 * Returns the row only to the caller that actually won the update.
 */
export async function claimAuthorizationCode(
  env: Env,
  code: string,
  now: string
): Promise<OAuthCodeRow | "unknown" | "replayed" | "expired"> {
  const hash = await sha256Hex(code);
  const row = await env.DB.prepare(
    `SELECT code_hash, client_id, email, account_id, scopes, resource, redirect_uri,
            code_challenge, expires_at, consumed_at, created_at
       FROM oauth_codes WHERE code_hash = ?`
  )
    .bind(hash)
    .first<OAuthCodeRow>();
  if (!row) return "unknown";
  if (row.consumed_at) return "replayed";
  if (Date.parse(row.expires_at) <= Date.parse(now)) return "expired";

  const res = await env.DB.prepare(
    "UPDATE oauth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL"
  )
    .bind(now, hash)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return "replayed";
  return row;
}

export interface OAuthRefreshRow {
  id: string;
  token_hash: string;
  client_id: string;
  email: string;
  account_id: string | null;
  scopes: string;
  resource: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export async function createRefreshToken(
  env: Env,
  input: {
    clientId: string;
    email: string;
    accountId: string | null;
    scopes: OAuthScope[];
    resource: string;
    now: string;
  }
): Promise<string> {
  const token = newRefreshToken();
  await env.DB.prepare(
    `INSERT INTO oauth_refresh_tokens
       (id, token_hash, client_id, email, account_id, scopes, resource, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      hex(randomBytes(8)),
      await sha256Hex(token),
      input.clientId,
      input.email,
      input.accountId,
      input.scopes.join(" "),
      input.resource,
      input.now,
      new Date(Date.parse(input.now) + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString()
    )
    .run();
  return token;
}

export async function findRefreshToken(env: Env, token: string): Promise<OAuthRefreshRow | null> {
  return env.DB.prepare(
    `SELECT id, token_hash, client_id, email, account_id, scopes, resource,
            created_at, last_used_at, expires_at, revoked_at
       FROM oauth_refresh_tokens WHERE token_hash = ?`
  )
    .bind(await sha256Hex(token))
    .first<OAuthRefreshRow>();
}

export function isRefreshUsable(row: OAuthRefreshRow, now: string): boolean {
  if (row.revoked_at) return false;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.parse(now)) return false;
  return true;
}

/** Revoke one refresh token by id. Returns true when it was live before this. */
export async function revokeRefreshToken(env: Env, id: string, now: string): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"
  )
    .bind(now, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Scopes stored on a code/refresh row, ignoring anything no longer recognized. */
export function rowOAuthScopes(raw: string): OAuthScope[] {
  return raw.split(/\s+/).filter(isOAuthScope);
}

/**
 * Stamp an `api_tokens` row as OAuth-issued.
 *
 * Done as a follow-up UPDATE rather than by widening `createApiToken`, so the
 * dashboard's token-minting path is untouched by this feature. Best-effort: on
 * an instance that has not run migration 0019 the columns do not exist, and a
 * missing badge must not fail a grant that is otherwise complete.
 */
export async function markTokenIssuedViaOAuth(
  env: Env,
  tokenId: string,
  clientId: string
): Promise<void> {
  try {
    await env.DB.prepare(
      "UPDATE api_tokens SET issued_via = 'oauth', oauth_client_id = ? WHERE id = ?"
    )
      .bind(clientId, tokenId)
      .run();
  } catch {
    // Pre-0019 instance: the badge is cosmetic, the grant is not.
  }
}
