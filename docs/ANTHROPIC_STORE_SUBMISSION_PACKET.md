# Anthropic Store / Directory Submission Packet — rtfx.pro

Status: submitted and pending review
Product: rtfx.pro
Package version: 1.2.0
Repository: https://github.com/yogevgab/artifacts-server
Primary website: https://rtfx.pro
Remote MCP endpoint: https://mcp.rtfx.pro/mcp
Claude Desktop bundle asset: https://github.com/yogevgab/artifacts-server/releases/download/v1.2.0/rtfx.dxt

> Do not claim “Anthropic approved”, “Anthropic verified”, “official”, or “in the store” until Anthropic confirms acceptance.

## Submission target

There are two Anthropic distribution lanes worth pursuing.

### 1. Claude Code plugin community marketplace

Submit here when available / logged in:

```text
https://platform.claude.com/plugins/submit
```

Current state seen from browser: page is gated by Claude Platform login. A human login is required before Hermes can complete the form.

### 2. Claude Desktop / MCP Bundle review or directory

Use this packet plus the downloadable `rtfx.dxt` / MCPB package if Anthropic asks for Desktop Extension / MCP connector materials. The extension source is:

```text
dxt/rtfx/manifest.json
```

The bundle build output is:

```text
dist/rtfx.dxt
```

## Short catalog copy

```text
Publish Claude-built HTML, PDFs, and multi-file artifacts to rtfx.pro as private, versioned, access-controlled URLs.
```

## Longer description

```text
rtfx.pro turns agent output into deliverable artifacts. From Claude Code or Claude Desktop, Claude can publish a local file, folder, HTML page, PDF, or generated bundle and receive a stable URL with immutable versions, access control, rollback, and safe sharing. The local plugin and Desktop Extension run beside the user's files for path/folder publishing; the hosted Remote MCP endpoint supports OAuth and content-based publishing plus artifact management tools for clients that cannot access the local filesystem. rtfx keeps published content on a separate content origin from the management app and refuses credential-shaped files, unsafe paths, dotfiles, and common dependency/build directories.
```

## Recommended category

```text
Deployment / Developer Tools / Productivity
```

If the form only allows one category, choose:

```text
Deployment
```

## Keywords

```text
claude, mcp, publishing, artifacts, hosting, preview, deployment, html, pdf, versioning, access control, collaboration
```

## Plugin submission fields

| Field | Value |
|---|---|
| Name | `rtfx` |
| Display name | `rtfx.pro` |
| Version | `1.2.0` |
| Repository | `https://github.com/yogevgab/artifacts-server` |
| Branch | `main` |
| Commit SHA | `4878adfbabc081dfb9436755bb15a19cb8abd572` for the refreshed 2026-08-27 plugin submission |
| Plugin path | `./plugins/rtfx` |
| Plugin manifest | `plugins/rtfx/.claude-plugin/plugin.json` |
| Marketplace manifest | `.claude-plugin/marketplace.json` |
| License | MIT |
| Homepage | `https://rtfx.pro/docs` |
| Docs | `https://rtfx.pro/docs` |
| Support | `https://rtfx.pro/contact` |
| Security contact | `SECURITY.md` / GitHub Security Advisories |

## Desktop Extension / MCPB fields

| Field | Value |
|---|---|
| Name | `rtfx` |
| Display name | `rtfx.pro` |
| Version | `1.2.0` |
| Manifest | `dxt/rtfx/manifest.json` |
| Built bundle | `dist/rtfx.dxt` |
| Download URL | `https://github.com/yogevgab/artifacts-server/releases/download/v1.2.0/rtfx.dxt` |
| Validation command | `npm run dxt:validate` |
| Runtime | Node >= 18 |
| Platforms | macOS, Windows, Linux |

## What the local Claude Code plugin provides

- Slash commands:
  - `/rtfx:login`
  - `/rtfx:logout`
  - `/rtfx:setup`
  - `/rtfx:publish`
  - `/rtfx:list`
  - `/rtfx:versions`
  - `/rtfx:rollback`
- Local stdio MCP server:
  - `publish`
  - `list_artifacts`
  - `get_versions`
  - `rollback`
  - `doctor`
  - optional `update_access`, off by default and requiring `manage` scope.
- Dependency-free Node scripts.
- Browser OAuth credential storage by default.
- Optional `RTFX_API_TOKEN` for CI/advanced usage.

## What the Claude Desktop extension provides

The Desktop Extension installs the local rtfx MCP server inside Claude Desktop so Claude can publish local paths/folders from the user's machine.

Tools:

```text
publish
list_artifacts
get_versions
rollback
doctor
```

Optional/off-by-default:

```text
update_access
```

## What the hosted Remote MCP provides

Endpoint:

```text
https://mcp.rtfx.pro/mcp
```

Auth:

- OAuth authorization-code + PKCE.
- Anthropic-recommended Client ID Metadata Document support.
- Dynamic client registration fallback.
- Scoped bearer tokens.

Tools:

```text
doctor
publish
list_artifacts
artifact_details
artifact_statistics
share_artifact
rollback_artifact
delete_artifact
```

Scope model:

- `read`: list/details/statistics.
- `publish`: content-based publishing.
- `manage`: sharing, rollback, deletion.

Important boundary:

- Hosted Remote MCP publishes content supplied in the tool call: `content_text`, `content_base64`, or explicit `files[]`.
- It does **not** read client-local paths or folders.
- Local plugin/Desktop Extension remains the correct path/folder publishing mechanism.

## Safety / privacy answers

### Does rtfx require cloud-provider credentials?

No. rtfx never asks for Cloudflare account credentials, AWS credentials, or deploy-provider credentials. It uses rtfx-scoped OAuth or API tokens only.

### What data leaves the user's machine?

Only files/content explicitly selected for publishing, plus metadata such as slug, title, description/note, and access settings. No background repository scanning or telemetry is performed by the plugin.

### How are credentials handled?

Default authentication is browser OAuth. Credentials are stored locally with owner-only permissions and refreshed/rotated automatically. Advanced users can set `RTFX_API_TOKEN`; the plugin never writes that env token to disk.

### Are tokens printed?

No. `doctor` and related commands report token IDs and scopes only. Full tokens and refresh tokens are redacted and covered by tests.

### Can it upload secrets accidentally?

The local publisher refuses or skips `.env`, `.dev.vars`, private keys, `.git`, `node_modules`, unsafe paths, dotfiles, and credential-looking files. Prebuilt zips containing sensitive paths are refused rather than silently filtered.

### Are operations destructive?

Publishing appends immutable versions. Rollback repoints the current version but does not delete old content. Destructive deletion exists only in the hosted Remote MCP management surface, requires `manage` scope, and requires `confirm_slug` to exactly match the artifact slug.

### Are artifacts public by default?

No. Published artifacts are access-controlled/restricted by default. The product supports explicit sharing/grants.

### Why separate local and remote MCP?

A hosted server cannot read the user's `./dist` folder. Local MCP runs beside the user's files and can publish paths. Remote MCP is best for OAuth connection, content generated inside the model/tool call, and artifact management.

## Validation evidence to collect before final submit

Run:

```bash
npm run dxt:validate
npm run validate:plugin
claude plugin validate . --strict
claude plugin validate ./plugins/rtfx --strict
npm run check
npm run validate:deploy
git diff --check
```

Expected evidence:

- MCPB manifest schema validation passes.
- `dist/rtfx.dxt` builds.
- Claude plugin marketplace manifest validates.
- Claude plugin manifest validates.
- Full test suite passes.
- Deploy config validates.
- Git diff has no whitespace errors.

## Demo / asset shot list

Capture only after ensuring no token is visible.

1. Claude Code plugin install from custom marketplace:
   ```text
   /plugin marketplace add yogevgab/artifacts-server
   /plugin install rtfx@rtfx
   ```
2. `/rtfx:login` browser OAuth.
3. `/rtfx:setup` showing connected status with token id only.
4. `/rtfx:publish ./demo --slug anthropic-review-demo` returning a stable rtfx URL.
5. Artifact page open on `a.rtfx.pro`.
6. `/rtfx:versions anthropic-review-demo` showing immutable versions.
7. `/rtfx:rollback anthropic-review-demo 1` if a v2 exists.
8. Claude Desktop installing/opening `rtfx.dxt`.
9. Claude Desktop MCP `doctor`.
10. Hosted Remote MCP OAuth connector setup using Anthropic hosted client metadata.

## Submission note / cover letter

```text
Hi Anthropic team,

I'm submitting rtfx.pro for review/listing because it fills a very common Claude workflow gap: Claude can build useful HTML, PDFs, reports, demos and small apps, but users still need a safe way to turn that output into a shareable, access-controlled artifact.

rtfx provides a Claude Code plugin, a Claude Desktop MCP Bundle, and a hosted Remote MCP endpoint. The local plugin/extension handles local path and folder publishing because it runs beside the user's files. The hosted Remote MCP endpoint supports OAuth, Anthropic-recommended client metadata, content-based publishing, and scoped artifact management.

The safety boundary is deliberate: no cloud-provider credentials, no background repository scanning, no local path claims from the hosted endpoint, token redaction, credential-file filtering, immutable versions, restricted-by-default artifacts, and scoped management operations.

Repository: https://github.com/yogevgab/artifacts-server
Docs: https://rtfx.pro/docs
Desktop bundle: https://github.com/yogevgab/artifacts-server/releases/download/v1.2.0/rtfx.dxt
Remote MCP endpoint: https://mcp.rtfx.pro/mcp
```

## Post-submission tracking

After submitting, update `docs/ANTHROPIC_PLUGIN_SUBMISSION.md` and this file with:

| Date | Version | Commit SHA | Form | Outcome |
|---|---|---|---|---|
| YYYY-MM-DD | 1.2.0 | `<sha>` | `<url/name>` | submitted |


## Submission status log

| Date | Surface | Commit/source | Outcome |
|---|---|---|---|
| 2026-08-26 | Claude Platform plugin submit form | unknown from local evidence | `rtfx` submission visible as submitted and pending review |
| 2026-08-27 | Claude Platform plugin submit form | `4878adfbabc081dfb9436755bb15a19cb8abd572` | duplicate/refreshed `rtfx` submission received and pending review |
