-- First-class API tokens: bearer credentials for server-to-server publishing
-- (Hermes Cloud, CI, scripts) that can't do an interactive Cloudflare Access login.
--
-- Only the SHA-256 hash of the token is stored, so a database leak yields no
-- usable credential. `id` is the non-secret handle embedded in the token string
-- (rtfx_<id>_<secret>) and is what tokens are listed and revoked by.
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  -- The beta user this token acts as (issue #7 ownership). NULL only for admin
  -- tokens, which manage every artifact.
  owner_email  TEXT,
  is_admin     INTEGER NOT NULL DEFAULT 0,
  -- Comma-separated subset of: read, publish, manage.
  scopes       TEXT NOT NULL DEFAULT 'read,publish',
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  -- Revocation is a tombstone, not a delete, so the audit trail survives.
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_owner ON api_tokens (owner_email);
