# Changelog — rtfx Claude Code plugin

Versions of the plugin under `plugins/rtfx`, which is versioned independently of the
`artifacts-server` application that hosts it. The version here is the one declared in
`.claude-plugin/plugin.json` and mirrored into the repository's `.claude-plugin/marketplace.json`;
`npm run validate:plugin` fails if the two disagree, or if the newest entry below is not the
declared version.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
[semantic](https://semver.org/spec/v2.0.0.html).

## 1.1.0

The version currently declared, and the one offered for marketplace submission. Everything in this
section shipped under it — the manifest was set to `1.1.0` when the MCP server landed, and the
entries after it were released without a further bump.

### Added

- **Native MCP server** (`scripts/rtfx-mcp.mjs`), so a client with no shell — Claude Desktop, or
  anything else that speaks MCP — publishes through tool calls. Stdio transport, written out by
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
- **PDF publishing** — a `.pdf` is accepted as an artifact alongside HTML pages, folders and zips.
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
- Five slash commands: `/rtfx:publish`, `/rtfx:list`, `/rtfx:versions`, `/rtfx:rollback`,
  `/rtfx:setup`.
- Dependency-free publisher (`scripts/rtfx.mjs`, plain Node 18+) that writes its own zip container
  rather than pulling a compression library, because the plugin lands on machines that have never
  seen this repository.
- Refusal to upload credentials: the directory walk drops `.env`, `.dev.vars`, `*.pem`, `*.key` and
  friends along with `.git`/`node_modules`, and reports everything it skipped.
- `--json` on every command, with failures as
  `{ "ok": false, "error", "detail", "hint", "retryable" }` and exit code 1.
