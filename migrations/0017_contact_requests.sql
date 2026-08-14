-- Sales/support contact requests: the other half of "Talk to us".
--
-- Additive and idempotent — `CREATE TABLE IF NOT EXISTS` and nothing else. It
-- drops no data, alters no existing table and changes no existing behaviour, so
-- applying it to a live database is a no-op for everything already running.
--
-- Deliberately NOT the `waitlist` table (0004). That table is one row per unique
-- address with an UNIQUE constraint, which is exactly wrong here: the same
-- person may legitimately ask about Team in March and Enterprise in June, and
-- the second request must not be silently swallowed as a duplicate. It also
-- carries no message and no plan, which are the two fields that make a contact
-- request answerable at all.
--
-- `plan` is free text rather than a CHECK constraint on purpose: it records what
-- the button said at the time it was pressed, and the tier ladder
-- (src/plan-copy.ts) is allowed to change without a migration.
CREATE TABLE IF NOT EXISTS contact_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  -- Which tier's button they came from ('team', 'enterprise'), or NULL for a
  -- plain support request from /contact with no plan attached.
  plan       TEXT,
  -- What they typed. Capped in the route (src/contact.ts), not here: SQLite
  -- does not enforce TEXT length, so a limit written here would be decoration.
  message    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_requests_created ON contact_requests (created_at DESC);
