-- One-time cross-host sign-in handoffs between the two APP hosts (rtfx.pro and
-- mcp.rtfx.pro). The session cookie is host-only by design, so a sign-in on one
-- app host is invisible to the other; a handoff carries a verified sign-in across
-- without ever sharing a cookie. See src/handoff.ts.
--
-- The Worker also creates this table on demand (CREATE TABLE IF NOT EXISTS), like
-- session_revocations, so applying this migration is optional but tidy.
--
-- token_hash is SHA-256 of the one-time token (never stored in plaintext);
-- nonce_hash is SHA-256 of the target browser's __Host- cookie nonce, which binds
-- the token to the browser that started the handoff (login-CSRF defence).
CREATE TABLE IF NOT EXISTS auth_handoffs (
  token_hash   TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  source_host  TEXT NOT NULL,
  target_host  TEXT NOT NULL,
  next_path    TEXT NOT NULL,
  nonce_hash   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT,
  created_at   TEXT NOT NULL
);
