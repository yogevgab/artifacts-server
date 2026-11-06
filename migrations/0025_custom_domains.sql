-- Custom domains (docs/CUSTOM_DOMAINS.md), phase 1.
--
-- Purely additive: one new table, two indexes. Nothing reads it unless the
-- Worker runs with CUSTOM_DOMAINS_ENABLED="true", and every read fails soft when
-- the table does not exist yet, so deploying the Worker before this migration
-- changes nothing. Idempotent (IF NOT EXISTS), safe to re-run:
--
--   wrangler d1 execute artifacts-meta --remote --file migrations/0025_custom_domains.sql
--
-- A custom domain maps to the WHOLE workspace: docs.acme.com/<artifact> is
-- rtfx.pro/<workspace>/<artifact>. `hostname` is the primary key, lower-cased,
-- no trailing dot, so a hostname belongs to exactly one workspace.
CREATE TABLE IF NOT EXISTS custom_domains (
  hostname            TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts(id),
  status              TEXT NOT NULL,   -- pending | active | failed | removed
  cf_hostname_id      TEXT,            -- Cloudflare custom hostname id (phase 2)
  ssl_status          TEXT,
  verification_errors TEXT,
  is_primary          INTEGER NOT NULL DEFAULT 0, -- the one links and emails use
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  verified_at         TEXT,
  updated_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_custom_domains_account ON custom_domains (account_id);

-- At most one primary domain per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_domains_primary
  ON custom_domains (account_id) WHERE is_primary = 1;
