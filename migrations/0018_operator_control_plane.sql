-- Operator control plane (Production SaaS plan, Phase 1).
--
-- Two additions, both additive:
--
--  1. `admin_audit` — an append-only record of operator actions. The feature
--     plan moved this *earlier* than the rest of Phase 1 on purpose: an
--     override or a suspension that leaves no trace is worse than one that
--     cannot be made at all, so the table has to exist before the first
--     control it records. Nothing ever UPDATEs or DELETEs a row here; the
--     product has no surface that can, which is what makes "append-only" a
--     fact rather than a promise.
--
--  2. Operator-owned columns on `accounts`. Kept as columns on the account
--     rather than a side table because they are one-per-account, are read on
--     the hot path (`effectivePlan`, suspension checks) and have to survive a
--     `SELECT *`. Every one is nullable with no default, so an existing row is
--     untouched and reads exactly as it did before this migration ran.
--
-- The load-bearing separation: `accounts.plan` stays what BILLING says (Lemon
-- Squeezy writes it, and keeps writing it), and `plan_override` is what the
-- OPERATOR says. Because they are different columns, a webhook delivery
-- physically cannot clobber an override — see `effectivePlan` in
-- src/accounts.ts for how the two combine, and `processWebhookEvent` in
-- src/billing.ts for what the webhook does when it lands under a live one.

CREATE TABLE IF NOT EXISTS admin_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Who did it. NULL only for a system actor (the billing webhook), which
  -- records itself as `actor_role = 'system'` instead.
  actor_email  TEXT,
  actor_role   TEXT,
  -- Dotted, stable and machine-readable: 'account.suspended',
  -- 'account.plan_override_set'. Never a sentence — `summary` is for that.
  action       TEXT NOT NULL,
  -- 'account' | 'user' | 'artifact' — what `target_id` names.
  target_type  TEXT NOT NULL,
  target_id    TEXT,
  -- One line an operator can read six months later without decoding `detail`.
  summary      TEXT,
  -- JSON. Whatever the action needs (before/after plan, expiry, reason).
  detail       TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target
  ON admin_audit (target_type, target_id, created_at DESC);

-- Sticky operator plan override. `plan_override_expires_at` NULL means "until
-- an operator removes it"; a timestamp in the past is simply inert, so an
-- expired comp needs no cron job to stop applying.
ALTER TABLE accounts ADD COLUMN plan_override TEXT;
ALTER TABLE accounts ADD COLUMN plan_override_expires_at TEXT;
ALTER TABLE accounts ADD COLUMN plan_override_note TEXT;
ALTER TABLE accounts ADD COLUMN plan_override_by TEXT;
ALTER TABLE accounts ADD COLUMN plan_override_at TEXT;

-- Free-text operator notes about the account ("migrating from X", "invoice by
-- bank transfer"). Never shown to the customer.
ALTER TABLE accounts ADD COLUMN notes TEXT;

-- Suspension metadata. `accounts.status` (0008) remains authoritative — these
-- record who/why/when, so an unsuspend is answerable rather than mysterious.
ALTER TABLE accounts ADD COLUMN suspended_at TEXT;
ALTER TABLE accounts ADD COLUMN suspended_by TEXT;
ALTER TABLE accounts ADD COLUMN suspended_reason TEXT;
