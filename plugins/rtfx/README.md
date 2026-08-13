# rtfx — Claude Code plugin

Publish what a session just built to [rtfx.pro](https://rtfx.pro): a stable URL, an immutable
version history, and real access control instead of an unlisted link.

```
you: publish this dashboard and share the link
→   https://a.rtfx.pro/sales-dashboard/   (v1, bundle, 14 files)
```

## Install

```
/plugin marketplace add yogevgab/artifacts-server
/plugin install rtfx@rtfx
```

Then mint a token at <https://rtfx.pro/admin/integrations> (scopes `read` and `publish`) and
export it in the shell you run Claude Code from:

```bash
export RTFX_API_TOKEN=rtfx_…
export ARTIFACTS_URL=https://rtfx.pro   # only if you self-host artifacts-server
```

Verify with `/rtfx:setup`.

## What you get

| | |
|---|---|
| **Skill** `publishing-to-rtfx` | Loads on its own when you say "publish this", "ship it", "share this page". Covers single files, folders, zips, versioning and rollback. |
| `/rtfx:publish [path] [slug]` | Publish or re-publish, then report the URL. |
| `/rtfx:list` | What this token can reach. |
| `/rtfx:versions <slug>` | Version history, newest first. |
| `/rtfx:rollback <slug> <n>` | Make an earlier version live again. |
| `/rtfx:setup` | Check credentials and connectivity. |

The plugin also works as a plain CLI, with or without Claude Code:

```bash
node scripts/rtfx.mjs publish ./dist --slug q3-report --title "Q3 Report"
node scripts/rtfx.mjs publish ./dist --slug q3-report --note "revised charts"  # → v2
node scripts/rtfx.mjs versions q3-report
node scripts/rtfx.mjs rollback q3-report 1
node scripts/rtfx.mjs list --json
```

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `RTFX_API_TOKEN` | yes | Scoped API token. Bound to its owner, revocable on its own. |
| `ARTIFACTS_URL` | no | Instance URL, default `https://rtfx.pro`. `RTFX_URL` is accepted too. |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | no | Cloudflare Access **service token**, only for an instance that still gates `/api` at the edge. Not a Cloudflare account credential; grants nothing inside the app. |

No Cloudflare management token is involved anywhere, and the plugin never writes a credential to
disk. `doctor` prints a token's **id** only.

## Design notes

- **Zero dependencies, no install step.** `scripts/rtfx.mjs` is plain Node 18+. It writes its own
  zip container (`scripts/rtfx.lib.mjs`) rather than pulling a compression library, because the
  plugin lands on machines that have never seen this repo.
- **Deterministic bundles.** Zip entries are sorted and carry a fixed timestamp, so publishing
  unchanged files produces identical bytes.
- **Refuses to upload credentials.** The directory walk drops `.env`, `.dev.vars`, `*.pem`,
  `*.key` and friends, along with `.git`/`node_modules`, and prints everything it skipped.
- **`--json` everywhere**, so an agent parses results instead of scraping prose. Failures come
  back as `{ "ok": false, "error", "detail", "hint", "retryable" }` with exit code 1.
- **The URL is never constructed client-side.** It comes from the API response, which knows the
  content host — a separate origin from the API, so uploaded HTML can't reach the app that
  manages it.

## Contract

Publishing to a new slug creates the artifact at v1, private to its owner. Publishing to a slug
you already own appends an immutable version and makes it live at the same URL. Publishing to
someone else's slug is refused (`409`), never merged into their artifact. Rollback repoints the
slug without deleting anything.

Full HTTP contract: `skills/publishing-to-rtfx/references/api.md`.
Operator-side reference: [docs/HERMES_CLOUD.md](../../docs/HERMES_CLOUD.md).
