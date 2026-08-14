-- Read receipts (product replan): tell an owner the first time a person they
-- shared an artifact with actually opens it. Default ON, matching every other
-- owner-facing signal in this product (the view log, mail_log) — an owner who
-- never asked for less visibility should not have to discover a setting to
-- get the visibility they already had. An explicit 0 turns it off.
ALTER TABLE artifacts ADD COLUMN read_receipts INTEGER NOT NULL DEFAULT 1;
