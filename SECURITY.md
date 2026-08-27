# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately through [GitHub Security Advisories](https://github.com/yogevgab/artifacts-server/security/advisories/new)
(Security → Report a vulnerability). That is the private channel — there is no separate security
mailbox, so a report sent anywhere else may simply not be seen.

Include: a description, affected version/commit, reproduction steps, and impact. You'll get an
acknowledgement as soon as one can be written, and we'll coordinate a fix and disclosure with you.

**What this is not.** This is a small open-source project maintained by one person in their own
time. There is no response-time commitment, no bug-bounty programme, no legal entity behind these
words, and no safe-harbour promise anyone here is in a position to make. Best effort, in public, is
what is on offer — please size your expectations to that, and test only against your own instance.

## The Claude Code plugin and the local MCP server

`plugins/rtfx` is published as a Claude Code plugin, so it is worth stating its blast radius
separately from the server's. It runs plain Node files from this repository, has no dependencies
and installs nothing. It talks to exactly one host — the instance in `ARTIFACTS_URL`, default
`rtfx.pro` — with no telemetry and no third-party calls, and it sends only the files a user names
for a specific publish.

### How it authenticates

**Browser sign-in is the normal path.** `/rtfx:login` (`rtfx.mjs login`) runs an OAuth
authorization-code flow with **PKCE S256** against the instance itself: the client registers
dynamically, opens the system browser, and receives the code on a **loopback redirect**
(`http://127.0.0.1:<port>/callback`, RFC 8252) that is bound to a one-shot `state`. It requests
two scopes, `rtfx:read` and `rtfx:publish` — never `manage`. `/rtfx:logout` posts both the refresh
token and the access token to the instance's revocation endpoint and then deletes the local
credential; the delete happens whether or not the revocation call succeeds, because a person
running logout wants the credential off *this machine* regardless of the network.

**The credential is on disk, and that is the point.** It lives in
`$XDG_CONFIG_HOME/rtfx/credentials.json` (default `~/.config/rtfx/credentials.json`), written with
mode **`0600`** in a directory created **`0700`** — owner read/write only. It holds a short-lived
access token, a rotating refresh token, the client id and the issuer; entries are keyed by issuer
origin, so a credential minted for one host is never offered to another. Refresh tokens rotate on
use and the new one is persisted *before* the access token is used, because the server spends the
old one whether or not the process survives.

**`RTFX_API_TOKEN` is the advanced/CI fallback, and it always wins.** When it is set it
short-circuits credential resolution entirely, including the disk read (`resolveConfig` in
`plugins/rtfx/scripts/rtfx.lib.mjs`). That order is deliberate: a CI job sets the variable on
purpose, often with different scopes than an interactive login would grant, and a stored browser
credential silently overriding it would be a surprise in exactly the setting where surprises cost
the most. The user mints and revokes that token themselves at `/admin/integrations`.

**No token is ever printed.** `doctor` and `login` report a token's **id** and expiry only, and the
commands instruct the model never to echo a token or read one out of a file to display it;
`redactToken`/`tokenId` and the OAuth redaction helpers are unit-tested.

No Cloudflare account or management credential is involved — a test pins that the plugin's config
resolution ignores one. `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` remain an optional
pass-through for a self-hosted instance that still gates every path at the edge; they are a
Cloudflare Access *service token*, they grant nothing inside the app, and the bearer credential
alone decides identity and scope.

### What it will and won't upload

The directory walk refuses to upload anything shaped like a credential (`.env`, `*.pem`, `*.key`,
`id_rsa` …) and skips `.git`/`node_modules`, reporting everything it left out; a prebuilt zip
containing such a file is refused rather than silently filtered. `npm run validate:plugin` fails if
a token-shaped string is ever committed under `plugins/`.

The plugin's stdio MCP server (`plugins/rtfx/scripts/rtfx-mcp.mjs`) offers `publish`,
`list_artifacts`, `get_versions`, `rollback` and `doctor`. `update_access` exists but is not
registered unless `RTFX_MCP_ALLOW_ACCESS` is set, and even then needs a `manage`-scoped
credential — changing who can see an artifact is not something a model should be able to reach for
by default.

## Local MCP vs. remote MCP — the boundary that matters

There are two MCP surfaces in this repository and they are deliberately not the same shape.

**Local (stdio), `plugins/rtfx/scripts/rtfx-mcp.mjs`.** Runs on the user's machine, beside their
files. It takes a **filesystem path** and uploads what it finds there, minus the credential and
build-directory filters above. It can do this safely because the disk it reads is the caller's own.

**Remote (Streamable HTTP), `POST /mcp` in `src/mcp.ts`.** Runs in Cloudflare's network. It has
**no `publish(path)` and never will**: the only disk it could read is the server's, which is not
what the caller means, so a remote `publish(path)` would be either a no-op or a server-side
file-disclosure primitive. `path` and its synonyms are refused with an explanation rather than
merely being unknown arguments. Remote publishing takes the **content** instead — `content_text`,
`content_base64`, or an explicit `files` list — capped at 50 files and 5 MiB decoded, because
base64 inside a JSON-RPC message is an expensive way to move a build output.

The remote surface is otherwise a *narrower* door than the one that already exists, not a wider
one:

- **Same gate as the machine API.** It is authenticated by a bearer `rtfx_…` token through
  `requireApiToken` — the identical middleware that guards `/api/machine/*`. A credential can also
  be obtained by OAuth: the app serves RFC 9728 protected-resource metadata and RFC 8414
  authorization-server metadata, supports dynamic client registration, authorization-code + PKCE,
  refresh and revocation (`src/oauth-routes.ts`, [`docs/REMOTE_MCP_OAUTH.md`](docs/REMOTE_MCP_OAUTH.md)).
  Either way the credential is the same kind of scoped, revocable token row.
- **The allow-list is a literal.** `REMOTE_TOOLS` is written out by hand, not filtered from the
  stdio server's tool list, so it cannot grow silently when that one does.
- **Scope is enforced by the handler, not by the advertised list.** `tools/list` is filtered for
  convenience, but `TOOL_SCOPE` is checked again in `route` before any handler runs. `read` covers
  `list_artifacts`/`artifact_details`/`artifact_statistics`; `publish` covers `publish`; `manage`
  covers `share_artifact`/`rollback_artifact`/`delete_artifact`. A read-only credential sees
  `doctor` and the read tools and nothing else.
- **Reach is the REST surface's reach.** Every tool resolves the artifact through
  `manageableArtifact` or `visibleArtifacts` from `src/api.ts`, so an artifact the caller cannot
  manage is indistinguishable from one that does not exist.
- **User, token and workspace management is absent, not merely unlisted.** There is no handler at
  all, on the same rule the rest of the machine surface follows (`denyApiToken` in `src/api.ts`).
- `delete_artifact` is the one irreversible call and additionally requires `confirm_slug` to equal
  `slug`.

Every one of those rules is pinned by a test in `test/mcp-http.test.ts`.

Distribution status and the remaining open limitations are in
[`docs/ANTHROPIC_PLUGIN_SUBMISSION.md`](docs/ANTHROPIC_PLUGIN_SUBMISSION.md).

## Scope & design notes

This project is an authorization layer in front of static content. The most sensitive areas:

- `src/auth.ts` — app-owned session verification, API-token auth, optional Cloudflare Access JWT
  verification (issuer, audience, JWKS), and the admin gate.
- `src/session.ts` + `src/otp.ts` + `src/auth-routes.ts` — the app-owned sign-in path: one-time
  codes and magic-link tokens (stored hashed, single-use) and the signed `rtfx_session` cookie.
- `src/authz.ts` + serving/gallery in `src/index.ts` — per-artifact authorization.
- `src/host.ts` + `src/serve.ts` — the content-origin split and the headers artifact files ship with.

Design invariants worth knowing when reviewing:

- The app stores **no passwords**. Primary interactive sign-in is app-owned email OTP / magic link
  into a signed `rtfx_session` cookie; API tokens authenticate machine publishing. Older/self-hosted
  deployments may still put Cloudflare Access in front as an additional edge gate.
- Admin rights require an allow-listed email (`ADMIN_EMAILS`) or an allow-listed service-token
  `common_name` (`ADMIN_SERVICE_TOKENS`) — a valid session or Access token is **not** admin by
  itself.
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

Production dependencies are minimal — `hono`, `jose`, `fflate` — and the claim below is one you
can re-run rather than take on trust:

```bash
npm audit --omit=dev    # what actually ships to the Worker
npm audit               # the same, plus the dev toolchain
```

As of 2026-08-27, `npm audit --omit=dev` reports **0 vulnerabilities**. The plain `npm audit` does
report advisories; every one of them is in the dev toolchain (wrangler, vitest and their
transitive `ws`/esbuild deps), which is not bundled into the deployed Worker and never runs in
production. If those two commands ever disagree with this paragraph, believe the commands and open
an issue — a stale "0 known vulnerabilities" line is worse than no line.

## What is in this repository, and what is not

The source is MIT and public on purpose: an access-control product that asks you to trust it should
let you read it. What that does *not* include is the operational side of the hosted `rtfx.pro`
service — customer data, runbooks with live account detail, incident history, credentials. The line
is drawn explicitly in [`OPEN_SOURCE.md`](OPEN_SOURCE.md); running your own instance is
[`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md).
