-- Lemon Squeezy billing: idempotency ledger for webhook deliveries.
-- accounts.plan (0008) stays the single source of truth for what an account
-- may do; this table exists only so a retried webhook delivery — Lemon
-- Squeezy retries on anything but a fast 200 — is a no-op rather than a
-- second write. See src/billing.ts for how `id` is derived: Lemon Squeezy's
-- webhook payload carries no documented, stable per-delivery id, so `id` is a
-- SHA-256 of the raw request body, which is byte-identical across retries of
-- the same delivery and differs for any genuinely new event (even one for the
-- same subscription).
CREATE TABLE IF NOT EXISTS billing_events (
  id           TEXT PRIMARY KEY,
  event_name   TEXT NOT NULL,
  -- The account this event was attributed to, or NULL when the webhook body
  -- carried no (or an unresolvable) account id — still recorded, so a
  -- delivery Lemon Squeezy retries because we returned 200 late doesn't get
  -- looked at twice.
  account_id   TEXT,
  processed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_events_account ON billing_events (account_id);
