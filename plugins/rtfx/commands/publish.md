---
description: Publish a page, folder or zip to rtfx.pro and return its URL
argument-hint: [path] [slug]
allowed-tools: Bash(node:*), Read, Glob
---

Publish to rtfx.pro using the `publishing-to-rtfx` skill.

Target: $ARGUMENTS

Work through this in order:

1. **Resolve what to publish.** If a path was given, use it. If not, find the artifact this
   session produced — a built output directory (`dist/`, `build/`, `out/`, `_site/`) if one
   exists, otherwise the HTML file that was just written. If more than one candidate fits, ask
   rather than guess.
2. **Resolve the slug.** If one was given, use it. Otherwise propose one from what the thing
   actually is — lowercase letters, digits and hyphens — and say which one you picked.
3. **Check whether it already exists**, so you get the semantics right:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" list --json`
   - **New slug** → pass `--title`.
   - **Existing slug** → omit `--title` (sending one renames it) and pass a `--note` describing
     what changed in this version.
4. **Publish** with `node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" publish <path> --slug <slug> …`.
   For a directory you did not build yourself, run it once with `--dry-run` first and show the
   user what would be uploaded.
5. **Report the URL exactly as printed**, plus the version number. That line is the deliverable.
   Mention anything the command reported as skipped.

If it fails, follow the `hint:` line the script printed. Do not retry a 401, 403, 404 or 409 —
none of them get better on a second attempt. Report what the user needs to fix.

Never write a token into a file or the transcript. If `RTFX_API_TOKEN` is unset, stop and say so.
