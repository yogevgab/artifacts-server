-- Browser/CLI upload sessions for the remote MCP `create_upload_link` tool.
--
-- The remote MCP `publish` only takes bytes the model writes inline (5 MiB / 50
-- files). A real portfolio (images, video) does not fit. `create_upload_link`
-- reserves a destination and returns a single-use URL; the person (or the
-- model's code sandbox) then sends the files straight to POST /api/uploads/<token>.
--
-- Additive: a brand-new table, nothing else is touched. A Worker deployed ahead
-- of this migration fails the tool call with a clear error and nothing else.
--
-- The token is the whole credential for that one upload, so only its SHA-256 is
-- stored (like api_tokens / share_links). Nothing is published until the bytes
-- arrive; `used_at` is set only after a successful store, by a conditional
-- UPDATE, so a failed upload does not burn the link and two racing uploads can
-- not both win.
CREATE TABLE IF NOT EXISTS upload_sessions (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  account_id  TEXT,
  email       TEXT NOT NULL,
  -- Snapshot of the creator's platform-admin status at creation, so an admin
  -- adding a version to someone else's artifact can still finish the upload.
  is_admin    INTEGER NOT NULL DEFAULT 0,
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_expires ON upload_sessions (expires_at);
