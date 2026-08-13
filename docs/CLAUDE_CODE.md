# Claude Code integration

A first-class Claude Code plugin lives in this repo at [`plugins/rtfx`](../plugins/rtfx). It turns
"publish this" into an ordinary sentence in a session: the agent picks the build output, versions
it under a slug, and hands back `https://a.rtfx.pro/<slug>/`.

This document is the operator's view — what ships, how it is installed, how it is tested, and why
it is built the way it is. The user-facing README is
[`plugins/rtfx/README.md`](../plugins/rtfx/README.md).

---

## 1. What ships

The repository is itself a Claude Code **marketplace**: `.claude-plugin/marketplace.json` at the
root lists one plugin, `./plugins/rtfx`.

```
.claude-plugin/marketplace.json          the repo, as an installable marketplace
plugins/rtfx/
  .claude-plugin/plugin.json             manifest (name, version, description)
  commands/publish.md                    /rtfx:publish
  commands/list.md                       /rtfx:list
  commands/versions.md                   /rtfx:versions
  commands/rollback.md                   /rtfx:rollback
  commands/setup.md                      /rtfx:setup
  skills/publishing-to-rtfx/SKILL.md     loads on its own when someone says "publish this"
  skills/publishing-to-rtfx/references/api.md
  scripts/rtfx.lib.mjs                   pure helpers (config, zip, error mapping)
  scripts/rtfx.bundle.mjs                what may be uploaded — pure, shared with the MCP server
  scripts/rtfx.mjs                       the publisher — Node 18+, zero dependencies
  scripts/rtfx-mcp.mjs                   the MCP server (see MCP.md)
  scripts/rtfx.mcp.lib.mjs               MCP tool schemas and JSON-RPC — pure
  .mcp.json                              MCP server declaration (mirrored in plugin.json)
  README.md
```

The **skill** is the part that matters. Slash commands are for people who already know the plugin
exists; the skill is what makes an ordinary "ship this so I can send it to Dana" resolve to a
published, access-controlled artifact without anyone naming a tool.

Installing the plugin also registers a native **MCP server** with the same operations, for clients
that have no shell to run a command in. It is documented on its own in [`MCP.md`](MCP.md); the two
share every library below the entry point, so this document's configuration surface, safety model
and API contract apply verbatim to both.

## 2. Install

```
/plugin marketplace add yogevgab/artifacts-server
/plugin install rtfx@rtfx
```

Then, in the shell Claude Code runs in:

```bash
export RTFX_API_TOKEN=rtfx_…            # dashboard → Integrations, scopes read + publish
export ARTIFACTS_URL=https://rtfx.pro   # only when self-hosting
```

`/rtfx:setup` verifies both and reports the token's **id** — never the token.

For local development against `npm run dev`, mint a token on the dev server and point the plugin
at it. A *made-up* token will not do: a bad bearer token is always `401`, never a silent downgrade
to the dev identity.

```bash
npx wrangler d1 execute artifacts-meta --local --file schema.sql   # once
npm run dev

export ARTIFACTS_URL=http://localhost:8787
ARTIFACTS_URL=http://localhost:8787 node cli/artifacts.mjs \
  token-create "local" --owner you@example.com --scopes read,publish
export RTFX_API_TOKEN=<the token it printed>
```

The dev server also serves artifacts from the configured content host, which wrangler cannot route
locally — add `--var CONTENT_HOSTNAMES:` to `wrangler dev` to collapse to a single origin if you
want to fetch what you just published over HTTP.

## 3. Configuration surface

Exactly two variables, and neither is a Cloudflare account credential:

| Variable | Required | Meaning |
|---|---|---|
| `RTFX_API_TOKEN` | yes | Scoped API token. Bound to its owner, revocable on its own. |
| `ARTIFACTS_URL` | no | Instance URL, default `https://rtfx.pro`. `RTFX_URL` is an accepted alias. |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | no | Cloudflare Access **service token**, for an instance that still gates `/api` at the edge (the production posture in [`HERMES_CLOUD.md`](HERMES_CLOUD.md) §2). Pass-through only — it gets a request past Access and grants nothing inside the app. |
| `RTFX_MCP_ALLOW_ACCESS` / `RTFX_MCP_DEBUG` | no | MCP server only. See [`MCP.md`](MCP.md) §3. |

`CF_API_TOKEN` — the Cloudflare management token used for user administration — is deliberately
**not** part of this surface, and the plugin ignores it if present.

`RTFX_URL` was added as an alias on `cli/artifacts.mjs` too, so the plugin and the repo CLI accept
the same environment. `ARTIFACTS_URL` still wins where both are set, and the CLI's existing
default (`http://localhost:8787`) is unchanged.

## 4. Capability map

| Requirement | Command | Notes |
|---|---|---|
| Publish a single HTML file | `publish page.html --slug s --title T` | Sent as `file`. |
| Publish a multi-file folder | `publish ./dist --slug s --title T` | Zipped in-process; needs `index.html` at the root. |
| Publish a zip | `publish ./site.zip --slug s --title T` | Sent as-is. |
| Update an existing slug as a new version | `publish ./dist --slug s --note "…"` | Omit `--title`; a new immutable version goes live. |
| List versions | `versions <slug>` | Newest first, marks the live one. |
| Roll back | `rollback <slug> <n>` | Non-destructive; roll forward the same way. |
| Print the final URL | every command above | Taken from the API response, never assembled client-side. |
| Inspect before uploading | `publish … --dry-run` | Lists every file included and skipped, sends nothing. |
| Check configuration | `doctor` | Endpoint, token id, Access headers, live API reachability. |

Sharing (`grant`, `visibility`) and user/token management are deliberately **absent** from the
plugin. They need a `manage` scope or a browser login, and a publishing integration that can also
change who sees things is a bigger blast radius than the feature is worth. The skill says so
explicitly rather than failing halfway through. The MCP server ships `update_access` behind an
opt-in env var for the operators who do want it — same reasoning, made switchable rather than
absent ([`MCP.md`](MCP.md) §5).

Every row above is reachable through the MCP server too, under the tool names in
[`MCP.md`](MCP.md) §4.

## 5. Why it does not reuse `cli/artifacts.mjs`

The repo CLI depends on `fflate` and on being inside a checkout with `node_modules`. A plugin
installs onto machines that have never seen this repository, so it must stand alone. The MCP server
is standalone for the same reason, which is why it implements the stdio transport rather than
depending on an MCP SDK.

`scripts/rtfx.mjs` therefore writes its own ZIP container (local file headers, central directory,
EOCD, CRC-32), with DEFLATE injected from `node:zlib` and a fallback to *stored* whenever
compression would not actually shrink an entry. Entries are sorted and carry a fixed DOS
timestamp, so publishing unchanged files twice produces byte-identical bytes.

That container is not taken on trust. `test/claude-plugin.test.ts` pushes plugin-built zips —
stored *and* deflated — through the real `POST /api/artifacts` path and then fetches the served
page, so the server is the judge of whether the format is right.

## 6. API changes made for this

Three additive fields. No existing field changed shape, and no route changed status codes:

| Route | Added |
|---|---|
| `GET /api/artifacts` | `content_base` — the origin artifacts are served from |
| `GET /api/artifacts/:slug/versions` | `url` |
| `POST /api/artifacts/:slug/current` | `url` |

All three come from one helper in `src/api.ts`, which resolves the content host from
`CONTENT_HOSTNAMES` and falls back to the request host. The point is that a client never has to
guess: hard-coding `https://a.rtfx.pro/<slug>/` is correct on rtfx.pro and wrong on every
self-hosted instance, and a confidently wrong link is worse than no link.

`cli/artifacts.mjs` now prints the URL on `versions` and `rollback` as a result. The plugin treats
all three fields as optional, so it still works against an instance running older code.

## 7. Testing

| Layer | Where | Runs in |
|---|---|---|
| Config, arg parsing, walk filters, zip writer, error mapping | `test/claude-plugin.test.ts` | `npm test` |
| Plugin-built zips through the real upload + serve path | `test/claude-plugin.test.ts` | `npm test` |
| The new `url` / `content_base` fields, incl. via an API token | `test/claude-plugin.test.ts` | `npm test` |
| Docs and Integrations markers | `test/claude-plugin.test.ts` | `npm test` |
| Structure of the actual plugin files, incl. `.mcp.json` | `scripts/validate-plugin.mjs` | `npm run validate:plugin`, `npm run check`, CI |
| The MCP server: schemas, JSON-RPC, redaction, tools against the real API | `test/mcp.test.ts` | `npm test` |

The split exists because the Workers test pool has no filesystem. The *rules* the validator
applies are pure functions in `scripts/validate-plugin.lib.mjs` and are unit-tested alongside
everything else; the validator walks the real tree and applies them.

`npm run validate:plugin` fails on: a malformed or misplaced manifest, a manifest name that
disagrees with its directory, a marketplace entry pointing at a plugin that isn't there, a command
with no description or body, a skill whose `description` doesn't say *when* to use it, a skill
directory whose name disagrees with its frontmatter, a `${CLAUDE_PLUGIN_ROOT}` reference to a file
that doesn't exist, a bare `scripts/*.mjs` path that would resolve against the user's cwd, an
MCP server declaration that points at a script which isn't there, hard-codes a credential, or
disagrees between `plugin.json` and `.mcp.json`, and anything that looks like a committed credential.

## 8. Secrets

The plugin never writes a credential anywhere. `doctor` prints a token's id (`rtfx_<id>_…`), which
is what `artifacts tokens` lists and what `token-revoke` takes — enough to find or kill a token,
useless for authenticating.

Going the other way, the directory walk refuses to *upload* credentials: `.env`, `.env.*`,
`.dev.vars`, `.npmrc`, `*.pem`, `*.key`, `*.p12`, `id_rsa` and friends are dropped, along with
`.git`, `node_modules` and other build/VCS directories. Every skip is printed, because a bundle
silently missing a file is its own kind of bug.

Credential-shaped strings in the plugin's own files fail `npm run validate:plugin`. The patterns
are tuned to match a plausible secret and not the `rtfx_…` placeholder the docs use throughout.

## 9. Related

- [`MCP.md`](MCP.md) — the MCP server: tools, client configuration, plugin-vs-MCP
- [`plugins/rtfx/README.md`](../plugins/rtfx/README.md) — user-facing install and usage
- [`plugins/rtfx/skills/publishing-to-rtfx/references/api.md`](../plugins/rtfx/skills/publishing-to-rtfx/references/api.md) — HTTP contract as the agent sees it
- [`HERMES_CLOUD.md`](HERMES_CLOUD.md) — full token lifecycle, scopes and error semantics
- [`DEPLOY_RTFX.md`](DEPLOY_RTFX.md) — the Access posture that decides whether service-token headers are needed
