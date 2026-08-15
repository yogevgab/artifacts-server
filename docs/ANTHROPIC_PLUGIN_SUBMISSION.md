# Submitting the rtfx plugin to Anthropic

Everything a human needs in front of them to fill in the submission form, in one page, so the form
is a transcription job rather than a research one.

**Status: not submitted.** Nothing in this repository can grant a listing, and no page here should
imply one. What the repository *can* do — a valid marketplace manifest, a plugin that passes
`claude plugin validate --strict`, a license, a security policy, a changelog — is done, and
[the checklist below](#pre-submission-checklist) is how you confirm that before opening the form.

---

## 1. Which marketplace

Three different things get called "the marketplace". Only the first works today.

| | How it is obtained | Status here |
|---|---|---|
| **This repository, as a custom marketplace** | Nothing. Any repository with a valid `.claude-plugin/marketplace.json` is one. | **Live.** `/plugin marketplace add yogevgab/artifacts-server`, then `/plugin install rtfx@rtfx`. |
| **Community marketplace** (`anthropics/claude-plugins-community`) | Submit through the form in §3; Anthropic reviews. | **Not submitted.** The install string only becomes real after approval — see §6. |
| **Official marketplace** | No application process. Anthropic curates it at their own discretion. | **Nothing to do.** There is no form, and no step here that moves it along. |

A custom marketplace is not a lesser version of the other two — it is the same install flow, from a
repository the user chooses to trust. It is the path that works while a submission is pending, and
it keeps working afterwards.

## 2. The packet

Copy these into the form.

| Field | Value |
|---|---|
| Plugin name | `rtfx` |
| Version | `1.1.0` |
| Plugin path in repository | `./plugins/rtfx` |
| Manifest | `plugins/rtfx/.claude-plugin/plugin.json` |
| Marketplace manifest | `.claude-plugin/marketplace.json` (marketplace name: `rtfx`) |
| Repository URL | `https://github.com/yogevgab/artifacts-server` (public) |
| Branch | `main` |
| Commit SHA | *fill at submission time* — see the note below |
| License | MIT (`LICENSE` at repository root) |
| Homepage | `https://rtfx.pro/docs` |
| Author | rtfx.pro — `https://rtfx.pro` |
| Category | `deployment` |
| Keywords | publishing, artifacts, hosting, cloudflare, mcp, rtfx |
| Security contact | `SECURITY.md` at repository root (GitHub Security Advisories) |
| User documentation | [`CLAUDE_ONBOARDING.md`](CLAUDE_ONBOARDING.md) |
| Changelog | [`../plugins/rtfx/CHANGELOG.md`](../plugins/rtfx/CHANGELOG.md) |

**On the commit SHA.** Approved plugins are pinned to a specific commit, and the catalog re-syncs
nightly, so the SHA you submit is the code reviewers read and users install. Submit a SHA that is
already on `main` — not a branch head that can move under review. Get it with:

```bash
git rev-parse origin/main
```

Record the submitted SHA and date at the bottom of this file when you send the form, so a later
reader knows which code was reviewed.

## 3. Where to submit

Two forms, and which one applies depends on who is submitting, not on the plugin:

- **Individual author** → `https://platform.claude.com/plugins/submit`
- **Team/Enterprise directory manager**, listing into their own organisation's directory →
  `https://claude.ai/admin-settings/directory/submissions/plugins/new`

For this plugin the individual-author form is the one.

## 4. Description copy

**One line** (for the catalog row):

> Publish HTML pages and multi-file artifacts to rtfx.pro from a Claude Code session — versioned,
> access-controlled, with a stable URL.

This is the string already in both manifests; `npm run validate:plugin` fails if they disagree, so
change it in both places or not at all.

**A paragraph** (for a longer field, if the form has one):

> rtfx turns "publish this" into an ordinary sentence in a session. Point it at a built directory, a
> single HTML file, a PDF or a zip and it returns a stable URL. Re-publishing the same slug appends
> an immutable version at the same address, and rollback repoints it without deleting anything.
> Artifacts are private to their owner by default and served from a separate content origin, so a
> published page cannot reach the dashboard that manages it. The publisher is dependency-free Node,
> ships as both slash commands and an MCP server, and refuses to upload anything shaped like a
> credential.

## 5. Security and data answers

Answers to the questions a review — automated or human — is going to ask. All of these are checked
by `npm run validate:plugin` or the test suite unless noted.

| Question | Answer |
|---|---|
| **What does the plugin execute?** | `node ${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs` (commands) and `node ${CLAUDE_PLUGIN_ROOT}/scripts/rtfx-mcp.mjs` (MCP server). Both are plain Node 18+ files in this repository. |
| **Dependencies?** | None. The plugin has no `package.json` and installs nothing — it writes its own zip container rather than pulling a compression library. |
| **Network destinations?** | One: the instance in `ARTIFACTS_URL`, default `https://rtfx.pro`. No telemetry, no analytics, no third-party calls. |
| **What data leaves the machine?** | Only the files the user names for a specific publish, plus the slug/title/note they give. Nothing is read or sent in the background. |
| **Credentials required** | One scoped API token in `RTFX_API_TOKEN`, minted by the user at `/admin/integrations` with the scopes they choose (`read`, `publish`, optionally `manage`). Bound to its owner, individually revocable, expirable. |
| **Is a cloud-provider credential involved?** | No. The plugin takes no Cloudflare account or management credential; `test/claude-plugin.test.ts` pins that its config resolution ignores one. `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` are an optional self-host-only pass-through for an instance that gates every path at the edge — a Cloudflare Access service token, which grants nothing inside the app. |
| **Does it write credentials to disk?** | No. It reads `RTFX_API_TOKEN` from the environment and never writes it anywhere. |
| **Does anything print a token?** | No. `doctor` reports a token's **id**; the commands instruct the model never to echo a token or read one out of a file to display it. `redactToken`/`tokenId` are unit-tested. |
| **Can it exfiltrate a repository?** | The directory walk drops `.env`, `.dev.vars`, `*.pem`, `*.key`, `id_rsa` and similar, skips `.git`/`node_modules`, and reports everything it skipped. A prebuilt zip containing any of them is refused outright rather than silently filtered. `dry_run` lists exactly what would be sent without uploading. |
| **Destructive operations?** | None. Publishing appends a version; rollback repoints a slug. Neither deletes content. Publishing to a slug owned by someone else is refused with `409`, never merged. |
| **Filesystem writes?** | None outside a temporary bundle. |
| **Secrets committed to the repository?** | `npm run validate:plugin` scans every file under `plugins/` and the marketplace manifest for token-shaped strings and fails on a match. Docs use the `rtfx_…` placeholder deliberately. |

## 6. Known limitations — state these plainly

Two things a reviewer will notice. Both are already documented for users in
[`CLAUDE_ONBOARDING.md`](CLAUDE_ONBOARDING.md) and the plugin README, in the same words.

**Authentication is a manually exported token.** The user mints a scoped token and exports
`RTFX_API_TOKEN` in the shell they start Claude Code from. That is a developer setup step, and it
is the supported path today.

**Server-side remote MCP/OAuth is separate from this plugin.** The artifacts-server app answers MCP
over HTTP at `POST /mcp` (`src/mcp.ts`) and now serves OAuth discovery, dynamic client registration,
authorization-code + PKCE, token refresh and revocation. That remote endpoint exposes one read-only
tool (`doctor`) and no publishing. `mcp.rtfx.pro` is the dedicated remote-MCP origin for live smoke;
there is still no remote upload or publish tool. The plan and status are in
[`REMOTE_MCP_OAUTH.md`](REMOTE_MCP_OAUTH.md).

None of that changes what is being submitted here. **The plugin itself is stdio-only** and reads
`RTFX_API_TOKEN` — the HTTP/OAuth endpoint is server-side code in this repository, not something the
plugin ships or calls. Do not describe the plugin to reviewers as having a sign-in flow.

**Artifacts share one content origin.** The origin split isolates published content from the
dashboard, not artifacts from each other. `SECURITY.md` §"Content-origin isolation" covers exactly
what that does and does not buy, and is the honest answer if a reviewer asks about sandboxing.

## 7. Validation

Run all five and paste nothing that did not pass. The first three are this repository's own checks;
the last two are the same validation the review pipeline runs, which also applies automated safety
screening on their side.

```bash
npm run validate:plugin                        # structure, manifest drift, secret scan
npm run check                                  # typecheck + full test suite + validate:plugin
git diff --check                               # no whitespace damage
claude plugin validate . --strict              # marketplace manifest
claude plugin validate ./plugins/rtfx --strict # plugin manifest
```

`--strict` treats warnings as errors — unrecognized fields, missing metadata and everything else
the runtime would quietly tolerate. Submit only from a tree where all five are clean.

## 8. Assets

The form may ask for a screenshot or a short demo. Do not shoot these ad hoc — the shot list, the
capture settings and the redaction rule are already written down:

- **Screenshot checklist** — [`CLAUDE_ONBOARDING.md` § Screenshot checklist](CLAUDE_ONBOARDING.md#screenshot-checklist)
- **60-second video outline** — [`CLAUDE_ONBOARDING.md` § 60-second video outline](CLAUDE_ONBOARDING.md#60-second-video-outline)

The one rule that matters: every token in frame must be redacted to the `rtfx_…` placeholder shape.
A screenshot is the easiest way to leak one, and a leaked token in a submission is not recoverable
by editing the file afterwards.

## 9. Pre-submission checklist

- [ ] Working tree clean, and the change is on `main` — not a branch head that can move under review
- [ ] All five commands in §7 pass
- [ ] `plugins/rtfx/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` both read `1.1.0`
- [ ] [`../plugins/rtfx/CHANGELOG.md`](../plugins/rtfx/CHANGELOG.md) has an entry for that version
- [ ] `LICENSE` (MIT) and `SECURITY.md` present at repository root
- [ ] No page in the repository claims an official or community listing
- [ ] Assets captured per §8, every token redacted
- [ ] Commit SHA from `git rev-parse origin/main` recorded in §2 and in the log below

## 10. After approval

An approved plugin is pinned to the submitted commit in `anthropics/claude-plugins-community`, and
the catalog re-syncs nightly — so a later commit is not live until the pin moves. Only once that
has happened may any page here say: users add `anthropics/claude-plugins-community` as a
marketplace and install `rtfx@claude-community` — **after approval**, and not before.

`npm run validate:plugin` enforces that: a passage naming the community marketplace or its install
suffix, with no approval qualifier anywhere in it, fails the build. It is a lint against a
documentation change that would quietly promise a listing this project does not have.

Until then, and afterwards too, the path that works is the one in §1:

```
/plugin marketplace add yogevgab/artifacts-server
/plugin install rtfx@rtfx
```

## Submission log

Fill in when a submission is actually made. Empty is the honest state until then.

| Date | Version | Commit SHA | Form | Outcome |
|---|---|---|---|---|
| — | — | — | — | not submitted |

## Related

- [`CLAUDE_ONBOARDING.md`](CLAUDE_ONBOARDING.md) — what a new user reads
- [`CLAUDE_CODE.md`](CLAUDE_CODE.md) — how the plugin is built, validated and tested
- [`MCP.md`](MCP.md) — MCP tools and client configuration
- [`../SECURITY.md`](../SECURITY.md) — reporting, scope, and what the origin split does not cover
- [`../plugins/rtfx/README.md`](../plugins/rtfx/README.md) — the plugin's own README
