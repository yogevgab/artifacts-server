# rtfx - Claude Code plugin (hosted)

Publish the HTML pages and small sites a Claude Code session produces to
[rtfx.pro](https://rtfx.pro): versioned, access-controlled, with a stable URL.

This plugin is deliberately small. It adds a skill and connects Claude Code to the **hosted rtfx MCP
server** at `https://mcp.rtfx.pro/mcp`. Nothing runs on your computer, and the plugin contains no
scripts. The server receives content in the tool call, so it publishes pages and small sites you hand
it; it cannot read your disk.

## Install

```
/plugin marketplace add yogevgab/artifacts-server
/plugin install rtfx@rtfx
```

Then run `/mcp`, choose `plugin:rtfx:rtfx` and Authenticate in the browser (or `claude mcp login plugin:rtfx:rtfx`). Claude Code
stores and renews the credential. The server supports OAuth discovery (RFC 9728 / RFC 8414), dynamic
client registration and client ID metadata documents, with PKCE S256.

Ask Claude to "publish this page to rtfx" and it uses the `publish` tool. Other tools: `list_artifacts`,
`artifact_details`, `artifact_statistics`, `share_artifact`, `rollback_artifact`, `delete_artifact`,
`create_upload_link` (large or binary sites) and `doctor`.

## Publishing a folder from disk

The hosted server cannot see your files. To publish a build directory, folder or zip **by path**,
install the full local tooling instead (or as well):

```
/plugin install rtfx-local@rtfx
```

`rtfx-local` is not in Anthropic's plugin directory; it comes from this repository's own marketplace.
See [`plugins/rtfx-local`](../rtfx-local/README.md).

## Upgrading from 1.x

Version 2.0.0 replaces the local scripts, slash commands and API-token options with the hosted
server and browser sign-in. If you used `/rtfx:*` commands, a local stdio server, or the `api_token`
option, install `rtfx-local@rtfx`, which is the same package as 1.2.2 under a new name. Plugin
option values (`api_token`, `endpoint`) do **not** carry over to `rtfx-local`: enter them again
under `/plugin`, rtfx-local, Configure. Your stored
browser sign-in file (`~/.config/rtfx/credentials.json`) keeps working there.

## Privacy and support

Content you publish is sent to rtfx.pro and stored there. [Privacy policy](https://rtfx.pro/privacy). Docs: <https://rtfx.pro/docs>. Source and
issues: <https://github.com/yogevgab/artifacts-server>. MIT licensed.
