# rtfx.pro production deployment runbook

Production deploy for rtfx.pro: `rtfx.pro` (public site + dashboard/API/admin) +
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
   with destinations `rtfx.pro/` (exact root), `rtfx.pro/waitlist`, — **added for issue
   #24** — `rtfx.pro/login`, — **added for issue #29** — `rtfx.pro/docs`,
   `rtfx.pro/robots.txt`, `rtfx.pro/sitemap.xml`, `rtfx.pro/llms.txt`, `rtfx.pro/og.svg` and `rtfx.pro/og.png`,
   and — **added for issue #36** — `rtfx.pro/privacy` and `rtfx.pro/terms`,
   plus — **new: `rtfx.pro/logo.png`**, the square mark the landing page's `Organization.logo`
   JSON-LD now points at (it used to point at the 1200×630 social card). It is a static image
   that reads nothing about the caller, so it exposes exactly what `rtfx.pro/og.png` already
   does — but without the bypass, every consumer of the structured data follows that URL into
   Cloudflare's login screen,
   plus — see **§5e**, and read it before adding this one — `rtfx.pro/api/machine`,
   one policy with decision **Bypass**. Without this, the viewer app above (destination
   `rtfx.pro`) still gates those paths, so `/` would show Access's login screen instead of
   the public landing page. `/login` matters for the same reason and more sharply: it is the
   page that *explains* how to sign in, so meeting Cloudflare's own login screen there
   instead defeats its entire purpose. The issue-#29 paths matter for a third reason: a
   crawler cannot log in, so an Access-gated `robots.txt` or `sitemap.xml` is the same as
   not having one, and an Access-gated `/docs` is a page no search engine or AI agent can
   ever read. The issue-#36 pages are the ones a person reads *before* deciding to hand over
   an email address — a privacy policy you must sign in to read is not a privacy policy.
   `a.rtfx.pro` doesn't need this — it never serves any of them except
   `robots.txt`, which is public there by design and answers `Disallow: /` (`src/host.ts`
   and `src/seo.ts`).
4. Fill in `wrangler.jsonc`:
   - `vars.ACCESS_TEAM_DOMAIN` — your `…cloudflareaccess.com` team domain.
   - `vars.ACCESS_AUD` — `"<viewer app AUD>,<admin app AUD>"`.
   - `vars.CF_ACCOUNT_ID` — your account id (`wrangler whoami`).
   - `vars.ACCESS_VIEWER_APP_ID` / `vars.ACCESS_VIEWER_POLICY_ID` — the viewer app's id
     and its `— humans` policy id.
   - `vars.ADMIN_SERVICE_TOKENS` — the `artifacts-cli` service token's client id.

## 5b. Invite-only ownership model (issue #7) — MANUAL, mutates Cloudflare

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

**C. Access path change — required before invited members can use their dashboard.** The Worker enforces
ownership itself (`src/authz.ts`): admins manage every artifact, a signed-in member
manages only artifacts whose `owner_email` is theirs, and `/api/users` (the sign-in
allow-list) stays admin-only in code. But the `Artifacts (admin)` app from step 5.2
still gates *all* of `/admin` and `/api` at the edge to admin emails only — so without
this change a member is stopped by Access before the Worker ever sees the request.

Make the admin Access app guard only the genuinely admin-only surface:

1. Zero Trust → Access → Applications → **`Artifacts (admin)`** → Edit.
2. Replace its destinations `rtfx.pro/admin` and `rtfx.pro/api` with the single
   destination **`rtfx.pro/api/users`** (this also covers `/api/users/<email>`).
   Leave its policies (`— humans` = admin emails, `— cli`) unchanged.
3. Leave `Artifacts (viewers)` exactly as-is. `/admin` and `/api/artifacts…` now fall
   under it, so every *invited* member — the app-managed allow-list in
   `ACCESS_VIEWER_POLICY_ID` — reaches them, and the Worker scopes what they see.

Access resolves the most specific path first, so `/api/users` stays admin-gated at the
edge while `/api/artifacts` is viewer-gated. No `wrangler.jsonc` value changes; both
AUDs stay in `ACCESS_AUD`. **No deploy is needed for this step**, but the Worker code
carrying the ownership model must already be deployed before you widen the path —
deploy first, then edit Access.

If you'd rather not widen `/admin` yet, skip this step: everything keeps working exactly
as before (admins only), and members simply can't reach their own dashboard.

Verify after the change (in a browser, signed in as a non-admin invited user):

```bash
# as an invited non-admin: their own dashboard, scoped to their artifacts
open https://rtfx.pro/admin           # 200, "Member" header, no People panel
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
address. Do one keyboard pass while you are there: Tab from the top of `/` and `/admin` — the
first stop is **Skip to content**, and every stop after it has a visible focus ring.

To roll back, restore the `Artifacts (admin)` destinations to `rtfx.pro/admin` and
`rtfx.pro/api`.

## 5d. Invite-user "CORS error" + branding the sign-in (issue #37)

### The problem

After step 5b.C, `/admin` is guarded by `Artifacts (viewers)` and `/api/users` by
`Artifacts (admin)` — two Access **applications**, and an Access session is per-application.
A browser that signed in at `/admin` holds no session for `/api/users`, so the People panel's
first write is answered by Access, before the Worker ever sees it, with a 302 to
`…cloudflareaccess.com`. That is a *cross-origin* redirect, and a `fetch` carrying
`Content-Type: application/json` may not follow one without a preflight — which is not allowed
after a redirect. Chrome reports "blocked by CORS policy" and "Send invite" appears broken.

Reproduce it from a shell with no browser session:

```bash
# 302 to …cloudflareaccess.com — the redirect a fetch cannot follow
curl -si -X POST https://rtfx.pro/api/users -H 'Content-Type: application/json' \
  -H 'Origin: https://rtfx.pro' -d '{"email":"x@example.com"}' | head -3

# 403 from the Cloudflare edge, with no Access-Control-* headers: a browser
# preflight never carries credentials, so Access refuses it
curl -si -X OPTIONS https://rtfx.pro/api/users -H 'Origin: https://rtfx.pro' \
  -H 'Access-Control-Request-Method: POST' | head -1
```

### The Worker's half (deployed with the code)

`src/cors.ts` answers preflights before authentication and names one concrete origin (never `*`,
never a content host); the People panel fetches with `redirect: 'manual'` and recovers through
`GET /api/users/reauth`, a full-page navigation Access *can* complete.

### Required Cloudflare Access option when keeping the two-app setup — MANUAL, mutates Cloudflare

If `Artifacts (admin)` still guards `rtfx.pro/api/users`, Access must be told to pass browser
preflights through to the Worker; otherwise `OPTIONS /api/users` is refused at the edge and
`src/cors.ts` never runs.

1. Zero Trust → Access → Applications → **`Artifacts (admin)`** → Edit.
2. Enable **Bypass OPTIONS requests** / `options_preflight_bypass`.
3. Do the same on **`Artifacts (viewers)`** so every `/api/*` preflight behaves consistently.

This leaves the admin Access application in place and keeps `/api/users` edge-gated for real
non-OPTIONS requests; the first invite of a browser session may still bounce through
`/api/users/reauth`, then succeeds.

### Alternative Cloudflare simplification — MANUAL, mutates Cloudflare

You can remove the second application boundary entirely, so there is no second Access session to
establish:

1. Zero Trust → Access → Applications → **`Artifacts (admin)`** → Edit.
2. Delete the `rtfx.pro/api/users` destination (i.e. retire the app), leaving `/admin` and `/api`
   under `Artifacts (viewers)`.

This does **not** widen who may manage users. `/api/users` has always been admin-only in the
Worker (`api.use("/users", requireAdmin, denyApiToken)` in `src/api.ts`) and additionally refuses
API tokens outright, so an invited non-admin reaching the route still gets 403. What is lost is
one layer of edge defence-in-depth — an admin-only *edge* filter in front of an admin-only
*application* check.

Drop `<adminAud>` from `vars.ACCESS_AUD` only after the app is retired, never before.

### Branding the one-time-code screen — MANUAL, mutates Cloudflare (§5d)

`/login` is ours and carries the rtfx.pro wordmark, product copy, and troubleshooting help
(`src/login.ts`). The screen immediately after it — the email prompt and the one-time code — is
**hosted by Cloudflare Access** and cannot be styled by the Worker at all. Match it in Zero Trust or
the handoff still looks like two unrelated products:

1. Zero Trust → **Settings → Custom Pages** → *Login page* → Customize.
2. Use **rtfx.pro** as the header/brand text. Do not upload the old square mark if the product
   chrome is intentionally wordmark-only.
3. Zero Trust → Settings → Custom Pages → **Block page**: same wordmark treatment, and a support
   link that points at `https://rtfx.pro/login`, which explains invite-only access in plain words.

The one-time-code **email** is sent by Cloudflare Access, not the Worker. Keep the Cloudflare team
and application names product-clean (`rtfx.pro`) so the sender/context look trustworthy, but do not
promise repo-controlled HTML email styling unless Cloudflare exposes that account-level feature.

No deploy or `wrangler.jsonc` change is involved; it is account-level Zero Trust configuration.

### Verify after deploy

```bash
# preflight is answered by the Worker, names one origin, never a wildcard
curl -si -X OPTIONS https://rtfx.pro/api/users -H 'Origin: https://rtfx.pro' \
  -H 'Access-Control-Request-Method: POST' | grep -i '^HTTP\|^access-control\|^vary'
# expect: 204, Access-Control-Allow-Origin: https://rtfx.pro, Allow-Credentials: true, Vary: Origin

# a foreign origin gets no allow headers at all
curl -si -X OPTIONS https://rtfx.pro/api/users -H 'Origin: https://evil.example.com' \
  -H 'Access-Control-Request-Method: POST' | grep -ci 'access-control-allow-origin'   # 0

# the content host still refuses the management API outright
curl -so /dev/null -w '%{http_code}\n' -X OPTIONS https://a.rtfx.pro/api/users        # 404
```

Then, in a browser signed in as an admin: open `/admin/people`, invite a throwaway address, and
confirm the row appears with no console error — then Remove it and confirm it is gone from both
the directory and the Access allow-list.

## 5e. The machine API — REQUIRED before external users can publish

### The problem

`/api` is guarded by Cloudflare Access. Access runs at the edge, *before* the
Worker, and it decides on a browser session cookie or on Cloudflare service-token
headers — it has no idea what an `rtfx_…` API token is. So a request that carries
only a bearer token is answered by Access's login redirect and the Worker never
sees it.

That made the documented publishing story impossible for the people it is written
for. An invited user mints a token at `/admin/integrations`, sets
`RTFX_API_TOKEN`, runs `rtfx publish` (or the Claude Code plugin, or the MCP
server, or plain `curl`) — and it fails, because the only way past Access is a
service token, which is a *deployment* credential an operator cannot hand out per
person.

### The fix (deployed with the code)

`/api/machine/*` serves the same artifact routes — publish, list, versions,
rollback, views, sharing, delete — behind `requireApiToken` (`src/auth.ts`)
instead of the dashboard's gate. It is deliberately **stricter** than `/api`:

- A bearer token is required. A browser session is refused, which is what keeps
  the surface immune to CSRF once Access is no longer in front of it — a browser
  attaches cookies to a cross-site request by itself, never an `Authorization`
  header.
- Scopes, per-artifact ownership and the paused-account check are unchanged.
- User management, token issuance and workspace membership are **not** mounted
  there at all. They stay on `/api`, edge-gated, and keep refusing API tokens.

### Required Access change — MANUAL, mutates Cloudflare

1. Zero Trust → Access → Applications → **`Artifacts (public)`** → Edit.
2. Add the destination **`rtfx.pro/api/machine`** (this covers everything under
   it).
3. Confirm its single policy is decision **Bypass**.

Access resolves the most specific path first, so `/api/machine` becomes
un-gated while `/api`, `/api/users` and `/admin` stay exactly as they were.

If you would rather keep a separate application, create one named
`Artifacts (machine)` with that one destination and a **Bypass** policy — the
effect is the same.

Nothing about `wrangler.jsonc` changes, and no deploy is needed for the Access
edit itself — but the Worker code carrying the machine surface must already be
deployed before you un-gate the path, or the bypass points at a 404.

### Verify after the change

```bash
# A scoped API token, and no Cloudflare credential of any kind.
export RTFX_API_TOKEN=<a token minted at /admin/integrations>

# 200 and a JSON body. Before the Access change this is a 302 to
# …cloudflareaccess.com, which is exactly the failure being fixed.
curl -si https://rtfx.pro/api/machine/artifacts \
  -H "Authorization: Bearer $RTFX_API_TOKEN" | head -1

# No token: 401 from the Worker, with a Bearer challenge — never a 200.
curl -s -o /dev/null -w '%{http_code}\n' https://rtfx.pro/api/machine/artifacts   # 401

# Credential management is not on this surface at all.
curl -s -o /dev/null -w '%{http_code}\n' https://rtfx.pro/api/machine/users \
  -H "Authorization: Bearer $RTFX_API_TOKEN"                                      # 404

# The dashboard API is untouched — still an Access redirect from a shell.
curl -s -o /dev/null -w '%{http_code}\n' https://rtfx.pro/api/users               # 302

# End to end, as an invited user would: no CF_ACCESS_* variables set.
env -u CF_ACCESS_CLIENT_ID -u CF_ACCESS_CLIENT_SECRET \
  node cli/artifacts.mjs publish /tmp/smoke.html --slug smoke-test --title "Smoke Test"
```

### Optional hardening: an edge rate limit — POST-DEPLOY, MANUAL, mutates Cloudflare

Not required to ship, and deliberately **not** implemented in the Worker. Once
`/api/machine` is bypassed, it is the one authenticated surface with no Access
challenge in front of it, so an unauthenticated flood reaches the Worker (each
request costs an invocation; `identityFromApiToken` rejects a malformed token on
shape before it costs a D1 read, which is the cheap half of the defence).

If that traffic ever shows up, add it at the edge rather than in code — Security
→ WAF → Rate limiting rules, on `http.request.uri.path starts_with
"/api/machine"`, counting responses with status 401. Edge rules are the right
layer: they are free of Worker invocations, adjustable without a deploy, and
reversible in one click. Nothing in this repo depends on the rule existing.

### Rollback

Delete the `rtfx.pro/api/machine` destination. Access gates it again, and
publishing goes back to needing service-token headers (`/api` is unchanged and
still accepts them alongside the bearer token). Clients do **not** silently fall
back in that state — Access answers with a sign-in page rather than a 404, and
they report that by name, which is the honest outcome: the credential the user
has is genuinely not sufficient any more.

## 6. Redeploy + secret — MANUAL, mutates Cloudflare

```bash
npx wrangler deploy
npx wrangler secret put CF_API_TOKEN   # optional: only needed for in-app user management
```

`CF_API_TOKEN` needs "Access: Apps and Policies — Edit" scope for the account.

## 6b. Public site + crawler surface (issue #29)

No Cloudflare mutation beyond the Access bypass destinations in step 5.3. After deploying,
confirm each public path answers **unauthenticated** — run this from a shell with no browser
session, so an Access redirect (302 to `…cloudflareaccess.com`) shows up as a failure:

```bash
for p in / /docs /login /privacy /terms /robots.txt /sitemap.xml /llms.txt /og.svg /og.png /logo.png; do
  printf '%-14s ' "$p"; curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "https://rtfx.pro$p"
done
# all 200; / /docs /login /privacy /terms are text/html, robots+llms text/plain,
# sitemap application/xml, og.png + logo.png image/png

# No public page may set a cookie of its own (issue #36) — the only cookie in the
# product is the Cloudflare Access session, and it is set by signing in, not by reading.
for p in / /docs /login /privacy /terms; do
  printf '%-10s ' "$p"; curl -sI "https://rtfx.pro$p" | grep -ci '^set-cookie:'
done
# all 0

curl -s https://rtfx.pro/robots.txt        # allows /, /docs, /login, /privacy, /terms; Sitemap: https://rtfx.pro/sitemap.xml
curl -s https://a.rtfx.pro/robots.txt      # Disallow: /  (artifact content is access-controlled)
curl -sI https://a.rtfx.pro/<some-slug>/ | grep -i x-robots-tag   # noindex, nofollow, noarchive
```

Gated paths must still challenge or 404 without a session:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://rtfx.pro/admin     # 302 to Cloudflare Access
curl -s -o /dev/null -w '%{http_code}\n' https://a.rtfx.pro/docs    # 404 — content host serves files only
```

Then, in a browser: `/` and `/docs` render, the **Request access** form returns
"Request received", and `view-source:` shows `<link rel="canonical">` plus the OpenGraph tags.
Also confirm the issue-#36 surface: `/privacy` and `/terms` render with the site chrome, the
footer of every public page links to both, and the cookie notice appears once, dismisses, and
stays dismissed on reload (it is remembered in `localStorage`, not in a cookie). Before
publishing to real users, fill in the two placeholders both legal pages call out — the
contact address and the governing law — see [PUBLIC_SITE.md](PUBLIC_SITE.md).
Finally submit `https://rtfx.pro/sitemap.xml` in Google Search Console and Bing Webmaster
Tools — nothing in the deploy does that for you. Details: [PUBLIC_SITE.md](PUBLIC_SITE.md).

## 7. Smoke test (after deploy)

```bash
# Both hosts respond; the content host must not serve the app dashboard.
curl -i https://rtfx.pro/health
curl -i https://a.rtfx.pro/admin        # expect 404 — content hosts never serve /admin

export ARTIFACTS_URL=https://rtfx.pro
# The normal path, and the one an invited user has: a scoped API token, no
# Cloudflare credential. Needs §5e to have been done.
export RTFX_API_TOKEN=<a token minted at /admin/integrations>

# Advanced / self-host only: the service token is what gets a request past
# Access on an instance where every path is still edge-gated. It is a
# deployment credential — never hand it to a user.
# export CF_ACCESS_CLIENT_ID=<artifacts-cli service token client id>
# export CF_ACCESS_CLIENT_SECRET=<artifacts-cli service token secret>

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
