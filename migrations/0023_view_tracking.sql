-- View tracking for share links: who/where/what-device for every view, plus a
-- record of link-card previews and attempts with expired or revoked links.
--
-- Additive only: nine new columns on `artifact_views` and one index. Every
-- existing row reads exactly as before (NULL for the new fields, outcome
-- 'viewed'). The Worker fails soft when these columns do not exist yet: the
-- view insert falls back to the pre-0023 column list and the new rows
-- (previews, expired/revoked attempts) are simply skipped, so a deploy that
-- lands before this migration does not break serving. Apply it BEFORE
-- deploying, to get the new data from the first request:
--
--   wrangler d1 execute artifacts-meta --remote --file migrations/0023_view_tracking.sql
--
-- ⚠️ The CREATE INDEXes are idempotent; the ALTERs are NOT. SQLite (and
-- therefore D1) has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so
-- re-running them against a database that already has the columns fails with
-- "duplicate column name" (the same caveat 0009, 0018 and 0019 carry). Check
-- before re-applying by hand:
--
--   wrangler d1 execute artifacts-meta --remote --command "PRAGMA table_info(artifact_views)"
--
-- A "duplicate column name" error is benign: the schema is already correct. A
-- fresh database built from schema.sql gets the columns inline instead.
--
-- Privacy: `ip` is personal data and is erased after 90 days (set to NULL). With
-- no scheduled job, the Worker does it lazily on view inserts for the same
-- artifact and never returns an older IP from the API (IP_RETENTION_DAYS in
-- src/view-context.ts). Everything else is kept with the artifact. See /privacy.

ALTER TABLE artifact_views ADD COLUMN ip TEXT;
ALTER TABLE artifact_views ADD COLUMN region TEXT;
ALTER TABLE artifact_views ADD COLUMN city TEXT;
-- 'mobile' | 'tablet' | 'desktop' | 'bot'
ALTER TABLE artifact_views ADD COLUMN device TEXT;
ALTER TABLE artifact_views ADD COLUMN os TEXT;
ALTER TABLE artifact_views ADD COLUMN browser TEXT;
-- Truncated to ~300 characters by the Worker.
ALTER TABLE artifact_views ADD COLUMN user_agent TEXT;
-- The share link the view came through (share_links.id), else NULL.
ALTER TABLE artifact_views ADD COLUMN link_id TEXT;
-- 'viewed' | 'preview' (link-card crawler) | 'link_expired' | 'link_revoked'
ALTER TABLE artifact_views ADD COLUMN outcome TEXT NOT NULL DEFAULT 'viewed';

CREATE INDEX IF NOT EXISTS idx_views_link ON artifact_views (link_id);
-- Rows that still hold an IP, so the lazy 90-day erasure never rescans rows it
-- already cleared.
CREATE INDEX IF NOT EXISTS idx_views_ip_pending ON artifact_views (slug, viewed_at) WHERE ip IS NOT NULL;
-- (slug, viewed_at) is already indexed by idx_views_slug (0003), which also serves
-- the lazy IP-erasure UPDATE and the dedupe lookups, so no second index is added.
