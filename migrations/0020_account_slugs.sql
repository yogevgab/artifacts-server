-- Branded workspace addresses: rtfx.pro/yogev/q3-board-report.
--
-- One nullable column on `accounts`, plus a partial UNIQUE index. Additive in
-- the same sense as 0018: every existing row reads exactly as it did before,
-- because NULL means "this workspace has no branded address", which is what
-- every account has today and what most will keep having.
--
-- Deliberately NOT a second table. A workspace has at most one public address,
-- it is read on the branded route's hot path, and `accounts.ts` reads the row
-- with `SELECT *` — a side table would add a join to a request whose whole job
-- is one redirect. History of who held what, if it is ever wanted, belongs in
-- `admin_audit`, which already records operator and account changes.
--
-- Like 0015 and 0018, the ALTER is not re-runnable on its own (SQLite has no
-- `ADD COLUMN IF NOT EXISTS`); the index below is. Re-running this file against
-- an already-migrated database fails on the ALTER and changes nothing, which is
-- the same behavior every other column-adding migration here has.

-- The workspace's public address, lowercase and globally unique across every
-- account. NULL for an account that has not claimed one — which is the default,
-- and stays the default: nothing backfills this. Auto-assigning an address to
-- every existing account would publish a guessable namespace for workspaces
-- whose owners never asked for one.
ALTER TABLE accounts ADD COLUMN public_slug TEXT;

-- Partial, so the many NULLs do not contend, and UNIQUE so two accounts can
-- never hold the same address even if two requests claim it at the same
-- instant. This index IS the uniqueness guarantee — `setAccountPublicSlug`
-- (src/accounts.ts) reads before it writes only to produce a good error
-- message, and relies on the constraint for correctness.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_public_slug
  ON accounts (public_slug) WHERE public_slug IS NOT NULL;
