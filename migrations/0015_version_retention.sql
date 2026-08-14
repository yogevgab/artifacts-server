-- Free-tier retention: versions outside the window are marked expired and
-- their bytes removed from R2, but the row stays so the history remains
-- honest — "v2 existed and is gone" beats a hole in the numbering.
ALTER TABLE artifact_versions ADD COLUMN expired_at TEXT;
