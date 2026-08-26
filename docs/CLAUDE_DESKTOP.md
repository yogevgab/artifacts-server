# Claude Desktop Extension (`rtfx.dxt`)

rtfx ships a Claude Desktop Extension so Claude Desktop users can install the local rtfx MCP server without editing `claude_desktop_config.json` by hand.

## Why Desktop Extension instead of hosted Remote MCP?

They solve different problems:

| Surface | Runs where? | Can read local paths? | Best for |
|---|---:|---:|---|
| Claude Desktop Extension (`rtfx.dxt`) | User's machine | Yes | `publish ./report.html`, `publish ./dist`, local files/folders |
| Hosted Remote MCP (`https://mcp.rtfx.pro/mcp`) | Cloudflare Worker | No | no-install OAuth and content sent inside the tool call |

Remote MCP must never be documented as `publish(path)`. The Desktop Extension can publish paths because the MCP server is local.

## Build the extension

```bash
npm run dxt:pack
```

This copies the dependency-free local MCP server from `plugins/rtfx/scripts/` into `dxt/rtfx/server/`, validates the manifest, and packs:

```text
dist/rtfx.dxt
```

## Validate the packed extension

```bash
npm run dxt:validate
```

This performs the pack step, prints extension metadata, and verifies the DXT signature state/structure. Unsigned extensions can still be installed locally; signing/listing is a separate distribution step.

## Install in Claude Desktop

1. Build or download `rtfx.dxt`.
2. Open it with Claude Desktop.
3. Leave `rtfx endpoint` as `https://rtfx.pro` unless self-hosting.
4. Leave `API token` blank unless using an advanced dashboard-minted token.
5. Keep `Expose access-management tool` off unless the user explicitly wants Claude to change artifact access.
6. If no API token is configured, use the rtfx browser-login flow once so the local MCP server can read the stored OAuth credential:

```bash
node /path/to/rtfx.mjs login
```

Then use Claude Desktop's rtfx tools:

- `doctor`
- `publish`
- `list_artifacts`
- `get_versions`
- `rollback`
- optional `update_access` when access management is enabled and the credential has `manage` scope

## Submission / approval posture

DXT gives an easy install artifact immediately. Anthropic approval/listing is not something the repo can force; it requires submitting a complete, safe extension package and waiting for Anthropic review. Prepare:

- `dist/rtfx.dxt`
- source repo link
- concise product description
- privacy/security explanation
- local file-access boundary explanation
- screenshots/GIF/video of install → doctor → publish
- tests/verification evidence
- support and documentation URLs

Do not claim “Anthropic approved” or “verified” until Anthropic explicitly grants that status.
