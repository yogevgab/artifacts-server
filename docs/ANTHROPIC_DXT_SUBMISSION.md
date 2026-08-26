# Anthropic approval / listing packet for rtfx Desktop Extension

This is the working packet for asking Anthropic to list or review the rtfx Claude Desktop Extension. It is not proof of approval; do not claim Anthropic approval until Anthropic explicitly grants it.

## What we can ask for

Anthropic can potentially list/review extensions/plugins, but approval is not automatic and there is no repo-side switch that forces it. The practical path is:

1. Ship a valid `.dxt` package for Claude Desktop.
2. Keep source public and easy to audit.
3. Provide a concise safety/privacy packet.
4. Submit through Anthropic's current extension/plugin/directory channel when available.
5. Treat acceptance as a distribution/trust milestone, not a product launch blocker.

## Package

- Source: `dxt/rtfx/manifest.json`
- Build: `npm run dxt:pack`
- Output: `dist/rtfx.dxt`
- Validation: `npm run dxt:validate`

## Submission summary

**Name:** rtfx.pro

**One-liner:** Publish local files, folders, PDFs, and Claude-built artifacts from Claude Desktop to rtfx.pro as private, versioned, access-controlled URLs.

**What it does:** Installs a local MCP stdio server into Claude Desktop. The server exposes `publish`, `list_artifacts`, `get_versions`, `rollback`, and `doctor`; optional `update_access` is hidden unless explicitly enabled and requires `manage` scope.

**Why it needs local execution:** Claude Desktop path/folder publishing must run beside the user's files. The hosted Remote MCP endpoint cannot read local paths and is documented as content-only.

## Safety and privacy claims to make

- No Cloudflare account credential is required or accepted.
- Normal auth is browser OAuth/local credential storage, or an optional scoped `RTFX_API_TOKEN`.
- Credentials are scoped (`read`, `publish`, `manage`), owner-bound, expiring/revocable, and never grant instance-admin power.
- Local credential storage uses the existing rtfx OAuth store; token output is redacted.
- Bundle filtering refuses/skips sensitive files such as `.env`, private keys, VCS/build directories, and unsafe paths.
- Published artifacts are private/restricted by default and versioned immutably.
- The Desktop Extension/local MCP can read local paths only because the user installs it locally; hosted Remote MCP cannot.

## Evidence to attach

- `npm run check` output.
- `npm run dxt:validate` output.
- Unpacked DXT smoke: `node /tmp/rtfx-dxt-unpack/server/rtfx-mcp.mjs --help`.
- MCP stdio smoke showing `tools/list` returns `publish`, `list_artifacts`, `get_versions`, `rollback`, `doctor`.
- Production remote MCP smoke remains separate and should not be used to claim local path publishing.
- Screenshots/video: install `.dxt` in Claude Desktop → run `doctor` → publish a throwaway local HTML/folder → open private artifact URL → cleanup.

## Known limitations to disclose

- Requires Node 18+ available to Claude Desktop's extension runtime.
- Unsigned local builds are for testing/self-distribution; signing/listing/curation depends on Anthropic's process.
- `update_access` is off by default because changing who can open an artifact is a stronger side effect.

## Wording boundaries

Say:

> “Submitted for Anthropic review/listing”

only after submission.

Say:

> “Available as a Claude Desktop Extension”

once the `.dxt` is built and downloadable.

Do **not** say:

> “Anthropic approved,” “Anthropic verified,” or “official Claude extension”

unless Anthropic explicitly grants that status.
