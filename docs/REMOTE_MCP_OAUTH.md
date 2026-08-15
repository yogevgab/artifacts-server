# Remote MCP and OAuth

The plan for deleting the token export from onboarding, and an exact account of how far it has
actually got.

Today a Claude Code user installs the plugin and then does a second, unrelated thing: mints a token
in a browser and exports it in a shell. That second step is the whole gap between rtfx and something
you just authorize. The destination is symmetrical:

```
claude mcp add --transport http rtfx https://mcp.rtfx.pro/mcp
claude mcp login rtfx
```

**Status: the transport exists; the login does not.** `POST /mcp` is served by this app
(`src/mcp.ts`) and authenticates a bearer `rtfx_…` token. `claude mcp login` needs an OAuth
authorization server, and there is none — no `/.well-known` metadata, no authorization endpoint, no
token endpoint, no client registration. `mcp.rtfx.pro` is not a hostname; the route answers on the
app host of whatever instance is deployed.

---

## 1. What shipped: the bearer-token bridge

| | |
|---|---|
| Route | `POST /mcp` on the **app** host. A content host answers 404 (`MANAGEMENT_PREFIXES`, src/host.ts). |
| Transport | MCP Streamable HTTP. One JSON-RPC message per POST, one JSON response. No SSE stream, no session id. |
| Auth | `Authorization: Bearer rtfx_…`, gated by `requireApiToken` — the *same* middleware as `/api/machine/*`. |
| Tools | `doctor`, and nothing else. |
| Tests | [`test/mcp-http.test.ts`](../test/mcp-http.test.ts), driving the real Worker, D1 and the real token API. |

It is a bridge in the literal sense: it is the half of the destination that does not need an
authorization server, built so the half that does can be dropped in behind it without moving the
route, the transport or the tool surface. A client configured with
`claude mcp add --transport http rtfx https://<instance>/mcp --header "Authorization: Bearer rtfx_…"`
connects today. `claude mcp login rtfx` still fails, and this document is not permission to say
otherwise anywhere.

### What it deliberately does not do

**No `publish`.** This is not a gap to be closed by enabling something. `publish` takes a path on the
machine running the *client*; a server-side endpoint cannot read that machine's disk. A remote
`publish(path)` could only ever read the **server's** filesystem, which is not what the caller means
and is a disclosure primitive rather than a feature. Publishing stays with the local plugin, whose
stdio MCP server runs beside the user's files. Any future remote publish is an *upload* design —
bytes travelling up in the request — not a path argument, and it needs its own slice.

**No `list_artifacts`, `get_versions` or `rollback`.** These have no filesystem problem; they are
ordinary API calls. They are held back on a narrower rule: this endpoint's reach should stay at
"reports on the credential you already hold" until OAuth has decided how a remote credential is
minted and scoped. Adding a read tool later is a line in `REMOTE_TOOLS` plus a scope check. Removing
one after clients depend on it is not.

**No `update_access`, and nothing that manages users, tokens or workspaces.** Same rule the rest of
the machine surface follows (`denyApiToken`, src/api.ts). Not merely unlisted — there is no handler.

**No OAuth metadata.** A 401 from `/mcp` carries a plain `WWW-Authenticate: Bearer` challenge with
**no** `resource_metadata` parameter. MCP clients read that parameter and go looking for an
RFC 9728 document; advertising one we do not serve would send every compliant client into a
discovery 404 and would amount to claiming OAuth exists here. A test pins the absence.

### Security decisions, and why

- **One gate, not two.** `/mcp` reuses `requireApiToken` verbatim rather than re-deriving a bearer
  check. A session cookie, dev impersonation and a Cloudflare Access assertion are all refused —
  which is what keeps an endpoint meant to sit outside Access immune to CSRF, since a browser
  attaches cookies by itself but never an `Authorization` header.
- **The secret never returns.** `doctor` reports `rtfx_<id>_…`. The plaintext is resolved to a row
  by the gate and never carried into the handler.
- **Scopes still bind.** `doctor` needs no scope to report on the connection — the caller already
  holds the credential it describes — but the artifact count it uses as a reachability proof runs
  only for a token holding `read`, under the same visibility rule as `GET /api/artifacts`.
- **Origin is validated, not just annotated.** A request carrying an `Origin` this instance does not
  recognize is refused 403, which is the DNS-rebinding protection the MCP specification asks for.
  A request with no `Origin` — every non-browser client — is untouched. Allowed origins come from
  `appOrigins` (src/cors.ts), so a content host can never be one and `*` is never emitted.
- **Bounded input.** 256 KiB per message, counted against bytes actually read rather than a declared
  `Content-Length`. Batches are refused, matching the stdio server.
- **The allow-list is a literal.** `REMOTE_TOOLS` is written out, not filtered from the stdio
  server's `TOOLS` — a derived allow-list grows silently when its source grows.

## 2. The next slice: OAuth

What follows is a **design, not an implementation**. Nothing in it exists in this repository.

MCP's authorization spec (revision 2025-06-18) makes the MCP server an OAuth 2.1 *resource server*.
It does not have to be the authorization server, but for rtfx it should be: we already own sign-in
(`/auth/*`, src/auth-routes.ts), already have a consent-capable session, and already mint scoped,
revocable, hashed credentials (`api_tokens`). The pieces are there; what is missing is the protocol
skin over them.

### 2.1 The shape

```
client                     rtfx (RS + AS)
  │  POST /mcp  (no creds)
  │─────────────────────────►  401 + WWW-Authenticate: Bearer
  │                                 resource_metadata="https://rtfx.pro/.well-known/
  │                                 oauth-protected-resource/mcp"
  │  GET that document       ──►  { resource, authorization_servers: [ "https://rtfx.pro" ] }
  │  GET /.well-known/oauth-authorization-server
  │                          ──►  endpoints, PKCE methods, scopes_supported
  │  POST /oauth/register    ──►  a client_id (RFC 7591 dynamic registration)
  │  browser → /oauth/authorize?…&code_challenge=…&resource=https://rtfx.pro/mcp
  │                          ──►  sign in (existing /auth), then a consent screen
  │  POST /oauth/token       ──►  access token (+ refresh token)
  │  POST /mcp  Bearer …     ──►  200
```

### 2.2 Routes to add

| Route | Spec | Notes |
|---|---|---|
| `GET /.well-known/oauth-protected-resource/mcp` | RFC 9728 | Must be **public** — outside any Access application, like `/docs`. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | Public. Advertise `code_challenge_methods_supported: ["S256"]` only. |
| `POST /oauth/register` | RFC 7591 | Dynamic registration, because Claude Code will not be pre-registered. Rate-limited per IP like `/auth/start`. |
| `GET /oauth/authorize` | OAuth 2.1 | Requires an interactive session; redirects to `/login?next=…` when there is none. Renders consent naming the client, the scopes and the resource. |
| `POST /oauth/authorize` | — | The consent submission. CSRF-protected; this is the only place a browser POST grants a credential. |
| `POST /oauth/token` | OAuth 2.1 | `authorization_code` + PKCE, and `refresh_token`. No implicit grant, no password grant. |
| `POST /oauth/revoke` | RFC 7009 | So `claude mcp logout` is real. |

`/mcp`'s 401 gains the `resource_metadata` parameter **in the same change** that adds the document —
never before it.

### 2.3 Storage

Three new tables, plus two columns on the one that exists. Only hashes are stored, exactly as
`api_tokens` does today (src/tokens.ts).

```sql
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,       -- JSON array; exact-match only, no wildcards
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  email TEXT NOT NULL,
  account_id TEXT,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,            -- RFC 8707 audience; pinned into the issued token
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,      -- S256 only
  expires_at TEXT NOT NULL,          -- 60s
  consumed_at TEXT
);

CREATE TABLE oauth_refresh_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  email TEXT NOT NULL,
  account_id TEXT,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);

ALTER TABLE api_tokens ADD COLUMN issued_via TEXT;      -- 'dashboard' | 'oauth'
ALTER TABLE api_tokens ADD COLUMN oauth_client_id TEXT;
```

### 2.4 The load-bearing decision: the access token is an `api_tokens` row

An OAuth access token should be minted by `createApiToken` with a short expiry (an hour), the scopes
consented to, the workspace the person was acting in, and `issued_via = 'oauth'`. It is then an
ordinary `rtfx_…` bearer credential.

That is the whole point of having built the bridge first:

- `requireApiToken`, `requireScope`, `canManage`, the paused-account check and revocation-on-user-
  removal all apply with **no new code** and no second authorization path to keep in step.
- `/admin/integrations` lists it beside hand-minted tokens, so a person can see and revoke what they
  authorized. It needs a badge saying which client asked, which is what `oauth_client_id` is for.
- A leaked access token is exactly as dangerous as a leaked dashboard token, and no more — a
  property that is easy to state and easy to test, and would not be true of a bespoke token format
  with its own verification path.

The cost is that the access token is opaque rather than a JWT, so validating one is a D1 read. That
read is already on the machine path today and is indexed on the hash.

### 2.5 Scopes

Map OAuth scope strings onto the three that exist, rather than inventing a parallel vocabulary:
`rtfx:read` → `read`, `rtfx:publish` → `publish`, `rtfx:manage` → `manage`. The consent screen must
name them in product terms ("publish and update your artifacts"), never as bare tokens. Default
requested set for an MCP client: `read publish`. `manage` is never in a default and gets its own
line on the consent screen, matching why the stdio server keeps `update_access` behind a flag.

### 2.6 Only then: widen the tool surface

OAuth is what makes a per-user, per-client, expiring, individually revocable credential the normal
case rather than the careful case. `list_artifacts`, `get_versions` and `rollback` should land in
`REMOTE_TOOLS` in the same change that ships it, each behind its existing scope. `publish` still does
not, until upload-over-MCP is designed.

### 2.7 Risks to settle before writing any of it

1. **Dynamic client registration is an unauthenticated write.** It has to be, and it is the obvious
   abuse target. Rate-limit per IP, cap registrations, expire unused clients, and never let a
   registration widen anything by itself — a `client_id` grants nothing without a human consent.
2. **Redirect URIs.** Exact match, no wildcards, no substring checks. Loopback (`http://127.0.0.1:*`)
   needs an explicit port-flexible rule, which is where this class of bug usually lives.
3. **The consent screen is a CSRF target.** It is the one browser POST that mints a credential.
4. **Access in front of `/mcp`.** On an Access-gated deployment the discovery documents and `/mcp`
   itself must sit on a Bypass policy, or a client meets a Cloudflare login page and reports it as a
   broken server. Same operator step `/api/machine` already needs (`docs/DEPLOY_RTFX.md` §5e).
5. **`mcp.rtfx.pro` is not required.** A dedicated hostname is cosmetic; the resource identifier in
   the metadata must match whatever host is actually served, or audience validation fails. Pick one
   and pin it in the metadata document, not in prose.

## 3. Related

- [`MCP.md`](MCP.md) — the tool surface, both transports
- [`CLAUDE_ONBOARDING.md`](CLAUDE_ONBOARDING.md) — what a new user reads
- [`HERMES_CLOUD.md`](HERMES_CLOUD.md) — token lifecycle, scopes and error semantics
- [`../src/mcp.ts`](../src/mcp.ts) — the endpoint
- [`../test/mcp-http.test.ts`](../test/mcp-http.test.ts) — what it is pinned to
