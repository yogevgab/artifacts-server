# MCP integration

Issue #39. rtfx.pro ships a native **MCP server**: `plugins/rtfx/scripts/rtfx-mcp.mjs`. Any MCP
client — Claude Desktop, Claude Code, or something you wrote — can publish an artifact, read its
version history and roll it back as *tool calls*, with no shell command in between.

It is a wrapper, not a second product. The credential resolution, the bundle safety model and the
HTTP contract are the same modules the CLI uses, so the two cannot drift apart.

The user-facing quickstart is in [`plugins/rtfx/README.md`](../plugins/rtfx/README.md); this is the
operator's view.

There is now a **second** transport: the app itself answers MCP over HTTP at `POST /mcp`, with one
read-only tool and a bearer token. It is a foundation for hosted MCP, not a replacement for the
plugin — §10, and [`REMOTE_MCP_OAUTH.md`](REMOTE_MCP_OAUTH.md) for where it is going.

---

## 1. What ships

```
plugins/rtfx/
  .claude-plugin/plugin.json    declares the server (`mcpServers`)
  .mcp.json                     the same declaration, as a plugin-root config
  scripts/rtfx-mcp.mjs          the stdio server (Node 18+, zero dependencies)
  scripts/rtfx.mcp.lib.mjs      tool schemas, JSON-RPC dispatch, redaction — pure
  scripts/rtfx.bundle.mjs       what may be uploaded — pure, shared with the CLI
  scripts/rtfx.lib.mjs          config, zip writer, error mapping — pure, shared with the CLI
```

Three layers, for one reason: the middle two have **no `node:` imports**, so the artifacts-server
test suite can drive them inside the Workers pool — which has no filesystem and no sockets — with
`fetch` pointed at the real Worker and the filesystem replaced by a virtual one. The safety filters
and the publish path are therefore covered by tests rather than by hand.

`rtfx-mcp.mjs` is the only file that touches the outside world: stdin/stdout, `node:fs`,
`node:zlib`, `fetch`.

## 2. Configure a client

The server needs one credential in its environment. It reads nothing from disk and writes nothing
to disk.

### Claude Code

```bash
claude mcp add rtfx -- node /absolute/path/to/plugins/rtfx/scripts/rtfx-mcp.mjs
```

That is the by-hand route, and it needs the real path to the script — either this checkout, or
wherever `/plugin` reports the plugin was installed. Installing the plugin is usually enough on its
own — the plugin declares the server (in both
`plugin.json` and `.mcp.json`, which is the convention Claude Code's own MCP plugins follow), and it
inherits `RTFX_API_TOKEN` from the shell Claude Code was started in:

```
/plugin marketplace add yogevgab/artifacts-server
/plugin install rtfx@rtfx
```

Or, per project, in the repo's own `.mcp.json`:

```json
{
  "mcpServers": {
    "rtfx": {
      "command": "node",
      "args": ["/absolute/path/to/artifacts-server/plugins/rtfx/scripts/rtfx-mcp.mjs"]
    }
  }
}
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows. Claude Desktop does **not** inherit your
shell environment, so the token goes in the `env` block here:

```json
{
  "mcpServers": {
    "rtfx": {
      "command": "node",
      "args": ["/absolute/path/to/artifacts-server/plugins/rtfx/scripts/rtfx-mcp.mjs"],
      "env": {
        "RTFX_API_TOKEN": "rtfx_…"
      }
    }
  }
}
```

Use an absolute path (double the backslashes on Windows), and give that token an expiry — it is
sitting in a plaintext config file, which is exactly the case scoped, revocable tokens exist for.

### Anything else

`node plugins/rtfx/scripts/rtfx-mcp.mjs` speaks the MCP **stdio transport**: one JSON-RPC message
per line on stdin and stdout, diagnostics on stderr. `--help` prints the configuration a client
needs, plus how the current environment resolves.

## 3. Environment

| Variable | Required | Meaning |
|---|---|---|
| `RTFX_API_TOKEN` | yes | Scoped API token from the dashboard → Integrations. Bound to its owner, revocable on its own. |
| `ARTIFACTS_URL` | no | Instance URL, default `https://rtfx.pro`. `RTFX_URL` is an accepted alias. |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | no | **Advanced / self-host only.** Cloudflare Access service token, for an instance that gates every path at the edge. Not needed on rtfx.pro: the tools call `/api/machine`, which authenticates the bearer token alone ([`HERMES_CLOUD.md`](HERMES_CLOUD.md) §2). Pass-through only: it gets a request past Access and grants nothing inside the app. |
| `RTFX_MCP_ALLOW_ACCESS` | no | Set to `1` to also expose `update_access`. Off by default — see §5. |
| `RTFX_MCP_DEBUG` | no | Log method names to stderr. Never logs arguments. |

`CF_API_TOKEN` — the Cloudflare management token used for user administration — is deliberately
**not** part of this surface, and is ignored if present. This server never manages Cloudflare.

## 4. Tools

| Tool | Scope needed | What it does |
|---|---|---|
| `publish` | `publish` | Publish an `.html` file, a `.zip`, or a directory with `index.html` at its root. New slug → v1; existing slug you own → a new immutable version, live at the same URL. Returns the URL the *API* chose. |
| `list_artifacts` | `read` | Everything the token can reach, with slug, title, type, live version and visibility. |
| `get_versions` | `read` | Version history for one slug, newest first, marking the live one. |
| `rollback` | `publish` | Make an earlier version live again. Non-destructive; roll forward the same way. |
| `update_access` | `manage` | Replace who may open an artifact. **Disabled unless `RTFX_MCP_ALLOW_ACCESS=1`.** |
| `doctor` | `read` | Endpoint, token **id**, whether Access headers are set, which tools are exposed, and whether the API answers. |

`publish` also takes `dry_run: true`, which reports every file that would be included and skipped
and uploads nothing. It needs no token at all, which makes it the safe first call against an
unfamiliar directory.

Every schema is closed (`additionalProperties: false`) with an explicit type and description per
field, so a malformed call comes back as JSON-RPC `-32602` *before* any filesystem or network work
happens. A slug is pattern-checked client-side against the same shape the server enforces.

Results carry two text blocks: a line a person can read, then the same facts as JSON for the model.
A tool that *failed* comes back as a result with `isError: true` and a `hint`, not as a protocol
error — the model is supposed to read the hint and do something else, and a protocol error is not
something it can reason about.

## 5. Why sharing is opt-in, and minting tokens is absent

`update_access` changes who can see an artifact. That is a different blast radius from publishing:
a prompt-injected agent that can publish makes a mess you can roll back, and one that can re-address
the access list has disclosed something. It is off unless the operator turns it on, which keeps the
default MCP surface identical in reach to the Claude Code plugin's.

Even enabled, it is not a way around anything: the API requires the `manage` scope, so a
`read,publish` token gets a `403` (`test/mcp.test.ts` pins this).

Token creation and people management have no tools at all. The API refuses a bearer token on those
routes by design (`denyApiToken` in `src/api.ts`) — issuing a credential takes an interactive login
— so there would be nothing to expose.

## 6. Secrets

The token goes into an `Authorization` header and nowhere else.

- `doctor` reports the token's **id** (`rtfx_<id>_…`), which is what the dashboard lists and what
  revoking it takes, and is useless for authenticating.
- `redactSecrets` runs over every line the server emits — stdout and stderr — replacing the
  configured token, the Access client id and the Access client secret. It also cuts down *any*
  `rtfx_…`-shaped string, so a token for a different instance echoed back in an error body is
  redacted too.
- The shipped declaration has no `env` block on purpose: it is committed to this repository, so a
  token in it would be a published token — the server inherits the environment instead.
  `npm run validate:plugin` fails on a hard-coded `*TOKEN*`/`*SECRET*`/`*KEY*` value in either
  declaration, and on the two declarations disagreeing.
- `RTFX_MCP_DEBUG` logs method names only, never arguments.

Going the other way, the bundle refuses to *upload* credentials — see §7.

## 7. Bundle safety, unchanged

Publishing through MCP runs the same `rtfx.bundle.mjs` the CLI runs:

- **Directory walk.** `.env`, `.env.*`, `.dev.vars`, `.npmrc`, `*.pem`, `*.key`, `*.p12`, `id_rsa`
  and friends are dropped; so are `.git`, `node_modules`, `.wrangler`, `.venv`, `__pycache__` and
  the rest, plus `.DS_Store`/`Thumbs.db`. Every skip is **reported** in the result — a bundle
  silently missing a file is its own kind of bug.
- **Symlinks are recorded and skipped, never followed.** Following one would let a link inside a
  published folder pull in `~/.ssh/id_rsa`, a path the credential filter never even sees, because
  the filter reads the *link's* name.
- **Prebuilt zips are inspected, not trusted.** The central directory is read and every entry
  screened; a zip containing any hidden segment, `__MACOSX`, a build directory or a
  credential-looking name is **refused outright** rather than filtered. An agent is often handed an
  archive it did not build, and quietly changing its contents is worse than saying no.
- **`index.html` at the root** is required for a directory or zip, so a project root fails fast
  instead of publishing something unservable.
- **Caps.** 50 MiB per upload (the server's own limit), plus a walk that gives up past 5000 files
  or 200 MiB of raw input — a guard against being pointed at a home directory, not a policy.

`test/mcp.test.ts` drives all of this over a virtual filesystem and then asserts against real R2
that the skipped paths were never stored and answer 404 when fetched.

## 8. Plugin or MCP?

Both ship in the same plugin and use the same token. Either is a fine default.

| | Claude Code plugin | MCP server |
|---|---|---|
| Surface | Slash commands + a skill that loads on its own | Tools any MCP client can call |
| Works in | Claude Code | Claude Desktop, Claude Code, any MCP client |
| Needs a shell | Yes — it runs `node` | No |
| Output | Human-readable text, or `--json` | Structured tool results, always |
| Guidance | The skill teaches slug choice, versioning, rollback | `instructions` at connect time, plus per-tool descriptions |

Rules of thumb: **Claude Desktop, or any non-Claude-Code client → MCP**, because there is no shell
to run a command in. **Claude Code with the plugin installed → either**; the skill carries more
judgement about *how* to publish (choose an explicit slug, always pass a note, never rename on
re-publish) than tool descriptions can. **CI or a script → the CLI**, which is what `--json` and
the exit code are for.

They compose: the plugin declares the MCP server, so installing it gives you both, and `doctor`
answers the same way through either.

## 9. Testing

| Layer | Where | Runs in |
|---|---|---|
| Tool schemas: closed, typed, described, annotated | `test/mcp.test.ts` | `npm test` |
| Argument validation, including slug and version shapes | `test/mcp.test.ts` | `npm test` |
| JSON-RPC: initialize, negotiation, notifications, `-32601`, `-32602`, parse errors, one-line framing | `test/mcp.test.ts` | `npm test` |
| Redaction, and that no credential reaches a result, error or config report | `test/mcp.test.ts` | `npm test` |
| publish / list / versions / rollback / update_access against the **real** Worker, R2 and D1 | `test/mcp.test.ts` | `npm test` |
| Scope enforcement (`read` cannot publish, `publish` cannot re-address access) | `test/mcp.test.ts` | `npm test` |
| Safety filters over a virtual filesystem, then verified against R2 | `test/mcp.test.ts` | `npm test` |
| Node 18 compatibility: the injected `File` constructor is the one used | `test/mcp.test.ts` | `npm test` |
| Both MCP declarations: structure, resolvable script path, no committed credential, and that they agree | `scripts/validate-plugin.mjs` | `npm run validate:plugin`, `npm run check`, CI |

The pattern is the one the repo already uses: pure rules unit-tested inside the Workers pool, the
filesystem walk applied to the real tree by a script.

## 10. The remote HTTP transport — a foundation, not the finished thing

Everything above describes the **stdio** server that ships in the plugin. The app also serves MCP
over HTTP, from `src/mcp.ts`:

```bash
claude mcp add --transport http rtfx https://rtfx.pro/mcp \
  --header "Authorization: Bearer rtfx_…"
```

That works. `claude mcp login rtfx` does **not** — there is no OAuth authorization server here, no
`/.well-known` metadata and no browser sign-in for MCP. The header is still a hand-minted token, so
this removes no setup step yet; what it removes is the need for a Node process and a filesystem on
the client side, which is what makes a hosted server possible at all.

| | stdio (the plugin) | HTTP (`/mcp`) |
|---|---|---|
| Tools | publish, list_artifacts, get_versions, rollback, doctor (+ update_access, gated) | `doctor` only |
| Credential | `RTFX_API_TOKEN` in the environment | `Authorization: Bearer` header |
| Sign-in | none — export a token | none yet — export a token |
| Runs | on the user's machine | on the instance |

**Why one tool.** `publish` takes a path on the machine running the *client*, and a server-side
endpoint cannot read that machine's disk — a remote `publish(path)` could only read the **server's**
filesystem, which is not what the caller means. It is absent rather than stubbed, and the refusal
says where publishing actually lives so an agent redirects instead of retrying. The read tools have
no such problem and are held back on a narrower rule: the remote surface stays at "reports on the
credential you already hold" until OAuth settles how a remote credential is minted. `update_access`,
user management and token management have no handler at all, the same rule `/api/machine` follows.

**What the endpoint enforces.** Bearer token only, through the very same `requireApiToken` that
guards `/api/machine/*` — so a session cookie, dev impersonation and a Cloudflare Access assertion
are all refused, which is what keeps a surface meant to sit outside Access immune to CSRF. `Origin`
is validated and an unrecognized one is refused outright (DNS-rebinding protection, per the MCP
spec); a content host can never be an allowed origin, and `*` is never emitted. Messages are capped
at 256 KiB, batches are refused, and a content host answers 404 for `/mcp` entirely. `doctor`
reports the token's **id**, never its secret.

`test/mcp-http.test.ts` pins all of it against the real Worker, including that every tool the stdio
server exposes and this one does not is genuinely unreachable here.

## 11. Related

- [`REMOTE_MCP_OAUTH.md`](REMOTE_MCP_OAUTH.md) — the remote transport, and the OAuth slice after it
- [`plugins/rtfx/README.md`](../plugins/rtfx/README.md) — user-facing install and usage
- [`CLAUDE_CODE.md`](CLAUDE_CODE.md) — the plugin this ships alongside
- [`HERMES_CLOUD.md`](HERMES_CLOUD.md) — token lifecycle, scopes and error semantics
- [`POSITIONING.md`](POSITIONING.md) — where "native MCP" sits in what we claim
