---
name: publishing-to-rtfx
description: Use when the user asks to publish, ship, share, deploy, host or "put somewhere I can send it" an HTML page, report, dashboard, prototype or built site — and when they ask to update, re-publish, version, roll back, or get the link for something already on rtfx.pro. Covers single HTML files, multi-file folders and zips.
---

# Publishing to rtfx.pro

rtfx.pro hosts the HTML pages and multi-file artifacts that come out of a session, behind real
access control instead of an unlisted URL. Every publish is an immutable version at a stable
slug, owned by whoever's token published it.

The whole integration is one script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" <command> [...]
```

It has no dependencies and needs no install. Node 18+ is the only requirement.

**If rtfx MCP tools are connected** — `publish`, `list_artifacts`, `get_versions`, `rollback`,
`doctor` — prefer them over the shell command. They are the same code behind the same token, and a
tool call needs no Bash permission. Everything below still applies: the slug rules, re-publishing
instead of renaming, always passing a note, reporting the URL verbatim. The argument names match the
flags (`path`, `slug`, `title`, `note`, `dry_run`).

## Before the first publish in a session

Run the check once. It never prints the token itself — only its id.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" doctor
```

If it reports `RTFX_API_TOKEN is not set`, stop and ask the user to mint one at
`https://rtfx.pro/admin/integrations` (scopes `read` and `publish`) and export it. **Never invent,
guess, or write a token into a file, a commit, or the transcript.** Two variables, that's all:

| Variable | Required | Meaning |
|---|---|---|
| `RTFX_API_TOKEN` | yes | Scoped token, `rtfx_…`. Bound to its owner; revocable on its own. |
| `ARTIFACTS_URL` | no | The instance. Defaults to `https://rtfx.pro`. `RTFX_URL` also works. |

The token really is the whole credential set: publishing goes to `/api/machine`, which
authenticates the bearer token and nothing else. `CF_ACCESS_CLIENT_ID` /
`CF_ACCESS_CLIENT_SECRET` are optional pass-through for a self-hosted instance that gates every
path at the edge with Cloudflare Access. They are not a Cloudflare account credential, grant
nothing inside the app, and are never needed on rtfx.pro — if a call reports that Cloudflare
Access answered instead of the API, say so plainly and point the user at their operator rather
than inventing a credential.

## Publishing

One command covers all three shapes. Pick the path by what actually exists:

| What you have | What to pass |
|---|---|
| One self-contained HTML file | the `.html` path |
| A PDF document | the `.pdf` path |
| A built site with assets | the **output directory** (must contain `index.html` at its root) |
| An already-built archive | the `.zip` path (must contain `index.html` at its root) |

```bash
# new artifact — needs a title
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" publish ./report.html \
  --slug q3-report --title "Q3 Report"

# multi-file: point at the build output, not the project root
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" publish ./dist --slug q3-report
```

Always **choose an explicit `--slug`**: lowercase letters, digits and hyphens, derived from what
the thing is (`checkout-prototype`, `q3-report`). It is the permanent address, so a good one is
worth two seconds.

Then **report the URL the command printed**, verbatim. That line —
`https://a.rtfx.pro/<slug>/` — is the deliverable. Do not construct it yourself and do not
paraphrase it.

### Updating something already published

Publishing to a slug that already exists appends a new version and makes it live at the same URL.
There is no separate update command and no `--force` to find.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" publish ./dist \
  --slug q3-report --note "revised charts"
```

Omit `--title` on a re-publish — sending one renames the artifact. Always pass `--note`: it is the
per-version changelog line, and it is what makes a version list readable a month later.

### Unsure what you're about to upload?

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" publish ./dist --slug q3-report --dry-run
```

Lists every file that would go up and every one skipped, and sends nothing. Worth doing when
publishing a directory you did not build yourself.

The walk skips `.git`, `node_modules` and similar build/VCS directories, and refuses anything that
looks like a credential (`.env`, `*.pem`, `*.key`, `.dev.vars`). Skips are always printed. If
something you needed was skipped, move it into the build output rather than defeating the filter.

## Versions and rollback

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" versions q3-report
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" rollback q3-report 2
node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" list
```

Rollback is instant and non-destructive within the plan's retention window — the newer version's
files stay, so rolling forward is
just another `rollback` to the higher number. Confirm with the user before rolling back: it
changes what everyone who has the link sees.

## Reading results in a script

Add `--json` to any command for a single object on stdout: `{ "ok": true, ... }` on success,
`{ "ok": false, "error", "detail", "hint", "retryable" }` with exit code 1 on failure. Prefer this
when chaining, and the human-readable form when the output goes to the user.

## When it fails

The script prints a `hint:` line for every API error. Honour it — most are not retryable:

| Failure | What it means |
|---|---|
| `401` | Token unknown, revoked or expired. Ask for a new one. **Retrying will not help.** |
| `403 insufficient_scope` | Token lacks `publish`. It needs a new token, not a retry. |
| `404` | The slug doesn't exist or isn't yours. Run `list`. |
| `409 slug_taken` | Someone else owns that slug. Pick another — you cannot take it over. |
| `413` | Over the 50 MiB cap. Drop large assets. |
| `400` | New artifacts need `--title`; slugs are lowercase, digits and hyphens. |

Do not loop on a failing publish. Report the hint and let the user decide.

## What this skill does not do

Sharing, user management and token minting are deliberately outside it. A publish token cannot
mint another token or change who may sign in, and it should not try — point the user at
`https://rtfx.pro/admin` instead. Per-artifact sharing (`grant`, `visibility`) needs a `manage`
scope; if the user asks for it, say so rather than failing halfway.

Full HTTP contract, scopes and error semantics: `references/api.md`.
