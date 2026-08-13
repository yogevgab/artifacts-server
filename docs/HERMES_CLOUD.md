# Hermes Cloud publish contract

How an automated agent — Hermes Cloud, CI, a script — publishes, updates and rolls back
artifacts on this server with an **API token**, without a browser login.

The whole contract is: mint a token once, send it as `Authorization: Bearer <token>`, and
POST a multipart form to `/api/artifacts`.

---

## 1. Get a token

Tokens can only be minted by someone signed in through Cloudflare Access (a human, or the
CLI's Access service token). **An API token can never mint another token** — that is
deliberate, so a leaked publishing credential can't grow itself new rights.

```bash
# As an admin, for an integration that publishes on behalf of a member:
node cli/artifacts.mjs token-create "hermes-cloud" \
  --owner alice@example.com \
  --scopes read,publish \
  --expires-days 90
```

or over HTTP:

```http
POST /api/tokens
Content-Type: application/json

{ "name": "hermes-cloud", "owner_email": "alice@example.com",
  "scopes": ["read", "publish"], "expires_in_days": 90 }
```

```json
201 Created
{
  "token": "rtfx_9f2c1ab30d4e_Xj7…",        ← shown ONCE; store it now
  "id": "9f2c1ab30d4e",
  "name": "hermes-cloud",
  "owner_email": "alice@example.com",
  "is_admin": false,
  "scopes": ["read", "publish"],
  "created_at": "2026-08-13T09:00:00.000Z",
  "expires_at": "2026-11-11T09:00:00.000Z",
  "last_used_at": null,
  "revoked_at": null
}
```

The server stores only a SHA-256 hash of the token. If you lose it, revoke it
(`DELETE /api/tokens/<id>`) and mint another.

**Who may mint what**

| Caller | May create |
|---|---|
| Admin | Any token: for any `owner_email`, or `"is_admin": true` for a token that manages every artifact |
| Member | Only tokens that act as themselves (`owner_email` = their own email, never `is_admin`) |
| API token | Nothing — `403` |

### Token fields

| Field | Meaning |
|---|---|
| `name` | Label, ≤ 80 chars. Required. |
| `owner_email` | The user this token acts as. Required unless `is_admin`. |
| `is_admin` | Admin token: manages every artifact. Admin-only to create. |
| `scopes` | Subset of `read`, `publish`, `manage`. Defaults to `["read","publish"]`. |
| `expires_in_days` | 1–365. Omit for a token that never expires. |

### Scopes

| Scope | Grants |
|---|---|
| `read` | `GET /api/artifacts`, `…/versions`, `…/views`, `…/access` |
| `publish` | `POST /api/artifacts` (create + new version), `POST /api/artifacts/:slug/current` (rollback) |
| `manage` | `PUT /api/artifacts/:slug/access` (visibility + grants), `DELETE /api/artifacts/:slug` |

Scopes only ever **narrow** a token below its owner's rights. A `manage`-scoped token issued
for Alice still reaches only Alice's artifacts.

## 2. Authenticate

```
Authorization: Bearer rtfx_9f2c1ab30d4e_Xj7…
```

The CLI reads it from `RTFX_API_TOKEN`:

```bash
export ARTIFACTS_URL=https://rtfx.pro
export RTFX_API_TOKEN=rtfx_9f2c1ab30d4e_Xj7…
node cli/artifacts.mjs publish ./page.html --slug my-page --title "My Page"
```

> **Cloudflare Access still gates the edge.** A bearer token authenticates you *to the app*;
> it does not get you *past Access*. As long as `/api` sits behind the Access admin
> application (the current production posture — see
> [`DEPLOY_RTFX.md`](DEPLOY_RTFX.md) §5b), a direct machine call must also satisfy Access.
> Two ways to do that:
>
> - **Both credentials** — send the Access service-token headers *and* the bearer token. The
>   CLI does this automatically when `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` and
>   `RTFX_API_TOKEN` are all set. The API token decides identity and scope.
> - **Exclude `/api` from Access** (operator decision, not done here) so bearer auth is the
>   only gate on it. Do this only once you're satisfied the app-layer checks are what you
>   want fronting the internet.

## 3. Publish

```http
POST /api/artifacts
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

| Field | Required | Notes |
|---|---|---|
| `file` | one of | a single `.html` document |
| `bundle` | one of | a `.zip` containing `index.html` at its root |
| `title` | for a new artifact | omit when adding a version, to keep the existing title |
| `slug` | recommended | stable id; derived from `title` when omitted |
| `description` | no | |
| `note` | no | per-version changelog line |

Publishing to a **new** slug creates the artifact at v1 and sets its owner to the token's
owner. Publishing to an **existing** slug you own appends a new version and makes it live
immediately. Ownership is never transferred by a republish.

```json
200 OK
{ "slug": "my-page", "url": "https://a.rtfx.pro/my-page/", "type": "single",
  "file_count": 1, "version": 3 }
```

`url` points at the content host (`CONTENT_HOSTNAMES`), which is where artifacts are served.

```bash
curl -sS -X POST "$ARTIFACTS_URL/api/artifacts" \
  -H "Authorization: Bearer $RTFX_API_TOKEN" \
  -F "slug=my-page" -F "title=My Page" -F "note=headline copy" \
  -F "file=@./page.html;type=text/html"
```

Uploads are capped (413 `payload_too_large` beyond the limit); a `.zip` must contain a root
`index.html`.

## 4. Update and roll back

Updating is just publishing to the same slug — every publish is a new immutable version.

```bash
# what versions exist, and which is live
curl -sS "$ARTIFACTS_URL/api/artifacts/my-page/versions" -H "Authorization: Bearer $RTFX_API_TOKEN"
# {"current":3,"versions":[{"version":3,…},{"version":2,…},{"version":1,…}]}

# roll back to v2 (requires `publish` scope)
curl -sS -X POST "$ARTIFACTS_URL/api/artifacts/my-page/current" \
  -H "Authorization: Bearer $RTFX_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"version": 2}'
# {"slug":"my-page","current":2}
```

Rollback is instant and non-destructive: v3's files stay in R2, so rolling forward again is
another `current` call. Preview any version at `/v/<slug>/<n>/` (owner/admin only).

## 5. Access and deletion (scope `manage`)

```bash
# share with named people
curl -sS -X PUT "$ARTIFACTS_URL/api/artifacts/my-page/access" \
  -H "Authorization: Bearer $RTFX_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"visibility":"restricted","emails":["bob@example.com"]}'

# open to every signed-in user
… -d '{"visibility":"everyone","emails":[]}'

curl -sS -X DELETE "$ARTIFACTS_URL/api/artifacts/my-page" -H "Authorization: Bearer $RTFX_API_TOKEN"
```

A non-admin token's grants are saved but do **not** invite anyone to sign in — the
response carries `allowlistWarning` when a granted address still needs an admin invite.

## 6. Errors

| Status | `error` | Meaning / what to do |
|---|---|---|
| 401 | `invalid_token` | Unknown, revoked, or expired token. Response carries `WWW-Authenticate: Bearer error="invalid_token"`. Mint a new one — do not retry. |
| 403 | `insufficient_scope` | The token lacks the scope for this route. Mint one with the scope; retrying won't help. |
| 403 | `forbidden` | Token used against `/api/users` or `/api/tokens`, which require an Access login. |
| 403 | `account_disabled` | The account this credential acts as has been paused by an admin. Not retryable and not a token problem — ask an admin to re-enable it. |
| 404 | `not_found` | The slug doesn't exist **or** isn't yours. Existence of other users' artifacts is deliberately not observable. |
| 409 | `slug_taken` | Someone else owns that slug. Pick another. |
| 400 | `bad_request` | Missing title/file, bad slug, malformed JSON body. |
| 413 | `payload_too_large` | Upload over the size cap. |
| 503 | `not_configured` | User management isn't configured on this instance. |

A missing/blank `Authorization` header is not an error by itself — the request simply falls
through to Cloudflare Access authentication, and ends in `403 forbidden` if that yields no
identity. A **bad** bearer token is always `401`, never a silent downgrade to another identity.

## 7. Lifecycle and hygiene

```bash
node cli/artifacts.mjs tokens                 # id, owner, scopes, state, last used
node cli/artifacts.mjs token-revoke 9f2c1ab30d4e
```

- Revocation is immediate and permanent; the row is kept as an audit tombstone.
- `last_used_at` is refreshed at most every 5 minutes per token — enough to spot a token
  nobody uses, cheap enough not to write on every request.
- Removing a user (`DELETE /api/users/:email`) revokes their tokens too, and so
  does pausing one (`POST /api/users/:email/disable`). Re-enabling does **not** restore them —
  mint a replacement.
- Prefer one token per integration, with the narrowest scopes and an expiry. Rotate by
  minting the replacement, switching the consumer, then revoking the old id.
- Tokens are secrets: keep them in your platform's secret store, never in a repo, never in a
  URL query string.
