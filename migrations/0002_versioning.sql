-- Artifact versioning.
ALTER TABLE artifacts ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1;

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

-- Backfill a v1 version row for every pre-existing artifact (that has none yet).
-- Their files are moved from <slug>/… to <slug>/v1/… out-of-band (R2 copy).
INSERT INTO artifact_versions (slug, version, type, entry, file_count, size_bytes, note, created_by, created_at)
SELECT slug, 1, type, entry, file_count, size_bytes, NULL, created_by, created_at
FROM artifacts
WHERE slug NOT IN (SELECT DISTINCT slug FROM artifact_versions);
