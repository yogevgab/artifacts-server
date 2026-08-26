# rtfx.pro for Claude Desktop

This folder is the source for the Claude Desktop Extension package (`rtfx.dxt`).

A DXT is a zip-style desktop extension that installs a local MCP server into Claude Desktop. Unlike hosted Remote MCP, this server runs on the user's machine, so its `publish` tool can read local paths such as `./report.html` or `./dist`.

## Build

From the repository root:

```bash
npm run dxt:pack
```

Output:

```text
dist/rtfx.dxt
```

## Validate

```bash
npm run dxt:validate
```

This validates `dxt/rtfx/manifest.json`, packs the extension, and verifies the packed archive metadata.

## User install flow

1. Download/open `rtfx.dxt` in Claude Desktop.
2. Configure the optional fields:
   - `rtfx endpoint`: leave `https://rtfx.pro`.
   - `API token`: optional; browser sign-in is preferred when credentials already exist.
   - `Expose access-management tool`: off by default.
3. If not using an API token, run browser sign-in via the rtfx CLI/plugin flow so the local MCP server can read `~/.config/rtfx/credentials.json`.
4. In Claude Desktop, run the `doctor` tool, then publish a local file/folder.

## Boundary

- Claude Desktop DXT/local MCP: can publish local files and folders by path.
- Hosted Remote MCP (`https://mcp.rtfx.pro/mcp`): can publish only content supplied inside the tool call, not local paths.
