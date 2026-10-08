#!/usr/bin/env node
// rtfx — publish an artifact to rtfx.pro (or your own artifacts-server instance)
// from a Claude Code session, a terminal, or CI.
//
// Standalone by design: no npm install, no dependencies, Node 18+. The plugin is
// copied to machines that have never checked out artifacts-server, so everything
// it needs lives in this directory (see rtfx.lib.mjs for the pure parts, and
// rtfx.bundle.mjs for what may and may not be uploaded).
//
// The same operations are available to an MCP client through rtfx-mcp.mjs, which
// wraps the same two libraries — there is one auth path and one bundle safety
// model, not two.
//
// Credentials — two ways, and `login` is the one to reach for first:
//
//   rtfx.mjs login    a browser sign-in (OAuth 2.1 + PKCE). The credential is
//                     stored under ~/.config/rtfx/credentials.json with mode
//                     0600 and renews itself until `logout`.
//   RTFX_API_TOKEN    a scoped token from the dashboard → Integrations. Always
//                     wins over a stored sign-in, so CI and scripts are
//                     unaffected by whatever a developer logged into.
//
//   ARTIFACTS_URL     your instance, default https://rtfx.pro (RTFX_URL also accepted)
//
// Optional, and only for a self-hosted instance that gates every path at the
// edge (rtfx.pro does not — the machine API this talks to is reachable with the
// bearer token alone):
//   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET   Access service token headers
//
// Usage:
//   rtfx.mjs login [--manual] [--json]
//   rtfx.mjs logout [--json]
//   rtfx.mjs publish <path> [--slug s] [--title t] [--description d] [--note n] [--json] [--dry-run]
//   rtfx.mjs list [--json]
//   rtfx.mjs versions <slug> [--json]
//   rtfx.mjs rollback <slug> <version> [--json]
//   rtfx.mjs doctor [--json]

import { readFileSync, statSync, lstatSync, readdirSync } from "node:fs";
import { File } from "node:buffer";
import { createInterface } from "node:readline";
import { join, basename } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  DEFAULT_ENDPOINT,
  TOKEN_VAR,
  SOURCE_ENV,
  SOURCE_OAUTH,
  resolveConfig,
  resolveEndpoint,
  authHeaders,
  apiUrl,
  machineApiPath,
  shouldRetryOnLegacyApi,
  describeNonJsonResponse,
  parseArgs,
  describeApiError,
  publishSummary,
  redactToken,
} from "./rtfx.lib.mjs";
import { BundleError, describeSkips, prepareBundle } from "./rtfx.bundle.mjs";
import { describeCredential, needsRefresh } from "./rtfx.oauth.lib.mjs";
import {
  OAuthError,
  credentialsPath,
  ensureAccessToken,
  login as oauthLogin,
  logout as oauthLogout,
  readCredential,
} from "./rtfx.oauth.mjs";

const USAGE = `rtfx — publish to rtfx.pro

  login                             sign in with a browser; stores a renewing credential
  logout                            revoke and forget that credential
  publish <path> [--slug s] [--title t] [--description d] [--note n]
        <path> is an .html file, a .pdf, a .zip, or a directory containing index.html.
        A new slug creates the artifact at v1; an existing slug you own adds a
        new version and makes it live. Prints the artifact URL.
  list                              artifacts this credential can reach
  versions <slug>                   version history, newest first
  rollback <slug> <version>         make an earlier version live again
  doctor                            check configuration and reach the API

  --json      machine-readable output (one object on stdout)
  --dry-run   publish only: report what would be uploaded, send nothing
  --manual    login only: no browser or listener; paste the callback URL back

credentials: \`login\` (recommended) or ${TOKEN_VAR}, which wins when both are set
env: ARTIFACTS_URL (default ${DEFAULT_ENDPOINT})`;

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

/**
 * The credential every API call runs on.
 *
 * `RTFX_API_TOKEN` short-circuits everything, including the disk read: a CI job
 * that sets it must never depend on what is in a developer's home directory.
 * Otherwise the stored sign-in is used, renewed first if it is at or near expiry
 * — and the renewal is persisted before the token is used, because the server
 * rotates refresh tokens and spends the old one whether or not this process
 * survives.
 */
async function config() {
  const fromEnv = resolveConfig(process.env);
  if (fromEnv.hasToken) return fromEnv;

  let endpoint;
  try {
    endpoint = resolveEndpoint(process.env);
  } catch (e) {
    fail(e.message);
  }

  let credential;
  try {
    credential = await ensureAccessToken(endpoint);
  } catch (e) {
    if (e instanceof OAuthError) {
      fail(`the stored sign-in for ${endpoint} could not be renewed`, {
        detail: e.detail ?? e.message,
        hint: e.needsLogin ? "Run `rtfx.mjs login` to sign in again." : (e.hint ?? undefined),
      });
    }
    fail(`could not read the stored sign-in: ${e.message}`);
  }
  if (!credential) {
    fail(`not signed in to ${endpoint}`, {
      hint: `Run \`rtfx.mjs login\` (or /rtfx:login in Claude Code). For CI, export ${TOKEN_VAR} instead.`,
    });
  }
  return resolveConfig(process.env, { credential });
}

/** One HTTP attempt. Never throws: a transport failure exits with a hint. */
async function attempt(cfg, path, init) {
  const url = apiUrl(cfg.endpoint, path);
  let res;
  try {
    res = await fetch(url, { ...init, headers: { ...authHeaders(cfg), ...(init.headers ?? {}) } });
  } catch (e) {
    fail(`could not reach ${cfg.endpoint}: ${e.message}`, {
      hint: "Check ARTIFACTS_URL and that the host is reachable from here.",
    });
  }
  try {
    return { res, url, body: await res.json(), json: true };
  } catch {
    return { res, url, body: {}, json: false };
  }
}

/**
 * One API call, on the machine surface.
 *
 * Every call here is a machine call, so it goes to `/api/machine/...`, which
 * authenticates the bearer token and nothing else — no Cloudflare Access
 * credential required. An instance that predates that surface answers with the
 * framework's bare 404, which `shouldRetryOnLegacyApi` recognises (and only
 * that), so the call is repeated once against `/api`. That keeps a plugin newer
 * than the instance it publishes to working, and lets the two be upgraded in
 * either order.
 */
async function call(cfg, path, init = {}) {
  const machine = machineApiPath(path);
  let out = await attempt(cfg, machine, init);
  if (machine !== path && shouldRetryOnLegacyApi(out.res.status, out.body)) {
    out = await attempt(cfg, path, init);
  }
  // A non-JSON answer means something other than the app replied — most often
  // Cloudflare Access, with a sign-in page a `fetch` happily follows and reports
  // as a 200. Saying so beats reporting "published undefined".
  if (!out.json) {
    const { message, hint } = describeNonJsonResponse(out.url, out.res.url);
    fail(message, { hint, status: out.res.status });
  }
  if (!out.res.ok) {
    const described = describeApiError(out.res.status, out.body);
    fail(`${out.res.status} ${described.error || out.res.statusText}`, described);
  }
  return out.body;
}

// --- Collecting what to publish ---------------------------------------------
//
// The walk, the credential filter and the zip inspection live in
// `rtfx.bundle.mjs`, which takes its filesystem as an argument. This is the real
// filesystem; the MCP server passes the same one, and the test suite passes a
// virtual one — so all three exercise identical safety rules.

const IO = {
  stat: (path) => statSync(path),
  lstat: (path) => lstatSync(path),
  readDir: (path) => readdirSync(path),
  readFile: (path) => new Uint8Array(readFileSync(path)),
  join,
  deflate: (bytes) => new Uint8Array(deflateRawSync(bytes)),
};

/** Turn a path into the bytes and form field the API expects. */
function bundleFor(path) {
  try {
    return prepareBundle(path, IO);
  } catch (e) {
    if (e instanceof BundleError) fail(e.message, e.hint ? { hint: e.hint } : {});
    fail(`could not read ${path}: ${e.message}`);
  }
}

// --- Commands ----------------------------------------------------------------

async function publish(path, flags) {
  if (!path) fail("publish needs a <path>");
  const prepared = bundleFor(path);

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
        ...describeSkips(prepared.skipped).map((line) => `  - ${line}`),
      ]
    );
    return;
  }

  const cfg = await config();
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
    ...describeSkips(prepared.skipped).map((line) => `skipped ${line}`),
    publishSummary(data),
  ]);
}

async function list() {
  const cfg = await config();
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
  const cfg = await config();
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
  const cfg = await config();
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

// --- Signing in and out -------------------------------------------------------

/** Read one line from the terminal. Only used by `login --manual`. */
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

/**
 * Browser sign-in.
 *
 * Prints the credential's *id* and expiry on success and nothing else about it.
 * The access token goes straight from the token endpoint into a 0600 file; it is
 * never written to stdout, stderr, an argument list or an environment variable,
 * because each of those is somewhere an agent transcript or a process listing
 * would pick it up.
 */
async function login(flags) {
  let endpoint;
  try {
    endpoint = resolveEndpoint(process.env);
  } catch (e) {
    fail(e.message);
  }

  if (resolveConfig(process.env).source === SOURCE_ENV && !asJson) {
    // Not a refusal: the login still happens and is still stored. But without
    // this, a person would sign in, see success, and watch every later command
    // keep using the env token — with nothing on screen explaining why.
    console.error(
      `note: ${TOKEN_VAR} is set, and it takes priority over a browser sign-in.\n` +
        `      Unset it if you want this login to be what publishes.\n`
    );
  }

  let result;
  try {
    result = await oauthLogin(endpoint, {
      notify: (line) => {
        if (!asJson) console.error(line);
      },
      manual: flags.manual ? () => prompt("Paste the full URL you were redirected to: ") : null,
    });
  } catch (e) {
    if (e instanceof OAuthError) {
      fail(e.message, { detail: e.detail ?? undefined, hint: e.hint ?? undefined });
    }
    fail(`sign-in failed: ${e.message}`);
  }

  const described = describeCredential(result.credential);
  succeed({ command: "login", endpoint, ...described, stored_at: result.path }, [
    `signed in to ${endpoint}`,
    `token     ${described.token}`,
    `scopes    ${described.scopes.join(", ")}`,
    `renews    automatically; expires ${described.expires_at}`,
    `stored    ${result.path} (mode 0600)`,
  ]);
}

/** Revoke the stored credential and delete it. */
async function logout() {
  let endpoint;
  try {
    endpoint = resolveEndpoint(process.env);
  } catch (e) {
    fail(e.message);
  }

  let result;
  try {
    result = await oauthLogout(endpoint);
  } catch (e) {
    fail(`logout failed: ${e.message}`);
  }

  if (!result.hadCredential) {
    succeed({ command: "logout", endpoint, signed_in: false, revoked: false }, [
      `not signed in to ${endpoint} — nothing to do`,
    ]);
    return;
  }
  succeed({ command: "logout", endpoint, signed_in: false, revoked: result.revoked }, [
    `signed out of ${endpoint}`,
    result.revoked
      ? "the credential was revoked on the server and deleted from this machine"
      : "the credential was deleted from this machine; the server could not be reached to revoke it",
  ]);
}

/**
 * Config check. Deliberately reports the token *id* and never the token — an
 * agent transcript is a place secrets go to leak, and the id is all anyone needs
 * to find or revoke it.
 *
 * The credential's *source* is the first thing it prints, because "which of the
 * two credentials is actually in play" is the question that makes every other
 * line here interpretable — and the answer surprises people whenever both exist.
 */
async function doctor() {
  let endpoint;
  try {
    endpoint = resolveEndpoint(process.env);
  } catch (e) {
    fail(e.message);
  }

  const fromEnv = resolveConfig(process.env);
  const stored = fromEnv.hasToken ? readCredential(endpoint) : null;
  const shadowed = Boolean(fromEnv.hasToken && stored);

  let resolved = fromEnv;
  let refreshFailure = null;
  if (!fromEnv.hasToken) {
    try {
      const credential = await ensureAccessToken(endpoint);
      resolved = resolveConfig(process.env, { credential });
    } catch (e) {
      refreshFailure = e instanceof OAuthError ? e : new OAuthError(e.message);
      resolved = resolveConfig(process.env, { credential: readCredential(endpoint) });
    }
  }

  const credential = resolved.credential ?? stored;
  const facts = {
    command: "doctor",
    endpoint: resolved.endpoint,
    credential_source: resolved.source,
    token: resolved.hasToken ? redactToken(resolved.token) : null,
    token_set: resolved.hasToken,
    env_token_set: fromEnv.hasToken,
    oauth: credential ? { ...describeCredential(credential), shadowed_by_env: shadowed } : null,
    credentials_file: credentialsPath(),
    access_headers: Boolean(resolved.access),
    node: process.version,
  };

  if (refreshFailure) {
    fail(`the stored sign-in for ${endpoint} could not be renewed`, {
      ...facts,
      detail: refreshFailure.detail ?? refreshFailure.message,
      hint: refreshFailure.needsLogin ? "Run `rtfx.mjs login` to sign in again." : (refreshFailure.hint ?? undefined),
    });
  }
  if (!resolved.hasToken) {
    fail(`no credential for ${endpoint}`, {
      ...facts,
      hint: `Run \`rtfx.mjs login\` (or /rtfx:login in Claude Code). For CI, export ${TOKEN_VAR} instead.`,
    });
  }

  const data = await call(resolved, "/api/artifacts");
  const reachable = { ...facts, reachable: true, artifact_count: (data.artifacts ?? []).length };
  succeed(reachable, [
    `endpoint  ${reachable.endpoint}`,
    `auth      ${describeSource(reachable, credential)}`,
    `token     ${reachable.token}`,
    ...(shadowed ? [`note      a stored sign-in exists but ${TOKEN_VAR} takes priority`] : []),
    `access    ${reachable.access_headers ? "service-token headers set" : "not set (not needed — the machine API takes the bearer token)"}`,
    `api       ok — ${reachable.artifact_count} artifact(s) visible to this credential`,
  ]);
}

/** The one line that says which credential is in play, and how healthy it is. */
function describeSource(facts, credential) {
  if (facts.credential_source === SOURCE_ENV) return `${TOKEN_VAR} (environment)`;
  if (facts.credential_source === SOURCE_OAUTH) {
    const scopes = credential?.scopes?.length ? ` · ${credential.scopes.join(", ")}` : "";
    const soon = credential && needsRefresh(credential, Date.now()) ? " · renewing on next call" : "";
    return `browser sign-in${scopes}${soon} · ${facts.credentials_file}`;
  }
  return "none";
}

// --- Entry point -------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const { flags, positional, errors } = parseArgs(rest);
asJson = Boolean(flags.json);

if (errors.length) fail(errors.join("; "));

switch (command) {
  case "login":
    await login(flags);
    break;
  case "logout":
    await logout();
    break;
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
