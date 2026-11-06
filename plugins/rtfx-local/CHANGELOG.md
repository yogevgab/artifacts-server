# Changelog - rtfx Claude Code plugin

Versions of the plugin under `plugins/rtfx-local`, which is versioned independently of the
`artifacts-server` application that hosts it. The version here is the one declared in
`.claude-plugin/plugin.json` and mirrored into the repository's `.claude-plugin/marketplace.json`;
`npm run validate:plugin` fails if the two disagree, or if the newest entry below is not the
declared version.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
[semantic](https://semver.org/spec/v2.0.0.html).

## 1.3.0

This is the 1.2.2 `rtfx` plugin under a new name. Anthropic's directory lists the hosted-only `rtfx`
2.0.0 (see `plugins/rtfx/CHANGELOG.md`); everything that runs on your computer lives here and is
installed from this repository's own marketplace.

### Changed

- Renamed `rtfx` to `rtfx-local`. Install with `/plugin install rtfx-local@rtfx`. Slash commands are
  now `/rtfx-local:login`, `/rtfx-local:publish`, `/rtfx-local:list`, `/rtfx-local:versions`,
  `/rtfx-local:rollback`, `/rtfx-local:setup` and `/rtfx-local:logout`.
- Option values you set on `rtfx` 1.x (`api_token`, `endpoint`) do NOT carry over: re-enter them under `/plugin`, rtfx-local, Configure.
- Behaviour, scripts, the `api_token` / `endpoint` options and the browser sign-in file
  (`~/.config/rtfx/credentials.json`) are unchanged from 1.2.2.

### Migration

- Existing `rtfx@rtfx` users get the hosted 2.0.0 plugin on update. To keep publishing folders from
  disk, run `/plugin install rtfx-local@rtfx`.

## 1.2.2

Fixes from the Claude plugin directory review of 1.2.1.

### Changed

- **The plugin no longer reads credentials from your shell environment.** The MCP server's API
  token and endpoint are now plugin options (`userConfig`): `api_token` is marked sensitive and kept
  in the system keychain, `endpoint` defaults to `https://rtfx.pro`. Claude Code passes them to the
  MCP server only. Enter them under `/plugin`, rtfx, Configure; leave the token empty to use the
  browser sign-in (`/rtfx-local:login`).
- The scripts now read only `ARTIFACTS_URL` / `RTFX_URL`, `XDG_CONFIG_HOME` (credentials path),
  `RTFX_MCP_ALLOW_ACCESS`, `RTFX_MCP_DEBUG` and, in the MCP server only, `RTFX_API_TOKEN` as injected
  by the plugin option. Everything else in the environment is dropped before use. An endpoint that
  is not https (loopback http excepted) is ignored, so a token is never sent in clear text.
- The browser sign-in is unchanged: `~/.config/rtfx/credentials.json` is written by the plugin itself
  and sent only to the issuer origin that minted it.

### Migration

- If you had `export RTFX_API_TOKEN=...` in your shell: the MCP server and the `/rtfx:*` commands no
  longer pick it up (keeping that would keep the credential-from-environment behaviour under review).
  Paste the same token into the plugin's **API token** option, or run `/rtfx-local:login`. The
  `/rtfx:*` slash commands (the CLI) use the browser sign-in only; the MCP tools use the token option.
- Cloudflare Access service-token headers (`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`) are no
  longer forwarded by the plugin. rtfx.pro does not need them; for an instance gated at the edge use
  the repo's `artifacts` CLI.

### Fixed

- This changelog is plain ASCII text; it no longer mentions the listing image by file name.

## 1.2.1

Fixes from the Claude plugin directory review of 1.2.0.

### Fixed

- `/rtfx-local:publish` and `/rtfx-local:rollback` frontmatter is valid YAML again: `argument-hint` values with
  more than one bracketed group are quoted (`/rtfx-local:versions` too, for consistency).
- Commands no longer pre-approve every `node` command. `allowed-tools` names only the plugin's own
  CLI, `${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs` (and, in `/rtfx-local:setup`, `rtfx-mcp.mjs --help`).

### Added

- A 512 x 512 listing icon (the rtfx.pro logo).

## 1.2.0

The submission-ready package for Anthropic review/listing. This version keeps the local Claude Code
and Claude Desktop extension surface stable while aligning the review packet with the current product:
browser OAuth by default, hosted Remote MCP with Anthropic-recommended client metadata support, and
remote artifact lifecycle management.

### Changed

- Submission and review materials now describe browser OAuth as the default connection path, with
  `RTFX_API_TOKEN` kept as an advanced/CI fallback.
- Desktop extension and public docs now link the `v1.2.0` downloadable MCP bundle.
- Review materials document the hosted Remote MCP management tools: list, details, statistics,
  sharing, rollback and deletion with scoped authorization.

## 1.1.0

This version introduced the local MCP server and browser-login era of the plugin.

### Added

- **Native MCP server** (`scripts/rtfx-mcp.mjs`), so a client with no shell - Claude Desktop, or
  anything else that speaks MCP - publishes through tool calls. Stdio transport, written out by
  hand: no SDK, no dependencies. Tools: `publish`, `list_artifacts`, `get_versions`, `rollback`,
  `doctor`.
- `update_access` as an **opt-in** MCP tool. Absent unless the server is started with
  `RTFX_MCP_ALLOW_ACCESS=1`, and it still needs a token carrying the `manage` scope.
- `.mcp.json` at plugin root, so installing the plugin registers the server rather than asking the
  user to wire one up.
- **Machine publishing API.** The CLI and the MCP server call `/api/machine/*`, which authenticates
  the bearer token and nothing else, so publishing needs no Cloudflare Access service token on an
  instance that gates its dashboard at the edge. Requests fall back to `/api/*` on an instance too
  old to expose the machine surface.
- **PDF publishing** - a `.pdf` is accepted as an artifact alongside HTML pages, folders and zips.
- Free-tier retention guidance in the skill and the MCP tool descriptions, so a session says what
  happens to an unopened artifact instead of leaving the user to find out.

### Changed

- The bundle builder moved into `scripts/rtfx.bundle.mjs`, shared by the CLI and the MCP server, so
  credential filtering and zip determinism cannot drift between the two front doors.
- `doctor` reports a token's **id** only. The full token is never printed, logged or written.

## 1.0.0

### Added

- Skill `publishing-to-rtfx`, which loads on its own when a session says "publish this", "ship it"
  or "share this page", and carries the judgement about single files, folders, zips, versioning and
  rollback.
- Five slash commands: `/rtfx-local:publish`, `/rtfx-local:list`, `/rtfx-local:versions`, `/rtfx-local:rollback`,
  `/rtfx-local:setup`.
- Dependency-free publisher (`scripts/rtfx.mjs`, plain Node 18+) that writes its own zip container
  rather than pulling a compression library, because the plugin lands on machines that have never
  seen this repository.
- Refusal to upload credentials: the directory walk drops `.env`, `.dev.vars`, `*.pem`, `*.key` and
  friends along with `.git`/`node_modules`, and reports everything it skipped.
- `--json` on every command, with failures as
  `{ "ok": false, "error", "detail", "hint", "retryable" }` and exit code 1.
