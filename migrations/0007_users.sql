-- Local user directory (issue #24): SaaS-style state *above* the Cloudflare
-- Access allow-list. Access stays the authentication source of truth — it decides
-- who can log in at all. This table records what the product needs to know about
-- each person: their lifecycle status, a display name, operator notes, and
-- timestamps. It is additive: an Access-allowed person with no row here is still
-- a valid beta user (the row is created on their first sign-in), so deploying
-- this migration can never lock anyone out.
--
-- `role` is a RECORD of the configured role, not a grant. Admin and super-admin
-- rights come from ADMIN_EMAILS / SUPER_ADMIN_EMAILS only, so a write to this
-- table can never escalate anyone. `status` IS authoritative: 'disabled' is
-- enforced by the Worker on every request (see resolveAuth in src/auth.ts), which
-- is what makes disabling effective even if the Access allow-list write fails.
CREATE TABLE IF NOT EXISTS users (
  -- Lowercased email — the same key ownership and grants use.
  email        TEXT PRIMARY KEY,
  -- 'member' | 'admin' | 'super_admin' (informational; see above).
  role         TEXT NOT NULL DEFAULT 'member',
  -- 'invited' (added, never signed in) | 'active' | 'disabled'.
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

-- Backfill: every email already known to the product becomes an active member,
-- so the directory is populated on day one instead of looking empty. Artifact
-- owners are the people who have demonstrably signed in and published.
INSERT INTO users (email, role, status, created_at, last_seen_at)
SELECT lower(trim(owner_email)), 'member', 'active', min(created_at), max(updated_at)
FROM artifacts
WHERE owner_email IS NOT NULL AND trim(owner_email) LIKE '%@%'
GROUP BY lower(trim(owner_email))
ON CONFLICT(email) DO NOTHING;
