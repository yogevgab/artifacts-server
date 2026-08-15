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
  account_id      TEXT,
  -- Read receipts (migration 0016): notify the owner the first time a named
  -- person opens this artifact. Default ON; an explicit 0 turns it off.
  read_receipts   INTEGER NOT NULL DEFAULT 1
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

-- "Talk to us" requests from /contact and the Team/Enterprise pricing buttons.
-- No UNIQUE on email: the same person may ask twice, about two different things.
CREATE TABLE IF NOT EXISTS contact_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  plan       TEXT,
  message    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_requests_created ON contact_requests (created_at DESC);

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
  revoked_at   TEXT,
  -- Provenance (migration 0019). NULL means "minted in the dashboard", which is
  -- what every pre-OAuth token was; 'oauth' means this row is an OAuth access
  -- token, and is the only kind /oauth/revoke will revoke.
  issued_via   TEXT,
  oauth_client_id TEXT
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
  updated_at     TEXT NOT NULL,
  -- Operator control plane (migration 0018). `plan` above stays what BILLING
  -- says; `plan_override` is what the OPERATOR says, and because they are
  -- different columns a Lemon Squeezy webhook physically cannot clobber a live
  -- override. `effectivePlan` (src/accounts.ts) is the only place the two are
  -- combined. A NULL/expired override is inert, so a comp that ran out needs no
  -- cron job to stop applying.
  plan_override            TEXT,
  plan_override_expires_at TEXT,
  plan_override_note       TEXT,
  plan_override_by         TEXT,
  plan_override_at         TEXT,
  -- Internal operator notes. Never shown to the customer.
  notes                    TEXT,
  -- Suspension metadata. `status` above is authoritative; these record who,
  -- why and when so an unsuspend is answerable rather than mysterious.
  suspended_at             TEXT,
  suspended_by             TEXT,
  suspended_reason         TEXT
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
-- Bearer capability URLs: a link an owner can paste anywhere, which opens one
-- artifact for whoever holds it. Deliberately separate from artifact_grants —
-- a grant names a person, a share link names nobody, and the view log must be
-- able to tell those apart.
-- See docs/superpowers/specs/2026-08-14-app-owned-identity-design.md §6.4.
CREATE TABLE IF NOT EXISTS share_links (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  expires_at  TEXT,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_share_links_slug ON share_links (slug);
-- Free-tier retention: versions outside the window are marked expired and
-- their bytes removed from R2, but the row stays so the history remains
-- honest — "v2 existed and is gone" beats a hole in the numbering.
ALTER TABLE artifact_versions ADD COLUMN expired_at TEXT;

-- Lemon Squeezy billing: idempotency ledger for webhook deliveries.
-- accounts.plan (0008) stays the single source of truth for what an account
-- may do; this table exists only so a retried webhook delivery — Lemon
-- Squeezy retries on anything but a fast 200 — is a no-op rather than a
-- second write. See src/billing.ts for how `id` is derived: Lemon Squeezy's
-- webhook payload carries no documented, stable per-delivery id, so `id` is a
-- SHA-256 of the raw request body, which is byte-identical across retries of
-- the same delivery and differs for any genuinely new event (even one for the
-- same subscription).
CREATE TABLE IF NOT EXISTS billing_events (
  id           TEXT PRIMARY KEY,
  event_name   TEXT NOT NULL,
  -- The account this event was attributed to, or NULL when the webhook body
  -- carried no (or an unresolvable) account id — still recorded, so a
  -- delivery Lemon Squeezy retries because we returned 200 late doesn't get
  -- looked at twice.
  account_id   TEXT,
  processed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_events_account ON billing_events (account_id);
-- Operator audit trail (migration 0018). Append-only: nothing in the product
-- UPDATEs or DELETEs a row here, which is what makes "append-only" a fact
-- rather than a promise. Every operator control that changes what an account
-- may do writes here in the SAME D1 batch as the change itself, so an
-- unaudited override is not a state this schema can reach.
CREATE TABLE IF NOT EXISTS admin_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NULL only for a system actor (the billing webhook), which records itself
  -- as `actor_role = 'system'` instead.
  actor_email  TEXT,
  actor_role   TEXT,
  -- Dotted, stable, machine-readable: 'account.suspended'. `summary` is the
  -- sentence a human reads.
  action       TEXT NOT NULL,
  -- 'account' | 'user' | 'artifact' — what `target_id` names.
  target_type  TEXT NOT NULL,
  target_id    TEXT,
  summary      TEXT,
  -- JSON: whatever the action needs (before/after plan, expiry, reason).
  detail       TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target
  ON admin_audit (target_type, target_id, created_at DESC);

-- OAuth 2.1 authorization server for the remote MCP endpoint (migration 0019).
-- There is deliberately NO access-token table: an OAuth access token is an
-- ordinary `api_tokens` row with a one-hour expiry and the consented scopes, so
-- every gate that already guards a bearer credential guards this one too. See
-- docs/REMOTE_MCP_OAUTH.md and src/oauth.ts.
--
-- Public clients only — no `client_secret` column, because none is ever issued.
-- Registration is unauthenticated by necessity (Claude Code cannot be
-- pre-registered), so a row here grants nothing on its own.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  -- JSON array of exact-match redirect URIs. No wildcards, no prefix matching.
  redirect_uris TEXT NOT NULL,
  scope         TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);

-- Authorization codes: 60-second lifetime, single use, PKCE (S256) bound.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  email          TEXT NOT NULL,
  account_id     TEXT,
  scopes         TEXT NOT NULL,
  -- RFC 8707 audience — the `/mcp` URL this grant was made against.
  resource       TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  consumed_at    TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes (expires_at);

-- Refresh tokens, rotated on every use: redeeming one revokes it and issues a
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

-- The provenance columns 0019 adds to `api_tokens` are declared inline in that
-- table above, not repeated here as ALTERs: this file builds a database from
-- nothing, and an ALTER against a table it just created with those columns would
-- fail with "duplicate column name". The migration file has the ALTER form,
-- because it is applied to a database that already has the table.
