-- Delivery outcomes for transactional email, so "why didn't they get it" is
-- answerable from data instead of from reading source.
-- See docs/superpowers/specs/2026-08-14-app-owned-identity-design.md §7.
CREATE TABLE IF NOT EXISTS mail_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_log_email ON mail_log (email, created_at DESC);
