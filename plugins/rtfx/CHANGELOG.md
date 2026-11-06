# Changelog - rtfx Claude Code plugin (hosted)

Versions of the plugin under `plugins/rtfx`, the one listed in Anthropic's plugin directory. It is
versioned independently of the `artifacts-server` application and of `rtfx-local`. The version here is
the one declared in `.claude-plugin/plugin.json` and mirrored into the repository's
`.claude-plugin/marketplace.json`; `npm run validate:plugin` fails if the two disagree, or if the
newest entry below is not the declared version.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
[semantic](https://semver.org/spec/v2.0.0.html).

## 2.0.0

The directory plugin is now remote-only. The directory accepts local-code MCP servers, scripts and
tool grants only from verified organizations, so everything that ran on your computer moved to a
separate plugin.

### Changed (breaking)

- `rtfx` connects to the hosted MCP server `https://mcp.rtfx.pro/mcp` (HTTP transport). Sign in with
  the browser through `/mcp` (or `claude mcp login rtfx`); Claude Code stores the credential.
- The skill is rewritten for the hosted tools: `publish` (content sent with the call),
  `create_upload_link`, `list_artifacts`, `artifact_details`, `artifact_statistics`, `share_artifact`,
  `rollback_artifact`, `delete_artifact` and `doctor`.
- The plugin ships only Markdown, JSON and the icon. No scripts, no hooks, no slash commands, no
  tool pre-approvals, no plugin options.

### Removed

- The local stdio MCP server, the `/rtfx:*` slash commands and the `rtfx.mjs` CLI, together with the
  `api_token` and `endpoint` options.

### Migration

- Publishing a folder, build output or zip from disk by path needs the local tooling: run
  `/plugin install rtfx-local@rtfx`. It is the 1.2.2 package renamed (see its changelog), installed
  from this repository's own marketplace rather than the directory.
- A browser sign-in stored by 1.x at `~/.config/rtfx/credentials.json` is used by `rtfx-local`; the
  hosted `rtfx` plugin signs in separately through `/mcp`.

## 1.2.2 and earlier

The local package, now `rtfx-local`. Its history is in `plugins/rtfx-local/CHANGELOG.md`.
