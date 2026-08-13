# rtfx.pro production deployment runbook

Production deploy for the rtfx.pro private beta: `rtfx.pro` (dashboard/API/admin) +
`a.rtfx.pro` (artifact content only, per the origin isolation in `src/host.ts`).

This document is a checklist for a **human operator** running commands locally. Every
step that creates, modifies, or deletes a Cloudflare resource is labeled
**MANUAL — mutates Cloudflare, run yourself**. Do not let an agent run those steps
unattended; review each one before running it.

## Already prepared (this repo)

- `wrangler.jsonc` `routes`: `rtfx.pro` and `a.rtfx.pro` (both `custom_domain: true`).
- `wrangler.jsonc` `vars.CONTENT_HOSTNAMES`: `a.rtfx.pro`.
- `npm run validate:deploy` — read-only check that `wrangler.jsonc` is structurally
  consistent (routes/`CONTENT_HOSTNAMES` line up, required bindings exist) and reports
  which fields are still pending manual Cloudflare provisioning. Safe to run any time;
  touches no external resources.

Still placeholders in `wrangler.jsonc`, filled in during the steps below:
`d1_databases[0].database_id`, `vars.ADMIN_EMAILS`, `vars.ACCESS_TEAM_DOMAIN`,
`vars.ACCESS_AUD`, `vars.CF_ACCOUNT_ID`, `vars.ACCESS_VIEWER_APP_ID`,
`vars.ACCESS_VIEWER_POLICY_ID`, `vars.ADMIN_SERVICE_TOKENS`. No secret values are
committed anywhere — `CF_API_TOKEN` is set with `wrangler secret put`, never in this file.

## Prerequisites

- `rtfx.pro` is an active zone on the Cloudflare account you'll deploy from.
- Cloudflare Zero Trust is enabled on that account (pick a team name once, in the
  dashboard — free plan is fine).
- `npx wrangler login` has been run.

## Why `npm run setup` doesn't apply here

`scripts/setup.mjs` automates a **single-hostname** deploy: it patches the first
`"pattern"` it finds in `wrangler.jsonc` and creates one Access app on one hostname.
This deployment needs two routes (`rtfx.pro` + `a.rtfx.pro`) and an Access viewer app
covering *both* hostnames (see step 5) — `npm run setup` was not built for that and
would misconfigure the second route. Use the manual steps below instead.

## 1. Pre-deploy config gate

Before any of the steps below (and again before any redeploy), confirm the file is
structurally correct and see what's still outstanding:

```bash
npm run validate:deploy           # report only
npm run validate:deploy -- --strict   # also fails if anything is still pending — run once
                                       # everything above is filled in, right before go-live
```

## 2. Storage — MANUAL, mutates Cloudflare

```bash
npx wrangler r2 bucket create artifacts-files
npx wrangler d1 create artifacts-meta
```

Copy the printed `database_id` into `wrangler.jsonc` → `d1_databases[0].database_id`.

```bash
npx wrangler d1 execute artifacts-meta --remote --file schema.sql
```

## 3. Admin email

Edit `wrangler.jsonc` → `vars.ADMIN_EMAILS` to your real admin email (comma-separated
for more than one). This is not a secret, but is left as a placeholder in this repo
since it's operator-specific.

## 4. First deploy — MANUAL, mutates Cloudflare

```bash
npx wrangler deploy
```

This creates the `rtfx.pro` and `a.rtfx.pro` custom domains. `/admin` and `/api` will
reject all requests until Access is configured (steps below) — that's expected.

## 5. Cloudflare Access — MANUAL, mutates Cloudflare (Zero Trust dashboard or API)

The viewer app must cover **both** hostnames — a signed-in viewer's request to
`a.rtfx.pro` still needs an Access JWT for the Worker's own per-artifact authorization
(`src/auth.ts`) to identify them, even though Access itself isn't what blocks
management routes there (the Worker does, per `src/host.ts`).

1. Self-hosted app **`Artifacts (viewers)`** with destinations `rtfx.pro` **and**
   `a.rtfx.pro`, two policies:
   - `— humans`: decision **Allow**, include your admin email(s) (add more viewers
     later from `/admin`).
   - `— cli`: decision **Service Auth**, include a new service token `artifacts-cli`.
2. Self-hosted app **`Artifacts (admin)`** with destinations `rtfx.pro/admin` and
   `rtfx.pro/api` (not `a.rtfx.pro` — content hosts never serve those paths), same two
   policies.
3. **New for the public landing page (issue #5):** self-hosted app **`Artifacts (public)`**
   with destinations `rtfx.pro/` (exact root), `rtfx.pro/waitlist` and — **added for issue
   #24** — `rtfx.pro/login`, one policy with decision **Bypass**. Without this, the viewer
   app above (destination `rtfx.pro`) still gates those paths, so `/` would show Access's
   login screen instead of the public landing page. `/login` matters for the same reason and
   more sharply: it is the page that *explains* how to sign in, so meeting Cloudflare's own
   login screen there instead defeats its entire purpose. `a.rtfx.pro` doesn't need this — it
   never serves `/`, `/waitlist` or `/login` (`src/host.ts` blocks management routes there
   regardless of Access).
4. Fill in `wrangler.jsonc`:
   - `vars.ACCESS_TEAM_DOMAIN` — your `…cloudflareaccess.com` team domain.
   - `vars.ACCESS_AUD` — `"<viewer app AUD>,<admin app AUD>"`.
   - `vars.CF_ACCOUNT_ID` — your account id (`wrangler whoami`).
   - `vars.ACCESS_VIEWER_APP_ID` / `vars.ACCESS_VIEWER_POLICY_ID` — the viewer app's id
     and its `— humans` policy id.
   - `vars.ADMIN_SERVICE_TOKENS` — the `artifacts-cli` service token's client id.

## 5b. Invite-only beta ownership model (issue #7) — MANUAL, mutates Cloudflare

Do these in order; each is safe on its own, and stopping after step B leaves the deployment
behaving exactly as it does today (admins only).

**A. D1 migration — required before deploying the new Worker code.** `artifacts.owner_email`
must exist before the code that writes it runs:

```bash
npx wrangler d1 execute artifacts-meta --remote --file migrations/0005_owner_email.sql
# spot-check the backfill (existing artifacts become owned by whoever created them)
npx wrangler d1 execute artifacts-meta --remote --command \
  "SELECT slug, created_by, owner_email FROM artifacts"
```

Rows created by the CLI service token keep `owner_email = NULL` on purpose — they stay
admin-only. The migration is additive and re-runnable only once (`ALTER TABLE … ADD COLUMN`
fails if the column already exists, which is a harmless no-op signal).

**B. Deploy** (`npx wrangler deploy`). Nothing user-visible changes yet: Access still gates
`/admin` and `/api` to admins.

**C. Access path change — required before beta users can use their dashboard.** The Worker enforces
ownership itself (`src/authz.ts`): admins manage every artifact, a signed-in beta user
manages only artifacts whose `owner_email` is theirs, and `/api/users` (the sign-in
allow-list) stays admin-only in code. But the `Artifacts (admin)` app from step 5.2
still gates *all* of `/admin` and `/api` at the edge to admin emails only — so without
this change a beta user is stopped by Access before the Worker ever sees the request.

Make the admin Access app guard only the genuinely admin-only surface:

1. Zero Trust → Access → Applications → **`Artifacts (admin)`** → Edit.
2. Replace its destinations `rtfx.pro/admin` and `rtfx.pro/api` with the single
   destination **`rtfx.pro/api/users`** (this also covers `/api/users/<email>`).
   Leave its policies (`— humans` = admin emails, `— cli`) unchanged.
3. Leave `Artifacts (viewers)` exactly as-is. `/admin` and `/api/artifacts…` now fall
   under it, so every *invited* beta user — the app-managed allow-list in
   `ACCESS_VIEWER_POLICY_ID` — reaches them, and the Worker scopes what they see.

Access resolves the most specific path first, so `/api/users` stays admin-gated at the
edge while `/api/artifacts` is viewer-gated. No `wrangler.jsonc` value changes; both
AUDs stay in `ACCESS_AUD`. **No deploy is needed for this step**, but the Worker code
carrying the ownership model must already be deployed before you widen the path —
deploy first, then edit Access.

If you'd rather not widen `/admin` yet, skip this step: everything keeps working exactly
as before (admins only), and beta users simply can't reach their own dashboard.

Verify after the change (in a browser, signed in as a non-admin invited user):

```bash
# as an invited non-admin: their own dashboard, scoped to their artifacts
open https://rtfx.pro/admin           # 200, "Beta" header, no People panel
open https://rtfx.pro/api/users       # blocked by Access; 403 from the Worker if it gets through
```

## 5c. Local user directory (issue #24) — MANUAL, mutates D1

```bash
npx wrangler d1 migrations apply DB --remote     # applies 0007_users.sql
```

Additive and safe to apply before or after the deploy: an Access-allowed person with no row
is still a valid user (the row is created on their first sign-in), and the migration backfills
existing artifact owners as active members. Optionally set `vars.SUPER_ADMIN_EMAILS` in
`wrangler.jsonc` to name the operator explicitly; left unset it defaults to the first
`ADMIN_EMAILS` entry, so the anti-lockout invariant holds either way.

Browser-smoke after deploy: `/login` signed out (both CTAs), `/login` signed in, the People
panel on `/admin`, and one invite → pause → re-enable → remove round trip on a throwaway
address.

To roll back, restore the `Artifacts (admin)` destinations to `rtfx.pro/admin` and
`rtfx.pro/api`.

## 6. Redeploy + secret — MANUAL, mutates Cloudflare

```bash
npx wrangler deploy
npx wrangler secret put CF_API_TOKEN   # optional: only needed for in-app user management
```

`CF_API_TOKEN` needs "Access: Apps and Policies — Edit" scope for the account.

## 7. Smoke test (after deploy)

```bash
# Both hosts respond; the content host must not serve the app dashboard.
curl -i https://rtfx.pro/health
curl -i https://a.rtfx.pro/admin        # expect 404 — content hosts never serve /admin

export ARTIFACTS_URL=https://rtfx.pro
export CF_ACCESS_CLIENT_ID=<artifacts-cli service token client id>
export CF_ACCESS_CLIENT_SECRET=<artifacts-cli service token secret>

echo '<h1>rtfx smoke test</h1>' > /tmp/smoke.html
node cli/artifacts.mjs publish /tmp/smoke.html --slug smoke-test --title "Smoke Test"
node cli/artifacts.mjs list                       # confirm smoke-test appears

curl -i https://a.rtfx.pro/smoke-test/            # renders on the content host
                                                   # (302 to the Access login if run
                                                   # outside a browser session — that's
                                                   # expected; check status in a browser
                                                   # signed in as an admin/viewer instead)

node cli/artifacts.mjs delete smoke-test
node cli/artifacts.mjs list                       # confirm smoke-test is gone
```

## Rollback

```bash
npx wrangler deployments list
npx wrangler rollback [deployment-id]
```

If Access or `wrangler.jsonc` config was the problem, revert the relevant local edits
and redeploy — Cloudflare Access apps/policies created above are not removed by a
Worker rollback and must be cleaned up separately in the Zero Trust dashboard if no
longer wanted.
