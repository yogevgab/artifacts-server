-- OAuth 2.1 authorization server for the remote MCP endpoint (slice 1).
--
-- Everything here is additive: three new tables and two nullable columns on
-- `api_tokens`. An instance that has not run this migration keeps working
-- exactly as it did — the OAuth routes answer `503 temporarily_unavailable`
-- (see `isMissingOAuthTable` in src/oauth.ts), `markTokenIssuedViaOAuth` fails
-- soft, and the bearer-token path that has always served `/mcp` is untouched.
--
-- ⚠️ The three CREATE TABLEs are idempotent; the two ALTERs at the bottom are
-- NOT. SQLite (and therefore D1) has no `ALTER TABLE ... ADD COLUMN IF NOT
-- EXISTS`, so re-running them against a database that already has the columns
-- fails with "duplicate column name". `wrangler d1 migrations apply` records
-- each migration and runs it once, so this only bites a hand-applied re-run —
-- the same caveat 0009 and 0018 carry. Check before re-applying by hand:
--
--   wrangler d1 execute rtfx --remote --command "PRAGMA table_info(api_tokens)"
--
-- A "duplicate column name" error here is benign: the schema is already correct.
-- A fresh database built from schema.sql gets both columns inline in the
-- `api_tokens` CREATE TABLE instead, so that file stays re-runnable.
--
-- The load-bearing decision this schema encodes: there is NO access-token table.
-- An OAuth access token is an ordinary `api_tokens` row with a one-hour expiry
-- and the consented scopes, so `requireApiToken`, `requireScope`, the
-- paused-account check and revoke-on-user-removal all apply to it without a
-- second authorization path to keep in step. `issued_via` and `oauth_client_id`
-- exist so a person can *see* which of their tokens an application asked for.
--
-- Only hashes are stored, exactly as `api_tokens` stores its secret.

-- Registered OAuth clients (RFC 7591 dynamic registration).
--
-- Public clients only: there is no `client_secret` column because none is ever
-- issued. Registration is necessarily unauthenticated — Claude Code cannot be
-- pre-registered — which is why a row here grants nothing on its own. A
-- `client_id` is a name; every credential is minted by a signed-in human
-- clicking Allow.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  -- JSON array of exact-match redirect URIs. Exact match only: no wildcards, no
  -- prefix tests, no substring tests. See `normalizeRedirectUri` in src/oauth.ts.
  redirect_uris TEXT NOT NULL,
  -- The scopes this client says it wants. Advisory — the authorization request
  -- is what actually decides, and the person consenting is what grants.
  scope         TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);

-- Authorization codes. Sixty-second lifetime, single use, PKCE-bound.
--
-- `consumed_at` is set by a conditional UPDATE inside the redemption, so two
-- simultaneous exchanges of the same code cannot both succeed. Rows are swept
-- opportunistically on each mint rather than by a scheduled job.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  email          TEXT NOT NULL,
  -- The workspace the resulting token will act inside. NULL only when the
  -- account tables are unavailable, which is the legacy owner_email path.
  account_id     TEXT,
  scopes         TEXT NOT NULL,
  -- RFC 8707 audience: the `/mcp` URL on the host this grant was made against.
  resource       TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  -- S256 only. The authorization endpoint refuses any other method, so a
  -- `plain` challenge is not a state this column can hold.
  code_challenge TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  consumed_at    TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes (expires_at);

-- Refresh tokens. Rotated on every use: redeeming one revokes it and issues a
-- replacement, so a stolen refresh token is usable at most once.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  client_id    TEXT NOT NULL,
  email        TEXT NOT NULL,
  account_id   TEXT,
  scopes       TEXT NOT NULL,
  resource     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_email ON oauth_refresh_tokens (email);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_client ON oauth_refresh_tokens (client_id);

-- Provenance on the token rows themselves. Nullable with no default, so every
-- existing row reads exactly as it did before this migration ran: NULL means
-- "minted in the dashboard", which is what every pre-OAuth token was.
ALTER TABLE api_tokens ADD COLUMN issued_via TEXT;
ALTER TABLE api_tokens ADD COLUMN oauth_client_id TEXT;
