# Cloudflare Access cutover runbook

**Do this in Zero Trust. It cannot be scripted from the repo, and it is the one step where a
mistake locks you out of your own product.**

## Why it is needed

The Worker now authenticates people itself: `/auth/start` mails a code, `/auth/verify` sets a
signed session cookie, and `resolveAuth` accepts that cookie. Verified in production on
2026-08-14 — real code, real inbox, real session, personal workspace provisioned.

But Cloudflare Access still gates `/admin`, `/api`, `/whoami`, `/gallery` and **all of
`a.rtfx.pro`** at the edge. Those requests never reach the Worker, so the cookie is never seen.
Today that means:

- Signing in works, then lands on Cloudflare's login screen. The new flow is unusable.
- Guest viewers are impossible. A person who is not on the Access allow-list cannot reach the
  content host at all, so `hasGrant` never runs.

Until this runbook is done, the product is in a deliberate half-state: everything old works,
nothing new is reachable. That is what dual-accept is for — it is safe to sit here.

## Before you start

Confirm the app-owned path works while Access is still up. From any machine:

```bash
curl -s -X POST https://rtfx.pro/auth/start \
  -H 'Content-Type: application/json' -d '{"email":"yogevgab@gmail.com"}'
# expect: {"status":"accepted"}
```

Check the inbox, then redeem the code:

```bash
curl -si -X POST https://rtfx.pro/auth/verify \
  -H 'Content-Type: application/json' -d '{"email":"yogevgab@gmail.com","code":"<CODE>"}'
# expect: HTTP 200 and a Set-Cookie: rtfx_session=…
```

**If that does not return a cookie, stop.** Removing Access now would lock everyone out.

## The change

Zero Trust → Access → Applications.

1. **`Artifacts (viewers)`** — the app covering `rtfx.pro` and `a.rtfx.pro`.
   Do **not** delete it first. Set its policy decision to **Bypass** and save.
   Wait 60 seconds, then confirm the Worker is now the gate:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://rtfx.pro/admin      # expect 302 to /login
   curl -s -o /dev/null -w '%{http_code}\n' https://a.rtfx.pro/admin    # expect 404
   curl -s -o /dev/null -w '%{http_code}\n' https://a.rtfx.pro/what-is-rtfx/   # expect 404 signed out
   ```

   A 302 to `yogevgab.cloudflareaccess.com` means the bypass has not taken effect yet. Wait,
   do not proceed.

2. **Sign in through the product** at <https://rtfx.pro/login> and confirm you land on the
   dashboard and can see your artifacts. This is the real test — do it in a browser, not curl.

3. **`Artifacts (admin)`** — the app guarding `rtfx.pro/api/users`. Same treatment: Bypass,
   verify the People panel still works, then leave it.

4. Only once 1–3 are confirmed, delete both applications. Keep
   **`Artifacts (machine)`** (the `/api/machine` Bypass app) and **`Artifacts (public)`** —
   deleting those changes nothing but costs you the documented topology.

## Rollback

At any point before deletion, set the policy decision back from **Bypass** to **Allow**. The
Worker keeps accepting app sessions either way — dual-accept is still in the code — so
flipping back is non-destructive and instant.

## After it is done

These become dead and should be removed in one commit:

- `wrangler.jsonc` vars: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ACCESS_VIEWER_APP_ID`,
  `ACCESS_VIEWER_POLICY_ID`, `CF_ACCOUNT_ID`, `ADMIN_SERVICE_TOKENS`
- secret: `CF_API_TOKEN`
- `src/access-api.ts`, and the `verifyAccess` branch of `resolveAuth`
- `docs/DEPLOY_RTFX.md` §5a–5e

**One breaking change to plan for:** `ADMIN_SERVICE_TOKENS` holds an Access service-token
client id (`9872ac5c….access`). Retiring Access invalidates it. CLI publishing is unaffected —
it already uses `rtfx_` bearer tokens against `/api/machine` — but anything relying on that
service token for admin rights needs an admin-scoped API token instead. Mint one before you
delete the applications, not after.
