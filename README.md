# artifacts-server

Private, access-gated hosting for landing pages and HTML/[Claude](https://claude.ai) artifacts,
running entirely on **Cloudflare Workers**. A public product site at `/` (plus `/docs`, `/signup`
and `/login`) explains the product and lets people start on the Free plan. Sign-in is app-owned
and passwordless: rtfx.pro emails a one-time code or magic link, then a host-only `rtfx_session`
keeps the browser signed in. One dashboard at `/admin` handles publishing, sharing and the gallery
of everything shared with you. Artifacts — single HTML files or multi-file static bundles — are
published from a web dashboard, a CLI, or an agent session (Claude Code, Hermes). With
**per-artifact permissions** and **versioning**.

- 🤖 **Agent-native publishing** — Claude Code, a native MCP server, Hermes, the CLI and the HTTP API all take the same path a human takes; no separate, weaker agent route. See [`plugins/rtfx`](plugins/rtfx) and [`docs/MCP.md`](docs/MCP.md).
- 👥 **Access by identity, not a secret link** — each artifact is private, shared with named people, or open to all signed-in users. Unauthorized and non-existent both return **404**.
- 🕓 **Versioning** — every re-publish is a new immutable version; roll back within your plan's
  retention window (free keeps the last 5; paid plans keep everything).
- 📈 **Views log** — see who viewed each artifact, when, which version, and from where — per person, not an aggregate counter.
- 🏢 **Workspaces & roles** — artifacts belong to an account with `owner`/`admin`/`member`/`viewer` roles; instance privilege is re-derived from config, never read from a table.
- 🌐 **Public product site** — `/`, `/docs`, `/signup`, `/login`, `/privacy` and `/terms` are reachable by anyone, with SEO metadata, `sitemap.xml`, `robots.txt` and `llms.txt`; everything else needs an identity.
- 🔒 **Access-gated dashboard** — app-owned email OTP/magic-link sign-in for `/admin` and the API; the app stores no passwords.
- 🖼️ **One dashboard** — publish and manage under **Artifacts**; everything shared with you under **Gallery**. Same shell, same nav, same brand.
- 🔑 **API tokens** — hashed bearer tokens for server-to-server publishing (Hermes Cloud, CI), scoped, owner-bound and revocable.
- ☁️ **All Cloudflare** — Worker + R2 (files) + D1 (metadata). No servers, no database to run.

> **Stack:** TypeScript · [Hono](https://hono.dev) · Cloudflare Workers / R2 / D1 / Email Sending · Lemon Squeezy

**Not built yet**, and deliberately not implied anywhere in the copy: per-link passwords or
shared link secrets, custom domains for artifacts, comments/approvals, a public gallery of
artifacts, usage-based billing, and per-seat billing beyond the fixed seats included in each plan.
Access is by identity only; share links can carry optional expiry. The competitive reasoning, and the full
table-stakes-vs-differentiators split, is in [`docs/POSITIONING.md`](docs/POSITIONING.md) and
published at [`/docs#why-rtfx`](https://rtfx.pro/docs#why-rtfx).

---

## How it works

```
                    /, /docs, /signup, /login and legal pages (public)
                                        │
Browser / CLI ─────────────────────────┼──────────────────────────▶  Worker (Hono)
                    ┌──────── app-owned email OTP / magic link ───────┐    │
                    │  rtfx_session cookie + users/accounts tables    │────┘
                    └─────────────────────────────────────────────────┘
                            files · /admin · /api                          │
                        ┌───────────────────────┬────────────────────┐      │
                        ▼                       ▼                    ▼      │
                  R2  (files at            D1 (metadata:        Email +     │
                  <slug>/v<N>/…)           artifacts, grants,   billing     │
                                           versions, sessions)  webhooks    │
```

- **`/`, `/signup`, `/login`, `/docs`, `/privacy`, `/terms`, `robots.txt`, `sitemap.xml` and
  `llms.txt`** are public product/crawler pages.
- **rtfx.pro sessions** authenticate dashboard/API/artifact requests with a signed `rtfx_session`
  cookie created after email-code or magic-link verification.
- The **Worker** authorizes per-artifact (who sees what), serves the current version of each
  artifact, renders the public site and the dashboard, and exposes a JSON API.
- **R2** stores files under `<slug>/v<N>/…`; **D1** stores metadata.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for details.

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- A **Cloudflare account** with a **domain (zone)** on the account (you'll serve from a
  hostname you control, plus a separate content hostname if you want the same isolation as rtfx.pro).
- Cloudflare Workers, R2, D1 and Email Sending enabled.
- `npx wrangler login` (authorizes Workers/R2/D1/deploy)

## Quick deploy

```bash
git clone https://github.com/yogevgab/artifacts-server.git
cd artifacts-server
npm install
npx wrangler login

npm run setup
```

`npm run setup` is the simple, single-hostname path: it creates the R2 bucket + D1 database,
applies the schema, fills the basic Worker config, deploys, and leaves you to add production-only
choices such as a separate content hostname, Email Sending, billing secrets and legal values. For a
multi-hostname deployment like rtfx.pro, use [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) plus the
manual steps below instead of relying on the setup script.

When it finishes, configure Email Sending and `SESSION_SECRET`, then open
`https://<your-domain>/signup` or `/login` to create the first account. `ADMIN_EMAILS` in
`wrangler.jsonc` decides who gets platform-admin rights.

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

# 2. Edit wrangler.jsonc: set route patterns to your app/content hostnames,
#    ADMIN_EMAILS, PUBLIC_BASE_URL, CONTENT_HOSTNAMES and the database_id.

# 3. Required secrets / mail
npx wrangler secret put SESSION_SECRET
# Optional, only if selling paid plans:
# npx wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET

# 4. Deploy (creates the custom domains)
npx wrangler deploy
```

**Email Sending is required for sign-in.** Enable it for the domain, verify SPF/DKIM/DMARC, and keep
`MAIL_FROM` inside the Worker `send_email.allowed_sender_addresses`. The app sends a one-time code
or magic link, then issues its own host-only `rtfx_session` cookie. Fresh deployments do not need
Cloudflare Access.

</details>

## Configuration

All config lives in `wrangler.jsonc` (`vars`) plus one secret. See the comments there.

| Setting | What it is |
|---|---|
| `routes[0].pattern` | Hostname to serve from (a zone on your account). |
| `ADMIN_EMAILS` | Comma-separated emails with admin rights. |
| `SUPER_ADMIN_EMAILS` *(optional)* | The operator/owner account(s). A super admin may manage other admins, and can never be paused or removed — the anti-lockout invariant. Defaults to the first `ADMIN_EMAILS` entry, so every deployment has one. |
| `MAIL_FROM` | Verified sender address for OTP/magic-link email. Must match the Email Sending binding. |
| `SESSION_SECRET` *(secret)* | At least 32 bytes; signs the app-owned `rtfx_session` cookie. |
| `LEMONSQUEEZY_WEBHOOK_SECRET` *(secret, optional)* | Verifies billing webhooks when paid plans are enabled. |
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
`https://<your-domain>/login` — public, app-owned sign-in. It emails a one-time code or magic
link, verifies it, then sets a host-only `rtfx_session` cookie. It renders signed-out, already
signed-in and paused-account states. There is no password auth and no Cloudflare Access dependency
in a fresh deployment.

### Dashboard
`https://<your-domain>/admin` — publish artifacts, manage per-artifact access, upload new
versions / roll back, and (admins only) manage people. Admins see every artifact, labelled
with its owner; a member sees only the ones they published. The **Gallery** section at
`/admin/gallery` is filtered to what each viewer may *open* — what they own plus what has been
shared with them. `/gallery` is kept as a redirect into it; visiting it signed out goes to
`/login`.

### People (user management)
Admin-only, in the dashboard and at `/api/users`. The app owns identity with signed sessions and
stores account/user state in D1:

| Layer | Holds | Source of truth for |
|---|---|---|
| `rtfx_session` cookie | Signed email/account identity | Who this browser request is |
| `users` / `accounts` tables | status, display name, workspace membership, roles and audit state | Whether this app serves them and what they can manage |
| `ADMIN_EMAILS` / `SUPER_ADMIN_EMAILS` | Platform privilege | Who is an operator/admin for the whole instance |

The Worker re-derives platform privilege from config, never from a user-writable table. Lifecycle
actions can pause/re-enable/remove accounts and revoke API tokens, but API tokens are refused from
user-management routes entirely.

### CLI

```bash
export ARTIFACTS_URL=https://<your-domain>
# One credential: the artifact commands go to /api/machine/…, which authenticates
# this bearer token and nothing else.
export RTFX_API_TOKEN=<rtfx_… token>

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

`token-*` and `user-*` require an app session with the right platform/workspace role — an API
token can't mint or revoke tokens, or change who may sign in.

### Claude Code plugin

This repository is also a Claude Code marketplace. Installing the plugin makes publishing part of
the conversation rather than a separate step:

```
/plugin marketplace add yogevgab/artifacts-server
/plugin install rtfx@rtfx
```

Then sign in from the session — no token to copy, paste or store:

```
/rtfx:login
```

That runs an OAuth authorization-code flow with PKCE against the instance, on a loopback redirect,
and writes a `0600` credential to `~/.config/rtfx/credentials.json` (refresh tokens rotate;
`/rtfx:logout` revokes both tokens and deletes it). For CI and scripted use, an environment token
is the fallback and takes precedence over any stored sign-in:

```bash
export RTFX_API_TOKEN=rtfx_…            # dashboard → Integrations (scopes: read, publish)
export ARTIFACTS_URL=https://rtfx.pro   # only when self-hosting
```

| | |
|---|---|
| Skill `publishing-to-rtfx` | Loads on its own when someone says "publish this" / "ship it". |
| `/rtfx:publish [path] [slug]` | Publish or re-publish, then report the URL. |
| `/rtfx:list` · `/rtfx:versions` · `/rtfx:rollback` | Inventory, history, and going back. |
| `/rtfx:login` · `/rtfx:logout` | Browser sign-in, and revoking it. |
| `/rtfx:setup` | Check credentials and connectivity (prints a token's id, never the token). |

The publisher (`plugins/rtfx/scripts/rtfx.mjs`) is dependency-free Node 18+, so it also works as a
plain CLI on a machine that has never checked this repo out. It refuses to upload `.env`, `*.pem`,
`*.key` and similar, and skips `.git`/`node_modules`, printing everything it left out.

This works today and needs nobody's approval — any repository with a valid
`.claude-plugin/marketplace.json` is a Claude Code marketplace. The plugin is **not** listed in
Anthropic's community or official marketplace; what a submission to the first would need is written
down in [`docs/ANTHROPIC_PLUGIN_SUBMISSION.md`](docs/ANTHROPIC_PLUGIN_SUBMISSION.md).

Details, testing and design notes: [`docs/CLAUDE_CODE.md`](docs/CLAUDE_CODE.md). Release notes:
[`plugins/rtfx/CHANGELOG.md`](plugins/rtfx/CHANGELOG.md).

### Claude Desktop Extension

Download it from the current release or build it locally:

```text
https://github.com/yogevgab/artifacts-server/releases/download/v1.2.0/rtfx.dxt
```

```bash
npm run dxt:pack
open dist/rtfx.dxt
```

That installs the same local MCP server without hand-editing `claude_desktop_config.json`. Because it
runs on the user's machine, it can publish local paths/folders. Leave the optional API token blank
when using the browser OAuth credential store; expose access management only when explicitly needed.
Full details: [`docs/CLAUDE_DESKTOP.md`](docs/CLAUDE_DESKTOP.md).

### MCP server

The plugin also ships a native **MCP server** (`plugins/rtfx/scripts/rtfx-mcp.mjs`), so a client
with no shell to run a command in — Claude Desktop, or anything else that speaks MCP — publishes
through tool calls instead. Installing the plugin registers it; for a manual Claude Desktop setup,
point `claude_desktop_config.json` at the script:

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

**Two surfaces, on purpose.** `/api/…` is the dashboard's browser/session API: the app-owned
`rtfx_session` identifies you and ordinary role checks decide what you may do. `/api/machine/…` is
the same artifact surface for machines — publish, list, versions, rollback, views, sharing, delete
— behind a **stricter** gate that requires a bearer token and refuses a browser session outright
(`requireApiToken` in `src/auth.ts`). User management, token issuance and workspace membership are
deliberately *not* mounted there: they require a signed-in app session with the right role, and
refuse API tokens whatever the path.

Full request/response contract, error codes and rollback flow:
[`docs/HERMES_CLOUD.md`](docs/HERMES_CLOUD.md).

### Permissions
The app decides **who is signed in** by verifying an emailed code or magic link and setting an
`rtfx_session` cookie. The Worker decides **who sees each artifact**: `restricted` (only granted
emails + admins) or `everyone` (any signed-in user). New artifacts are private by default. A direct
URL a viewer lacks access to returns 404.

**Ownership.** Every artifact belongs to the person/workspace that published it
(`artifacts.owner_email` / `artifacts.account_id`). Instance admins (`ADMIN_EMAILS` /
`SUPER_ADMIN_EMAILS`) manage everything; ordinary signed-in members manage the artifacts their
workspace role allows — their dashboard, `/api/artifacts` list, version previews and analytics are
scoped to artifacts they own/manage. Attempts to read or change someone else's artifact return
**404**, so a slug they don't own is indistinguishable from one that doesn't exist. Being *granted*
view access never confers management rights, and publishing to a slug someone else owns is refused
(`409 slug_taken`) rather than adding a version to their artifact. Account/user management is
admin-only, and API tokens are deliberately refused from those routes.

Artifacts with no owner (published before this model, or by a legacy service token with no email)
are manageable by admins only. Run `migrations/0005_owner_email.sql` on an existing database; it
backfills owners from `created_by` where that was a real email. API tokens live in
`migrations/0006_api_tokens.sql`, and the local user/account tables in `0007` onward are additive.

**Accounts / workspaces.** An artifact also belongs to an **account** — the workspace that owns
it, and later the thing a plan is billed to (`artifacts.account_id`). Every person gets a
personal workspace automatically; a team workspace can have several members with an *account
role* of `owner`, `admin`, `member` or `viewer`. `member` and up manage the workspace's
artifacts; a `viewer` can open them but not change them.

Four ideas are kept apart on purpose, and it is worth reading the row you care about twice:

| | Answers | Comes from |
|---|---|---|
| **Identity** | who you are | `rtfx_session` + `users` |
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
Each publish to an existing slug creates a new immutable version and makes it live. On the free
plan the five most recent versions are retained and older ones expire — their bytes are removed
but the history entry stays, so a version list never has holes in it. Paid plans keep every
version. Previous
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
npm run dev        # wrangler dev on http://localhost:8787 (DEV_LOGIN: no sign-in, you are admin)
npm test           # vitest (unit + integration via @cloudflare/vitest-pool-workers)
npm run typecheck
npm run validate:plugin  # structural check of the Claude Code plugin files
npm run check      # typecheck + tests + plugin validation
```

Locally there is no real email challenge. To simulate a specific viewer, send an `X-Dev-Email` header; to
simulate a signed-out visitor (e.g. to see `/gallery` redirect to `/login`), send
`X-Dev-Anonymous: true`. Both are honored only when `DEV_LOGIN=true`, which `npm run dev` sets —
never in production.

```bash
# once, seed the local DB:
npx wrangler d1 execute artifacts-meta --local --file schema.sql
```

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please run `npm run check`
before opening a PR. Security reports: see [SECURITY.md](SECURITY.md) — GitHub Security
Advisories, never a public issue.

## Self-hosting

Everything needed to run your own instance is in this repository; you supply your own Cloudflare
account, R2/D1, mail path, session secret, optional Lemon Squeezy billing config, and your own
legal values — the `/privacy` and `/terms` pages ship as an operator template and say so on the
page. See [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md).

## Open source, and where the line is

The source is [MIT](LICENSE) and public on purpose: an access-control product should let you read
the code that enforces the access. The Worker, the plugin, the local and remote MCP servers, the
CLI, the tests and the docs are all here, and the parts that run on your own machine are not held
back.

The hosted `rtfx.pro` service is operated separately from this source. Its customer data, live
account configuration, support and billing pipelines and commercial materials are not in this
repository — and the name, mark and domain are not part of the MIT grant, which is a copyright
licence and does not license trademarks. Fork it and run it; please call it your own thing.

The full boundary — what is intentionally public, what stays out, and why — is in
[`OPEN_SOURCE.md`](OPEN_SOURCE.md). The threat model, the plugin's credential handling and the
local-vs-remote MCP boundary are in [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE)
