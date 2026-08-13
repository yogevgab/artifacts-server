---
description: Show an rtfx.pro artifact's version history
argument-hint: [slug]
allowed-tools: Bash(node:*)
---

Slug: $ARGUMENTS

If no slug was given, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" list` first and ask which
one, unless the session has published exactly one artifact — then use that.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" versions <slug>
```

Report the artifact URL, which version is live, and the history newest-first with each version's
date, file count and note. If versions carry no notes, say so — it is worth telling the user that
future publishes should pass `--note`.

A `404` means the slug does not exist **or** is not yours; the API deliberately does not
distinguish. Suggest `list` rather than guessing at the cause.
