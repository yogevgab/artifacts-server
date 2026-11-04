-- Which workspace each Lemon Squeezy subscription belongs to, and what it
-- currently entitles that workspace to.
--
-- A subscription is bound to the workspace named in its checkout's
-- `custom_data.account_id` the FIRST time a webhook for it arrives, and never
-- rebound: that id comes from the checkout URL, which the buyer can edit, so
-- it may claim an unclaimed subscription but not move a claimed one. A
-- workspace's `accounts.plan` is then the best plan among its subscriptions,
-- so a stranger's subscription aimed at somebody else's workspace can add to
-- its plan but never take the owner's paid plan away.
--
-- Additive and idempotent. The Worker also creates this table on demand
-- (src/billing.ts), so a deploy that lands before the migration still works.
-- Subscriptions created before this table existed bind on their next webhook
-- (Lemon Squeezy sends one at every renewal).
--
--   wrangler d1 execute artifacts-meta --remote --file migrations/0025_billing_subscriptions.sql

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  plan            TEXT,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_account ON billing_subscriptions (account_id);
