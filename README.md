# artifacts-server

Private, access-gated hosting for landing pages and HTML/[Claude](https://claude.ai) artifacts,
running entirely on **Cloudflare Workers**. A public product site at `/` (plus `/docs` and
`/login`) explains the product and collects access requests; invited people sign in (Cloudflare
Access, email one-time-PIN) to reach one dashboard at `/admin` — publishing, sharing and the
gallery of everything shared with them. Artifacts — single HTML files
or multi-file static bundles — are published from a web dashboard, a CLI, or an agent session
(Claude Code, Hermes). With **per-artifact permissions** and **versioning**.

- 🤖 **Agent-native publishing** — Claude Code, a native MCP server, Hermes, the CLI and the HTTP API all take the same path a human takes; no separate, weaker agent route. See [`plugins/rtfx`](plugins/rtfx) and [`docs/MCP.md`](docs/MCP.md).
- 👥 **Access by identity, not a secret link** — each artifact is private, shared with named people, or open to all signed-in users. Unauthorized and non-existent both return **404**.
- 🕓 **Versioning** — every re-publish is a new immutable version; roll back anytime.
- 📈 **Views log** — see who viewed each artifact, when, which version, and from where — per person, not an aggregate counter.
- 🏢 **Workspaces & roles** — artifacts belong to an account with `owner`/`admin`/`member`/`viewer` roles; instance privilege is re-derived from config, never read from a table.
- 🌐 **Public product site** — `/`, `/docs`, `/login`, `/privacy`, `/terms` and `/waitlist` are reachable by anyone, with SEO metadata, `sitemap.xml`, `robots.txt` and `llms.txt`; everything else needs an identity.
- 🔒 **Access-gated dashboard** — Cloudflare Access handles login for `/admin` and the API; sign-in is passwordless (one-time email code) and the app stores no passwords.
- 🖼️ **One dashboard** — publish and manage under **Artifacts**; everything shared with you under **Gallery**. Same shell, same nav, same brand.
- 🔑 **API tokens** — hashed bearer tokens for server-to-server publishing (Hermes Cloud, CI), scoped, owner-bound and revocable.
- ☁️ **All Cloudflare** — Worker + R2 (files) + D1 (metadata). No servers, no database to run.

> **Stack:** TypeScript · [Hono](https://hono.dev) · Cloudflare Workers / R2 / D1 · Cloudflare Access

**Not built yet**, and deliberately not implied anywhere in the copy: per-link passwords or
shared link secrets, link expiry, custom domains for artifacts, comments/approvals, a public
gallery of artifacts, and **self-serve signup or billing of any kind** — access is granted by
invitation, by a person, and nothing is charged for rtfx.pro today. Access is
by identity only. The competitive reasoning, and the full
table-stakes-vs-differentiators split, is in [`docs/POSITIONING.md`](docs/POSITIONING.md) and
published at [`/docs#why-rtfx`](https://rtfx.pro/docs#why-rtfx).

---

## How it works

```
                              /  and  /waitlist  (always public)
                                        │
Browser / CLI ─────────────────────────┼──────────────────────────▶  Worker (Hono)
                    ┌──────────── Cloudflare Access ────────────┐          │
                    │  login gate (email OTP) + allow-list      │────▶     │
                    └───────────────────────────────────────────┘          │
                            files · /admin · /api                          │
                        ┌───────────────────────┬────────────────────┐      │
                        ▼                       ▼                    ▼      │
                  R2  (files at            D1 (metadata:        Cloudflare  │
                  <slug>/v<N>/…)           artifacts, grants,   Access API ◀┘
                                           versions, waitlist)  (manage users)
```

- **`/` and `/waitlist`** are never behind Cloudflare Access — the public landing page and
  waitlist signup must be reachable by anyone.
- **Cloudflare Access** authenticates every other request (`/admin`, `/api`, artifact
  files) and holds the login allow-list.
- The **Worker** authorizes per-artifact (who sees what), serves the current version of each
  artifact, renders the public site and the dashboard, and exposes a JSON API.
- **R2** stores files under `<slug>/v<N>/…`; **D1** stores metadata.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for details.

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- A **Cloudflare account** with:
  - a **domain (zone)** on the account (you'll serve from a subdomain, e.g. `artifacts.example.com`)
  - **Zero Trust** enabled (pick a team name once in the dashboard — the free plan is fine)
- `npx wrangler login` (authorizes Workers/R2/D1/deploy)

## Quick deploy

```bash
git clone https://github.com/yogevgab/artifacts-server.git
cd artifacts-server
npm install
npx wrangler login

# Optional but recommended: a Cloudflare API token with
# "Access: Apps and Policies — Edit" so setup can wire Access for you.
npm run setup
```

`npm run setup` will prompt for your domain, admin email, Zero Trust team domain, and (optionally)
the API token, then:

1. create the R2 bucket + D1 database and apply the schema,
2. create the two Cloudflare Access applications, their policies, and a CLI service token,
3. fill in `wrangler.jsonc`, deploy, and print your CLI credentials.

`npm run setup` does not yet create the public-bypass Access app described in step 3 of
[Manual deployment](#manual-deployment) below — add it once, by hand, so `/` and `/waitlist`
stay reachable without logging in.

Prefer to skip Access automation? Set `SKIP_ACCESS=1` — it deploys everything else, and you
finish Access from the dashboard (see [Manual deployment](#manual-deployment)).

When it finishes, open `https://<your-domain>/admin`, add users under **Users**, and publish.

## Manual deployment

<details>
<summary>Step-by-step without the setup script</summary>

> Deploying with a separate content-only hostname (multiple `routes` entries, e.g.
> app + content-host isolation)? `npm run setup` only supports a single hostname —
> see [`docs/DEPLOY_RTFX.md`](docs/DEPLOY_RTFX.md) for a worked example runbook.

```bash
npm install
npx wrangler login

# 1. Storage
npx wrangler r2 bucket create artifacts-files
npx wrangler d1 create artifacts-meta        # copy the database_id into wrangler.jsonc
npx wrangler d1 execute artifacts-meta --remote --file schema.sql

# 2. Edit wrangler.jsonc: set routes[0].pattern to your domain, ADMIN_EMAILS,
#    ACCESS_TEAM_DOMAIN, CF_ACCOUNT_ID, and the database_id.

# 3. Deploy (creates the custom domain)
npx wrangler deploy
```

**Cloudflare Access** (Zero Trust dashboard):

1. Create a **self-hosted app** `Artifacts (viewers)` on `your-domain` with two policies:
   - `— humans`: action **Allow**, include the admin email (add more viewers later, or via the app).
   - `— cli`: action **Service Auth**, include a new service token `artifacts-cli`.
2. Create a **self-hosted app** `Artifacts (admin)` on paths `your-domain/admin` **and**
   `your-domain/api`, with the same two policies.
3. So the public landing page and waitlist are reachable without logging in, add a third
   **self-hosted app** `Artifacts (public)` on paths `your-domain/` (exact root) **and**
   `your-domain/waitlist`, with a single policy action **Bypass** (no rule criteria needed). Access
   evaluates the most specific matching app, so this exempts just those two paths — artifact
   links, `/admin` (the gallery included), and `/api` stay behind the viewer/admin apps above.
4. Put the **admin app's AUD** and the **viewer app's AUD** into `ACCESS_AUD` as
   `"<viewerAud>,<adminAud>"`. Put the viewer app id and its `— humans` policy id into
   `ACCESS_VIEWER_APP_ID` / `ACCESS_VIEWER_POLICY_ID`, and the service token's client id into
   `ADMIN_SERVICE_TOKENS`. Redeploy.
5. For in-app user management, store an API token: `npx wrangler secret put CF_API_TOKEN`.

</details>

## Configuration

All config lives in `wrangler.jsonc` (`vars`) plus one secret. See the comments there.

| Setting | What it is |
|---|---|
| `routes[0].pattern` | Hostname to serve from (a zone on your account). |
| `ADMIN_EMAILS` | Comma-separated emails with admin rights. |
| `SUPER_ADMIN_EMAILS` *(optional)* | The operator/owner account(s). A super admin may manage other admins, and can never be paused or removed — the anti-lockout invariant. Defaults to the first `ADMIN_EMAILS` entry, so every deployment has one. |
| `ADMIN_SERVICE_TOKENS` | Access service-token client ids (`…access`) with admin rights (for the CLI). |
| `ACCESS_TEAM_DOMAIN` | Your Zero Trust team domain, `…cloudflareaccess.com`. |
| `ACCESS_AUD` | Comma-separated `viewerAud,adminAud`; the Worker verifies JWTs against either. |
| `CF_ACCOUNT_ID`, `ACCESS_VIEWER_APP_ID`, `ACCESS_VIEWER_POLICY_ID` | Used to manage the login allow-list via the Cloudflare API. |
| `CF_API_TOKEN` *(secret)* | Token with "Access: Apps and Policies — Edit". Only for in-app user management. |
| `PUBLIC_BASE_URL` *(optional)* | Canonical public origin, e.g. `https://rtfx.pro`. Canonical links, OpenGraph URLs, `sitemap.xml` and `llms.txt` are absolute against it, and any other hostname serves a disallow-everything `robots.txt`. Defaults to `https://rtfx.pro` (`SITE.origin` in `src/seo.ts`). |
| `CONTENT_HOSTNAMES` *(optional)* | Hostnames that serve artifact files only — no dashboard, API or product pages. |

## Usage

### Public product site
`https://<your-domain>/` — public, no login required. Positions the product, covers use cases and
differentiators, and collects `/waitlist` access requests. Its two CTAs are deliberately distinct:
**Request access** (for people without an account) and **Sign in** (`/login`, for people with one).
`/docs` is the public documentation page (publishing, Claude Code/Hermes, the access model,
`#why-rtfx`, FAQ). See [docs/PUBLIC_SITE.md](docs/PUBLIC_SITE.md) for the SEO/crawler surface and
the copy rules, and [docs/POSITIONING.md](docs/POSITIONING.md) for what the copy may claim.

### Sign-in
`https://<your-domain>/login` — **public, and must stay outside the Cloudflare Access
application.** It authenticates nobody: it explains that access is by invitation and that invited
users get a one-time code by email, then hands off to `/admin`, which Access gates —
and that hand-off is what triggers the login. It renders three states: signed out, already
signed in, and *paused* (a valid login whose account an admin disabled). There is no password
auth anywhere in this product by design.

### Dashboard
`https://<your-domain>/admin` — publish artifacts, manage per-artifact access, upload new
versions / roll back, and (admins only) manage people. Admins see every artifact, labelled
with its owner; a member sees only the ones they published. The **Gallery** section at
`/admin/gallery` is filtered to what each viewer may *open* — what they own plus what has been
shared with them. `/gallery` is kept as a redirect into it; visiting it signed out goes to
`/login`.

### People (user management)
Admin-only, in the dashboard and at `/api/users`. Cloudflare Access remains the authentication
provider; the local `users` table (`migrations/0007_users.sql`) is **product metadata and state**
layered above the Access allow-list:

| Layer | Holds | Source of truth for |
|---|---|---|
| Cloudflare Access | The login allow-list | Who can authenticate at all |
| `users` table | `status`, display name, notes, `invited_at` / `last_seen_at` / `disabled_at` | Whether this app serves them |
| `ADMIN_EMAILS` / `SUPER_ADMIN_EMAILS` | Privilege | Who is an admin or the operator |

The `role` column only *records* configuration — writing it can never escalate anyone, and the
Worker always re-derives privilege from env. Lifecycle actions: **invite** (adds to the Access
allow-list and creates the row), **pause** (disable — refused on every surface immediately, and
their API tokens are revoked), **re-enable**, and **remove** (drops the login, every artifact
grant and every API token — but never their published artifacts). Safeguards: the super admin
can't be paused or removed by anyone including themselves, only a super admin may act on another
admin, nobody may disable their own account, and API tokens are refused from these routes
entirely.

> If Cloudflare Access gates `/admin` and `/api` to admins only (the default in
> [docs/DEPLOY_RTFX.md](docs/DEPLOY_RTFX.md) step 5), invited members are stopped at the edge before
> the Worker's ownership rules apply. Step 5b there narrows the admin Access app to
> `/api/users` so invited users can reach their own dashboard.

### CLI

```bash
export ARTIFACTS_URL=https://<your-domain>
# One credential: the artifact commands go to /api/machine/…, which authenticates
# this bearer token and nothing else.
export RTFX_API_TOKEN=<rtfx_… token>

# Advanced / self-host only: on an instance that gates every path at the edge,
# these get a request past Cloudflare Access. They grant nothing inside the app,
# and rtfx.pro does not need them (see docs/DEPLOY_RTFX.md §5e).
# export CF_ACCESS_CLIENT_ID=<service-token-client-id>
# export CF_ACCESS_CLIENT_SECRET=<service-token-client-secret>

node cli/artifacts.mjs publish ./page.html --slug my-page --title "My Page"
node cli/artifacts.mjs publish ./site/ --slug demo --title "Demo"   # a folder is zipped
node cli/artifacts.mjs list
node cli/artifacts.mjs publish ./page-v2.html --slug my-page --note "new hero"  # new version
node cli/artifacts.mjs versions my-page
node cli/artifacts.mjs rollback my-page 1
node cli/artifacts.mjs grant my-page alice@example.com
node cli/artifacts.mjs views my-page   # total/unique + recent views log
node cli/artifacts.mjs users                     # directory with role + status
node cli/artifacts.mjs user-add bob@example.com  # invite
node cli/artifacts.mjs user-disable bob@example.com  # pause + revoke their tokens
node cli/artifacts.mjs user-enable bob@example.com

node cli/artifacts.mjs token-create "hermes-cloud" --owner alice@example.com --scopes read,publish
node cli/artifacts.mjs tokens
node cli/artifacts.mjs token-revoke <token-id>
```

`token-*` and `user-*` require an Access login (or the Access service token) — an API token
can't mint or revoke tokens, or change who may sign in.

### Claude Code plugin

This repository is also a Claude Code marketplace. Installing the plugin makes publishing part of
the conversation rather than a separate step:

```
/plugin marketplace add yogevgab/artifacts-server
/plugin install rtfx@rtfx
```

```bash
export RTFX_API_TOKEN=rtfx_…            # dashboard → Integrations (scopes: read, publish)
export ARTIFACTS_URL=https://rtfx.pro   # only when self-hosting
```

| | |
|---|---|
| Skill `publishing-to-rtfx` | Loads on its own when someone says "publish this" / "ship it". |
| `/rtfx:publish [path] [slug]` | Publish or re-publish, then report the URL. |
| `/rtfx:list` · `/rtfx:versions` · `/rtfx:rollback` | Inventory, history, and going back. |
| `/rtfx:setup` | Check credentials and connectivity (prints a token's id, never the token). |

The publisher (`plugins/rtfx/scripts/rtfx.mjs`) is dependency-free Node 18+, so it also works as a
plain CLI on a machine that has never checked this repo out. It refuses to upload `.env`, `*.pem`,
`*.key` and similar, and skips `.git`/`node_modules`, printing everything it left out.

Details, testing and design notes: [`docs/CLAUDE_CODE.md`](docs/CLAUDE_CODE.md).

### MCP server

The plugin also ships a native **MCP server** (`plugins/rtfx/scripts/rtfx-mcp.mjs`), so a client
with no shell to run a command in — Claude Desktop, or anything else that speaks MCP — publishes
through tool calls instead. Installing the plugin registers it; for Claude Desktop, point
`claude_desktop_config.json` at the script:

```json
{
  "mcpServers": {
    "rtfx": {
      "command": "node",
      "args": ["/absolute/path/to/plugins/rtfx/scripts/rtfx-mcp.mjs"],
      "env": { "RTFX_API_TOKEN": "rtfx_…" }
    }
  }
}
```

Tools: `publish` (with a `dry_run` that uploads nothing), `list_artifacts`, `get_versions`,
`rollback`, `doctor`, and `update_access` behind an opt-in env var. Same token, same scopes, same
bundle filters — it is a wrapper over the same libraries as the CLI, not a second implementation.
Zero dependencies, no MCP SDK, Node 18+.

Tool schemas, client configuration and when to use the plugin instead:
[`docs/MCP.md`](docs/MCP.md).

### API tokens (server-to-server)

Automated publishers — Hermes Cloud, CI, scripts — authenticate with a hashed API token sent
as `Authorization: Bearer <token>`, instead of a browser login:

```bash
curl -X POST "$ARTIFACTS_URL/api/machine/artifacts" \
  -H "Authorization: Bearer $RTFX_API_TOKEN" \
  -F "slug=my-page" -F "title=My Page" -F "file=@./page.html;type=text/html"
```

- Only a **SHA-256 hash** of each token is stored; the plaintext is shown once, at creation.
- Every token has an **owner** and so inherits that person's ownership rules — an admin token
  manages everything, a user's token only their own artifacts.
- **Scopes** (`read`, `publish`, `manage`) narrow a token below its owner's rights; they never
  widen anyone's. Default is `read,publish`, so a publishing integration can't delete.
- Tokens are revocable (`token-revoke`), can carry an expiry, and are revoked automatically
  when their owner is removed from rtfx.pro.

**Two surfaces, on purpose.** `/api/…` is the dashboard's API: Cloudflare Access gates it at the
edge and a browser session identifies you, so bearer auth there is an *additional* app-layer
check that bypasses nothing. `/api/machine/…` is the same artifact routes for machines — publish,
list, versions, rollback, views, sharing, delete — behind a **stricter** gate that requires a
bearer token and refuses a session outright (`requireApiToken` in `src/auth.ts`). That is what
lets an operator put it on an Access **Bypass** policy, so an invited user can publish with the
token they minted and no Cloudflare credential at all — see
[`docs/DEPLOY_RTFX.md`](docs/DEPLOY_RTFX.md) §5e. User management, token issuance and workspace
membership are deliberately *not* mounted there: they stay edge-gated on `/api`, and refuse API
tokens whatever the path.

Full request/response contract, error codes and rollback flow:
[`docs/HERMES_CLOUD.md`](docs/HERMES_CLOUD.md).

### Permissions
Cloudflare Access decides **who can log in** (managed in the app's *People* panel, which writes
the Access allow-list). The Worker decides **who sees each artifact**: `restricted` (only granted
emails + admins) or `everyone` (any signed-in user). New artifacts are private by default. A
direct URL a viewer lacks access to returns 404.

**Ownership (invite-only access).** Every artifact belongs to the person who published it
(`artifacts.owner_email`). Admins (`ADMIN_EMAILS`, plus `ADMIN_SERVICE_TOKENS`) manage
everything; a signed-in member manages only their own — their dashboard, `/api/artifacts`
list, version previews and analytics are scoped to artifacts they own, and any attempt to
read or change someone else's returns **404**, so a slug they don't own is indistinguishable
from one that doesn't exist. Being *granted* view access to an artifact never confers
management rights, and publishing to a slug someone else owns is refused (`409 slug_taken`)
rather than adding a version to their artifact. Managing the sign-in allow-list (`/api/users`)
is admin-only, and a non-admin owner's grants deliberately do **not** add anyone to that
allow-list — only an admin invites new people.

Artifacts with no owner (published before this model, or by a service token, which has no
email) are manageable by admins only. Run `migrations/0005_owner_email.sql` on an existing
database; it backfills owners from `created_by` where that was a real email. API tokens live
in `migrations/0006_api_tokens.sql`, and the local user directory in
`migrations/0007_users.sql` (additive and backfilled from artifact owners — an Access-allowed
person with no row is still a valid user, so applying it can't lock anyone out).

**Accounts / workspaces.** An artifact also belongs to an **account** — the workspace that owns
it, and later the thing a plan is billed to (`artifacts.account_id`). Every person gets a
personal workspace automatically; a team workspace can have several members with an *account
role* of `owner`, `admin`, `member` or `viewer`. `member` and up manage the workspace's
artifacts; a `viewer` can open them but not change them.

Four ideas are kept apart on purpose, and it is worth reading the row you care about twice:

| | Answers | Comes from |
|---|---|---|
| **Identity** | who you are | Cloudflare Access + `users` |
| **Account** | whose artifacts these are | `accounts` |
| **Membership** | what you may do *in one workspace* | `account_members` |
| **Instance role** | what you may do to *this deployment* | `ADMIN_EMAILS` / `SUPER_ADMIN_EMAILS` |

Being `owner` of a workspace is **not** being an admin of the instance, and there is no way to
become one by writing to the database: instance privilege is re-derived from configuration on
every request and is never read from a table. That is the property the test suite guards hardest.

This is entirely additive. `account_id` is nullable everywhere, `owner_email` is still checked
first, and an artifact the backfill never adopted behaves exactly as it did before. Run
`migrations/0008_accounts.sql`, `0009_account_links.sql` and `0010_backfill_accounts.sql` on an
existing database — 0008 and 0010 are safe to re-run, 0009 adds two columns and is not (check
`PRAGMA table_info(artifacts)` first). None of them is strictly required: the Worker provisions
the same rows on first use. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full model.

### Versioning
Each publish to an existing slug creates a new immutable version and makes it live; previous
versions are kept. Admins preview any version at `/v/<slug>/<n>/`; roll back from the dashboard
or `rollback <slug> <n>`.

### Views log
Each artifact records a view when a signed-in person loads an HTML page (assets, machine/
service-token fetches, and admin version previews aren't counted). The admin dashboard and
`views <slug>` show total/unique counts and a recent log (time · viewer · version · country).
Views are retained indefinitely; prune the `artifact_views` table if it grows large.

## Development

```bash
npm install
npm run dev        # wrangler dev on http://localhost:8787 (no Access gate; you are admin)
npm test           # vitest (unit + integration via @cloudflare/vitest-pool-workers)
npm run typecheck
npm run validate:plugin  # structural check of the Claude Code plugin files
npm run check      # typecheck + tests + plugin validation
```

Locally there's no Access gate. To simulate a specific viewer, send an `X-Dev-Email` header; to
simulate a signed-out visitor (e.g. to see `/gallery` redirect to `/login`), send
`X-Dev-Anonymous: true`. Both are honored only when `DEV_LOGIN=true`, which `npm run dev` sets —
never in production.

```bash
# once, seed the local DB:
npx wrangler d1 execute artifacts-meta --local --file schema.sql
```

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please run `npm run check`
before opening a PR. Security reports: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
