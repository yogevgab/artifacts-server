# Architecture

A single Cloudflare Worker (TypeScript + [Hono](https://hono.dev)) fronts R2 and D1, sitting
behind Cloudflare Access.

## Request flow

```
Cloudflare Access (login gate + allow-list)
        │  forwards a signed JWT (Cf-Access-Jwt-Assertion) on every request
        ▼
Worker (Hono router)
   GET /                     gallery, filtered to what the viewer may see
   GET /<slug>/…             serve the current version's files (per-artifact authz)
   GET /v/<slug>/<n>/…       admin-only preview of a specific version
   GET /admin                admin dashboard (publish, access, versions, users)
   /api/*                    JSON API (admin-only)
        │
        ├── R2  (binding FILES)  — files at  <slug>/v<N>/<path>
        └── D1  (binding DB)     — metadata
```

## Authentication vs authorization

- **Authentication** is Cloudflare Access's job: it gates the hostname, runs the login (email
  one-time-PIN), and holds the allow-list of who may sign in. The Worker never sees passwords.
- **Authorization** is the Worker's job. It verifies the Access JWT (`src/auth.ts`) against
  either configured application AUD, derives the caller's identity (`getIdentity`), and decides:
  - **admin** — email in `ADMIN_EMAILS`, or a service-token `common_name` in
    `ADMIN_SERVICE_TOKENS`. A valid token is not admin by itself.
  - **per-artifact view** (`src/authz.ts`, `canView`) — admins see all; `everyone` artifacts are
    visible to any signed-in user; `restricted` artifacts only to granted emails.

## Data model (D1)

- `artifacts` — one row per artifact: slug, title, description, current type/entry/counts,
  `visibility` (`restricted` | `everyone`), and `current_version`.
- `artifact_grants` — `(slug, email)` allow-list for restricted artifacts.
- `artifact_versions` — `(slug, version)` one row per immutable version, with per-version
  type/entry/counts/note.

The full schema is `schema.sql`; incremental changes live in `migrations/`.

## Storage layout (R2)

Every version's files live under `<slug>/v<N>/…`. A single HTML upload becomes
`<slug>/v<N>/index.html`; a `.zip` bundle is unzipped and each entry stored. The public URL
`/<slug>/…` serves the artifact's `current_version`; `/v/<slug>/<n>/…` serves a specific one.

## User management → Cloudflare Access

Cloudflare Access is the **source of truth** for the login allow-list. The app doesn't keep a
user table; instead `src/access-api.ts` reads and writes the viewer application's `— humans`
policy directly via the Cloudflare API (requires `CF_API_TOKEN` + the account/app/policy ids).
`setAllowlist` round-trips the whole policy and only overrides the email include list, always
preserving admin emails.

## Modules

| File | Responsibility |
|---|---|
| `src/index.ts` | Routing; gallery filtering; version-aware serving; `/v/` preview. |
| `src/auth.ts` | Access JWT verification, `getIdentity`, `requireAdmin`. |
| `src/authz.ts` | Pure `canView(identity, visibility, granted)`. |
| `src/serve.ts` | R2 file serving + content types. |
| `src/api.ts` | `/api` endpoints: publish, delete, access, versions, users. |
| `src/db.ts` | All D1 queries. |
| `src/access-api.ts` | Cloudflare Access allow-list management. |
| `src/upload.ts` | Zip processing / single-file wrapping. |
| `src/pages.ts`, `src/admin.ts` | Server-rendered gallery, 404, and admin HTML. |
| `src/util.ts` | Slug validation (+ reserved slugs), content-type map. |

## Testing

`vitest` with `@cloudflare/vitest-pool-workers` runs tests inside a real Workers runtime with
local R2/D1. Integration tests drive the Hono app via `app.request(...)` and impersonate viewers
with the dev-only `X-Dev-Email` header. No Cloudflare account is needed to run the suite.
