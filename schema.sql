CREATE TABLE IF NOT EXISTS artifacts (
  slug            TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT,
  type            TEXT NOT NULL,
  entry           TEXT NOT NULL DEFAULT 'index.html',
  file_count      INTEGER NOT NULL DEFAULT 1,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  visibility      TEXT NOT NULL DEFAULT 'restricted',
  current_version INTEGER NOT NULL DEFAULT 1,
  owner_email     TEXT
);

CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_owner ON artifacts (owner_email);

CREATE TABLE IF NOT EXISTS artifact_grants (
  slug       TEXT NOT NULL,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (slug, email)
);

CREATE INDEX IF NOT EXISTS idx_grants_slug ON artifact_grants (slug);

CREATE TABLE IF NOT EXISTS artifact_versions (
  slug        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  type        TEXT NOT NULL,
  entry       TEXT NOT NULL DEFAULT 'index.html',
  file_count  INTEGER NOT NULL DEFAULT 1,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (slug, version)
);

CREATE INDEX IF NOT EXISTS idx_versions_slug ON artifact_versions (slug, version DESC);

CREATE TABLE IF NOT EXISTS artifact_views (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  email      TEXT,
  path       TEXT,
  country    TEXT,
  referrer   TEXT,
  viewed_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_views_slug ON artifact_views (slug, viewed_at DESC);

CREATE TABLE IF NOT EXISTS waitlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Bearer credentials for server-to-server publishing. Only the SHA-256 hash of
-- the token is stored; `id` is the non-secret handle embedded in the token
-- string (rtfx_<id>_<secret>).
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  owner_email  TEXT,
  is_admin     INTEGER NOT NULL DEFAULT 0,
  scopes       TEXT NOT NULL DEFAULT 'read,publish',
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_owner ON api_tokens (owner_email);
