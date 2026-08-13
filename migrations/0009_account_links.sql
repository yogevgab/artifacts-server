-- Link the things an account owns back to it (issue #27).
--
-- Both columns are NULLABLE with no default, which is what makes this safe: every
-- existing row keeps `account_id IS NULL` and continues to be authorized by the
-- legacy `owner_email` path exactly as before. Nothing reads these columns until
-- 0010 has backfilled them, and even then `owner_email` stays authoritative for
-- any row that still has one.
--
-- ⚠️ Unlike 0008 and 0010, this migration is NOT idempotent: SQLite has no
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and re-running it against a
-- database that already has the column fails with "duplicate column name".
-- Given the historical migration drift on this project, check first and skip the
-- statements that already applied:
--
--   wrangler d1 execute rtfx --remote --command "PRAGMA table_info(artifacts)"
--   wrangler d1 execute rtfx --remote --command "PRAGMA table_info(api_tokens)"
--
-- A "duplicate column name" error here is benign — the schema is already correct
-- and 0010 can be applied directly. See docs/ARCHITECTURE.md § Data model (D1).

-- The account that owns this artifact. NULL = legacy row, authorized by
-- owner_email alone (and by platform admins).
ALTER TABLE artifacts ADD COLUMN account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_artifacts_account ON artifacts (account_id);

-- The account this token acts inside. NULL = legacy token, scoped by owner_email
-- alone. `owner_email` is retained and still authoritative: it records the
-- creating identity, so revoking a person still revokes their tokens.
ALTER TABLE api_tokens ADD COLUMN account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_api_tokens_account ON api_tokens (account_id);
