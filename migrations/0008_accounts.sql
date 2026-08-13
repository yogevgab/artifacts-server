-- Accounts + memberships (issue #27): the product container that owns artifacts,
-- tokens, settings and — later — a plan and billing.
--
-- Four concepts are deliberately separated from here on:
--
--   1. **Identity / user**  — a human email. Lives in `users`; authenticated by
--      Cloudflare Access. Says *who you are*.
--   2. **Account**          — the workspace/organization that OWNS things.
--      This table. Says *whose stuff it is*.
--   3. **Membership**       — (identity × account × account role). `account_members`
--      below. Says *what you may do inside one account*.
--   4. **Platform role**    — super_admin / admin operator authority over the whole
--      instance. Comes from ADMIN_EMAILS / SUPER_ADMIN_EMAILS **only** and is
--      deliberately NOT stored here. A row in this database can never make anybody
--      a platform admin (see src/users.ts `effectiveRole`, src/accounts.ts).
--
-- This migration is pure `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
-- EXISTS`, so it is fully idempotent and safe to re-run against a database whose
-- migration history has drifted.

-- An account is the owner of record. Every artifact and API token belongs to one
-- (once 0010 has backfilled); artifacts with a NULL account_id keep working on
-- the legacy `owner_email` path forever.
CREATE TABLE IF NOT EXISTS accounts (
  -- 'acct_<16 hex>'. Opaque on purpose: never derived from an email, so an id is
  -- safe to put in a URL, a log line, or an API response.
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  -- 'personal' — the auto-provisioned one-human workspace every identity gets.
  -- 'team'     — a shared workspace with more than one membership.
  kind           TEXT NOT NULL DEFAULT 'personal',
  -- 'active' | 'suspended'. Suspending an account is not implemented as an
  -- enforcement point yet; the column exists so adding it is not a migration.
  status         TEXT NOT NULL DEFAULT 'active',
  -- Billing plan placeholder. Read-only today.
  plan           TEXT NOT NULL DEFAULT 'free',
  -- For kind='personal', the one identity this workspace belongs to; NULL for a
  -- team account. UNIQUE (SQLite permits many NULLs) so "the personal account for
  -- X" is a single indexed lookup AND the backfill in 0010 is idempotent by
  -- construction — re-running it can never mint a second personal account.
  personal_email TEXT UNIQUE,
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_kind ON accounts (kind);

-- Membership joins an identity to an account with an ACCOUNT role. These roles
-- are customer-facing and stored in D1; they are NOT platform authority. The
-- ordering owner > admin > member > viewer is encoded in src/accounts.ts, not
-- here, so the two can never disagree about what a role means.
CREATE TABLE IF NOT EXISTS account_members (
  account_id TEXT NOT NULL,
  -- Lowercased email — the same key artifacts, grants and tokens use.
  email      TEXT NOT NULL,
  -- 'owner' | 'admin' | 'member' | 'viewer'.
  role       TEXT NOT NULL DEFAULT 'member',
  -- 'active' | 'invited'. Enforcement is on the identity (users.status), so this
  -- is currently descriptive.
  status     TEXT NOT NULL DEFAULT 'active',
  invited_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, email)
);

-- "Which accounts is this person in?" is the hot query — every portal page runs it.
CREATE INDEX IF NOT EXISTS idx_account_members_email ON account_members (email);
