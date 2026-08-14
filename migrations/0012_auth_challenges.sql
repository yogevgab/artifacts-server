-- Sign-in challenges. One row serves both the typed 6-digit code and the
-- magic-link token: redeeming either consumes the row, so a link never
-- outlives its code as a second invisible credential.
-- See docs/superpowers/specs/2026-08-14-app-owned-identity-design.md §9.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  purpose      TEXT NOT NULL,
  slug         TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_challenges_email ON auth_challenges (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_token ON auth_challenges (token_hash);
