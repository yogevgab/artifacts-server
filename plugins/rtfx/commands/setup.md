---
description: Check rtfx.pro credentials and connectivity
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" doctor
```

Report the endpoint, the token id (the command prints only the id — never echo a full token, and
never read one out of a file to display it), whether Access service-token headers are set, and
whether the API answered.

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

Remote HTTP MCP at `/mcp` also supports Claude's OAuth login, but it currently exposes only the
read-only `doctor` tool. Publishing remains the local plugin's job because it has to read files from
the user's machine.

If `doctor` reports that **Cloudflare Access** answered instead of the API, the instance has not
exposed that surface (see its operator's `DEPLOY_RTFX.md` §5e). Until they do, the only way
through the edge is a Cloudflare Access service token — `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET`, which the operator issues in Cloudflare Zero Trust, not the rtfx
dashboard. A `403` with the token looking right is a different problem: a scope the token lacks,
or a route (people, tokens) that needs a real sign-in.

The plugin also registers an **MCP server** with the same tools, for clients with no shell (Claude
Desktop). It reads the same `RTFX_API_TOKEN`. If the user asks about it, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx-mcp.mjs" --help
```

That prints the client configuration and how the current environment resolves — endpoint, token id,
exposed tools. Claude Desktop does not inherit the shell environment, so its config file needs the
token in an `env` block; recommend a short expiry for that one, since it sits in plaintext.
