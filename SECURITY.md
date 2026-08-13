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
- `src/host.ts` + `src/serve.ts` — the content-origin split and the headers artifact files ship with.

Design invariants worth knowing when reviewing:

- The app stores **no passwords**; authentication is Cloudflare Access's job.
- Admin rights require an allow-listed email (`ADMIN_EMAILS`) or an allow-listed service-token
  `common_name` (`ADMIN_SERVICE_TOKENS`) — a valid Access token is **not** admin by itself.
- The dev bypass (`DEV_LOGIN` / `X-Dev-Email`) is only active when `DEV_LOGIN=true`, which is set
  by `npm run dev` and the test config — never in a normal `wrangler deploy`.
- A viewer requesting an artifact they can't see gets `404` (existence is not revealed).

## Content-origin isolation, and what it does not cover

Artifact files are served from a configured content host (`CONTENT_HOSTNAMES`, e.g. `a.rtfx.pro`)
that answers artifact paths only; `src/host.ts` 404s `/admin`, `/api/*`, `/whoami`, `/health`,
`/v/*` and the gallery on that host. That is a real boundary, and it is the one to rely on:

- **Covered.** Uploaded HTML runs in an origin that holds no dashboard, no API and no admin
  surface, so a published page cannot read the app's DOM, cookies or same-origin endpoints. It
  is served with `nosniff`, `no-referrer`, `X-Robots-Tag: noindex` and a CSP that blocks framing
  and hostile `<base>` URLs.
- **Not covered.** Every artifact shares that one content origin. Two artifacts are therefore
  same-origin with each other, and normal same-origin reach — `localStorage`, `document.cookie`
  scoped to the host, `fetch` of another artifact's files with credentials, `window.opener`
  access between them — is not prevented by the origin split. Access control decides who may
  fetch an artifact at all; the browser is not a second wall between two artifacts.

**Self-hosting note: the split is configuration, not a default.** Everything above holds only on
an instance that actually has a content host. `CONTENT_HOSTNAMES` must name a hostname that is
also routed to the Worker (`wrangler.jsonc` `routes[]`) and is not the app hostname. Leave it
empty and `isContentHost()` is false for every request, so artifact files are served from the app
origin itself — uploaded HTML then runs same-origin with the dashboard and the API, and the
"Covered" bullet above is simply not true of that deployment. `npm run validate:deploy` fails on
an empty `CONTENT_HOSTNAMES`, and `/admin/platform` reports the same thing on a running instance;
treat either warning as a deploy blocker rather than a lint.

Practical reading: do not treat the content host as browser sandboxing between mutually
distrusting publishers or viewers. It isolates published content **from rtfx.pro**, not artifacts
from each other. An instance that needs the stronger property wants per-artifact origins
(a subdomain or a separate host per artifact) or an equivalent sandbox, which this version does
not implement.

## Dependencies

Production dependencies are minimal (`hono`, `jose`, `fflate`) and audited to **0 known
vulnerabilities**. Advisories reported by `npm audit` are in the dev toolchain (wrangler,
vitest) and do not ship to the deployed Worker.
