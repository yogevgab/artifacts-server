# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately via [GitHub Security Advisories](https://github.com/yogevgab/artifacts-server/security/advisories/new)
(Security → Report a vulnerability), or email the maintainer.

Include: a description, affected version/commit, reproduction steps, and impact. You'll get an
acknowledgement as soon as possible, and we'll coordinate a fix and disclosure.

## Scope & design notes

This project is an authorization layer in front of static content. The most sensitive areas:

- `src/auth.ts` — Cloudflare Access JWT verification (issuer, audience, JWKS) and the admin gate.
- `src/authz.ts` + serving/gallery in `src/index.ts` — per-artifact authorization.
- `src/access-api.ts` — manages the Cloudflare Access login allow-list via the CF API.

Design invariants worth knowing when reviewing:

- The app stores **no passwords**; authentication is Cloudflare Access's job.
- Admin rights require an allow-listed email (`ADMIN_EMAILS`) or an allow-listed service-token
  `common_name` (`ADMIN_SERVICE_TOKENS`) — a valid Access token is **not** admin by itself.
- The dev bypass (`DEV_LOGIN` / `X-Dev-Email`) is only active when `DEV_LOGIN=true`, which is set
  by `npm run dev` and the test config — never in a normal `wrangler deploy`.
- A viewer requesting an artifact they can't see gets `404` (existence is not revealed).

## Dependencies

Production dependencies are minimal (`hono`, `jose`, `fflate`) and audited to **0 known
vulnerabilities**. Advisories reported by `npm audit` are in the dev toolchain (wrangler,
vitest) and do not ship to the deployed Worker.
