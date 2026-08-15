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

**Status: the flow is complete server-side and has never been driven by a real client.** `POST /mcp`
is served by this app (`src/mcp.ts`) and accepts ordinary `rtfx_…` bearer tokens. The OAuth
authorization server (`src/oauth-routes.ts`) serves RFC 9728/RFC 8414 discovery, dynamic
public-client registration, authorization-code + PKCE consent, access-token issuance as short-lived
`api_tokens`, refresh-token rotation and revocation. `mcp.rtfx.pro` is now a route in
`wrangler.jsonc` (§3), and `/login` completes the sign-in detour the flow takes when nobody is
signed in yet (§4).

What that does **not** say:

- **It has not been smoke-tested against Claude Code.** Not once. Every claim here is pinned by
  `test/oauth.test.ts` and `test/mcp-http.test.ts` driving the real Worker, D1 and token API — which
  is evidence about this code, not about a client's interpretation of it. §5 is the checklist that
  turns that into evidence.
- **The hostname is configured, not provisioned.** The route exists in this repository. The custom
  domain and its DNS record are created by `wrangler deploy`, which has not been run for it.
- **It still cannot publish.** One read-only tool, `doctor`. The local plugin remains the supported
  publishing path, and that is a design decision rather than a missing feature — see below.

---

## 1. What ships: bearer-token bridge plus OAuth authorization server

| | |
|---|---|
| Route | `POST /mcp` on **either app host** — `rtfx.pro` or `mcp.rtfx.pro` (§3). A content host answers 404 (`MANAGEMENT_PREFIXES`, src/host.ts). |
| Transport | MCP Streamable HTTP. One JSON-RPC message per POST, one JSON response. No SSE stream, no session id. |
| Auth | `Authorization: Bearer rtfx_…`, gated by `requireApiToken` — the *same* middleware as `/api/machine/*`. A token may be hand-minted in `/admin/integrations` or issued by the OAuth flow below. |
| Tools | `doctor`, and nothing else. |
| OAuth | Discovery + dynamic registration + authorization-code/PKCE + refresh/revoke. |
| Tests | [`test/mcp-http.test.ts`](../test/mcp-http.test.ts) and [`test/oauth.test.ts`](../test/oauth.test.ts), driving the real Worker, D1 and token API. |

It is still a bridge in one important sense: the remote endpoint can be authorized by browser login,
but it exposes only `doctor`. Publishing still belongs to the local plugin because publishing needs
the user's local files. A client configured with
`claude mcp add --transport http rtfx https://<instance>/mcp --header "Authorization: Bearer ***"`
connects today; a compliant OAuth client can also discover the authorization server from `/mcp`'s
401 challenge.

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

**OAuth metadata is real.** A 401 from `/mcp` carries `resource_metadata` pointing to
`/.well-known/oauth-protected-resource/mcp`, and that document names the authorization server on the
same origin. Tests fetch the named document; advertising a missing one would be a blocker.

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

## 2. OAuth implementation

This section is now the implementation contract for `src/oauth-routes.ts`, `src/oauth.ts`,
`src/oauth-consent.ts` and `migrations/0019_oauth.sql`.

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

### 2.2 Routes

| Route | Spec | Notes |
|---|---|---|
| `GET /.well-known/oauth-protected-resource/mcp` | RFC 9728 | Must be **public** — outside any Access application, like `/docs`. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | Public. Advertise `code_challenge_methods_supported: ["S256"]` only. |
| `POST /oauth/register` | RFC 7591 | Dynamic registration, because Claude Code will not be pre-registered. Rate-limited per IP like `/auth/start`. |
| `GET /oauth/authorize` | OAuth 2.1 | Requires an interactive session; redirects to `/login?next=…` when there is none. Renders consent naming the client, the scopes and the resource. |
| `POST /oauth/authorize` | — | The consent submission. CSRF-protected; this is the only place a browser POST grants a credential. |
| `POST /oauth/token` | OAuth 2.1 | `authorization_code` + PKCE, and `refresh_token`. No implicit grant, no password grant. |
| `POST /oauth/revoke` | RFC 7009 | So `claude mcp logout` is real. |

`/mcp`'s 401 names the protected-resource document. The challenge and the document are shipped and
tested together.

### 2.3 Storage

Three new tables, plus two columns on the one that exists. Only hashes are stored, exactly as
`api_tokens` does today (src/tokens.ts). Fresh installs get the columns from `schema.sql`; existing
instances apply `migrations/0019_oauth.sql` once.

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

An OAuth access token is minted by `createApiToken` with a short expiry (an hour), the scopes
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
5. **`mcp.rtfx.pro` is not required.** ✅ Settled in §3: it is a route now, and it is optional for
   anyone self-hosting. The identifier is pinned in the metadata document rather than in prose —
   built from the origin each request arrived on, so it cannot disagree with where it was served.

## 3. Hosts

Three hostnames, two roles. The split is `CONTENT_HOSTNAMES` and nothing else: a host is
content-only if it is listed there, and an app host otherwise (`isContentHost`, src/host.ts).

| Host | Role | Serves |
|---|---|---|
| `rtfx.pro` | app | everything: dashboard, `/api`, `/mcp`, `/oauth`, `/.well-known`, public pages. The canonical origin (`PUBLIC_BASE_URL`). |
| `mcp.rtfx.pro` | app | the same Worker and the same code path. Named for the surface people point a client at. |
| `a.rtfx.pro` | **content** | uploaded artifact files and the viewer shell. Never `/mcp`, `/oauth` or `/.well-known` — they are `MANAGEMENT_PREFIXES`, so it answers 404. |

**`mcp.rtfx.pro` is an app host, and listing it in `CONTENT_HOSTNAMES` would be a bug**, not a
tightening. It would 404 the three prefixes it exists to serve, and strike it from `appOrigins`
(src/cors.ts) so the consent screen served there could not POST back to itself.
`npm run validate:deploy` fails on that mistake by name.

### Why a second app host is more than cosmetic

The OAuth documents are built from **the origin each request arrived on**, never from
`PUBLIC_BASE_URL` (`requestOrigin`, src/oauth-routes.ts). So a client that discovers rtfx at
`mcp.rtfx.pro` is told:

```
issuer:    https://mcp.rtfx.pro
resource:  https://mcp.rtfx.pro/mcp
endpoints: https://mcp.rtfx.pro/oauth/…
```

RFC 8707 audience validation compares strings and RFC 9207 `iss` validation compares origins, so
this is the property that matters: whichever host a client arrives at, everything it is told names
that host, and the flow agrees with itself. Pinned by "names the dedicated MCP host when the request
arrives there" in `test/oauth.test.ts`.

Two consequences worth stating plainly, because both are host-scoped by design:

- **Sessions do not carry across.** The session cookie is host-only (no `Domain`), deliberately, so
  it never reaches the content host. Being signed in to the dashboard on `rtfx.pro` therefore does
  *not* sign you in on `mcp.rtfx.pro`; authorizing a client there is its own sign-in. That is the
  cost of the isolation, not a bug in it.
- **A sign-in email points back where it started.** `signinOrigin` (src/auth-routes.ts) builds the
  magic link from the app host the request came from, so a sign-in begun mid `claude mcp login` on
  `mcp.rtfx.pro` finishes there rather than dropping the person on `rtfx.pro` with a session their
  consent screen cannot see. Guarded three ways — https only, never a content host, and the host
  must be the canonical site host or a subdomain of it — so an outgoing email can never name a
  surprise.

`PUBLIC_BASE_URL` stays `https://rtfx.pro`. `mcp.rtfx.pro` is therefore non-canonical and serves a
disallow-everything `robots.txt` (`robotsTxt`, src/seo.ts), which is what keeps a second copy of the
public pages out of the search index.

## 4. The sign-in detour

`/oauth/authorize` requires an interactive session. A signed-out visitor is bounced to
`/login?next=<the authorization request, as a path on this origin>` — and until that `next` was
consumed, the bounce was one-way: the person signed in, landed on `/admin`, and the MCP client sat
waiting on a callback that was never coming.

The round trip now closes, and it closes for both endings of a passwordless sign-in:

- `/login?next=…` parks the destination in `rtfx_next` — host-only, `HttpOnly`, `Secure`,
  `SameSite=Lax`, ten minutes. Opening `/login` *without* a `next` clears it, so an abandoned
  authorization cannot hijack an ordinary sign-in later.
- `POST /auth/verify` (the typed code) returns it as `redirect`; `POST /auth/m/:token` (the emailed
  link) returns it as `Location`. It rides a cookie rather than the challenge because the emailed
  link is a bare token with nowhere to carry a destination. `SameSite=Lax` is load-bearing: a link
  clicked in an email is a top-level GET, which Lax permits.
- Already signed in, `/login?next=…` is a 302 straight on, rather than a "you're already in" sheet
  in front of the thing they were trying to do.

`safeNextPath` (src/util.ts) runs when the value is parked **and again** when it is consumed, so a
tampered cookie is worth no more than an absent one. It admits exactly one shape — a path on this
origin — because what waits on the other side of this redirect is a freshly minted session, and an
open redirect here would hand it to whatever host an attacker named. Pinned by "?next= round trip"
in `test/auth-routes.test.ts`.

## 5. Production smoke checklist

**Nothing below has been run.** It is the gate between "the tests pass" and telling anyone this
works. Steps 1–2 are operator work outside this repository.

1. **Provision the host.** `npm run validate:deploy` (expect `routes include mcp.rtfx.pro`), then
   `wrangler deploy` — which creates the `mcp.rtfx.pro` custom domain and its DNS record in the
   `rtfx.pro` zone. Confirm `curl -sI https://mcp.rtfx.pro/health` answers from the Worker.
2. **Check the isolation held.** `https://mcp.rtfx.pro/mcp` → 401 with a `WWW-Authenticate` naming
   `resource_metadata`; `https://a.rtfx.pro/mcp`, `https://a.rtfx.pro/oauth/authorize` and
   `https://a.rtfx.pro/.well-known/oauth-authorization-server` → 404, with no `Location`;
   `https://mcp.rtfx.pro/robots.txt` → `Disallow: /`.
3. **Check discovery names its own host.** Both documents on `mcp.rtfx.pro` must say
   `https://mcp.rtfx.pro`, and both on `rtfx.pro` must say `https://rtfx.pro`. A document naming the
   other host is the failure that breaks audience validation later, and it is silent until then.
4. **Drive the real client**, signed out, in a browser with no rtfx session:
   ```
   claude mcp add --transport http rtfx https://mcp.rtfx.pro/mcp
   claude mcp login rtfx
   ```
   Watch for: dynamic registration succeeds; the browser opens `/oauth/authorize`; a signed-out
   visitor reaches `/login`, and **both** the six-digit code and the emailed link land back on the
   consent screen (this is the path that was broken, and the one to try first); the consent screen
   names Claude Code, the scopes in product terms and the workspace; Allow returns to the client's
   loopback callback; `doctor` then answers over the authorized connection.
5. **Check what it minted.** `/admin/integrations` lists the token, badged with the client that
   asked for it, with a one-hour expiry. Revoking it there stops `doctor` working.
6. **Check the ends.** `claude mcp logout` (RFC 7009 revoke) makes the credential unusable; leaving
   the connection idle past an hour proves refresh rotation works rather than silently re-prompting.

Only after 1–6 pass does any page here get to call the remote flow the recommended onboarding path,
and even then only for `doctor` — publishing needs the local plugin until upload-over-MCP is
designed and built.

## 6. Related

- [`MCP.md`](MCP.md) — the tool surface, both transports
- [`CLAUDE_ONBOARDING.md`](CLAUDE_ONBOARDING.md) — what a new user reads
- [`HERMES_CLOUD.md`](HERMES_CLOUD.md) — token lifecycle, scopes and error semantics
- [`../src/mcp.ts`](../src/mcp.ts) — the endpoint
- [`../test/mcp-http.test.ts`](../test/mcp-http.test.ts) — what it is pinned to
