---
description: Revoke and delete the locally stored rtfx.pro browser sign-in
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs:*), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs":*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" logout
```

This revokes the stored OAuth access/refresh credential when the server is reachable and deletes it
from this machine either way. It does not touch the plugin's "API token" option; if one is set, explain that the user can clear
it under `/plugin` > rtfx > Configure separately.

After logout, `/rtfx:setup` should report that no browser sign-in is available unless an API token
is still configured on the plugin.
