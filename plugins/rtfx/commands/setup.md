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

If `RTFX_API_TOKEN` is unset or the API returned `401`, walk the user through it:

1. Sign in at `https://rtfx.pro/admin/integrations` (or the `/admin/integrations` page of their own
   instance).
2. Create a token with scopes **read** and **publish** — `manage` only if they also want this
   session changing who can see an artifact. Set an expiry.
3. Copy it once; the server keeps only a hash and will never show it again.
4. Export it in the shell they run Claude Code from:

   ```bash
   export RTFX_API_TOKEN=rtfx_…
   export ARTIFACTS_URL=https://rtfx.pro   # only if self-hosting
   ```

Suggest putting the export in their shell profile or a secret manager — never in a file inside the
repository, and never in a commit.

The token is normally the whole credential set: publishing goes to `/api/machine`, which
authenticates the bearer token and nothing else.

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
