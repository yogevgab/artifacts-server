---
description: Revoke and delete the locally stored rtfx.pro browser sign-in
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" logout
```

This revokes the stored OAuth access/refresh credential when the server is reachable and deletes it
from this machine either way. It does not touch `RTFX_API_TOKEN`; if an environment token is set,
explain that the user should unset or remove it from their shell profile separately.

After logout, `/rtfx:setup` should report that no browser sign-in is available unless an environment
token is still set.
