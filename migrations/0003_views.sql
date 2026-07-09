-- Views log: one row per HTML page load by a signed-in person.
CREATE TABLE IF NOT EXISTS artifact_views (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  email      TEXT,
  path       TEXT,
  country    TEXT,
  referrer   TEXT,
  viewed_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_views_slug ON artifact_views (slug, viewed_at DESC);
