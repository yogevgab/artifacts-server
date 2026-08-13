-- Invite-only beta ownership: every artifact belongs to one signed-in person.
-- Admins manage everything; a non-admin beta user only ever sees or manages the
-- artifacts whose owner_email is theirs.
ALTER TABLE artifacts ADD COLUMN owner_email TEXT;

-- Backfill from created_by, but only where that was a real person's email.
-- Rows published by a service token were recorded as "service:<common_name>" (or
-- predate the field), so they get no owner and stay admin-only — fail closed.
UPDATE artifacts
SET owner_email = lower(trim(created_by))
WHERE owner_email IS NULL AND created_by LIKE '%@%';

CREATE INDEX IF NOT EXISTS idx_artifacts_owner ON artifacts (owner_email);
