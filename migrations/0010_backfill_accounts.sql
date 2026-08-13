-- Backfill every existing identity into a personal account (issue #27).
--
-- Every statement is idempotent and re-runnable:
--   • the INSERT into `accounts` is guarded by `NOT EXISTS` on the UNIQUE
--     `personal_email`, so a second run inserts nothing;
--   • the membership INSERT uses ON CONFLICT DO NOTHING on its primary key;
--   • the two UPDATEs only ever touch rows where `account_id IS NULL`.
--
-- It is also **not required for correctness**. The Worker self-heals: the first
-- time somebody with no personal account uses the product,
-- `ensurePersonalAccount` (src/accounts.ts) creates exactly the same rows, using
-- the same UNIQUE constraint for race-safety. This migration exists so the
-- portal is populated on day one rather than filling in as people sign in, and
-- so legacy artifacts get an `account_id` without waiting for a republish.
--
-- If this migration fails (e.g. `users` or `api_tokens` is missing on a drifted
-- database), nothing is broken — drop the offending UNION branch and re-run, or
-- skip it entirely and let the Worker self-heal.
--
-- Steps 1–2 do not depend on 0009 and steps 3–4 do. Running this before 0009 by
-- mistake therefore creates the accounts and memberships, errors on the two
-- UPDATEs with "no such column: account_id", and converges to exactly the right
-- state when re-run after 0009 — verified against SQLite. So the only recovery
-- action for any partial failure here is: fix the cause, run this file again.

-- 1. One personal account per known identity.
--
-- "Known" is the union of everybody the product has ever recorded: artifact
-- owners, the local user directory, and API-token owners. `created_at` is the
-- earliest trace of them, so the account is not backdated to today.
INSERT INTO accounts (id, name, kind, status, plan, personal_email, created_by, created_at, updated_at)
SELECT
  'acct_' || lower(hex(randomblob(8))),
  known.email,
  'personal',
  'active',
  'free',
  known.email,
  known.email,
  known.first_seen,
  known.first_seen
FROM (
  SELECT email, min(seen) AS first_seen
  FROM (
    SELECT lower(trim(owner_email)) AS email, created_at AS seen
      FROM artifacts
     WHERE owner_email IS NOT NULL AND trim(owner_email) LIKE '%@%'
    UNION ALL
    SELECT lower(trim(email)), created_at
      FROM users
     WHERE trim(email) LIKE '%@%'
    UNION ALL
    SELECT lower(trim(owner_email)), created_at
      FROM api_tokens
     WHERE owner_email IS NOT NULL AND trim(owner_email) LIKE '%@%'
  )
  GROUP BY email
) AS known
WHERE NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.personal_email = known.email
);

-- 2. The identity owns their own personal account.
--
-- 'owner' is the ACCOUNT role — full rights inside this one workspace. It confers
-- nothing at platform level: being the owner of your personal account does not
-- make you an admin of the instance, which still comes only from ADMIN_EMAILS /
-- SUPER_ADMIN_EMAILS.
INSERT INTO account_members (account_id, email, role, status, created_at, updated_at)
SELECT a.id, a.personal_email, 'owner', 'active', a.created_at, a.created_at
FROM accounts a
WHERE a.personal_email IS NOT NULL
ON CONFLICT(account_id, email) DO NOTHING;

-- 3. Adopt legacy artifacts into their owner's personal account.
--
-- `owner_email` is deliberately left in place, not migrated away: it stays the
-- primary authorization key for these rows, so this UPDATE cannot change who may
-- manage anything. It only adds the account view of the same fact.
--
-- Unowned artifacts (published by a service token, or predating owner_email) stay
-- NULL and remain platform-admin-only — fail closed, exactly as before.
UPDATE artifacts
SET account_id = (
  SELECT a.id FROM accounts a WHERE a.personal_email = lower(trim(artifacts.owner_email))
)
WHERE account_id IS NULL
  AND owner_email IS NOT NULL
  AND trim(owner_email) LIKE '%@%';

-- 4. Same for API tokens. Admin tokens (owner_email IS NULL) stay account-less:
-- they are platform credentials, not workspace credentials.
UPDATE api_tokens
SET account_id = (
  SELECT a.id FROM accounts a WHERE a.personal_email = lower(trim(api_tokens.owner_email))
)
WHERE account_id IS NULL
  AND owner_email IS NOT NULL
  AND trim(owner_email) LIKE '%@%';
