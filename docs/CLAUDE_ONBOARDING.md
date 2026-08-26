# Getting started with Claude Code

Two commands to install, one to connect your account, then *publish this* is an ordinary sentence
in a session.

This is the page to point a new user at. The operator's view of how the plugin is built, tested and
shipped is [`CLAUDE_CODE.md`](CLAUDE_CODE.md); the MCP surface is [`MCP.md`](MCP.md).

---

## 1. Install

In any Claude Code session:

```
/plugin marketplace add yogevgab/artifacts-server
/plugin install rtfx@rtfx
```

The repository is itself a Claude Code marketplace — `.claude-plugin/marketplace.json` at the root
lists one plugin, `./plugins/rtfx`. There is nothing to clone and no package to install: the
plugin carries its own dependency-free publisher and registers its MCP server on install.

You now have a skill, seven slash commands (`/rtfx:login`, `/rtfx:publish`, `/rtfx:list`,
`/rtfx:versions`, `/rtfx:rollback`, `/rtfx:logout`, `/rtfx:setup`) and an MCP server with the same
operations.

## 2. Connect your account

One command opens a browser, asks for the `read` and `publish` scopes, and stores a renewing local
credential with owner-only permissions:

```
/rtfx:login
/rtfx:setup
```

`/rtfx:setup` reports the endpoint, the active credential source, the token's **id** (never the
token or refresh token) and whether the API answered.

For CI or advanced scripted use, `RTFX_API_TOKEN` still works and takes priority over browser login:

```bash
export RTFX_API_TOKEN=rtfx_…
export ARTIFACTS_URL=https://rtfx.pro   # only when self-hosting
```

Keep any token export in a shell profile or a secret manager — not in a repository, and not in a
commit. No Cloudflare account credential is involved anywhere.

## 3. Publish

Say it in words, or name the command:

```
publish this dashboard and share the link
→  https://a.rtfx.pro/sales-dashboard/   (v1, bundle, 14 files)
```

Re-publishing the same slug appends an immutable version and keeps the URL. `/rtfx:versions`
shows the history, `/rtfx:rollback` makes an earlier version live again.

---

## Remote MCP option

Claude Code can also connect to the hosted Remote MCP endpoint with OAuth:

```
claude mcp add --transport http rtfx https://mcp.rtfx.pro/mcp
claude mcp login rtfx
```

The OAuth path has passed a live Claude Code client smoke against the same Worker at
`https://rtfx.pro/mcp`, and the dedicated `mcp.rtfx.pro` host has passed server/DNS smoke. The HTTP
endpoint exposes `publish` for content sent inside the MCP tool call, plus `doctor`. It still cannot
publish by local filesystem path — folders/build outputs should use the local plugin/server.

Section 2, with the local plugin, remains the supported path for publishing local directories or
large build outputs by path.

## Marketplace distribution

Three different things get called "the marketplace", and only the first is how you install this
plugin today.

**This repository, as a custom marketplace — live.** `/plugin marketplace add
yogevgab/artifacts-server` works for anyone, right now. A custom marketplace needs no approval from
anyone, only a repository with a valid `.claude-plugin/marketplace.json`; `npm run validate:plugin`
checks that file on every CI run. This is not a lesser path — it is the same install flow, from a
repository you choose to trust.

**Anthropic's community marketplace — not submitted.** `anthropics/claude-plugins-community` is a
separate listing that requires an external submission and review, which has not been made. Its
`@claude-community` install string would only resolve after approval, so you will not find one on
any page here. The packet a submission needs is written down in
[`ANTHROPIC_PLUGIN_SUBMISSION.md`](ANTHROPIC_PLUGIN_SUBMISSION.md).

**Anthropic's official marketplace — nothing to apply for.** It is curated by Anthropic at their
own discretion; there is no application process, so there is no step here that moves it along.

Nothing in this repository can grant a listing in either of the last two, and no page here should
imply the plugin has one.

---

## Screenshot checklist

Eight images, in the order a new user meets them. Capture on a clean profile at 1440×900, light
theme, no personal artifacts or real email addresses in frame. Every token must be redacted to the
`rtfx_…` placeholder shape — a screenshot is the easiest way to leak one.

Current draft assets live in `docs/media/rtfx-onboarding/`:

- `01-install.png`
- `02-login.png`
- `oauth-consent-redacted.png`
- `04-setup.png`
- `05-publish.png`
- `rtfx-onboarding.gif`
- `rtfx-onboarding.mp4`

The consent screenshot is from the live OAuth flow and has personal email/workspace text replaced
with `redacted@example.com` before being committed.

| # | Shot | Frame | Shows |
|---|---|---|---|
| 1 | `/plugin marketplace add yogevgab/artifacts-server` in a session | Terminal, the command and its confirmation | Install is one line, no clone |
| 2 | `/plugin install rtfx@rtfx` with the install confirmation | Terminal | What arrives: skill, commands, MCP server |
| 3 | `/rtfx:login` starting browser sign-in | Terminal + browser opening | No token copy/paste |
| 4 | OAuth consent screen showing read + publish scopes | Browser, consent only | The user controls authorization |
| 5 | Login success page / terminal success, token id redacted | Browser + terminal | Connected, with no secret on screen |
| 6 | `/rtfx:setup` reporting browser sign-in + API reachable | Terminal | Ready to publish |
| 7 | "publish this" → the returned `https://a.rtfx.pro/<slug>/` URL | Terminal, then the live page | The payoff, in the user's own words |
| 8 | Remote MCP `claude mcp login rtfx` + `publish`/`doctor` | Terminal | Hosted auth works; remote publishes inline content, not paths |

Optional ninth: `/rtfx:versions` next to `/rtfx:rollback`, for the versioning story.

## 60-second video outline

| Time | Beat | On screen |
|---|---|---|
| 0:00–0:07 | The problem: a finished build with nowhere to send it | A local `dist/` and an empty share sheet |
| 0:07–0:20 | Install — the two commands, uncut, real speed | Shots 1–2 |
| 0:20–0:35 | Connect — `/rtfx:login`, consent, `/rtfx:setup` goes green | Shots 3–6, token id only |
| 0:35–0:50 | "publish this" → a URL, opened in the browser | Shot 7 |
| 0:50–1:00 | Re-publish → v2 at the same URL; one line on access control | `/rtfx:versions`, then the sharing panel |

Record the install, login and publish in one take at real speed — the point of the video is that the
whole thing is short, and a cut undercuts the claim. If Remote MCP appears, say plainly that it
publishes inline content over OAuth; publishing a local folder path still stays local so Claude can
read the files.

## Related

- [`../plugins/rtfx/README.md`](../plugins/rtfx/README.md) — the plugin's own README
- [`../plugins/rtfx/CHANGELOG.md`](../plugins/rtfx/CHANGELOG.md) — what each plugin version contains
- [`CLAUDE_CODE.md`](CLAUDE_CODE.md) — how the plugin is built, validated and tested
- [`ANTHROPIC_PLUGIN_SUBMISSION.md`](ANTHROPIC_PLUGIN_SUBMISSION.md) — the marketplace submission packet
- [`MCP.md`](MCP.md) — MCP tools and client configuration
- [`REMOTE_MCP_OAUTH.md`](REMOTE_MCP_OAUTH.md) — the remote HTTP endpoint, and the OAuth plan
- [`HERMES_CLOUD.md`](HERMES_CLOUD.md) — token lifecycle, scopes and error semantics
