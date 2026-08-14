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
  owner_email     TEXT,
  -- Owning account/workspace (issue #27). Nullable: a row with only owner_email
  -- is authorized exactly as it was before accounts existed.
  account_id      TEXT
);

CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_owner ON artifacts (owner_email);
CREATE INDEX IF NOT EXISTS idx_artifacts_account ON artifacts (account_id);

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

-- Local user directory: product state above the Cloudflare Access allow-list.
-- Access remains the authentication source of truth; `role` here is a record of
-- the configured role and never grants privilege (ADMIN_EMAILS /
-- SUPER_ADMIN_EMAILS do). `status` is authoritative — 'disabled' is enforced by
-- the Worker on every request.
CREATE TABLE IF NOT EXISTS users (
  email        TEXT PRIMARY KEY,
  role         TEXT NOT NULL DEFAULT 'member',
  status       TEXT NOT NULL DEFAULT 'invited',
  display_name TEXT,
  notes        TEXT,
  invited_by   TEXT,
  invited_at   TEXT,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  disabled_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);

-- Bearer credentials for server-to-server publishing. Only the SHA-256 hash of
-- the token is stored; `id` is the non-secret handle embedded in the token
-- string (rtfx_<id>_<secret>).
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  owner_email  TEXT,
  -- The workspace this credential acts inside (issue #27). NULL for a legacy or
  -- admin/platform token.
  account_id   TEXT,
  is_admin     INTEGER NOT NULL DEFAULT 0,
  scopes       TEXT NOT NULL DEFAULT 'read,publish',
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_owner ON api_tokens (owner_email);
CREATE INDEX IF NOT EXISTS idx_api_tokens_account ON api_tokens (account_id);

-- Accounts / workspaces / organizations (issue #27): the product container that
-- OWNS artifacts, tokens, settings and — later — a plan.
--
-- Kept strictly apart from platform authority. An account role (`owner` down to
-- `viewer`, in account_members below) reaches exactly one workspace's data.
-- Operator authority over the whole instance comes from ADMIN_EMAILS /
-- SUPER_ADMIN_EMAILS only and is never stored in any table, so no write here can
-- escalate anybody. See src/accounts.ts.
CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  -- 'personal' (one auto-provisioned workspace per identity) | 'team'.
  kind           TEXT NOT NULL DEFAULT 'personal',
  status         TEXT NOT NULL DEFAULT 'active',
  plan           TEXT NOT NULL DEFAULT 'free',
  -- For kind='personal', the identity it belongs to. UNIQUE, which is what makes
  -- both the backfill and `ensurePersonalAccount` idempotent and race-safe.
  personal_email TEXT UNIQUE,
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_kind ON accounts (kind);

-- Membership: identity × account × ACCOUNT role.
CREATE TABLE IF NOT EXISTS account_members (
  account_id TEXT NOT NULL,
  email      TEXT NOT NULL,
  -- 'owner' | 'admin' | 'member' | 'viewer'. Workspace-scoped, never platform.
  role       TEXT NOT NULL DEFAULT 'member',
  status     TEXT NOT NULL DEFAULT 'active',
  invited_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, email)
);

CREATE INDEX IF NOT EXISTS idx_account_members_email ON account_members (email);
-- Delivery outcomes for transactional email, so "why didn't they get it" is
-- answerable from data instead of from reading source.
-- See docs/superpowers/specs/2026-08-14-app-owned-identity-design.md §7.
CREATE TABLE IF NOT EXISTS mail_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_log_email ON mail_log (email, created_at DESC);
-- Sign-in challenges. One row serves both the typed 6-digit code and the
-- magic-link token: redeeming either consumes the row, so a link never
-- outlives its code as a second invisible credential.
-- See docs/superpowers/specs/2026-08-14-app-owned-identity-design.md §9.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  purpose      TEXT NOT NULL,
  slug         TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_challenges_email ON auth_challenges (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_token ON auth_challenges (token_hash);
