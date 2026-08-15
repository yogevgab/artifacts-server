#!/usr/bin/env node
// rtfx-mcp — the rtfx.pro MCP server, over stdio.
//
// Issue #39. Lets Claude Desktop, Claude Code, or any MCP client publish to
// rtfx.pro (or your own artifacts-server) as a tool call rather than a shell
// command. Same credential, same bundle safety model and same HTTP contract as
// the plugin's CLI — the two are wrappers over one library, not two
// implementations that will drift.
//
// Standalone by design: no npm install, no dependencies, Node 18+.
//
// Configuration — two variables, neither a Cloudflare account credential:
//   RTFX_API_TOKEN   a scoped token from the dashboard → Integrations (required)
//   ARTIFACTS_URL    your instance, default https://rtfx.pro (RTFX_URL also accepted)
//
// Optional:
//   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET   Access service-token headers,
//                    only for a self-hosted instance that gates every path at the
//                    edge. Not needed on rtfx.pro: the tools call /api/machine,
//                    which authenticates the bearer token on its own.
//   RTFX_MCP_ALLOW_ACCESS=1   also expose `update_access` (needs a `manage` token)
//   RTFX_MCP_DEBUG=1          log method names to stderr (never arguments)
//
// CF_API_TOKEN is ignored. This server never manages Cloudflare.
//
// Run it:
//   node rtfx-mcp.mjs              # speaks JSON-RPC on stdin/stdout
//   node rtfx-mcp.mjs --help       # what a client should be configured with
//
// stdout carries protocol traffic and nothing else — one JSON message per line,
// as the stdio transport requires. Every diagnostic goes to stderr, redacted.

import { readFileSync, statSync, lstatSync, readdirSync } from "node:fs";
import { File } from "node:buffer";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { DEFAULT_ENDPOINT, TOKEN_VAR } from "./rtfx.lib.mjs";
import { prepareBundle } from "./rtfx.bundle.mjs";
import { getCredential, putCredential } from "./rtfx.oauth.lib.mjs";
import { credentialsPath, loadStore, saveStore } from "./rtfx.oauth.mjs";
import {
  ACCESS_TOOL_VAR,
  SERVER_INFO,
  createContext,
  describeEnv,
  handleMessage,
  parseLine,
  redactSecrets,
  toolsFor,
} from "./rtfx.mcp.lib.mjs";

// --- Node floor --------------------------------------------------------------
//
// `fetch`, `FormData` and `node:buffer`'s `File` are all what this depends on;
// 18 is the first release with all three. Failing here with a sentence beats
// failing later with a ReferenceError a client will render as "server crashed".

const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(NODE_MAJOR) || NODE_MAJOR < 18) {
  process.stderr.write(`rtfx-mcp needs Node 18 or newer; this is ${process.version}\n`);
  process.exit(1);
}

// --- Filesystem, injected ----------------------------------------------------
//
// rtfx.bundle.mjs takes its filesystem as an argument so the same walk can be
// tested without one. This is the real one.

const IO = {
  stat: (path) => statSync(path),
  lstat: (path) => lstatSync(path),
  readDir: (path) => readdirSync(path),
  readFile: (path) => new Uint8Array(readFileSync(path)),
  join,
  deflate: (bytes) => new Uint8Array(deflateRawSync(bytes)),
};

// --- The OAuth credential store, injected ------------------------------------
//
// Same shape as IO above and for the same reason: rtfx.mcp.lib.mjs must not
// import `node:fs`, so it takes the store as two functions. `read` runs on the
// way into every call — one small file read — because an MCP server outlives the
// one-hour access token it started with, and a credential resolved only at boot
// would be stale for most of the session.

const CREDENTIALS = {
  read: (issuer) => getCredential(loadStore(process.env), issuer),
  write: (issuer, credential) => saveStore(putCredential(loadStore(process.env), issuer, credential), process.env),
};

const ctx = createContext({
  env: process.env,
  fetch: (...args) => fetch(...args),
  prepareBundle: (path) => prepareBundle(path, IO),
  File,
  node: process.version,
  credentials: CREDENTIALS,
});

const DEBUG = ["1", "true", "yes", "on"].includes(String(process.env.RTFX_MCP_DEBUG ?? "").toLowerCase());

/** Diagnostics go to stderr only, and are redacted like everything else. */
function log(message) {
  process.stderr.write(`${redactSecrets(message, ctx.config)}\n`);
}

// --- --help ------------------------------------------------------------------

/** Which of the two credentials `--help` is looking at. Never prints either. */
function describeSource(facts) {
  if (facts.credential_source === "env") return `${TOKEN_VAR} (environment)`;
  if (facts.credential_source === "oauth") {
    const scopes = facts.oauth?.scopes?.length ? ` · ${facts.oauth.scopes.join(", ")}` : "";
    return `browser sign-in${scopes} · expires ${facts.oauth?.expires_at ?? "unknown"}, renews automatically`;
  }
  return "none";
}

if (process.argv.slice(2).some((a) => a === "--help" || a === "-h" || a === "help")) {
  const facts = describeEnv(ctx);
  process.stdout.write(
    [
      `${SERVER_INFO.name} MCP server v${SERVER_INFO.version} — publish to rtfx.pro from an MCP client`,
      "",
      "This speaks the MCP stdio transport; run it from a client, not by hand.",
      "",
      "Claude Code:",
      `  claude mcp add rtfx --env ${TOKEN_VAR}=rtfx_… -- node ${process.argv[1]}`,
      "",
      "Claude Desktop — claude_desktop_config.json:",
      '  { "mcpServers": { "rtfx": {',
      `      "command": "node", "args": ["${process.argv[1]}"],`,
      `      "env": { "${TOKEN_VAR}": "rtfx_…" } } } }`,
      "",
      "Credentials — either one works, and the environment variable wins:",
      `  node ${process.argv[1].replace(/rtfx-mcp\.mjs$/, "rtfx.mjs")} login`,
      "                            a browser sign-in, stored 0600 and renewed automatically",
      `  ${TOKEN_VAR}            a scoped token from the dashboard → Integrations`,
      "",
      "Environment:",
      `  ${TOKEN_VAR}            optional — takes priority over a stored sign-in`,
      `  ARTIFACTS_URL             optional — default ${DEFAULT_ENDPOINT} (RTFX_URL is an alias)`,
      "  CF_ACCESS_CLIENT_ID/…     optional — Cloudflare Access service token, edge gating only",
      `  ${ACCESS_TOOL_VAR}     optional — set to 1 to also expose update_access`,
      "  RTFX_MCP_DEBUG            optional — log method names to stderr",
      "",
      "As configured right now:",
      `  endpoint  ${facts.endpoint}`,
      `  auth      ${describeSource(facts)}`,
      `  token     ${facts.token ?? "none — run login, or export " + TOKEN_VAR}`,
      `  store     ${credentialsPath()}`,
      `  tools     ${facts.tools.join(", ")}`,
      "",
    ].join("\n")
  );
  process.exit(0);
}

// --- stdio transport ---------------------------------------------------------
//
// Messages are delimited by newlines and must not contain embedded newlines
// (MCP stdio transport). JSON.stringify escapes any newline inside a string, so
// one stringify per write is the whole framing.

function send(message) {
  if (!message) return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    void dispatch(line);
  }
});

// No explicit exit when stdin closes. Once the readable side ends Node drops its
// handle and the process leaves on its own — after any in-flight publish has
// written its response. Calling process.exit() here would truncate that.
process.stdin.on("end", () => {
  if (DEBUG) log("stdin closed; finishing in-flight work");
});

async function dispatch(line) {
  const { skip, error, message } = parseLine(line);
  if (skip) return;
  if (error) {
    send(error);
    return;
  }
  if (DEBUG) log(`→ ${message.method ?? "(no method)"}`);
  try {
    send(await handleMessage(message, ctx));
  } catch (e) {
    // handleMessage already turns failures into error responses; reaching here
    // means the transport itself failed, which is worth saying out loud.
    log(`internal error handling ${message.method}: ${e?.message ?? e}`);
  }
}

// A crash must not take the client's session with it silently.
process.on("uncaughtException", (e) => {
  log(`uncaught: ${e?.stack ?? e?.message ?? e}`);
});
process.on("unhandledRejection", (e) => {
  log(`unhandled rejection: ${e?.stack ?? e?.message ?? e}`);
});

if (DEBUG) log(`rtfx-mcp ${SERVER_INFO.version} ready on ${ctx.config.endpoint} — tools: ${toolsFor(ctx.env).map((t) => t.name).join(", ")}`);
