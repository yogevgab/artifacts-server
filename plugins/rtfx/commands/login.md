---
description: Sign in to rtfx.pro with a browser and store a local OAuth credential
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" login
```

This opens the user's browser, completes rtfx.pro OAuth with PKCE, and stores a local credential in
`~/.config/rtfx/credentials.json` with mode `0600`. The command prints the token **id** and expiry,
never the token or refresh token.

After it succeeds, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" doctor
```

If `RTFX_API_TOKEN` is already set, mention that it takes priority over this browser sign-in. The
login is still stored, but publish/list/version calls will keep using the environment token until it
is unset.

If browser opening fails or the user is on SSH, suggest the manual path:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" login --manual
```

Never ask the user to paste or reveal a token. The only thing they may paste in manual mode is the
full loopback callback URL from the browser address bar.
