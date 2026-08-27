# rtfx.pro production deployment runbook

Production deploy for rtfx.pro: `rtfx.pro` (public site + dashboard/API/admin) +
`a.rtfx.pro` (artifact content only, per the origin isolation in `src/host.ts`).

This document is a checklist for a **human operator** running commands locally. Every
step that creates, modifies, or deletes a Cloudflare resource is labeled
**MANUAL — mutates Cloudflare, run yourself**. Do not let an agent run those steps
unattended; review each one before running it.

It documents the *procedure* for the reference deployment and carries no credential, customer
record or live account secret — that is the line described in [`OPEN_SOURCE.md`](../OPEN_SOURCE.md),
and it is what keeps this file publishable. Running the software on your own domain instead is
[`SELF_HOSTING.md`](SELF_HOSTING.md).

## Already prepared (this repo)

- `wrangler.jsonc` `routes`: `rtfx.pro` and `a.rtfx.pro` (both `custom_domain: true`).
- `wrangler.jsonc` `vars.CONTENT_HOSTNAMES`: `a.rtfx.pro`.
- `npm run validate:deploy` — read-only check that `wrangler.jsonc` is structurally
  consistent (routes/`CONTENT_HOSTNAMES` line up, required bindings exist) and reports
  which fields are still pending manual Cloudflare provisioning. Safe to run any time;
  touches no external resources.

Operator-specific values in `wrangler.jsonc` are intentionally visible when they are not secrets:
routes, `vars.ADMIN_EMAILS`, `vars.MAIL_FROM`, plan variant ids and `PUBLIC_BASE_URL`. Actual
secrets are not committed anywhere: `SESSION_SECRET` and `LEMONSQUEEZY_WEBHOOK_SECRET` are set with
`wrangler secret put`.

## Prerequisites

- `rtfx.pro` is an active zone on the Cloudflare account you'll deploy from.
- (No longer required: Zero Trust. Earlier revisions needed it; the app owns identity now.)
- Formerly: Cloudflare Zero Trust enabled on that account (pick a team name once, in the
  dashboard — free plan is fine).
- `npx wrangler login` has been run.

## Why `npm run setup` doesn't apply here

`scripts/setup.mjs` automates a **single-hostname** starter deploy. This production deployment needs
three routes (`rtfx.pro`, `mcp.rtfx.pro`, `a.rtfx.pro`), app/content-host isolation, Cloudflare Email
Sending, billing-webhook secrets and legal/trust checks. Use the manual steps below instead.

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

This creates the `rtfx.pro`, `mcp.rtfx.pro` and `a.rtfx.pro` custom domains. `/admin` and `/api`
will redirect/reject unsigned requests until app-owned email sign-in and `SESSION_SECRET` are ready
— that's expected.

## 5. Identity — the app owns it

**rtfx.pro no longer uses Cloudflare Access.** The Worker authenticates people
itself: it emails a one-time code, verifies it, and issues a signed session
cookie. Earlier revisions of this runbook described a Zero Trust setup with
viewer/admin/public applications; that is gone, and a fresh deployment should
not recreate it.

If you are migrating an existing instance that still has those applications,
follow `docs/superpowers/plans/2026-08-14-access-cutover-runbook.md` rather than
this section — it flips policies to Bypass, verifies at each step, and rolls
back by flipping one switch.

### 5a. Email — REQUIRED, mutates DNS

Sign-in is an emailed code, so nobody can get in until mail works.

```bash
npx wrangler email sending enable rtfx.pro     # adds SPF + DKIM to the zone
npx wrangler email sending dns get rtfx.pro    # re-run until every record is present
```

Add a DMARC record if the zone has none. Cloudflare sets `p=reject` by default
here, which is strict: unauthenticated mail from the domain is refused outright
rather than spam-foldered, so verify a real send lands in an inbox before you
rely on it.

```bash
npx wrangler email sending send --from no-reply@rtfx.pro --to you@example.com \
  --subject "rtfx.pro mail check" --text "If you can read this, sending works."
```

**Check where it landed.** Inbox is the pass condition; Promotions or Spam means
authentication has not propagated and sign-in codes will be unreliable.

### 5b. The session secret — REQUIRED

Session cookies are signed JWTs. The secret must be at least 32 bytes; the code
refuses a shorter one rather than issuing forgeable sessions.

```bash
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put SESSION_SECRET
```

Rotating it signs everybody out, which is the intended emergency behaviour.

### 5c. Who can get in

There is no allow-list. Anyone can sign up at `/signup`, gets a personal
workspace, and lands on the free plan — see `PLANS` in `src/quota.ts` for what
that includes. Quotas are enforced at publish time, which is what makes open
signup safe.

`vars.ADMIN_EMAILS` still decides who holds platform-admin rights, and
`SUPER_ADMIN_EMAILS` who may manage other admins. Both are configuration, never
database state: no API call and no database write can grant admin.

```bash
# after signing in once, confirm the session and the role
curl -s https://rtfx.pro/whoami -b "rtfx_session=<cookie>"
```

### 5d. The machine API

`/api/machine` authenticates a bearer `rtfx_…` token and nothing else. Under
the old topology it needed a Cloudflare Access Bypass application to be
reachable at all; it does not any more. Mint tokens at `/admin/integrations`.

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $RTFX_API_TOKEN" https://rtfx.pro/api/machine/artifacts
# expect 200
```

### 5e. What the content host serves

`a.rtfx.pro` serves artifact files and the viewer shell, and nothing else — no
`/admin`, no `/api`. A viewer arriving without a session is bounced to the app
host to be identified and handed back; a share-link holder is admitted by the
link alone. None of this needs configuration beyond `vars.CONTENT_HOSTNAMES`.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://a.rtfx.pro/admin        # 404
curl -s -o /dev/null -w '%{http_code}\n' https://a.rtfx.pro/<some-slug>/ # 404 signed out
```

### 5f. Config that is no longer used

These were required by the Access topology and are now dead. Removing them is
safe once no code references them:

| | |
|---|---|
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | JWT verification against Zero Trust |
| `ACCESS_VIEWER_APP_ID`, `ACCESS_VIEWER_POLICY_ID`, `CF_ACCOUNT_ID` | editing the allow-list policy |
| `CF_API_TOKEN` (secret) | the credential that did the editing |
| `ADMIN_SERVICE_TOKENS` | an Access service token that granted admin to the CLI |

`ADMIN_SERVICE_TOKENS` is the one with a real successor: anything that relied on
it for admin rights needs an admin-scoped `rtfx_…` API token instead. Mint that
**before** deleting the Access applications, not after.

## 6. Redeploy + secret — MANUAL, mutates Cloudflare

```bash
npx wrangler deploy
npx wrangler secret put SESSION_SECRET             # if not already set in §5b
npx wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET # only if selling plans
```

`CF_API_TOKEN` is no longer used — it existed to edit the Cloudflare Access
allow-list. See §5f.

## 6b. Public site + crawler surface (issue #29)

After deploying, confirm each public path answers **unauthenticated** — run this from a shell with
no browser session. Historically this also caught an Access redirect to `…cloudflareaccess.com`; a
fresh deployment no longer uses Access, but the smoke still proves public pages are actually public.

```bash
for p in / /docs /login /privacy /terms /robots.txt /sitemap.xml /llms.txt /og.svg /og.png /logo.png; do
  printf '%-14s ' "$p"; curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "https://rtfx.pro$p"
done
# all 200; / /docs /login /privacy /terms are text/html, robots+llms text/plain,
# sitemap application/xml, og.png + logo.png image/png

# No public page may set a cookie of its own (issue #36) — the only cookie in the
# product is our own rtfx_session cookie, and it is set by signing in, not by reading.
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
curl -s -o /dev/null -w '%{http_code}\n' https://rtfx.pro/admin     # 302 to /login when signed out
curl -s -o /dev/null -w '%{http_code}\n' https://a.rtfx.pro/docs    # 404 — content host serves files only
```

Then, in a browser: `/` and `/docs` render, the **Request access** form returns
"Request received", and `view-source:` shows `<link rel="canonical">` plus the OpenGraph tags.
Also confirm the issue-#36 surface: `/privacy` and `/terms` render with the site chrome, the
footer of every public page links to both (plus **Source** and **Security**), and the cookie
notice appears once, dismisses, and stays dismissed on reload (it is remembered in `localStorage`,
not in a cookie). The public pages load no analytics, no third-party script and no font — that is
asserted by `test/legal.test.ts`, and it is what the notice claims, so it has to stay true.

**The legal pages are still an operator template, and the banner stays until they are not.** Both
open with "Operator template — not legal advice" on every deployment including this one. Before
serving real users, fill in what it names: the contact address (`privacy@rtfx.pro` is a
placeholder), the governing law and jurisdiction, and the legal entity's name and registered
address — then have a lawyer review the result. Do not delete the banner ahead of that.
See [PUBLIC_SITE.md](PUBLIC_SITE.md); self-hosters have the same job, in
[SELF_HOSTING.md](SELF_HOSTING.md).
Finally submit `https://rtfx.pro/sitemap.xml` in Google Search Console and Bing Webmaster
Tools — nothing in the deploy does that for you. Details: [PUBLIC_SITE.md](PUBLIC_SITE.md).

## 7. Smoke test (after deploy)

```bash
# Both hosts respond; the content host must not serve the app dashboard.
curl -i https://rtfx.pro/health
curl -i https://a.rtfx.pro/admin        # expect 404 — content hosts never serve /admin

export ARTIFACTS_URL=https://rtfx.pro
# The normal path: a scoped app API token minted at /admin/integrations.
# No Cloudflare credential is involved in a fresh rtfx.pro deployment.
export RTFX_API_TOKEN=<a token minted at /admin/integrations>

echo '<h1>rtfx smoke test</h1>' > /tmp/smoke.html
node cli/artifacts.mjs publish /tmp/smoke.html --slug smoke-test --title "Smoke Test"
node cli/artifacts.mjs list                       # confirm smoke-test appears

curl -i https://a.rtfx.pro/smoke-test/            # renders on the content host when your browser/session
                                                   # or share link is authorized; signed-out curl without
                                                   # a session/share link should not see private content.

node cli/artifacts.mjs delete smoke-test
node cli/artifacts.mjs list                       # confirm smoke-test is gone
```

## Rollback

```bash
npx wrangler deployments list
npx wrangler rollback [deployment-id]
```

If `wrangler.jsonc` config was the problem, revert the relevant local edits and redeploy. If you
are migrating an older instance that still has Cloudflare Access apps in front of it, remember those
apps/policies live outside the Worker and are not changed by a Worker rollback; clean or flip them
in Zero Trust separately.
