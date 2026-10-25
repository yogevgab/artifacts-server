-- Named share links, and a permission level on named-people grants.
--
-- Additive only: one nullable column on `share_links`, one defaulted column on
-- `artifact_grants`. Every existing row reads exactly as before: a link has no
-- name (NULL), a grant is a 'viewer' (the DEFAULT backfills it), so nobody gains
-- or loses anything by this migration. The Worker fails soft when these columns
-- do not exist yet: link names read as NULL (a name sent on create is simply
-- not stored), and every grant is treated as a viewer, so a deploy that lands before this migration does not
-- break serving or sharing. Apply it BEFORE deploying, to get names and
-- editors from the first request:
--
--   wrangler d1 execute artifacts-meta --remote --file migrations/0024_link_names_grant_roles.sql
--
-- ⚠️ The ALTERs are NOT idempotent. SQLite (and therefore D1) has no
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so re-running them against a
-- database that already has the columns fails with "duplicate column name"
-- (the same caveat 0009, 0018, 0019 and 0023 carry). Check before re-applying
-- by hand:
--
--   wrangler d1 execute artifacts-meta --remote --command "PRAGMA table_info(share_links)"
--   wrangler d1 execute artifacts-meta --remote --command "PRAGMA table_info(artifact_grants)"
--
-- A "duplicate column name" error is benign: the schema is already correct. A
-- fresh database built from schema.sql gets the columns inline instead.

-- The owner's own label for a link ("for Dana", "Acme legal"). Never shown to
-- whoever holds the link. NULL = unnamed.
ALTER TABLE share_links ADD COLUMN name TEXT;

-- What a named person may do: 'viewer' (open it) or 'editor' (open it, publish
-- new versions to it and roll it back). Editors still cannot change access,
-- manage links, read analytics or delete.
ALTER TABLE artifact_grants ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer';
