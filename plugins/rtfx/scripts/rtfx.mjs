#!/usr/bin/env node
// rtfx — publish an artifact to rtfx.pro (or your own artifacts-server instance)
// from a Claude Code session, a terminal, or CI.
//
// Standalone by design: no npm install, no dependencies, Node 18+. The plugin is
// copied to machines that have never checked out artifacts-server, so everything
// it needs lives in this directory (see rtfx.lib.mjs for the pure parts).
//
// Configuration — two variables, both plain text, neither a Cloudflare account
// credential:
//   RTFX_API_TOKEN   a scoped token from the dashboard → Integrations (required)
//   ARTIFACTS_URL    your instance, default https://rtfx.pro (RTFX_URL also accepted)
//
// Optional, only for an instance that still gates /api behind Cloudflare Access:
//   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET   Access service token headers
//
// Usage:
//   rtfx.mjs publish <path> [--slug s] [--title t] [--description d] [--note n] [--json] [--dry-run]
//   rtfx.mjs list [--json]
//   rtfx.mjs versions <slug> [--json]
//   rtfx.mjs rollback <slug> <version> [--json]
//   rtfx.mjs doctor [--json]

import { readFileSync, statSync, lstatSync, readdirSync } from "node:fs";
import { File } from "node:buffer";
import { join, relative, basename, extname, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  DEFAULT_ENDPOINT,
  MAX_UPLOAD_BYTES,
  TOKEN_VAR,
  INCLUDE,
  SKIP_SECRET,
  SKIP_DIR,
  SKIP_FILE,
  classifyEntry,
  isSensitivePath,
  resolveConfig,
  authHeaders,
  apiUrl,
  parseArgs,
  createZip,
  describeApiError,
  publishSummary,
  redactToken,
} from "./rtfx.lib.mjs";

const USAGE = `rtfx — publish to rtfx.pro

  publish <path> [--slug s] [--title t] [--description d] [--note n]
        <path> is an .html file, a .zip, or a directory containing index.html.
        A new slug creates the artifact at v1; an existing slug you own adds a
        new version and makes it live. Prints the artifact URL.
  list                              artifacts this token can reach
  versions <slug>                   version history, newest first
  rollback <slug> <version>         make an earlier version live again
  doctor                            check configuration and reach the API

  --json      machine-readable output (one object on stdout)
  --dry-run   publish only: report what would be uploaded, send nothing

env: ${TOKEN_VAR} (required) · ARTIFACTS_URL (default ${DEFAULT_ENDPOINT})`;

let asJson = false;

/** Everything exits through here, so --json always yields exactly one object. */
function fail(message, extra = {}) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  else {
    console.error(`error: ${message}`);
    if (extra.hint) console.error(`hint:  ${extra.hint}`);
    if (extra.detail) console.error(`detail: ${extra.detail}`);
  }
  process.exit(1);
}

function succeed(payload, lines) {
  if (asJson) console.log(JSON.stringify({ ok: true, ...payload }, null, 2));
  else for (const line of lines) console.log(line);
}

function config() {
  let resolved;
  try {
    resolved = resolveConfig(process.env);
  } catch (e) {
    fail(e.message);
  }
  if (!resolved.hasToken) {
    fail(`${TOKEN_VAR} is not set`, {
      hint: `Mint a token at ${resolved.endpoint}/admin/integrations (scopes: read, publish) and export it as ${TOKEN_VAR}.`,
    });
  }
  return resolved;
}

async function call(cfg, path, init = {}) {
  const url = apiUrl(cfg.endpoint, path);
  let res;
  try {
    res = await fetch(url, { ...init, headers: { ...authHeaders(cfg), ...(init.headers ?? {}) } });
  } catch (e) {
    fail(`could not reach ${cfg.endpoint}: ${e.message}`, {
      hint: "Check ARTIFACTS_URL and that the host is reachable from here.",
    });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const described = describeApiError(res.status, body);
    fail(`${res.status} ${described.error || res.statusText}`, described);
  }
  return body;
}

// --- Collecting what to publish ---------------------------------------------

/**
 * Walk a directory into `{ "relative/path": bytes }`, reporting what was left
 * out. Skips are surfaced rather than silent: a bundle missing its `.env` is
 * correct, a bundle missing a stylesheet because of an over-eager filter is not,
 * and the only way to tell them apart is to print both.
 */
function collect(dir, root = dir, out = { files: {}, skipped: [] }) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = lstatSync(full);
    const rel = relative(root, full).split(sep).join("/");
    if (st.isSymbolicLink()) {
      out.skipped.push({ path: rel, reason: "skip-symlink" });
      continue;
    }
    const verdict = classifyEntry(name, st.isDirectory());
    if (verdict !== INCLUDE) {
      out.skipped.push({ path: rel, reason: verdict });
      continue;
    }
    if (st.isDirectory()) collect(full, root, out);
    else out.files[relative(root, full).split(sep).join("/")] = new Uint8Array(readFileSync(full));
  }
  return out;
}

const SKIP_LABEL = {
  [SKIP_DIR]: "build/vcs directory",
  [SKIP_FILE]: "editor or OS file",
  [SKIP_SECRET]: "looks like a credential",
  "skip-symlink": "symbolic link outside the bundle boundary",
};

function zipEntryNames(bytes) {
  const names = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  for (let i = 0; i <= bytes.length - 46; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const nameLen = view.getUint16(i + 28, true);
    const extraLen = view.getUint16(i + 30, true);
    const commentLen = view.getUint16(i + 32, true);
    const nameStart = i + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > bytes.length) fail("zip central directory is malformed");
    names.push(dec.decode(bytes.subarray(nameStart, nameEnd)));
    i = nameEnd + extraLen + commentLen - 1;
  }
  if (!names.length) fail("zip archive has no readable central directory");
  return names.filter((name) => !name.endsWith("/"));
}

/** Turn a path into the bytes and form field the API expects. */
function bundleFor(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    fail(`no such file or directory: ${path}`);
  }

  if (st.isDirectory()) {
    const { files, skipped } = collect(path);
    if (!Object.keys(files).length) fail(`${path} contains no publishable files`);
    if (!files["index.html"]) {
      fail(`${path} has no index.html at its root`, {
        hint: "A multi-file artifact is served from index.html. Point at the built output directory, not the project root.",
      });
    }
    const zip = createZip(files, { deflate: (bytes) => new Uint8Array(deflateRawSync(bytes)) });
    return { field: "bundle", filename: "bundle.zip", type: "application/zip", bytes: zip, entries: Object.keys(files).sort(), skipped };
  }

  const bytes = new Uint8Array(readFileSync(path));
  const ext = extname(path).toLowerCase();
  if (ext === ".zip") {
    const entries = zipEntryNames(bytes);
    const sensitive = entries.filter(isSensitivePath);
    if (sensitive.length) {
      fail(`zip contains a hidden, generated or credential-looking path: ${sensitive[0]}`, {
        hint: "Unzip it, remove secrets/build directories, and publish the cleaned folder so rtfx can report every skipped file.",
      });
    }
    if (!entries.includes("index.html") && !entries.some((name) => /(^|\/)index\.html$/i.test(name))) {
      fail(`${path} has no index.html`, {
        hint: "A multi-file artifact is served from index.html. Publish a zip or directory with index.html at its root, or under one common top-level folder.",
      });
    }
    return { field: "bundle", filename: basename(path), type: "application/zip", bytes, entries: entries.sort(), skipped: [] };
  }
  if (ext === ".html" || ext === ".htm") {
    return { field: "file", filename: basename(path), type: "text/html", bytes, entries: [basename(path)], skipped: [] };
  }
  fail(`unsupported file type "${ext || basename(path)}"`, {
    hint: "Publish a .html file, a .zip, or a directory containing index.html.",
  });
}

// --- Commands ----------------------------------------------------------------

async function publish(path, flags) {
  if (!path) fail("publish needs a <path>");
  const prepared = bundleFor(path);

  if (prepared.bytes.length > MAX_UPLOAD_BYTES) {
    fail(`upload is ${(prepared.bytes.length / 1024 / 1024).toFixed(1)} MiB, over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB cap`, {
      hint: "Remove large assets, or host them elsewhere and reference them.",
    });
  }

  if (flags["dry-run"]) {
    succeed(
      {
        command: "publish",
        dry_run: true,
        path,
        slug: flags.slug ?? null,
        upload_bytes: prepared.bytes.length,
        files: prepared.entries,
        skipped: prepared.skipped,
      },
      [
        `would publish ${path} (${prepared.bytes.length} bytes as ${prepared.field})`,
        ...(prepared.entries ?? []).map((f) => `  + ${f}`),
        ...prepared.skipped.map((s) => `  - ${s.path}  (${SKIP_LABEL[s.reason] ?? s.reason})`),
      ]
    );
    return;
  }

  const cfg = config();
  const form = new FormData();
  // Only send a title when we have one to send: omitting it on a republish is
  // what keeps an existing artifact's title intact. A brand-new artifact with
  // neither --title nor --slug falls back to the file/folder name.
  if (flags.title) form.set("title", flags.title);
  else if (!flags.slug) form.set("title", basename(path).replace(/\.(html?|zip)$/i, ""));
  if (flags.slug) form.set("slug", flags.slug);
  if (flags.description) form.set("description", flags.description);
  if (flags.note) form.set("note", flags.note);
  form.set(prepared.field, new File([prepared.bytes], prepared.filename, { type: prepared.type }));

  const data = await call(cfg, "/api/artifacts", { method: "POST", body: form });
  succeed({ command: "publish", ...data, skipped: prepared.skipped }, [
    ...prepared.skipped.map((s) => `skipped ${s.path}  (${SKIP_LABEL[s.reason] ?? s.reason})`),
    publishSummary(data),
  ]);
}

async function list() {
  const cfg = config();
  const data = await call(cfg, "/api/artifacts");
  const artifacts = data.artifacts ?? [];
  succeed({ command: "list", ...data }, [
    artifacts.length ? "" : "(no artifacts)",
    ...artifacts.map((a) => {
      const visibility = a.visibility === "everyone" ? "everyone" : "restricted";
      return `${String(a.slug).padEnd(24)} v${a.current_version}  ${String(a.type).padEnd(7)} ${visibility.padEnd(11)} ${a.title}`;
    }),
  ].filter((line) => line !== ""));
}

async function versions(slug) {
  if (!slug) fail("versions needs a <slug>");
  const cfg = config();
  const data = await call(cfg, `/api/artifacts/${encodeURIComponent(slug)}/versions`);
  succeed({ command: "versions", slug, ...data }, [
    ...(data.url ? [data.url] : []),
    ...(data.versions ?? []).map((v) => {
      const live = v.version === data.current ? " (live)" : "";
      return `  v${v.version}${live}  ${String(v.created_at).slice(0, 10)}  ${v.file_count} file(s)${v.note ? `  ${v.note}` : ""}`;
    }),
  ]);
}

async function rollback(slug, version) {
  if (!slug || !version) fail("rollback needs <slug> <version>");
  if (!/^\d+$/.test(String(version))) fail(`version must be a positive integer, got "${version}"`);
  const cfg = config();
  const data = await call(cfg, `/api/artifacts/${encodeURIComponent(slug)}/current`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: Number(version) }),
  });
  succeed({ command: "rollback", ...data }, [
    `${data.slug} is live on v${data.current}`,
    ...(data.url ? [data.url] : []),
  ]);
}

/**
 * Config check. Deliberately reports the token *id* and never the token — an
 * agent transcript is a place secrets go to leak, and the id is all anyone needs
 * to find or revoke it.
 */
async function doctor() {
  let resolved;
  try {
    resolved = resolveConfig(process.env);
  } catch (e) {
    fail(e.message);
  }
  const facts = {
    command: "doctor",
    endpoint: resolved.endpoint,
    token: resolved.hasToken ? redactToken(resolved.token) : null,
    token_set: resolved.hasToken,
    access_headers: Boolean(resolved.access),
    node: process.version,
  };
  if (!resolved.hasToken) {
    fail(`${TOKEN_VAR} is not set`, {
      ...facts,
      hint: `Mint a token at ${resolved.endpoint}/admin/integrations (scopes: read, publish) and export it as ${TOKEN_VAR}.`,
    });
  }
  const data = await call(resolved, "/api/artifacts");
  const reachable = { ...facts, reachable: true, artifact_count: (data.artifacts ?? []).length };
  succeed(reachable, [
    `endpoint  ${reachable.endpoint}`,
    `token     ${reachable.token}`,
    `access    ${reachable.access_headers ? "service-token headers set" : "not set (fine unless /api is Access-gated)"}`,
    `api       ok — ${reachable.artifact_count} artifact(s) visible to this token`,
  ]);
}

// --- Entry point -------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const { flags, positional, errors } = parseArgs(rest);
asJson = Boolean(flags.json);

if (errors.length) fail(errors.join("; "));

switch (command) {
  case "publish":
    await publish(positional[0], flags);
    break;
  case "list":
    await list();
    break;
  case "versions":
    await versions(positional[0]);
    break;
  case "rollback":
    await rollback(positional[0], positional[1]);
    break;
  case "doctor":
    await doctor();
    break;
  case undefined:
  case "help":
  case "--help":
    console.log(USAGE);
    break;
  default:
    console.error(USAGE);
    process.exit(1);
}
