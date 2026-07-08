-- Per-artifact permissions.
ALTER TABLE artifacts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'restricted';

CREATE TABLE IF NOT EXISTS artifact_grants (
  slug       TEXT NOT NULL,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (slug, email)
);

CREATE INDEX IF NOT EXISTS idx_grants_slug ON artifact_grants (slug);
