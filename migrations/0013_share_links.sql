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
