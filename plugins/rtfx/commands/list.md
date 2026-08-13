---
description: List the rtfx.pro artifacts this token can reach
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" list
```

Show the result as a short table: slug, live version, visibility, title, and the URL of each
(`content_base` from `--json` plus the slug, or just quote the slug column if the plain output is
enough). Note that the list is scoped to what this token can reach — an ordinary token sees only
its owner's artifacts, so "not listed" does not mean "does not exist".

If `RTFX_API_TOKEN` is unset, say so and stop; do not guess a token.
