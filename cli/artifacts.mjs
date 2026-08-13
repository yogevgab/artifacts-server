#!/usr/bin/env node
// Artifacts CLI — publish/list/delete/version artifacts on your instance.
//
// Auth: an API token, a Cloudflare Access service token, or both.
//   ARTIFACTS_URL            your instance URL (default http://localhost:8787 for dev)
//   RTFX_URL                 alias for ARTIFACTS_URL, so the Claude Code plugin and this
//                            CLI accept the same environment (ARTIFACTS_URL still wins)
//   RTFX_API_TOKEN           API token (rtfx_…) — sent as `Authorization: Bearer`
//   CF_ACCESS_CLIENT_ID      Access service token client id      (advanced/self-host)
//   CF_ACCESS_CLIENT_SECRET  Access service token client secret  (advanced/self-host)
//
// The artifact commands go to the machine API (/api/machine/…), which
// authenticates the bearer token and nothing else — RTFX_API_TOKEN on its own is
// enough, with no Cloudflare credential. The service-token headers stay
// supported for a self-hosted instance that gates every path at the edge; they
// get a request *through the gate* and grant nothing inside the app.
//
// The user-* and token-* commands are different: they manage credentials, so
// they stay on /api, refuse API tokens outright, and need a real login (or, from
// a shell, the service-token headers).
//
// Usage:
//   artifacts publish <path> [--slug s] [--title t] [--description d] [--overwrite]
//   artifacts list
//   artifacts delete <slug>
//
// <path> may be a .html file, a .zip bundle, or a directory (zipped automatically).

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, basename, extname, sep } from "node:path";
import { zipSync } from "fflate";
import {
  describeNonJsonResponse,
  machineApiPath,
  shouldRetryOnLegacyApi,
} from "../plugins/rtfx/scripts/rtfx.lib.mjs";

const BASE = (process.env.ARTIFACTS_URL || process.env.RTFX_URL || "http://localhost:8787").replace(/\/+$/, "");
const ID = process.env.CF_ACCESS_CLIENT_ID;
const SECRET = process.env.CF_ACCESS_CLIENT_SECRET;
const API_TOKEN = process.env.RTFX_API_TOKEN;

function authHeaders() {
  const h = {};
  if (ID && SECRET) {
    h["CF-Access-Client-Id"] = ID;
    h["CF-Access-Client-Secret"] = SECRET;
  }
  if (API_TOKEN) h["Authorization"] = `Bearer ${API_TOKEN}`;
  return h;
}

function die(msg) {
  console.error("error:", msg);
  process.exit(1);
}

/** One HTTP attempt. Exits with a readable message if the host can't be reached. */
async function attempt(path, init) {
  const url = `${BASE}${path}`;
  let res;
  try {
    res = await fetch(url, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
  } catch (e) {
    die(`could not reach ${BASE}: ${e.message}`);
  }
  try {
    return { res, url, body: await res.json(), json: true };
  } catch {
    return { res, url, body: {}, json: false };
  }
}

/**
 * Call the API and return the parsed body, or exit with a readable error.
 *
 * Artifact work goes to the machine surface (`/api/machine/…`), which takes the
 * bearer token and nothing else — so publishing needs no Cloudflare credential
 * even on an Access-gated instance. An instance too old to have that surface
 * answers with a bare 404 and the call is retried once against `/api`.
 *
 * `{ admin: true }` opts out for the routes that manage credentials: they stay
 * on `/api`, where Cloudflare Access can still gate them, and they refuse API
 * tokens in the Worker regardless.
 */
async function call(path, init = {}, { admin = false } = {}) {
  const target = admin ? path : machineApiPath(path);
  let out = await attempt(target, init);
  if (target !== path && shouldRetryOnLegacyApi(out.res.status, out.body)) {
    out = await attempt(path, init);
  }
  if (!out.json) {
    const { message, hint } = describeNonJsonResponse(out.url, out.res.url);
    die(`${message}\nhint: ${hint}`);
  }
  if (!out.res.ok) {
    die(`${out.res.status} ${out.body.detail || out.body.error || out.res.statusText}`);
  }
  return out.body;
}

/** JSON request init, for the handful of routes that send a body. */
const asJson = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "overwrite" || key === "admin") flags[key] = true;
      else flags[key] = args[++i];
    } else positional.push(a);
  }
  return { flags, positional };
}

function walk(dir, root = dir, out = {}) {
  for (const name of readdirSync(dir)) {
    if (name === ".DS_Store") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, out);
    else out[relative(root, full).split(sep).join("/")] = new Uint8Array(readFileSync(full));
  }
  return out;
}

async function publish(path, flags) {
  if (!path) die("publish requires a <path>");
  const st = statSync(path);
  const form = new FormData();

  // Only set title when explicitly given, so publishing a new version doesn't
  // rename the artifact. A brand-new artifact needs --title (or --slug).
  if (flags.title) form.set("title", flags.title);
  else if (!flags.slug) form.set("title", basename(path).replace(/\.(html?|zip)$/i, ""));
  if (flags.slug) form.set("slug", flags.slug);
  if (flags.description) form.set("description", flags.description);
  if (flags.note) form.set("note", flags.note);

  if (st.isDirectory()) {
    const files = walk(path);
    if (!files["index.html"]) die("directory must contain an index.html at its root");
    const zip = zipSync(files);
    form.set("bundle", new File([zip], "bundle.zip", { type: "application/zip" }));
  } else {
    const ext = extname(path).toLowerCase();
    const bytes = new Uint8Array(readFileSync(path));
    if (ext === ".zip") form.set("bundle", new File([bytes], basename(path), { type: "application/zip" }));
    else if (ext === ".html" || ext === ".htm")
      form.set("file", new File([bytes], basename(path), { type: "text/html" }));
    else die(`unsupported file type "${ext}" (use .html, .zip, or a directory)`);
  }

  const data = await call("/api/artifacts", { method: "POST", body: form });
  console.log(`published: ${data.url}  (v${data.version}, ${data.type}, ${data.file_count} file(s))`);
}

async function versions(slug) {
  if (!slug) die("versions requires a <slug>");
  const data = await call(`/api/artifacts/${encodeURIComponent(slug)}/versions`);
  if (data.url) console.log(data.url);
  for (const v of data.versions) {
    const cur = v.version === data.current ? " (current)" : "";
    const note = v.note ? `  ${v.note}` : "";
    console.log(`  v${v.version}${cur}  ${v.created_at.slice(0, 10)}  ${v.file_count} file(s)${note}`);
  }
}

async function rollback(slug, version) {
  if (!slug || !version) die("rollback requires <slug> <version>");
  const data = await call(
    `/api/artifacts/${encodeURIComponent(slug)}/current`,
    asJson("POST", { version: Number(version) })
  );
  console.log(`${slug} is now live on v${data.current}`);
  if (data.url) console.log(data.url);
}

async function list() {
  const { artifacts } = await call("/api/artifacts");
  if (!artifacts.length) return console.log("(no artifacts)");
  for (const a of artifacts) {
    const vis = a.visibility === "everyone" ? "everyone" : "restricted";
    console.log(`${a.slug.padEnd(24)} ${a.type.padEnd(7)} ${vis.padEnd(11)} ${a.file_count} file(s)  ${a.title}`);
  }
}

async function getAccess(slug) {
  return call(`/api/artifacts/${encodeURIComponent(slug)}/access`);
}

async function putAccess(slug, visibility, emails) {
  return call(
    `/api/artifacts/${encodeURIComponent(slug)}/access`,
    asJson("PUT", { visibility, emails })
  );
}

async function access(slug) {
  if (!slug) die("access requires a <slug>");
  const a = await getAccess(slug);
  console.log(`${slug}: ${a.visibility}`);
  if (a.visibility === "restricted") {
    console.log(a.emails.length ? a.emails.map((e) => "  " + e).join("\n") : "  (no users granted — admin only)");
  }
}

async function grant(slug, email) {
  if (!slug || !email) die("grant requires <slug> <email>");
  const a = await getAccess(slug);
  const emails = [...new Set([...a.emails, email.toLowerCase()])];
  const r = await putAccess(slug, "restricted", emails);
  console.log(`granted ${email} on ${slug} (${r.emails.length} user(s), ${r.visibility})`);
}

async function revoke(slug, email) {
  if (!slug || !email) die("revoke requires <slug> <email>");
  const a = await getAccess(slug);
  const emails = a.emails.filter((e) => e !== email.toLowerCase());
  const r = await putAccess(slug, a.visibility, emails);
  console.log(`revoked ${email} on ${slug} (${r.emails.length} user(s) remain)`);
}

async function visibility(slug, mode) {
  if (!slug || !mode) die("visibility requires <slug> <everyone|restricted>");
  if (mode !== "everyone" && mode !== "restricted") die("mode must be 'everyone' or 'restricted'");
  const a = await getAccess(slug);
  const r = await putAccess(slug, mode, a.emails);
  console.log(`${slug} visibility set to ${r.visibility}`);
}

async function views(slug) {
  if (!slug) die("views requires a <slug>");
  const data = await call(`/api/artifacts/${encodeURIComponent(slug)}/views`);
  console.log(`${slug}: ${data.total} total · ${data.unique} unique viewer(s)`);
  for (const v of data.recent) {
    const where = v.country ? ` ${v.country}` : "";
    console.log(`  ${v.viewed_at.replace("T", " ").slice(0, 16)}  v${v.version}  ${v.email ?? "—"}${where}`);
  }
}

/**
 * Since issue #24, /api/users returns the local directory: `users` is a list of
 * objects (email, role, status, timestamps), not a list of email strings, and
 * `allowlist` describes what we can see of Cloudflare Access. Warnings are
 * surfaced verbatim — a write that landed locally but not in Access is a state
 * an operator must not miss.
 */
const ROLE_TAG = { super_admin: "owner", admin: "admin", member: "" };

function printUser(u) {
  const tags = [ROLE_TAG[u.role], u.status === "disabled" ? "paused" : u.status]
    .filter(Boolean)
    .join(", ");
  const name = u.display_name ? `  ${u.display_name}` : "";
  console.log(`  ${u.email}  (${tags})${name}`);
}

function printWarning(data) {
  if (data.warning) console.log(`  ! ${data.warning}`);
}

// The credential-management commands below all pass `{ admin: true }`: they stay
// on /api, which an operator can keep gated at the edge, and which refuses API
// tokens in the Worker whatever the path.

async function users() {
  const data = await call("/api/users", {}, { admin: true });
  const list = data.users || [];
  if (!list.length) return console.log("(no users)");
  for (const u of list) printUser(u);
  if (data.allowlist && !data.allowlist.configured) {
    console.log("  ! Cloudflare Access isn't configured — nobody new can sign in");
  } else if (data.allowlist?.error) {
    console.log(`  ! couldn't read the Access allow-list: ${data.allowlist.error}`);
  }
}

async function userAdd(email, flags = {}) {
  if (!email) die("user-add requires <email>");
  const body = { email };
  if (flags.name) body.display_name = flags.name;
  if (flags.note) body.notes = flags.note;
  const data = await call("/api/users", asJson("POST", body), { admin: true });
  console.log(`invited ${email} (${(data.users || []).length} user(s) known)`);
  if (data.user) printUser(data.user);
  printWarning(data);
}

async function userRemove(email) {
  if (!email) die("user-remove requires <email>");
  const data = await call(
    `/api/users/${encodeURIComponent(email)}`,
    { method: "DELETE" },
    { admin: true }
  );
  console.log(`removed ${email} (${(data.users || []).length} user(s) remain)`);
  printWarning(data);
}

/** Pause or re-enable somebody without removing them from the beta. */
async function userSetEnabled(email, enabled) {
  const verb = enabled ? "enable" : "disable";
  if (!email) die(`user-${verb} requires <email>`);
  const data = await call(
    `/api/users/${encodeURIComponent(email)}/${verb}`,
    { method: "POST" },
    { admin: true }
  );
  console.log(`${enabled ? "re-enabled" : "paused"} ${email}`);
  if (data.user) printUser(data.user);
  printWarning(data);
}

async function tokens() {
  const data = await call("/api/tokens", {}, { admin: true });
  if (!data.tokens.length) return console.log("(no tokens)");
  for (const t of data.tokens) {
    const who = t.is_admin ? "admin" : t.owner_email;
    const state = t.revoked_at ? "revoked" : t.expires_at ? `expires ${t.expires_at.slice(0, 10)}` : "active";
    const used = t.last_used_at ? `last used ${t.last_used_at.slice(0, 10)}` : "never used";
    console.log(`${t.id}  ${String(who).padEnd(24)} ${t.scopes.join(",").padEnd(20)} ${state.padEnd(20)} ${used}  ${t.name}`);
  }
}

async function tokenCreate(name, flags) {
  if (!name) die("token-create requires a <name>");
  const body = { name };
  if (flags.scopes) body.scopes = flags.scopes.split(",").map((s) => s.trim()).filter(Boolean);
  if (flags.owner) body.owner_email = flags.owner;
  if (flags.admin) body.is_admin = true;
  if (flags["expires-days"]) body.expires_in_days = Number(flags["expires-days"]);
  const data = await call("/api/tokens", asJson("POST", body), { admin: true });
  // Printed once — the server only keeps a hash.
  console.log(`token ${data.id} created (${data.scopes.join(",")}${data.is_admin ? ", admin" : ""})`);
  console.log(`\n  ${data.token}\n`);
  console.log("copy it now — it cannot be shown again. Use it as RTFX_API_TOKEN.");
}

async function tokenRevoke(id) {
  if (!id) die("token-revoke requires a <token-id>");
  const data = await call(
    `/api/tokens/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    { admin: true }
  );
  console.log(data.already_revoked ? `${data.revoked} was already revoked` : `revoked ${data.revoked}`);
}

async function del(slug) {
  if (!slug) die("delete requires a <slug>");
  const data = await call(`/api/artifacts/${encodeURIComponent(slug)}`, { method: "DELETE" });
  console.log(`deleted: ${data.deleted}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const { flags, positional } = parseFlags(rest);

switch (cmd) {
  case "publish":
    await publish(positional[0], flags);
    break;
  case "list":
    await list();
    break;
  case "delete":
    await del(positional[0]);
    break;
  case "access":
    await access(positional[0]);
    break;
  case "grant":
    await grant(positional[0], positional[1]);
    break;
  case "revoke":
    await revoke(positional[0], positional[1]);
    break;
  case "visibility":
    await visibility(positional[0], positional[1]);
    break;
  case "versions":
    await versions(positional[0]);
    break;
  case "rollback":
    await rollback(positional[0], positional[1]);
    break;
  case "views":
    await views(positional[0]);
    break;
  case "users":
    await users();
    break;
  case "user-add":
    await userAdd(positional[0], flags);
    break;
  case "user-remove":
    await userRemove(positional[0]);
    break;
  case "user-disable":
    await userSetEnabled(positional[0], false);
    break;
  case "user-enable":
    await userSetEnabled(positional[0], true);
    break;
  case "tokens":
    await tokens();
    break;
  case "token-create":
    await tokenCreate(positional[0], flags);
    break;
  case "token-revoke":
    await tokenRevoke(positional[0]);
    break;
  default:
    console.log("usage: artifacts <command> ...");
    console.log("  publish <path> [--slug s] [--title t] [--description d] [--note n]");
    console.log("        (new slug = v1; existing slug = new version, goes live)");
    console.log("  list");
    console.log("  delete <slug>");
    console.log("  versions <slug>                  list an artifact's versions");
    console.log("  rollback <slug> <version>        make an older version live again");
    console.log("  views <slug>                     view count + recent views log");
    console.log("  access <slug>                    show visibility + granted users");
    console.log("  grant <slug> <email>             allow a user (sets restricted)");
    console.log("  revoke <slug> <email>            remove a user from an artifact");
    console.log("  visibility <slug> <everyone|restricted>");
    console.log("  users                            list the beta directory (role + status)");
    console.log("  user-add <email> [--name n] [--note n] invite a person (adds them to Cloudflare Access)");
    console.log("  user-disable <email>             pause access + revoke their API tokens");
    console.log("  user-enable <email>              lift a pause");
    console.log("  user-remove <email>              revoke login, grants and tokens (keeps artifacts)");
    console.log("  tokens                           list API tokens");
    console.log("  token-create <name> [--scopes read,publish,manage] [--owner e] [--admin] [--expires-days n]");
    console.log("        (prints the token once — store it as RTFX_API_TOKEN)");
    console.log("  token-revoke <token-id>          revoke an API token");
    console.log("");
    console.log("auth: RTFX_API_TOKEN (bearer) is all the artifact commands need — they use the");
    console.log("      machine API (/api/machine/…). CF_ACCESS_CLIENT_ID/SECRET is only for a");
    console.log("      self-hosted instance that gates every path at the edge.");
    console.log("      token-* and user-* commands require an Access login, not an API token.");
    process.exit(cmd ? 1 : 0);
}
