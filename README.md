# artifacts-server

Private, access-gated hosting for landing pages and HTML/[Claude](https://claude.ai) artifacts,
running entirely on **Cloudflare Workers**. Authorized people sign in (Cloudflare Access,
email one-time-PIN); an admin publishes artifacts — single HTML files or multi-file static
bundles — from a web dashboard or a CLI. With **per-artifact permissions** and **versioning**.

- 🔒 **Access-gated** — Cloudflare Access handles login; no passwords stored by the app.
- 👥 **Per-artifact permissions** — each artifact is private, shared with specific people, or open to all signed-in users.
- 🕓 **Versioning** — every re-publish is a new immutable version; roll back anytime.
- 📈 **Views log** — see who viewed each artifact, when, which version, and from where.
- 🖼️ **Gallery + dashboard** — a filtered index for viewers, an admin UI to publish and manage.
- 🧑‍💻 **CLI** — publish and manage from your terminal.
- ☁️ **All Cloudflare** — Worker + R2 (files) + D1 (metadata). No servers, no database to run.

> **Stack:** TypeScript · [Hono](https://hono.dev) · Cloudflare Workers / R2 / D1 · Cloudflare Access

---

## How it works

```
                    ┌──────────── Cloudflare Access ────────────┐
Browser / CLI ─────▶│  login gate (email OTP) + allow-list      │────▶  Worker (Hono)
                    └───────────────────────────────────────────┘          │
                              gallery · files · /admin · /api               │
                        ┌───────────────────────┬────────────────────┐      │
                        ▼                       ▼                    ▼      │
                  R2  (files at            D1 (metadata:        Cloudflare  │
                  <slug>/v<N>/…)           artifacts, grants,   Access API ◀┘
                                           versions)            (manage users)
```

- **Cloudflare Access** authenticates every request and holds the login allow-list.
- The **Worker** authorizes per-artifact (who sees what), serves the current version of each
  artifact, renders the gallery/dashboard, and exposes a JSON API.
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

Prefer to skip Access automation? Set `SKIP_ACCESS=1` — it deploys everything else, and you
finish Access from the dashboard (see [Manual deployment](#manual-deployment)).

When it finishes, open `https://<your-domain>/admin`, add users under **Users**, and publish.

## Manual deployment

<details>
<summary>Step-by-step without the setup script</summary>

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
3. Put the **admin app's AUD** and the **viewer app's AUD** into `ACCESS_AUD` as
   `"<viewerAud>,<adminAud>"`. Put the viewer app id and its `— humans` policy id into
   `ACCESS_VIEWER_APP_ID` / `ACCESS_VIEWER_POLICY_ID`, and the service token's client id into
   `ADMIN_SERVICE_TOKENS`. Redeploy.
4. For in-app user management, store an API token: `npx wrangler secret put CF_API_TOKEN`.

</details>

## Configuration

All config lives in `wrangler.jsonc` (`vars`) plus one secret. See the comments there.

| Setting | What it is |
|---|---|
| `routes[0].pattern` | Hostname to serve from (a zone on your account). |
| `ADMIN_EMAILS` | Comma-separated emails with admin rights. |
| `ADMIN_SERVICE_TOKENS` | Access service-token client ids (`…access`) with admin rights (for the CLI). |
| `ACCESS_TEAM_DOMAIN` | Your Zero Trust team domain, `…cloudflareaccess.com`. |
| `ACCESS_AUD` | Comma-separated `viewerAud,adminAud`; the Worker verifies JWTs against either. |
| `CF_ACCOUNT_ID`, `ACCESS_VIEWER_APP_ID`, `ACCESS_VIEWER_POLICY_ID` | Used to manage the login allow-list via the Cloudflare API. |
| `CF_API_TOKEN` *(secret)* | Token with "Access: Apps and Policies — Edit". Only for in-app user management. |

## Usage

### Dashboard
`https://<your-domain>/admin` — publish artifacts, manage per-artifact access, upload new
versions / roll back, and add/remove users. The gallery at `/` is filtered to what each viewer
may see.

### CLI

```bash
export ARTIFACTS_URL=https://<your-domain>
export CF_ACCESS_CLIENT_ID=<service-token-client-id>
export CF_ACCESS_CLIENT_SECRET=<service-token-client-secret>

node cli/artifacts.mjs publish ./page.html --slug my-page --title "My Page"
node cli/artifacts.mjs publish ./site/ --slug demo --title "Demo"   # a folder is zipped
node cli/artifacts.mjs list
node cli/artifacts.mjs publish ./page-v2.html --slug my-page --note "new hero"  # new version
node cli/artifacts.mjs versions my-page
node cli/artifacts.mjs rollback my-page 1
node cli/artifacts.mjs grant my-page alice@example.com
node cli/artifacts.mjs views my-page   # total/unique + recent views log
node cli/artifacts.mjs users
node cli/artifacts.mjs user-add bob@example.com
```

### Permissions
Cloudflare Access decides **who can log in** (managed in the app's *Users* panel, which writes
the Access allow-list). The Worker decides **who sees each artifact**: `restricted` (only granted
emails + admins) or `everyone` (any signed-in user). New artifacts are private by default. A
direct URL a viewer lacks access to returns 404.

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
npm run check      # typecheck + tests
```

Locally there's no Access gate. To simulate a specific viewer, send an `X-Dev-Email` header
(honored only when `DEV_LOGIN=true`, which `npm run dev` sets — never in production).

```bash
# once, seed the local DB:
npx wrangler d1 execute artifacts-meta --local --file schema.sql
```

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please run `npm run check`
before opening a PR. Security reports: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
