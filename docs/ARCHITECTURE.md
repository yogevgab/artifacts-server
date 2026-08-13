# Architecture

A single Cloudflare Worker (TypeScript + [Hono](https://hono.dev)) fronts R2 and D1, sitting
behind Cloudflare Access.

## Request flow

```
                       /  and  /waitlist  (public — never behind Access)
                                │
                                ▼
Cloudflare Access (login gate + allow-list, everything else)
        │  forwards a signed JWT (Cf-Access-Jwt-Assertion) on every request
        ▼
Worker (Hono router)
   GET /                     public landing page — product pitch, use cases, request-access form
   POST /waitlist            join the waitlist (public; validates + dedupes by email)
   GET /gallery              gallery, filtered to what the viewer may see (signed-in only;
                              anonymous → 302 to /)
   GET /<slug>/…             serve the current version's files (per-artifact authz)
   GET /v/<slug>/<n>/…       preview a specific version (admin or the artifact's owner)
   GET /admin                portal — Overview. One server-rendered section per URL, no
                              client router (see docs/DESIGN.md §4)
   GET /admin/artifacts      publish + the artifact list; admins see every artifact,
                              a member only their own
   GET /admin/artifacts/<slug>  one artifact: versions, views, access, delete
   GET /admin/people         directory, invites, pause/remove (admin only; refuses API tokens)
   GET /admin/integrations   API tokens + CLI/Claude Code/Hermes setup
   GET /admin/settings       account and security facts
   GET /admin/platform       instance configuration readout (super admin only)
   /api/*                    JSON API (signed-in via Access *or* an API token; scoped to
                              what the caller owns. /api/users is admin-only;
                              /api/users + /api/tokens refuse API tokens entirely)
        │
        ├── R2  (binding FILES)  — files at  <slug>/v<N>/<path>
        └── D1  (binding DB)     — metadata (+ waitlist emails)
```

## Authentication vs authorization

- **Authentication** is Cloudflare Access's job for everything except `/` and `/waitlist`: it
  gates the hostname, runs the login (email one-time-PIN), and holds the allow-list of who may
  sign in. The Worker never sees passwords. `/` and `/waitlist` are exempted at the edge (an
  Access app scoped to those two paths with a **Bypass** policy — see README) so the public
  landing page and waitlist signup work with no login. `getIdentity` (`src/auth.ts`) still
  handles the case gracefully at the Worker layer: no valid Access JWT → `null` identity.
- **API tokens** (`src/tokens.ts`) are the second authentication path, for callers that can't do
  an interactive login (Hermes Cloud, CI). `Authorization: Bearer rtfx_<id>_<secret>` is resolved
  by `resolveAuth` *before* Access, and a bad token is a `401` — never a silent downgrade to the
  Access (or dev) identity. Only a SHA-256 hash is stored; the 256-bit secret makes a fast hash
  the right primitive (nothing to dictionary-attack) and the lookup an indexed equality match, so
  no secret is compared in the Worker. A token carries an `owner_email` (or the admin bit), so it
  inherits — and never exceeds — the rights of the person it was issued for; `scopes`
  (`read`/`publish`/`manage`) narrow it further. `/api/users` and `/api/tokens` refuse tokens
  outright (`denyApiToken`), so a leaked token can neither mint another nor widen the login
  allow-list. This is *additional* to Cloudflare Access, which still gates the edge — see
  `docs/HERMES_CLOUD.md`.
- **Authorization** is the Worker's job. It verifies the Access JWT (`src/auth.ts`) against
  either configured application AUD, derives the caller's identity (`getIdentity`), and decides:
  - **admin** — email in `ADMIN_EMAILS`, or a service-token `common_name` in
    `ADMIN_SERVICE_TOKENS`. A valid token is not admin by itself.
  - **dashboard access** (`canUseDashboard`) — admins, and signed-in humans. A non-admin
    service token is refused: ownership is keyed on an email, so a token owns nothing.
  - **per-artifact management** (`src/authz.ts`, `canManage`/`isOwner`) — admins manage every
    artifact; a member manages only those whose `owner_email` is theirs. Everything else
    answers 404, never 403, so another user's slugs stay unprobeable. A view grant confers no
    management rights, and an artifact with no owner is admin-only.
  - **per-artifact view** (`canView`) — admins see all; the owner always sees their own;
    `everyone` artifacts are visible to any signed-in user; `restricted` artifacts only to
    granted emails.

The invite-only access model relies on both layers: Access decides who may sign in at all, and the
Worker decides what each signed-in person may see and manage. Widening the Access path gating
(so members reach `/admin`) is a deliberate, documented operator step — see
`docs/DEPLOY_RTFX.md` §5b.

## Data model (D1)

- `artifacts` — one row per artifact: slug, title, description, current type/entry/counts,
  `visibility` (`restricted` | `everyone`), `current_version`, and `owner_email` (the member
  who may manage it; NULL = admin-only). `owner_email` is set once at creation and never
  changed by a republish, so an admin uploading a new version can't take over someone's
  artifact.
- `artifact_grants` — `(slug, email)` allow-list for restricted artifacts.
- `artifact_versions` — `(slug, version)` one row per immutable version, with per-version
  type/entry/counts/note.
- `artifact_views` — one row per HTML page load by a signed-in person (slug, version, email,
  path, country, referrer, timestamp). Written non-blocking via `waitUntil`.
- `api_tokens` — one row per bearer credential: public `id`, `token_hash` (SHA-256, unique),
  name, `owner_email`, `is_admin`, `scopes`, audit fields (`created_by`, `last_used_at`) and
  `expires_at` / `revoked_at`. Revocation is a tombstone, not a delete, so the audit trail
  survives. `last_used_at` is refreshed at most once every 5 minutes per token.

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
| `src/index.ts` | Routing; landing vs. gallery split; gallery filtering; version-aware serving; `/v/` preview. |
| `src/auth.ts` | Access JWT + bearer-token authentication, `resolveAuth`/`getIdentity`, `requireAdmin`, `requireUser`, `requireScope`, `denyApiToken`. |
| `src/authz.ts` | Pure policy: `canView`, `canManage`, `isOwner`, `canUseDashboard`, `hasScope`. |
| `src/tokens.ts` | API tokens: generation, hashing, scopes, lifecycle queries. |
| `src/serve.ts` | R2 file serving + content types. |
| `src/api.ts` | `/api` endpoints: publish, delete, access, versions, users, tokens. |
| `src/db.ts` | All D1 queries (including waitlist). |
| `src/access-api.ts` | Cloudflare Access allow-list management. |
| `src/upload.ts` | Zip processing / single-file wrapping. |
| `src/pages.ts`, `src/admin.ts` | Server-rendered gallery, 404, and admin HTML. |
| `src/landing.ts` | Server-rendered public landing page + waitlist form. |
| `src/waitlist.ts` | `/waitlist` endpoint: email validation, join/redirect. |
| `src/util.ts` | Slug validation (+ reserved slugs), content-type map. |

## Testing

`vitest` with `@cloudflare/vitest-pool-workers` runs tests inside a real Workers runtime with
local R2/D1. Integration tests drive the Hono app via `app.request(...)` and impersonate viewers
with the dev-only `X-Dev-Email` header, or simulate a signed-out visitor with `X-Dev-Anonymous:
true` (DEV_LOGIN mode otherwise always resolves an identity). API-token flows are exercised
end-to-end with real tokens minted through `/api/tokens` (`withToken` in `test/fixtures.ts`); the
bearer path is checked before dev impersonation, so those tests hit the same code production
does. No Cloudflare account is needed to run the suite.
