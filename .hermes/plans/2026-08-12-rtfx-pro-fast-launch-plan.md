# rtfx.pro Fast Launch Development Plan

Date: 2026-08-12
Repo: `/Users/yogevgab/dev/artifacts-server`
Domain: `rtfx.pro`
GitHub: `https://github.com/yogevgab/artifacts-server`

## Goal

Go live fast with a secure, reliable, premium-feeling hosted artifact publishing product, without prematurely building full SaaS billing/custom-domains/teams before product demand is validated.

Product positioning:

> RTFX — protected publishing for AI artifacts, demos, and client previews.

## Current verified repo state

- Branch: `main`
- Remote: `https://github.com/yogevgab/artifacts-server.git`
- Repo visibility: public
- Working tree: clean before `npm install`; `package-lock.json` may change only if dependency work is performed.
- Current stack: Cloudflare Worker + Hono + R2 + D1 + Cloudflare Access.
- Existing features: admin dashboard, gallery, CLI, single HTML/ZIP upload, per-artifact permissions, versions/rollback, views log, Access allow-list user management.
- Verified command: `npm run check` passed after `npm install` — 6 test files, 63 tests.
- Audit finding: `npm audit` reports 11 vulnerabilities, including a production Hono moderate advisory and multiple dev toolchain advisories through Wrangler/Vitest/Miniflare.
- Deployment config is still placeholder: `wrangler.jsonc` route `artifacts.example.com`, placeholder D1 database id, empty Access/account vars.

## Non-negotiable launch principles

1. **Security before public traffic** — arbitrary uploaded HTML must not be able to call dashboard/admin APIs as same-origin.
2. **Reliable deploy path** — every launch change has `npm run check`, deployment smoke tests, and rollback instructions.
3. **Premium UX** — simple landing, clear dashboard, polished publish flow; hide Cloudflare implementation details from product UI.
4. **Scoped beta** — start invite-only/manual, not fully self-serve SaaS billing.
5. **No secrets in Git or AI prompts** — Cloudflare tokens/service secrets stay in provider secret stores/password manager.

## Critical architecture decision

### Split app/admin/API origin from artifact content origin

Current risk: user-uploaded HTML is served from the same origin/path space as `/admin` and `/api`. If an admin opens a malicious artifact, artifact JS could potentially call same-origin admin endpoints with the admin session.

Launch-safe model:

- `rtfx.pro` — marketing + dashboard + API + docs/waitlist.
- `a.rtfx.pro` or `*.rtfxusercontent.pro` — artifact content only.

Content origin must not expose `/admin`, `/api`, `/whoami`, or management routes.

MVP implementation can route by hostname in one Worker, but the Worker must enforce content-only behavior for content hostnames.

## Milestone 0 — launch board + dependency/security baseline

Target: Day 1
Branch: `chore/launch-readiness`

Tasks:
- Create GitHub issues for each milestone.
- Upgrade `hono` to a version fixed for advisories (`>=4.12.34` or latest compatible).
- Upgrade Wrangler/Vitest/Cloudflare test pool if feasible without destabilizing tests.
- Add CI/launch gate: `npm run check` and `npm audit --omit=dev`.
- Record audit status in PR.

Acceptance criteria:
- `npm run check` passes.
- No known production dependency vulnerabilities.
- Dev vulnerabilities are either fixed or documented as non-runtime launch debt.

Verification:
```bash
npm install
npm run check
npm audit --omit=dev
```

## Milestone 1 — origin split + upload hardening

Target: Days 1–3
Branch: `feat/content-origin-isolation`

Tasks:
- Update routing/config for separate app origin and artifact content origin.
- Add host-aware route guard:
  - app host: marketing/dashboard/API/admin only.
  - content host: artifact file serving only.
- Add tests proving content host cannot reach `/admin`, `/api/*`, `/whoami`.
- Add security headers:
  - app/admin: strict CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors 'none'`.
  - content host: `nosniff`, conservative cache headers; artifact CSP only if it does not break common artifacts.
- Add upload limits and ZIP hardening:
  - max upload size.
  - max decompressed size.
  - max file count.
  - reject `..`, absolute paths, control characters, duplicate normalized paths.

Acceptance criteria:
- Malicious artifact cannot reach management routes on content origin.
- Upload abuse tests exist and pass.
- Existing functionality still works.
- `npm run check` passes.

## Milestone 2 — production Cloudflare deployment for private beta

Target: Days 3–4
Branch: `ops/rtfx-production-deploy`

Tasks:
- Confirm `rtfx.pro` zone is active in Cloudflare.
- Decide final hostnames:
  - recommended: `rtfx.pro` app/marketing/dashboard.
  - `a.rtfx.pro` artifact content.
- Run/adjust setup for production resources:
  - R2 bucket.
  - D1 database.
  - schema migration.
  - Worker deploy.
  - Cloudflare Access apps/policies.
  - service token for CLI.
- Store `CF_API_TOKEN` and other secrets using `wrangler secret put`; do not commit secrets.
- Commit only safe config IDs/routes.

Acceptance criteria:
- `/health` responds from production.
- `/admin` requires Cloudflare Access and loads for admin.
- CLI can publish a smoke artifact.
- Artifact renders on content origin.
- Delete smoke artifact works.
- `wrangler deployments list` shows a known deployment.

Smoke commands:
```bash
curl -i https://rtfx.pro/health
curl -i https://a.rtfx.pro/health # should NOT expose app health if content-only is enforced
node cli/artifacts.mjs publish ./smoke-site --slug smoke-test --title "Smoke Test"
node cli/artifacts.mjs list
node cli/artifacts.mjs delete smoke-test
```

## Milestone 3 — premium public shell + waitlist

Target: Days 4–6
Branch: `feat/rtfx-public-shell`

Tasks:
- Build polished landing page at `/`:
  - headline: “Publish AI artifacts beautifully.”
  - subheadline: protected, versioned, shareable hosting for Claude/Hermes artifacts and client previews.
  - CTA: Join beta.
  - example artifact/demo link.
  - concise FAQ/security trust section.
- Move authenticated gallery/dashboard entry to `/dashboard` or `/gallery` as needed.
- Add reserved slugs for marketing routes to avoid catch-all conflicts.
- Add waitlist capture:
  - simplest: external form/mail link.
  - better: D1 `waitlist_signups` endpoint with basic spam/rate controls.

Acceptance criteria:
- Visitor understands the product in 5 seconds.
- Landing is polished on desktop/mobile.
- Authenticated publishing flow still works.
- Marketing routes never get swallowed by artifact catch-all.
- `npm run check` passes.

## Milestone 4 — dashboard/publish UX redesign

Target: Days 6–9
Branch: `feat/premium-dashboard-ux`

Tasks:
- Replace utilitarian admin UI with polished SaaS dashboard shell.
- Artifact index:
  - title, URL, visibility badge, version badge, views, last updated, quick actions.
- Publish flow:
  - drag/drop `.html` or `.zip`.
  - auto slug.
  - private by default.
  - clear validation.
  - success state with copy/open buttons.
- Artifact detail:
  - overview, versions, access, views, settings.
- Better empty states/toasts/errors.
- Hide Cloudflare concepts from UI copy.

Acceptance criteria:
- Same backend features remain available.
- First artifact publish is understandable without docs.
- Dashboard feels like product, not internal tool.
- `npm run check` passes.
- Browser QA performed on desktop + mobile width.

## Milestone 5 — invite-only hosted beta ownership model

Target: Days 9–12
Branch: `feat/beta-owner-model`

Tasks:
- Add minimal owner model rather than full SaaS:
  - artifact owner email.
  - admin sees all.
  - non-admin sees own artifacts.
- Keep Cloudflare Access allow-list for beta invites.
- Add admin beta-user workflow if needed.
- Preserve existing per-artifact grants.

Acceptance criteria:
- Beta user can publish and manage only their own artifacts.
- Admin can manage all artifacts.
- Private artifacts are not visible to other beta users.
- Existing CLI/admin flows remain compatible.

## Milestone 6 — API token + Hermes Cloud contract

Target: Days 12–14 or immediately after beta launch
Branch: `feat/api-token-auth`

Tasks:
- Add first-class API tokens independent of Cloudflare Access service-token setup.
- Token format: `rtfx_live_<random>`.
- Store only token hash.
- Support `Authorization: Bearer <token>` for publish/list/update flows.
- CLI supports `RTFX_API_TOKEN`.
- Write `docs/HERMES_INTEGRATION.md` with publish/update/rollback contract.

Acceptance criteria:
- Bearer token can publish an artifact.
- Invalid/revoked token fails.
- Token secret is shown only once.
- Existing Access auth remains.
- CLI and docs are copy-pasteable.

## Explicitly postpone

Do not block first beta on:
- Stripe billing.
- Custom domains.
- SMS OTP.
- Teams/workspaces/roles beyond minimal owner/admin.
- Advanced analytics charts.
- In-browser artifact editor.
- Full MCP/Hermes plugin marketplace packaging.

## Claude Code workflow

Use Claude Code for implementation, but one issue/branch at a time.

Rules:
- Do not paste Cloudflare/API secrets into Claude.
- Do not allow Claude to deploy unless explicitly requested.
- Every task prompt includes files, non-goals, acceptance criteria, and `npm run check`.
- Hermes/Noam reviews diff and runs tests before commit/PR.

Prompt template:
```text
You are working in /Users/yogevgab/dev/artifacts-server.

Task: <one narrow issue>

Constraints:
- Do not deploy.
- Do not add or expose secrets.
- Preserve existing behavior unless listed in acceptance criteria.
- Use tests for security/route changes.

Likely files:
- ...

Acceptance criteria:
- ...

Verification:
- Run npm run check.
- Report changed files and commands run.
```

## Product copy direction

Working brand:
- RTFX
- `rtfx.pro`

Short positioning:
- “Protected publishing for AI artifacts.”
- “Publish AI artifacts beautifully.”
- “Share Claude/Hermes artifacts without shipping a deployment pipeline.”
- “Private by default. Versioned by design. Fast on Cloudflare.”

## Next concrete action

Start with Milestone 0 + 1. The first implementation ticket should be:

> Split artifact content onto a content-only origin and block management routes there.

This is the main security blocker for public hosted use.
