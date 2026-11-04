-- Server-side sign-out. Signing out records that every session for that
-- address issued before this moment is void, so a copied session cookie stops
-- working too (sessions are otherwise stateless signed cookies).
--
-- Additive and idempotent. The Worker also creates this table on demand
-- (src/session-revocation.ts), and treats an unreadable table as "nobody has
-- signed out yet", so deploy order does not matter.
--
--   wrangler d1 execute artifacts-meta --remote --file migrations/0026_session_revocations.sql

CREATE TABLE IF NOT EXISTS session_revocations (
  email          TEXT PRIMARY KEY,
  revoked_before TEXT NOT NULL
);
