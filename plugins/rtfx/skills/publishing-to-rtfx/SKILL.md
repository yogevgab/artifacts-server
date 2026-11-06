---
name: publishing-to-rtfx
description: Use when the user asks to publish, ship, share, deploy, host or "put somewhere I can send it" an HTML page, report, dashboard, prototype or small site - and when they ask to update, re-publish, version, roll back, share, or get the link for something already on rtfx.pro.
---

# Publishing to rtfx.pro

rtfx.pro hosts the HTML pages and small sites that come out of a session, behind real access
control instead of an unlisted URL. Every publish is an immutable version at a stable slug, owned by
whoever signed in.

This plugin connects Claude Code to the hosted rtfx MCP server (`https://mcp.rtfx.pro/mcp`). The
tools appear as `mcp__plugin_rtfx_rtfx__*` (for example `publish`). The server runs in the cloud, so
**it receives content in the tool call; it cannot read files on this machine and takes no path.**

## First use: sign in

The first call may report that the server needs authentication. Tell the user to run `/mcp`, pick
`plugin:rtfx:rtfx` and choose Authenticate to complete the browser sign-in (or `claude mcp login plugin:rtfx:rtfx` in a shell). Tokens are stored and
renewed by Claude Code. Never ask the user to paste a token. Call `doctor` to confirm the connection:
it shows the endpoint, the scopes held and the tools available.

## The tools

| Tool | Use it to |
|---|---|
| `publish` | Publish content you send: `content_text` (an HTML page), `content_base64` (a PDF), or `files` (a small multi-file site that contains `index.html`). Returns the URL. |
| `create_upload_link` | Publish a site that is too big for inline content or contains images, video or other binary files. Returns a single-use `upload_url` and a `page_url`. |
| `list_artifacts` | Find what already exists (search, paging, visibility and kind filters). |
| `artifact_details` | Versions, live version and sharing state of one artifact. Call it before sharing or rolling back. |
| `artifact_statistics` | View counts for one artifact. |
| `share_artifact` | Set who can open it: `restricted` (owner plus listed emails, with optional `editors`) or `everyone` in the workspace. The lists replace the current ones. Needs the `manage` scope. |
| `rollback_artifact` | Make an earlier version live again (version number from `artifact_details`). |
| `delete_artifact` | Permanently delete. `confirm_slug` must equal `slug`. Only after the user has confirmed the exact artifact by name. |
| `doctor` | Check how the connection is authenticated and what it may do. |

## Publishing

1. **Decide what is being published.** If you wrote the page in this session, send its HTML as
   `content_text`. A small text-only site goes in `files` (each entry has a `path` and either
   `content_text` or `content_base64`; one must be exactly `index.html`).
2. **Pick the slug.** Lowercase letters, digits and single hyphens. For a new artifact give a
   `title`, say which slug you chose, and expect it to be created private to its owner.
3. **Re-publish with the SAME slug** to update something that already exists: it appends a new
   version live at the same URL. Never invent a new slug to "update". Check `list_artifacts` first if
   unsure. For an existing slug, omit `title` (sending one renames it) and pass a short `note` that
   says what changed.
4. **Report the URL exactly as returned.** Never assemble it yourself: the workspace part of the
   address is chosen per account.

Credential-looking files, dotfiles and build directories are refused rather than silently dropped.
Do not try to work around a refusal; tell the user which file was refused.

### Large sites, images and video

Do not base64 a big or binary site into `publish`. Call `create_upload_link`, zip the site
(`index.html` at the zip root) in a code sandbox if you have one, and upload it:

```
curl -sS -F bundle=@site.zip <upload_url>
```

The response carries the published URL. If you have no sandbox with network access, give the user the
`page_url` and the zip to drop onto it.

### Publishing a folder that exists on disk

The hosted server cannot read the user's disk. To publish a build output directory, or any folder or
zip by path, the user needs the separate **rtfx-local** plugin: `/plugin install rtfx-local@rtfx`
(from the same marketplace). Say so rather than trying to send a large folder through `publish`.

## Sharing and access

Artifacts start private. Use `artifact_details` to see the current state, then `share_artifact` to
change it. Because the lists replace the current ones, always read the current grants first and send
the full intended list; an empty list revokes everyone. Granting access sends no invitation and
creates no account: tell the user to let the person know.

## Failures

Follow the hint in the error. Do not retry a 401, 403, 404 or 409: none of them improve on a second
attempt. 401 means sign in again via `/mcp`; 403 means the token lacks the scope for the call;
409 means the slug belongs to someone else, so choose another.
