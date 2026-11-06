# rtfx — Claude Code plugin

Publish what a session just built to [rtfx.pro](https://rtfx.pro): a stable URL, an immutable
version history, and real access control instead of an unlisted link.

```
you: publish this dashboard and share the link
→   https://rtfx.pro/w-3f9a0c12/sales-dashboard   (v1, bundle, 14 files)
```

## Install

Two commands in any Claude Code session. Nothing to clone, no package to install — the plugin
brings its own dependency-free publisher.

```
/plugin marketplace add yogevgab/artifacts-server
/plugin install rtfx@rtfx
```

That installs the skill, seven slash commands and the MCP server. One step is left: telling the
plugin who you are.

### Connect your account

Use the browser login. It stores a local OAuth credential with mode `0600`, renews it automatically,
and never prints the token:

```
/rtfx:login
/rtfx:setup
```

Prefer an API token (for the MCP tools)? Mint one at <https://rtfx.pro/admin/integrations> with the
`read` and `publish` scopes and enter it in the plugin's **API token** option: `/plugin`, choose
`rtfx`, **Configure**. Claude Code also asks for it when the plugin is enabled; leave it empty to use the
browser sign-in. The token is marked sensitive, so it is kept in your system keychain, not in a file.
The **rtfx endpoint** option defaults to `https://rtfx.pro`; change it only to point at a self-hosted
artifacts-server (https only; anything else is refused, never replaced by rtfx.pro). It applies to the MCP
tools. Claude Code does not substitute plugin options into slash-command text, so for a self-hosted instance
also `export ARTIFACTS_URL=https://your-instance` in the shell that starts Claude Code, or `/rtfx:login` will
sign in to rtfx.pro.

Since 1.2.2 the plugin **no longer reads `RTFX_API_TOKEN` (or any other credential) from your shell
environment**, and the `/rtfx:*` slash commands use the browser sign-in only. If you used to
`export RTFX_API_TOKEN=...`, paste that token into the **API token** option instead, or run `/rtfx:login`.
For CI and scripts, use the repo's `artifacts` CLI.

Run `/rtfx:setup` to confirm whichever credential is active. It prints the token's **id**, never the
token or refresh token.

> **Remote MCP is also available for content publishing and connection checks.** Claude Code can add the hosted MCP
> endpoint and sign in with OAuth:
>
> ```
> claude mcp add --transport http rtfx https://mcp.rtfx.pro/mcp
> claude mcp login rtfx
> ```
>
>
> Remote MCP exposes `publish` for content sent inside the MCP call, plus `doctor`. The local plugin
> still remains best for publishing folders by path, because it runs on *your* machine.

## What you get

| | |
|---|---|
| **Skill** `publishing-to-rtfx` | Loads on its own when you say "publish this", "ship it", "share this page". Covers single files, folders, zips, versioning and rollback. |
| `/rtfx:publish [path] [slug]` | Publish or re-publish, then report the URL. |
| `/rtfx:list` | What this credential can reach. |
| `/rtfx:versions <slug>` | Version history, newest first. |
| `/rtfx:rollback <slug> <n>` | Make an earlier version live again. |
| `/rtfx:login` | Browser OAuth sign-in; stores a renewing local credential. |
| `/rtfx:logout` | Revoke and delete the stored browser sign-in. |
| `/rtfx:setup` | Check credentials and connectivity. |

The plugin also works as a plain CLI, with or without Claude Code:

```bash
node scripts/rtfx.mjs publish ./dist --slug q3-report --title "Q3 Report"
node scripts/rtfx.mjs publish ./dist --slug q3-report --note "revised charts"  # → v2
node scripts/rtfx.mjs versions q3-report
node scripts/rtfx.mjs rollback q3-report 1
node scripts/rtfx.mjs list --json
node scripts/rtfx.mjs login
node scripts/rtfx.mjs logout
```

## MCP server

The same operations are available as **MCP tools**, for a client that has no shell to run a command
in — Claude Desktop, or anything else that speaks MCP. Installing the plugin registers it. It uses
the plugin's **API token** option when set, otherwise the same browser sign-in as the CLI.

| Tool | Does |
|---|---|
| `publish` | Publish a file, folder or zip; returns the URL. `dry_run: true` reports what would go up and sends nothing. |
| `list_artifacts` | What this token can reach. |
| `get_versions` | Version history, newest first, marking the live one. |
| `rollback` | Make an earlier version live again. |
| `doctor` | Endpoint, token **id**, Access headers, reachability. |
| `update_access` | Who may open an artifact. **Off** unless started with `RTFX_MCP_ALLOW_ACCESS=1`, and needs a `manage` token. |

**Claude Code**, if you would rather register it by hand — pass the absolute path to this
directory's copy of the script (`/plugin` shows where the plugin was installed):

```bash
claude mcp add rtfx -- node /absolute/path/to/plugins/rtfx/scripts/rtfx-mcp.mjs
```

**Claude Desktop** — `claude_desktop_config.json` (this standalone setup is separate from the plugin, which takes its token from the **API token** option). The token
belongs in `env` here; give that one an expiry, since it sits in a plaintext file:

```json
{
  "mcpServers": {
    "rtfx": {
      "command": "node",
      "args": ["/absolute/path/to/plugins/rtfx/scripts/rtfx-mcp.mjs"],
      "env": { "RTFX_API_TOKEN": "rtfx_…" }
    }
  }
}
```

`node scripts/rtfx-mcp.mjs --help` prints the configuration a client needs and how the current
environment resolves. Full detail: [docs/MCP.md](../../docs/MCP.md).

**Which one?** No shell (Claude Desktop, another client) → MCP. Claude Code → either; the skill
carries more judgement about *how* to publish than tool descriptions can. CI or a script → the CLI,
for `--json` and the exit code.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `RTFX_API_TOKEN` | no | MCP server only. Set by the plugin from its **API token** option (or by you, in a hand-registered / Claude Desktop MCP config). Ignored by the CLI. Takes priority over browser login. |
| `ARTIFACTS_URL` | no | Instance URL, default `https://rtfx.pro`; set by the plugin's **rtfx endpoint** option. `RTFX_URL` is accepted too. Must be https (loopback http allowed). |
| `RTFX_MCP_ALLOW_ACCESS` | no | MCP only. `1` also exposes `update_access`. |
| `RTFX_MCP_DEBUG` | no | MCP only. Logs method names to stderr; never arguments. |

The scripts read only the variables listed above (plus `XDG_CONFIG_HOME` for the credentials path); nothing
else in your environment. The stored browser sign-in is keyed by issuer origin and is only ever sent to the
issuer that minted it. No Cloudflare management token is involved anywhere, and Cloudflare Access service-token
headers are no longer forwarded. Browser login writes only
`~/.config/rtfx/credentials.json` with owner-only permissions; `doctor` prints a token's **id** only.

## Design notes

- **Zero dependencies, no install step.** `scripts/rtfx.mjs` is plain Node 18+. It writes its own
  zip container (`scripts/rtfx.lib.mjs`) rather than pulling a compression library, because the
  plugin lands on machines that have never seen this repo. The MCP server
  (`scripts/rtfx-mcp.mjs`) is the same: no SDK, one file, the stdio transport written out.
- **One safety model, two front doors.** The CLI and the MCP server are wrappers over the same
  `rtfx.lib.mjs` and `rtfx.bundle.mjs`, so credentials resolve and bundles get filtered identically
  either way — they cannot drift.
- **Deterministic bundles.** Zip entries are sorted and carry a fixed timestamp, so publishing
  unchanged files produces identical bytes.
- **Refuses to upload credentials.** The directory walk drops `.env`, `.dev.vars`, `*.pem`,
  `*.key` and friends, along with `.git`/`node_modules`, and prints everything it skipped.
- **`--json` everywhere**, so an agent parses results instead of scraping prose. Failures come
  back as `{ "ok": false, "error", "detail", "hint", "retryable" }` with exit code 1.
- **The URL is never constructed client-side.** It comes from the API response, which knows the
  workspace address (`rtfx.pro/<workspace>/<slug>`). Uploaded HTML itself runs in a sandboxed
  frame on a separate content origin, so it can't reach the app that manages it.

## Contract

Publishing to a new slug creates the artifact at v1, private to its owner. Publishing to a slug
you already own appends an immutable version and makes it live at the same URL. Publishing to
someone else's slug is refused (`409`), never merged into their artifact. Rollback repoints the
slug without deleting anything.

Full HTTP contract: `skills/publishing-to-rtfx/references/api.md`.
MCP surface: [docs/MCP.md](../../docs/MCP.md).
Operator-side reference: [docs/HERMES_CLOUD.md](../../docs/HERMES_CLOUD.md).
Release notes: [CHANGELOG.md](CHANGELOG.md).

## Where this plugin comes from

Install it the way the top of this page describes: this repository is itself a Claude Code
marketplace, which needs no approval from anyone. The plugin is **not** listed in Anthropic's
community or official marketplace, and no command on this page depends on one —
[docs/ANTHROPIC_PLUGIN_SUBMISSION.md](../../docs/ANTHROPIC_PLUGIN_SUBMISSION.md) covers what a
submission to the community marketplace would involve and what would change after approval.
