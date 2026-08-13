# Architecture

A single Cloudflare Worker (TypeScript + [Hono](https://hono.dev)) fronts R2 and D1, sitting
behind Cloudflare Access.

## Request flow

```
                       /, /docs, /login, /privacy, /terms and /waitlist (public bypass)
                                │
                                ▼
Cloudflare Access (login gate + allow-list, everything else)
        │  forwards a signed JWT (Cf-Access-Jwt-Assertion) on every request
        ▼
Worker (Hono router)
   GET /                     public landing page — product pitch, use cases, request-access form
   GET /docs,/login,/privacy,/terms public product/trust pages
   GET /robots.txt,/sitemap.xml,/llms.txt,/og.svg,/og.png crawler and social-preview files
   POST /waitlist            join the waitlist (public; validates + dedupes by email)
   GET /gallery              back-compat alias → 302 to /admin/gallery (signed-in only;
                              anonymous → 302 to /login, paused → the paused sheet)
   GET /<slug>/…             serve the current version's files (per-artifact authz)
   GET /v/<slug>/<n>/…       preview a specific version (admin or the artifact's owner)
   GET /admin                portal — Overview. One server-rendered section per URL, no
                              client router (see docs/DESIGN.md §4)
   GET /admin/artifacts      publish + the artifact list; admins see every artifact,
                              a member only their own
   GET /admin/artifacts/<slug>  one artifact: versions, views, access, delete
   GET /admin/gallery        everything the viewer may *open* (owned + granted + everyone),
                              as opposed to everything they manage
   GET /admin/people         directory, invites, pause/remove (admin only; refuses API tokens)
   GET /admin/integrations   API tokens + CLI/Claude Code/Hermes setup
   GET /admin/settings       account and security facts
   GET /admin/platform       instance configuration readout (super admin only)
   /api/*                    JSON API (signed-in via Access *or* an API token; scoped to
                              what the caller owns and to their workspaces. /api/users is
                              admin-only; /api/users + /api/tokens refuse API tokens
                              entirely, as do the mutating /api/accounts routes)
   GET  /api/accounts                    the caller's workspaces + which one is active
   POST /api/accounts                    create a team workspace (platform admin only)
   GET  /api/accounts/<id>/members       member list (any member of that account)
   PUT/DELETE  …/members/<email>         add / re-role / remove (account admin or owner)
        │
        ├── R2  (binding FILES)  — files at  <slug>/v<N>/<path>
        └── D1  (binding DB)     — metadata (+ waitlist emails)
```

## The product model: identity, account, membership, platform role

Four concepts, deliberately separate (issue #27). Conflating any two of them is the class of bug
this split exists to prevent.

| Concept | Means | Source of truth | Grants |
|---|---|---|---|
| **Identity / user** | a human email | Cloudflare Access + `users` | who you are |
| **Account** (workspace / organization) | the container that OWNS artifacts, tokens, settings, and later a plan | `accounts` | whose stuff it is |
| **Membership** | identity × account × account role (`owner` > `admin` > `member` > `viewer`) | `account_members` | what you may do *inside one account* |
| **Platform role** | operator authority over the whole instance (`super_admin`, `admin`) | `ADMIN_EMAILS` / `SUPER_ADMIN_EMAILS` **only** | what you may do to the *deployment* |

**The load-bearing rule: an account role is never platform authority.** Account roles are
customer data — anybody who can write to `account_members` can make themselves `owner` there, and
that is fine, because `owner` reaches exactly one workspace's artifacts and members. Platform
authority is never read from D1 at all: `effectiveRole` (`src/users.ts`) re-derives it from
configuration on every request, so no row, no API payload and no bug in `src/accounts.ts` can
escalate anybody to admin or super admin. `src/authz.ts` names its helpers for which system they
consult (`isPlatformAdmin` vs `accountRole` / `canManageMembers`) so a reader never has to guess.

Every identity gets a **personal account** on first use, provisioned by `ensurePersonalAccount`
and race-safe via a `UNIQUE` constraint on `accounts.personal_email`. Migration `0010` does the
same thing in bulk for existing data; the two converge on identical rows, so an instance that
skips the backfill self-heals as people sign in.

**Everything about accounts is additive.** `artifacts.account_id` and `api_tokens.account_id` are
nullable, `owner_email` is retained and still checked *first*, and every account helper fails soft
(a missing table or a D1 error resolves to "no account context"). A row that the backfill never
adopted is authorized exactly as it was before #27. Accounts can only ever *widen* what somebody
reaches, never narrow it — so failing soft is also failing closed.

Account context is resolved on demand (`resolveAccountContext`, cached per request by
`accountsFor` in `src/auth.ts`), **not** in `resolveAuth`. Authentication runs on every request
including the artifact-serving hot path; workspaces are only needed by `/admin` and `/api`. An API
token carries its account on its own row, so a bearer caller costs no extra read at all, and is
**pinned** to that one workspace — a credential issued for one account never reaches another, even
if the person who owns it later joins others.

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
  - **per-artifact management** (`src/authz.ts`, `canManage`/`isOwner`) — three paths, checked in
    order of authority: a **platform admin** manages every artifact; the **legacy owner**
    (`owner_email` matches) manages theirs, checked before any account lookup so un-backfilled
    rows behave identically to before #27; an **account member** holding `member` or better
    manages anything their workspace owns. A `viewer` falls below that line — see the read side
    below. Everything else answers 404, never 403, so another user's slugs stay unprobeable. A
    view grant confers no management rights, and an artifact with neither owner nor account is
    platform-admin-only.
  - **per-artifact view** (`canView`, `belongsToCaller`) — admins see all; the owner always sees
    their own; any member of the owning account — `viewer` included — sees the workspace's
    artifacts; `everyone` artifacts are visible to any signed-in user; `restricted` artifacts
    only to granted emails. The membership lookup on the serving path runs *last* and only on a
    request that would otherwise 404, so it adds no read to anything that already worked.
  - **account membership** (`canManageMembers`, `memberChangeDenial`) — changing who is in a
    workspace takes `admin`/`owner` *in that account* (or platform rights) and an interactive
    login; only an account `owner` may create or demote another `owner`; and nobody, platform
    admins included, may remove an account's last owner. Membership deliberately does **not**
    touch the Cloudflare Access allow-list: being in a workspace is not permission to sign in, so
    an account owner cannot widen who reaches the instance.

The invite-only access model relies on both layers: Access decides who may sign in at all, and the
Worker decides what each signed-in person may see and manage. Widening the Access path gating
(so members reach `/admin`) is a deliberate, documented operator step — see
`docs/DEPLOY_RTFX.md` §5b.

## Data model (D1)

- `artifacts` — one row per artifact: slug, title, description, current type/entry/counts,
  `visibility` (`restricted` | `everyone`), `current_version`, `owner_email` (the member
  who may manage it; NULL = platform-admin-only) and `account_id` (the owning workspace;
  NULL = legacy row, authorized by `owner_email` alone). Both are set once at creation and
  neither is changed by a republish, so an admin uploading a new version can't take over
  someone's artifact or move it into their own workspace.
- `artifact_grants` — `(slug, email)` allow-list for restricted artifacts.
- `artifact_versions` — `(slug, version)` one row per immutable version, with per-version
  type/entry/counts/note.
- `artifact_views` — one row per HTML page load by a signed-in person (slug, version, email,
  path, country, referrer, timestamp). Written non-blocking via `waitUntil`.
- `api_tokens` — one row per bearer credential: public `id`, `token_hash` (SHA-256, unique),
  name, `owner_email` (the creating identity), `account_id` (the workspace it acts inside; NULL
  for legacy and admin/platform tokens), `is_admin`, `scopes`, audit fields (`created_by`,
  `last_used_at`) and `expires_at` / `revoked_at`. Revocation is a tombstone, not a delete, so
  the audit trail survives. `last_used_at` is refreshed at most once every 5 minutes per token.
- `accounts` — one row per workspace/organization: opaque `id` (`acct_<16 hex>`, never derived
  from an email so it is safe in a URL), `name`, `kind` (`personal` | `team`), `status`, `plan`,
  and `personal_email` (set for a personal account; `UNIQUE`, which is what makes both the
  backfill and runtime provisioning idempotent and race-safe).
- `account_members` — `(account_id, email)` with an account `role` (`owner` | `admin` | `member`
  | `viewer`). Customer data; carries no platform authority.

The full schema is `schema.sql`; incremental changes live in `migrations/`.

**Migration drift.** This database's migration history has diverged from `migrations/` in the
past, so the #27 migrations are split by re-runnability rather than by topic:

| File | Re-runnable? | Notes |
|---|---|---|
| `0008_accounts.sql` | ✅ yes | `CREATE TABLE IF NOT EXISTS` only |
| `0009_account_links.sql` | ❌ no | two `ALTER TABLE ADD COLUMN`; SQLite has no `IF NOT EXISTS` for these. Check with `PRAGMA table_info(artifacts)` / `PRAGMA table_info(api_tokens)` first and skip what already applied — a "duplicate column name" error here is benign |
| `0010_backfill_accounts.sql` | ✅ yes | guarded by `NOT EXISTS` / `ON CONFLICT DO NOTHING` / `WHERE account_id IS NULL` |

`0010`'s first half (accounts + memberships) does not depend on `0009` and its second half
(linking artifacts and tokens) does, so applying them out of order partially succeeds and
converges correctly on a re-run. The only recovery action for a partial failure is: fix the
cause, run the file again. And none of it is required for correctness — the Worker provisions the
same rows on first use, so an instance that never runs `0010` still ends up in the right state.

## Storage layout (R2)

Every version's files live under `<slug>/v<N>/…`. A single HTML upload becomes
`<slug>/v<N>/index.html`; a `.zip` bundle is unzipped and each entry stored. The public URL
`/<slug>/…` serves the artifact's `current_version`; `/v/<slug>/<n>/…` serves a specific one.

## User management → Cloudflare Access

Cloudflare Access is the **source of truth** for the login allow-list: `src/access-api.ts` reads
and writes the viewer application's `— humans` policy directly via the Cloudflare API (requires
`CF_API_TOKEN` + the account/app/policy ids). `setAllowlist` round-trips the whole policy and only
overrides the email include list, always preserving admin emails.

The local `users` table (issue #24) sits *above* that and never grants a login. It holds product
state — lifecycle `status`, display name, operator notes, timestamps — and its `role` column
merely *records* the configured role; privilege is always re-derived from `ADMIN_EMAILS` /
`SUPER_ADMIN_EMAILS`. `status` is the one authoritative field: a `disabled` row is refused by the
Worker on every surface, so pausing somebody takes effect even if the Access write fails.

Workspace membership (`account_members`) is a third, independent thing again, and deliberately
does not touch the allow-list — see the table at the top of this document.

### Two Access applications, one dashboard (issue #37)

`/admin` and `/api/users` are guarded by *different* Cloudflare Access applications
(DEPLOY_RTFX.md §5d), and an Access session is per-application. A browser that signed in at
`/admin` therefore holds no session for `/api/users`, so Access answers the People panel's first
write with a **302 to `…cloudflareaccess.com`** — before the Worker sees the request at all.

That redirect is cross-origin, and a `fetch` carrying `Content-Type: application/json` may not
follow a cross-origin redirect without a preflight (which is not allowed *after* a redirect). The
browser reports it as a CORS error, which is why "Send invite" appeared broken. Three pieces
address it, none of which loosens who may do anything:

- `src/cors.ts` answers preflights *before* authentication — a preflight carries no credentials by
  definition, so authenticating one refuses a call that would have been authorized.
- `PEOPLE_SCRIPT` (`src/people.ts`) fetches with `redirect: 'manual'`, so the browser hands back an
  opaque response instead of raising a CORS error.
- `GET /api/users/reauth` is a full-page navigation Access *can* complete, which then returns the
  admin to the page they were on.

Folding `/api/users` into the same Access application as `/admin` removes the handoff entirely and
is the recommended production configuration — the Worker has always enforced admin-only and
token-denial on those routes in code. See DEPLOY_RTFX.md §5d.

## Modules

| File | Responsibility |
|---|---|
| `src/index.ts` | Routing; public vs. portal split; gallery filtering (`readableArtifacts`); version-aware serving; `/v/` preview. |
| `src/auth.ts` | Access JWT + bearer-token authentication, `resolveAuth`/`getIdentity`, `requireAdmin`, `requireUser`, `requireScope`, `denyApiToken`. |
| `src/authz.ts` | Pure policy: `canView`, `canManage`, `isOwner`, `canUseDashboard`, `hasScope`, and the platform-vs-account split (`isPlatformAdmin`, `canManageMembers`, `memberChangeDenial`). |
| `src/accounts.ts` | Accounts/workspaces: account roles, memberships, personal-account provisioning, per-request account context. |
| `src/tokens.ts` | API tokens: generation, hashing, scopes, lifecycle queries. |
| `src/serve.ts` | R2 file serving + content types. |
| `src/api.ts` | `/api` endpoints: publish, delete, access, versions, users, tokens. |
| `src/db.ts` | All D1 queries (including waitlist). |
| `src/access-api.ts` | Cloudflare Access allow-list management. |
| `src/cors.ts` | Browser preflight + allowed-origin policy for `/api` (issue #37). Never wildcards, never trusts a content host. |
| `src/upload.ts` | Zip processing / single-file wrapping. |
| `src/pages.ts` | Shared shell: `layout`, the rtfx mark/lockup, the public header+footer chrome (`siteHeader`/`siteFooter`), and the 404. |
| `src/admin.ts` | Portal sections: Overview, Artifacts (list + detail), Gallery, Settings, Platform. |
| `src/landing.ts` | Server-rendered public landing page + waitlist form. |
| `src/waitlist.ts` | `/waitlist` endpoint: email validation, join/redirect. |
| `src/util.ts` | Slug validation (+ reserved slugs), content-type map. |
| `plugins/rtfx/` | Claude Code plugin (skill, `/rtfx:*` commands, dependency-free publisher). Talks to `/api` like any other client — see [CLAUDE_CODE.md](CLAUDE_CODE.md). |

## Testing

`vitest` with `@cloudflare/vitest-pool-workers` runs tests inside a real Workers runtime with
local R2/D1. Integration tests drive the Hono app via `app.request(...)` and impersonate viewers
with the dev-only `X-Dev-Email` header, or simulate a signed-out visitor with `X-Dev-Anonymous:
true` (DEV_LOGIN mode otherwise always resolves an identity). API-token flows are exercised
end-to-end with real tokens minted through `/api/tokens` (`withToken` in `test/fixtures.ts`); the
bearer path is checked before dev impersonation, so those tests hit the same code production
does. No Cloudflare account is needed to run the suite.
