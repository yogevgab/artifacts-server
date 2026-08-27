# rtfx.pro HTTP contract

What `scripts/rtfx.mjs` calls underneath, for when you need to go direct — CI without Node, a
language that isn't JavaScript, or debugging a response the script summarised.

Base URL: `ARTIFACTS_URL` (default `https://rtfx.pro`). Every call carries:

```
Authorization: Bearer $RTFX_API_TOKEN
```

Only a SHA-256 hash of the token is stored server-side; the plaintext is shown once, at creation.

**Use `/api/machine/…`, not `/api/…`.** They serve the same artifact routes, but `/api` is the
dashboard's browser API: it also accepts the app's own `rtfx_session` cookie, and its
user/token/workspace routes refuse bearer tokens outright. `/api/machine` authenticates a bearer
`rtfx_…` token and *nothing else* — a browser session is refused there on purpose — so it is the
surface a machine should target. If a call to it returns a `404` with no `error` field, the
instance predates the machine surface: retry that one call against `/api`.

rtfx.pro needs no other credential: the token minted at `/admin/integrations` is sufficient on its
own. An older self-hosted instance that still puts an edge gate (e.g. Cloudflare Access) in front
of every path is the one exception — there the operator's `CF-Access-Client-Id` /
`CF-Access-Client-Secret` service-token headers go alongside the bearer token, getting the request
through the edge while the bearer token still decides identity and scope.

## Scopes

| Scope | Grants |
|---|---|
| `read` | `GET /api/machine/artifacts`, `…/versions`, `…/views`, `…/access` |
| `publish` | `POST /api/machine/artifacts` (create + new version), `POST /api/machine/artifacts/:slug/current` (rollback) |
| `manage` | `PUT /api/machine/artifacts/:slug/access`, `DELETE /api/machine/artifacts/:slug` |

Scopes only narrow a token below its owner's rights — never widen them. A token cannot mint
another token or touch `/api/users`; both are `403` by design.

## Publish

```http
POST /api/machine/artifacts
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
curl -sS -X POST "$ARTIFACTS_URL/api/machine/artifacts" \
  -H "Authorization: Bearer $RTFX_API_TOKEN" \
  -F slug=q3-report -F title="Q3 Report" -F note="revised charts" \
  -F "file=@./report.html;type=text/html"
```

Publishing to a **new** slug creates the artifact at v1, private, owned by the token's owner.
Publishing to an **existing** slug you own appends a version and makes it live immediately.
Ownership is never transferred by a re-publish, and publishing to somebody else's slug is `409`.

## Versions and rollback

```bash
curl -sS "$ARTIFACTS_URL/api/machine/artifacts/q3-report/versions" \
  -H "Authorization: Bearer $RTFX_API_TOKEN"
# {"current":3,"url":"https://a.rtfx.pro/q3-report/","versions":[{"version":3,…},…]}

curl -sS -X POST "$ARTIFACTS_URL/api/machine/artifacts/q3-report/current" \
  -H "Authorization: Bearer $RTFX_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"version": 2}'
# {"slug":"q3-report","current":2,"url":"https://a.rtfx.pro/q3-report/"}
```

Rollback is non-destructive: v3's files stay in R2, so rolling forward is another `current` call.

## Listing

```bash
curl -sS "$ARTIFACTS_URL/api/machine/artifacts" -H "Authorization: Bearer $RTFX_API_TOKEN"
# {"artifacts":[…],"content_base":"https://a.rtfx.pro"}
```

`content_base` is the origin artifacts are served from; `content_base + "/" + slug + "/"` is any
artifact's URL.

## Errors

| Status | `error` | Retryable | What to do |
|---|---|---|---|
| 401 | `unauthorized` | no | No bearer token reached the server. Set `RTFX_API_TOKEN`. |
| 401 | `invalid_token` | no | Unknown, revoked or expired. Mint a new one. |
| 403 | `insufficient_scope` | no | Token lacks the scope for this route. |
| 403 | `forbidden` | no | Route needs a signed-in browser session (people, tokens, workspaces). |
| 403 | `account_disabled` | no | The account was paused by an admin. |
| 404 | `not_found` | no | Slug missing **or** not yours — deliberately indistinguishable. |
| 409 | `slug_taken` | no | Someone else owns it. Pick another. |
| 400 | `bad_request` | no | Missing title/file, bad slug, malformed JSON. |
| 413 | `payload_too_large` | no | Over the 50 MiB cap. |
| 5xx | — | once | Server-side failure. |

On `/api/machine/…` a missing `Authorization` header is `401 unauthorized` — there is no other
identity to fall back to, which is the point. On `/api/…` it falls back to the app's `rtfx_session`
cookie, which a script does not have, and ends in `403 forbidden`. A **bad** bearer token is always
`401` on either, never a silent downgrade to another identity.

If a response is not JSON at all, something other than the API answered — an HTML error page, or,
on a self-hosted instance behind an edge gate, that gate's own sign-in page, which `fetch` follows
and reports as a `200`. Do not treat that as an empty result.

Full operator-side reference: <https://github.com/yogevgab/artifacts-server/blob/main/docs/HERMES_CLOUD.md>
