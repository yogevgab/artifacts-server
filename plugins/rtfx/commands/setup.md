---
description: Check rtfx.pro credentials and connectivity
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" doctor
```

Report the endpoint, the token id (the command prints only the id — never echo a full token, and
never read one out of a file to display it), whether Access service-token headers are set, and
whether the API answered.

If `RTFX_API_TOKEN` is unset or the API returned `401`, walk the user through it:

1. Sign in at `https://rtfx.pro/admin/integrations` (or the `/admin/integrations` page of their own
   instance).
2. Create a token with scopes **read** and **publish** — `manage` only if they also want this
   session changing who can see an artifact. Set an expiry.
3. Copy it once; the server keeps only a hash and will never show it again.
4. Export it in the shell they run Claude Code from:

   ```bash
   export RTFX_API_TOKEN=rtfx_…
   export ARTIFACTS_URL=https://rtfx.pro   # only if self-hosting
   ```

Suggest putting the export in their shell profile or a secret manager — never in a file inside the
repository, and never in a commit.

If `doctor` reports a `403` while the token looks right, the instance is gating `/api` behind
Cloudflare Access. That needs the service-token headers `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET` from the same dashboard as well.
