---
description: Check rtfx.pro credentials and connectivity
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" doctor
```

Report the endpoint, the token id (the command prints only the id — never echo a full token, and
never read one out of a file to display it), and whether the API answered. `doctor` also prints an
`access` line; on rtfx.pro it reads "not set" and that is correct — it only matters on a
self-hosted instance that gates every path at the edge.

If it all checks out, say so in one line and stop — there is nothing else to configure. Offer
`/rtfx:publish` as the next thing to try.

If no credential is available or the API returned `401`, the plugin is installed and only needs an
account connected. Prefer the browser login:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" login
```

That opens rtfx.pro, asks for the **read** and **publish** scopes, and stores a renewing credential
under `~/.config/rtfx/credentials.json` with mode `0600`. The command prints only the token id and
expiry — never the token or refresh token.

If the user is on SSH/headless, use:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" login --manual
```

If `RTFX_API_TOKEN` is set, it still takes priority over the browser sign-in. That is intentional for
CI and advanced users. To use the browser credential, unset the env var. To use an env token instead,
mint one at `https://rtfx.pro/admin/integrations` with scopes **read** and **publish** and export it
in the shell that starts Claude Code — never in a repository file or commit.

Remote HTTP MCP at `/mcp` also supports Claude's OAuth login and exposes `publish` for content
sent inside the MCP call, plus `doctor`. It still cannot publish by local filesystem path; folders
and build outputs remain the local plugin's job because it runs beside the user's files.

A `403` with the token looking right is not a credential problem: it is a scope the token lacks,
or a route (people, tokens, workspaces) that needs a real signed-in session rather than any token.

**Advanced / self-host only.** If `doctor` reports that something other than the API answered —
an edge gate's own sign-in page rather than JSON — the instance is an older self-hosted one that
still gates every path at the edge. rtfx.pro is not one of these and needs no such credential.
There, the operator issues a Cloudflare Access service token (`CF_ACCESS_CLIENT_ID` /
`CF_ACCESS_CLIENT_SECRET`) in Cloudflare Zero Trust, not the rtfx dashboard; it gets the request
through the edge while the `rtfx_…` token still decides identity and scope.

The plugin also registers an **MCP server** with the same tools, for clients with no shell (Claude
Desktop). It reads the same `RTFX_API_TOKEN`. If the user asks about it, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx-mcp.mjs" --help
```

That prints the client configuration and how the current environment resolves — endpoint, token id,
exposed tools. Claude Desktop does not inherit the shell environment, so its config file needs the
token in an `env` block; recommend a short expiry for that one, since it sits in plaintext.
