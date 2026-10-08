-- Every workspace gets an address: backfill auto slugs for accounts without one.
--
-- MUST be applied (`wrangler d1 migrations apply`) BEFORE deploying the code that
-- depends on it. The Worker also assigns an address lazily when it finds a NULL
-- (`ensureAccountPublicSlug`, src/accounts.ts), so a late migration degrades to
-- per-request writes rather than breaking links — but apply it first anyway.
--
-- Supersedes the note in 0020 that nothing backfills `public_slug`: the product
-- decision is that a workspace without a chosen name holds a generated one,
-- `w-` + 8 lowercase hex chars (e.g. `w-3f9a0c12`). "Is this auto?" is answered
-- by that shape alone (AUTO_ACCOUNT_SLUG_RE, src/account-slugs.ts); custom
-- addresses of that shape are refused, so the two never collide by design.
--
-- Random, not derived from the account id, so an address reveals nothing and
-- cannot be guessed from anything else. 32 bits across the accounts table makes
-- a collision unlikely but not impossible: if one occurs the UPDATE fails on the
-- partial UNIQUE index from 0020 and the migration must simply be re-run (it only
-- touches rows that are still NULL, so re-running is safe).

UPDATE accounts
   SET public_slug = 'w-' || lower(hex(randomblob(4)))
 WHERE public_slug IS NULL;
