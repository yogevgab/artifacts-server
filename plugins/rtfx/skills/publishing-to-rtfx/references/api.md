# rtfx.pro HTTP contract

What `scripts/rtfx.mjs` calls underneath, for when you need to go direct — CI without Node, a
language that isn't JavaScript, or debugging a response the script summarised.

Base URL: `ARTIFACTS_URL` (default `https://rtfx.pro`). Every call carries:

```
Authorization: Bearer $RTFX_API_TOKEN
```

Only a SHA-256 hash of the token is stored server-side; the plaintext is shown once, at creation.
On an instance that gates `/api` behind Cloudflare Access, add the service-token headers
`CF-Access-Client-Id` / `CF-Access-Client-Secret` as well — they get the request through the edge,
while the bearer token still decides identity and scope.

## Scopes

| Scope | Grants |
|---|---|
| `read` | `GET /api/artifacts`, `…/versions`, `…/views`, `…/access` |
| `publish` | `POST /api/artifacts` (create + new version), `POST /api/artifacts/:slug/current` (rollback) |
| `manage` | `PUT /api/artifacts/:slug/access`, `DELETE /api/artifacts/:slug` |

Scopes only narrow a token below its owner's rights — never widen them. A token cannot mint
another token or touch `/api/users`; both are `403` by design.

## Publish

```http
POST /api/artifacts
Content-Type: multipart/form-data
```

| Field | Required | Notes |
|---|---|---|
| `file` | one of | a single `.html` document |
| `bundle` | one of | a `.zip` with `index.html` at its root |
| `title` | new artifacts only | omit on a re-publish to keep the existing title |
| `slug` | recommended | the permanent address; derived from `title` when omitted |
| `description` | no | |
| `note` | no | per-version changelog line |

```json
{ "slug": "q3-report", "url": "https://a.rtfx.pro/q3-report/",
  "type": "bundle", "file_count": 12, "version": 3 }
```

`url` is authoritative — it points at the content host, which is a different origin from the API
so uploaded HTML can never reach the app that manages it. Use what the response returns rather
than assembling the URL yourself.

```bash
curl -sS -X POST "$ARTIFACTS_URL/api/artifacts" \
  -H "Authorization: Bearer $RTFX_API_TOKEN" \
  -F slug=q3-report -F title="Q3 Report" -F note="revised charts" \
  -F "file=@./report.html;type=text/html"
```

Publishing to a **new** slug creates the artifact at v1, private, owned by the token's owner.
Publishing to an **existing** slug you own appends a version and makes it live immediately.
Ownership is never transferred by a re-publish, and publishing to somebody else's slug is `409`.

## Versions and rollback

```bash
curl -sS "$ARTIFACTS_URL/api/artifacts/q3-report/versions" \
  -H "Authorization: Bearer $RTFX_API_TOKEN"
# {"current":3,"url":"https://a.rtfx.pro/q3-report/","versions":[{"version":3,…},…]}

curl -sS -X POST "$ARTIFACTS_URL/api/artifacts/q3-report/current" \
  -H "Authorization: Bearer $RTFX_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"version": 2}'
# {"slug":"q3-report","current":2,"url":"https://a.rtfx.pro/q3-report/"}
```

Rollback is non-destructive: v3's files stay in R2, so rolling forward is another `current` call.

## Listing

```bash
curl -sS "$ARTIFACTS_URL/api/artifacts" -H "Authorization: Bearer $RTFX_API_TOKEN"
# {"artifacts":[…],"content_base":"https://a.rtfx.pro"}
```

`content_base` is the origin artifacts are served from; `content_base + "/" + slug + "/"` is any
artifact's URL.

## Errors

| Status | `error` | Retryable | What to do |
|---|---|---|---|
| 401 | `invalid_token` | no | Unknown, revoked or expired. Mint a new one. |
| 403 | `insufficient_scope` | no | Token lacks the scope for this route. |
| 403 | `forbidden` | no | Route needs a browser login, or Access is blocking at the edge. |
| 403 | `account_disabled` | no | The account was paused by an admin. |
| 404 | `not_found` | no | Slug missing **or** not yours — deliberately indistinguishable. |
| 409 | `slug_taken` | no | Someone else owns it. Pick another. |
| 400 | `bad_request` | no | Missing title/file, bad slug, malformed JSON. |
| 413 | `payload_too_large` | no | Over the 50 MiB cap. |
| 5xx | — | once | Server-side failure. |

A missing `Authorization` header is not an error by itself — the request falls through to
Cloudflare Access and ends in `403` if that yields no identity. A **bad** bearer token is always
`401`, never a silent downgrade to another identity.

Full operator-side reference: <https://github.com/yogevgab/artifacts-server/blob/main/docs/HERMES_CLOUD.md>
