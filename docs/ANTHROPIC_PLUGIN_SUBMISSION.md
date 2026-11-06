# Submitting the rtfx plugin to Anthropic

Everything a human needs in front of them to fill in the submission form, in one page, so the form
is a transcription job rather than a research one.

**Directory rules (2026-11).** The directory scans the marketplace plugin named `rtfx`. For an
organization that is not Verified it refuses local-code MCP servers (`LOCAL_CODE_MCP_SERVER`),
allowed-tools beyond Read/Grep/Glob/LS (`LOCAL_CODE_TOOL_GRANT`) and files that are not
Markdown/text/JSON/YAML/images (`LOCAL_CODE_FILE_TYPE`). 1.2.2 (commit `3208367`) was refused on those
codes. From 2.0.0 the submitted `rtfx` plugin is **remote-only** (one HTTP MCP server at
`https://mcp.rtfx.pro/mcp`, one skill, no scripts); the local package lives on as `rtfx-local`,
installed from this repository's own marketplace and not submitted. `npm run validate:plugin` pins
those rules for `plugins/rtfx`. After merging, use "Check for new commits" on the directory page.

**Status (earlier submissions): submitted and pending review.** The Claude Platform submissions page shows an `rtfx`
submission from 2026-08-26 and a duplicate refreshed submission from 2026-08-27, both pending
review. Nothing in this repository can grant a listing, and no page here should imply approval.
What the repository *can* do — a valid marketplace manifest, a plugin that passes
`claude plugin validate --strict`, a license, a security policy, a changelog — is done, and
[the checklist below](#pre-submission-checklist) is how you confirm that before opening the form.

---

## 1. Which marketplace

Three different things get called "the marketplace". Only the first works today.

| | How it is obtained | Status here |
|---|---|---|
| **This repository, as a custom marketplace** | Nothing. Any repository with a valid `.claude-plugin/marketplace.json` is one. | **Live.** `/plugin marketplace add yogevgab/artifacts-server`, then `/plugin install rtfx@rtfx` (hosted) or `/plugin install rtfx-local@rtfx` (full local tooling, not submitted). |
| **Community marketplace** (`anthropics/claude-plugins-community`) | Submit through the form in §3; Anthropic reviews. | **Submitted, pending review.** The install string only becomes real after approval — see §6. |
| **Official marketplace** | No application process. Anthropic curates it at their own discretion. | **Nothing to do.** There is no form, and no step here that moves it along. |

A custom marketplace is not a lesser version of the other two — it is the same install flow, from a
repository the user chooses to trust. It is the path that works while a submission is pending, and
it keeps working afterwards.

## 2. The packet

Copy these into the form.

| Field | Value |
|---|---|
| Plugin name | `rtfx` |
| Version | `2.0.0` |
| Plugin path in repository | `./plugins/rtfx` |
| Manifest | `plugins/rtfx/.claude-plugin/plugin.json` |
| Marketplace manifest | `.claude-plugin/marketplace.json` (marketplace name: `rtfx`) |
| Repository URL | `https://github.com/yogevgab/artifacts-server` (public) |
| Branch | `main` |
| Commit SHA | `4878adfbabc081dfb9436755bb15a19cb8abd572` for the refreshed 2026-08-27 submission |
| License | MIT (`LICENSE` at repository root) |
| Homepage | `https://rtfx.pro/docs` |
| Author | rtfx.pro — `https://rtfx.pro` |
| Category | `deployment` |
| Keywords | publishing, artifacts, hosting, mcp, rtfx |
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

> Publish HTML pages and small sites to rtfx.pro from a Claude Code session through the hosted rtfx
> MCP server - versioned, access-controlled, with a stable URL.

This is the string already in both manifests; `npm run validate:plugin` fails if they disagree, so
change it in both places or not at all.

**A paragraph** (for a longer field, if the form has one):

> rtfx turns "publish this" into an ordinary sentence in a session. The plugin connects Claude Code to
> the hosted rtfx MCP server; Claude sends a page or a small site and gets a stable URL back.
> Re-publishing the same slug appends an immutable version at the same address, and rollback repoints
> it without deleting anything. Artifacts are private to their owner by default and served from a
> separate content origin, so a published page cannot reach the dashboard that manages it. The plugin
> itself contains only a skill, an icon and documentation; nothing runs on the user's computer.

## 5. Security and data answers

Answers to the questions a review - automated or human - is going to ask. The structural ones are
enforced by `npm run validate:plugin` (`checkDirectoryCompliance`).

| Question | Answer |
|---|---|
| **What does the plugin execute?** | Nothing. It ships a skill (Markdown), `plugin.json`, a README, a changelog, a license and a PNG icon. No scripts, hooks, commands or local MCP servers. |
| **MCP servers?** | One remote server, `type: http`, `https://mcp.rtfx.pro/mcp`. It runs in Cloudflare's network. |
| **Tool grants?** | None. No `allowed-tools` anywhere under `plugins/rtfx`. |
| **Dependencies?** | None. |
| **Network destinations?** | `https://mcp.rtfx.pro/mcp` only, from Claude Code itself. No telemetry. |
| **What data leaves the machine?** | Only the content Claude puts in a `publish` / `create_upload_link` call for a specific publish, plus the slug/title/note. The server cannot read the user's disk. |
| **Credentials?** | Browser OAuth through Claude Code's `/mcp` flow (RFC 9728 / RFC 8414 discovery, CIMD or dynamic client registration, PKCE S256). Claude Code stores and renews the token. The plugin reads no credential from the user's machine and has no user-supplied token option. |
| **Cloud-provider credential?** | No. |
| **Destructive operations?** | `delete_artifact` exists but requires `confirm_slug` to equal `slug` and the `manage` scope; the skill tells Claude to confirm the exact artifact with the user first. Publishing appends a version; rollback repoints. |
| **Secrets committed?** | `npm run validate:plugin` scans every file under `plugins/` and the marketplace manifest for token-shaped strings. |

## 6. Known limitations - state these plainly

**No publishing from disk by path.** The hosted server receives content in the tool call. Publishing a
folder, build output or zip by path is the job of `rtfx-local` (`/plugin install rtfx-local@rtfx`),
which runs a local MCP server and is therefore not submitted to the directory. The skill says so.

**Upgrading users.** `rtfx` 2.0.0 replaces the 1.x local scripts, `/rtfx:*` commands and API-token
options with the hosted server. 1.x users who need those install `rtfx-local`.

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
claude plugin validate ./plugins/rtfx --strict # plugin manifest (directory plugin)
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
- [ ] `plugins/rtfx/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` both read `2.0.0`
- [ ] [`../plugins/rtfx/CHANGELOG.md`](../plugins/rtfx/CHANGELOG.md) has an entry for that version
- [ ] `LICENSE` (MIT) and `SECURITY.md` present at repository root
- [ ] No page in the repository claims an official or community listing
- [ ] Assets captured per §8, every token redacted
- [x] Commit SHA from `git rev-parse origin/main` recorded in §2 and in the log below

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

| Date | Version | Commit SHA | Form | Outcome |
|---|---|---|---|---|
| 2026-08-26 | 1.2.0 | unknown from local evidence | Claude Platform plugin submit form | submitted and pending review |
| 2026-08-27 | 1.2.0 | `4878adfbabc081dfb9436755bb15a19cb8abd572` | Claude Platform plugin submit form | duplicate/refreshed submission received and pending review |

## Related

- [`CLAUDE_ONBOARDING.md`](CLAUDE_ONBOARDING.md) — what a new user reads
- [`CLAUDE_CODE.md`](CLAUDE_CODE.md) — how the plugin is built, validated and tested
- [`MCP.md`](MCP.md) — MCP tools and client configuration
- [`../SECURITY.md`](../SECURITY.md) — reporting, scope, and what the origin split does not cover
- [`../plugins/rtfx/README.md`](../plugins/rtfx/README.md) — the plugin's own README
