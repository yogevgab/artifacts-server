# rtfx.pro Production Deploy Prep (Issue #4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare non-secret, non-deployable config, docs, and a validation script for the rtfx.pro/a.rtfx.pro production Cloudflare deployment, so a human operator can run the actual (mutating) deploy steps safely and repeatably.

**Architecture:** No runtime code changes. `wrangler.jsonc` gets real route/`CONTENT_HOSTNAMES` values for the already-implemented app/content-host split (`src/host.ts`, landed in "Isolate artifact content hosts"). A new pure-function config validator (`scripts/validate-deploy-config.lib.mjs` + CLI wrapper) checks the file for structural mistakes vs. expected-pending provisioning fields. A new runbook (`docs/DEPLOY_RTFX.md`) enumerates every remaining mutating step individually, each requiring explicit operator approval, plus safe smoke-test commands.

**Tech Stack:** Node (`.mjs` scripts, no framework), Vitest (`@cloudflare/vitest-pool-workers`), Wrangler/JSONC.

**Spec:** GitHub issue #4 ("Production Cloudflare deployment for rtfx.pro private beta") — configure Cloudflare resources, routes, D1, R2, Access, secrets, deploy, and smoke-test CLI publish/render/delete; commit only non-secret config.

## Global Constraints

- DO NOT deploy, DO NOT create/modify Cloudflare resources, DO NOT run any mutating `wrangler`/Cloudflare API command.
- DO NOT add secret values. `wrangler.jsonc` keeps placeholders for `database_id` and everything only knowable after real provisioning (Access ids/AUD, `CF_ACCOUNT_ID`, `ADMIN_EMAILS`).
- DO NOT commit `.hermes/` or `docs/superpowers/`.
- Scope is limited to issue #4 prep — no product/UX feature work.
- App hostname: `rtfx.pro` (dashboard/API/admin). Content hostname: `a.rtfx.pro` (artifact files only, per `src/host.ts` isolation).

---

### Task 1: Non-secret `wrangler.jsonc` config for rtfx.pro/a.rtfx.pro

**Files:**
- Modify: `wrangler.jsonc`

**Interfaces:**
- Produces: `routes` containing `rtfx.pro` and `a.rtfx.pro` (both `custom_domain: true`); `vars.CONTENT_HOSTNAMES === "a.rtfx.pro"`. Later tasks (validator, runbook) assume these exact values.

- [x] Set `routes` to two entries: `{ "pattern": "rtfx.pro", "custom_domain": true }` and `{ "pattern": "a.rtfx.pro", "custom_domain": true }`.
- [x] Set `vars.CONTENT_HOSTNAMES` to `"a.rtfx.pro"`.
- [x] Update the surrounding comments so they describe the actual configured split instead of a hypothetical second host.
- [x] Leave `database_id`, `ADMIN_EMAILS`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `CF_ACCOUNT_ID`, `ACCESS_VIEWER_APP_ID`, `ACCESS_VIEWER_POLICY_ID` as placeholders — unknowable until real Cloudflare provisioning.

### Task 2: Pure config-validation library + CLI + tests

**Files:**
- Create: `scripts/validate-deploy-config.lib.mjs`
- Create: `scripts/validate-deploy-config.mjs`
- Create: `test/validate-deploy-config.test.ts`
- Modify: `package.json` (add `validate:deploy` script)

**Interfaces:**
- Produces: `checkWranglerConfig(config: object): { errors: string[], pending: string[], ok: string[] }` and `stripJsonComments(text: string): string`, both exported from the `.lib.mjs` file with zero Node built-in imports (must import cleanly under the Workers vitest pool). `errors` = structural problems that break the app regardless of provisioning state (missing routes, `CONTENT_HOSTNAMES` host with no matching route, content host = app host, missing R2/D1 bindings). `pending` = fields legitimately blocked on manual Cloudflare provisioning (placeholder D1 id, empty Access vars, default `ADMIN_EMAILS`).

- [x] Write `scripts/validate-deploy-config.lib.mjs` with `stripJsonComments`, `checkWranglerConfig`, and exported constants `EXPECTED_APP_HOSTNAME = "rtfx.pro"`, `EXPECTED_CONTENT_HOSTNAME = "a.rtfx.pro"`, `DEFAULT_ADMIN_EMAIL_PLACEHOLDER = "you@example.com"`, `DEFAULT_DATABASE_ID_PLACEHOLDER = "REPLACE_WITH_D1_DATABASE_ID"`.
- [x] Write `scripts/validate-deploy-config.mjs`: reads `wrangler.jsonc`, strips comments, parses, calls `checkWranglerConfig`, prints a categorized report, exits 1 on errors, and (with `--strict`) exits 1 if `pending` is non-empty too.
- [x] Write `test/validate-deploy-config.test.ts` covering: fully-configured config has no errors/pending; missing app-host route errors; missing content-host route errors; `CONTENT_HOSTNAMES` host with no route errors; `CONTENT_HOSTNAMES` including the app host errors; placeholder D1 id is `pending` not `errors`; default `ADMIN_EMAILS` is `pending`; empty Access vars are `pending`; `stripJsonComments` handles line comments, block comments, and doesn't touch `//` inside string values.
- [x] Add `"validate:deploy": "node scripts/validate-deploy-config.mjs"` to `package.json` scripts.
- [x] Run `npx vitest run test/validate-deploy-config.test.ts` — expect PASS.
- [x] Run `node scripts/validate-deploy-config.mjs` against the real (post-Task-1) `wrangler.jsonc` — expect it to print the current pending items (Access/D1 provisioning) and exit 0 (no structural errors).

### Task 3: rtfx.pro deployment runbook

**Files:**
- Create: `docs/DEPLOY_RTFX.md`
- Modify: `README.md` (one-line pointer from "Manual deployment" to the new runbook)

- [x] Write `docs/DEPLOY_RTFX.md`: prereqs, what's already prepared in-repo (Task 1), then every remaining step as an individually-labeled `MANUAL — mutates Cloudflare, run yourself` command block (R2 bucket create, D1 create + patch id, schema apply, deploy, Access team/apps/policies incl. the two-destination viewer app for `rtfx.pro` + `a.rtfx.pro`, patching the remaining `wrangler.jsonc` vars, redeploy, `wrangler secret put CF_API_TOKEN`), a note that `npm run setup` doesn't support this dual-hostname/dual-Access-destination layout (its `patch()` only rewrites the first `"pattern"` match) so the manual steps here must be used instead, a `npm run validate:deploy -- --strict` gate before deploying, and safe post-deploy smoke-test commands (`curl /health` on both hosts, CLI publish/list/delete of a throwaway artifact, curl the rendered artifact on `a.rtfx.pro`), plus rollback notes (`wrangler deployments list`/rollback, reverting `wrangler.jsonc`).
- [x] Add one line under README's "Manual deployment" section pointing to `docs/DEPLOY_RTFX.md` for the rtfx.pro-specific runbook.

### Task 4: Local smoke test (safe — no Cloudflare mutation)

- [x] Run `npm run dev` in the background (local `wrangler dev`, `DEV_LOGIN=true`, no real Cloudflare resources touched).
- [x] Against `http://localhost:8787`, run the CLI publish/list/delete flow from `docs/DEPLOY_RTFX.md`'s smoke-test section (a throwaway HTML artifact) and `curl` the rendered page, to prove the documented commands are correct before an operator runs them against production.
- [x] Stop the dev server.

### Task 5: Full verification + commit

- [x] Run `npm run check` (typecheck + full test suite) — expect PASS.
- [x] Run `npm audit --omit=dev` — record output (informational; no code changes expected to fix/worsen it).
- [x] `git status` / `git diff` review — confirm `.hermes/` and `docs/superpowers/` are not staged.
- [x] Commit the focused change set with a concise message.

## Self-Review

- **Spec coverage:** routes/`CONTENT_HOSTNAMES` prep → Task 1. Docs/checklist for safe manual deploy → Task 3. Validation script, testable locally → Task 2. Smoke-test commands, explicit + safe, mutating steps marked manual → Tasks 3–4. No deploy/resource mutation/secrets anywhere. ✓
- **Placeholder scan:** none found — every step names exact files/values.
- **Type consistency:** `checkWranglerConfig`/`stripJsonComments` names and shapes are used identically across Task 2's lib, CLI, and test steps.
