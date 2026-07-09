#!/usr/bin/env node
// Artifacts CLI — publish/list/delete/version artifacts on your instance.
//
// Auth: uses a Cloudflare Access service token via env vars.
//   ARTIFACTS_URL            your instance URL (default http://localhost:8787 for dev)
//   CF_ACCESS_CLIENT_ID      service token client id
//   CF_ACCESS_CLIENT_SECRET  service token client secret
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

const BASE = (process.env.ARTIFACTS_URL || "http://localhost:8787").replace(/\/+$/, "");
const ID = process.env.CF_ACCESS_CLIENT_ID;
const SECRET = process.env.CF_ACCESS_CLIENT_SECRET;

function authHeaders() {
  const h = {};
  if (ID && SECRET) {
    h["CF-Access-Client-Id"] = ID;
    h["CF-Access-Client-Secret"] = SECRET;
  }
  return h;
}

function die(msg) {
  console.error("error:", msg);
  process.exit(1);
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "overwrite") flags.overwrite = true;
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

  const res = await fetch(`${BASE}/api/artifacts`, { method: "POST", headers: authHeaders(), body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status} ${data.detail || data.error || res.statusText}`);
  console.log(`published: ${data.url}  (v${data.version}, ${data.type}, ${data.file_count} file(s))`);
}

async function versions(slug) {
  if (!slug) die("versions requires a <slug>");
  const res = await fetch(`${BASE}/api/artifacts/${encodeURIComponent(slug)}/versions`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status} ${data.detail || data.error || res.statusText}`);
  for (const v of data.versions) {
    const cur = v.version === data.current ? " (current)" : "";
    const note = v.note ? `  ${v.note}` : "";
    console.log(`  v${v.version}${cur}  ${v.created_at.slice(0, 10)}  ${v.file_count} file(s)${note}`);
  }
}

async function rollback(slug, version) {
  if (!slug || !version) die("rollback requires <slug> <version>");
  const res = await fetch(`${BASE}/api/artifacts/${encodeURIComponent(slug)}/current`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ version: Number(version) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status} ${data.detail || data.error || res.statusText}`);
  console.log(`${slug} is now live on v${data.current}`);
}

async function list() {
  const res = await fetch(`${BASE}/api/artifacts`, { headers: authHeaders() });
  if (!res.ok) die(`${res.status} ${res.statusText}`);
  const { artifacts } = await res.json();
  if (!artifacts.length) return console.log("(no artifacts)");
  for (const a of artifacts) {
    const vis = a.visibility === "everyone" ? "everyone" : "restricted";
    console.log(`${a.slug.padEnd(24)} ${a.type.padEnd(7)} ${vis.padEnd(11)} ${a.file_count} file(s)  ${a.title}`);
  }
}

async function getAccess(slug) {
  const res = await fetch(`${BASE}/api/artifacts/${encodeURIComponent(slug)}/access`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status} ${data.detail || data.error || res.statusText}`);
  return data;
}

async function putAccess(slug, visibility, emails) {
  const res = await fetch(`${BASE}/api/artifacts/${encodeURIComponent(slug)}/access`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ visibility, emails }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status} ${data.detail || data.error || res.statusText}`);
  return data;
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
  const res = await fetch(`${BASE}/api/artifacts/${encodeURIComponent(slug)}/views`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status} ${data.detail || data.error || res.statusText}`);
  console.log(`${slug}: ${data.total} total · ${data.unique} unique viewer(s)`);
  for (const v of data.recent) {
    const where = v.country ? ` ${v.country}` : "";
    console.log(`  ${v.viewed_at.replace("T", " ").slice(0, 16)}  v${v.version}  ${v.email ?? "—"}${where}`);
  }
}

async function users() {
  const res = await fetch(`${BASE}/api/users`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status} ${data.detail || data.error || res.statusText}`);
  const admins = new Set(data.admins || []);
  if (!data.users.length) return console.log("(no users)");
  for (const u of data.users) console.log(`  ${u}${admins.has(u) ? "  (admin)" : ""}`);
}

async function userAdd(email) {
  if (!email) die("user-add requires <email>");
  const res = await fetch(`${BASE}/api/users`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status} ${data.detail || data.error || res.statusText}`);
  console.log(`added ${email} (${data.users.length} user(s) can now log in)`);
}

async function userRemove(email) {
  if (!email) die("user-remove requires <email>");
  const res = await fetch(`${BASE}/api/users/${encodeURIComponent(email)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status} ${data.detail || data.error || res.statusText}`);
  console.log(`removed ${email} (${data.users.length} user(s) remain)`);
}

async function del(slug) {
  if (!slug) die("delete requires a <slug>");
  const res = await fetch(`${BASE}/api/artifacts/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status} ${data.detail || data.error || res.statusText}`);
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
    await userAdd(positional[0]);
    break;
  case "user-remove":
    await userRemove(positional[0]);
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
    console.log("  users                            list who can log in (Cloudflare Access)");
    console.log("  user-add <email>                 allow a person to log in");
    console.log("  user-remove <email>              revoke login + all artifact access");
    process.exit(cmd ? 1 : 0);
}
