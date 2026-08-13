---
description: Roll an rtfx.pro artifact back to an earlier version
argument-hint: [slug] [version]
allowed-tools: Bash(node:*)
---

Target: $ARGUMENTS

Rolling back changes what **everyone holding the link** sees. Treat it as a real deploy:

1. Show the history first — `node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" versions <slug>` — so
   the user can see which version they are choosing and which is live now.
2. If the version number was not given, ask. Do not assume "the previous one" is what they want.
3. Confirm explicitly before running the rollback.
4. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" rollback <slug> <version>
```

5. Report the new live version and the URL as printed.

Rollback is non-destructive — the newer version's files are still there, so rolling forward is
just another rollback to the higher number. Say this when you report the result; it is the thing
that makes the action safe to take.
