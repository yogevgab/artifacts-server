// The rtfx MCP server, as pure functions over plain data. Issue #39.
//
// Everything protocol-shaped lives here — the tool schemas, argument
// validation, JSON-RPC dispatch, result shaping and secret redaction — with no
// `node:` imports and no I/O of its own. `rtfx-mcp.mjs` supplies stdin/stdout,
// the filesystem and `fetch`; the artifacts-server test suite supplies a `fetch`
// wired straight to the real Worker, which is how publish/list/versions/rollback
// are tested end to end without a network.
//
// Two rules this file exists to keep:
//
//  1. **Nothing here reads a credential except through `resolveConfig`.** The
//     token goes into a request header and nowhere else — not into a result, not
//     into an error, not into a log line. `redactSecrets` is the backstop for the
//     one case we cannot audit by reading: a message that came from somewhere
//     else (a fetch failure, an API body) and happens to contain it.
//  2. **Every tool schema is closed.** `additionalProperties: false` plus an
//     explicit type for each field means a malformed call is refused with
//     `-32602` before any filesystem or network work happens, rather than being
//     coerced into something that looked close enough.
//
// Cloudflare management tokens are not part of this surface. `CF_API_TOKEN` is
// ignored if present, exactly as the CLI ignores it.

import {
  DEFAULT_ENDPOINT,
  ENDPOINT_VARS,
  MAX_UPLOAD_BYTES,
  TOKEN_VAR,
  apiUrl,
  authHeaders,
  describeApiError,
  describeNonJsonResponse,
  machineApiPath,
  publishSummary,
  redactToken,
  resolveConfig,
  shouldRetryOnLegacyApi,
} from "./rtfx.lib.mjs";
import { BundleError, describeSkips } from "./rtfx.bundle.mjs";
import {
  OAuthError,
  describeCredential,
  issuerFor,
  needsRefresh,
  redactRefreshToken,
  refreshCredential,
} from "./rtfx.oauth.lib.mjs";

/** Reported in `initialize`; bumped with the plugin manifest. */
export const SERVER_INFO = {
  name: "rtfx",
  title: "rtfx.pro publishing",
  version: "1.2.0",
};

/**
 * Protocol revisions this server speaks. The negotiated version is the client's
 * when we know it, and `LATEST_PROTOCOL_VERSION` otherwise — which is what tells
 * a client from the future that it is talking to an older server.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

/** Env var that opts the sharing tool in. Off by default — see TOOLS. */
export const ACCESS_TOOL_VAR = "RTFX_MCP_ALLOW_ACCESS";

/**
 * Shown to the model once, at connect time. Worth spending words on: it is the
 * difference between an agent that publishes to the right slug and one that
 * invents a new artifact on every run.
 */
export const INSTRUCTIONS = `Publish HTML pages and multi-file artifacts to rtfx.pro (or a self-hosted artifacts-server).

Publishing to a NEW slug creates the artifact at v1, private to its owner. Publishing to a slug
you already own appends an immutable version and makes it live at the same URL (free plans retain
the last 5 versions; paid plans keep all) — so re-publishing
an update means calling publish again with the same slug, never inventing a new one. Publishing to
someone else's slug is refused with 409.

Point publish at a built output directory (it must contain index.html at its root), a single .html
file, or a .zip. Never point it at a project root or a home directory. Credential-looking files
(.env, *.pem, *.key, id_rsa …), .git and node_modules are dropped and reported; a prebuilt zip
containing any of them is refused outright rather than silently filtered.

Use dry_run first when you are unsure what a directory contains — it reports every file that would
be included and skipped without uploading anything. Read the returned URL from the result; never
assemble it yourself, because the content host differs per instance.`;

// --- Tool schemas ------------------------------------------------------------

const SLUG = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
  description: "Artifact slug: lowercase letters, digits and single hyphens. This is the address, e.g. slug \"q3-report\" is served at /q3-report/.",
};

/**
 * The tool surface. Deliberately a subset of what the API can do: publishing and
 * reading history are what an agent needs, and a publishing integration that
 * could also change who sees an artifact is a bigger blast radius than the
 * convenience is worth. `update_access` therefore exists but is off unless
 * `RTFX_MCP_ALLOW_ACCESS` is set, and even then needs a `manage`-scoped token.
 *
 * Minting tokens and managing people are absent outright — the API refuses a
 * bearer token on those routes, so there is nothing to expose.
 */
export const TOOLS = [
  {
    name: "publish",
    title: "Publish an artifact",
    description:
      "Publish a local .html file, .zip, or directory (containing index.html at its root) to rtfx.pro and return its stable URL. A new slug creates the artifact at v1; an existing slug you own adds a new immutable version and makes it live at the same URL. Credential-looking files and build directories are never uploaded.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "Path to publish: an .html file, a .pdf, a .zip, or a directory with index.html at its root. Relative paths resolve against the working directory the server was started in, so prefer an absolute path.",
        },
        slug: SLUG,
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Human-readable title. Required for a brand-new artifact. Omit when adding a version to an existing slug — that keeps the current title.",
        },
        description: { type: "string", maxLength: 500, description: "Optional one-line description shown in the dashboard." },
        note: { type: "string", maxLength: 200, description: "Optional note attached to this version only, e.g. what changed." },
        dry_run: {
          type: "boolean",
          default: false,
          description:
            "Report every file that would be included and skipped, and upload nothing. Needs no token. Use this when unsure what a directory contains.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "list_artifacts",
    title: "List artifacts",
    description:
      "List the artifacts this token can reach, with each one's slug, title, type, current version and visibility. Use it to find the slug of something already published before re-publishing to it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "get_versions",
    title: "Get version history",
    description:
      "Version history for one artifact, newest first, marking which version is currently live. Every version stays retrievable; nothing is overwritten by a re-publish.",
    inputSchema: { type: "object", properties: { slug: SLUG }, required: ["slug"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "rollback",
    title: "Roll back to an earlier version",
    description:
      "Make an earlier version live again at the same URL. Non-destructive: no version is deleted, and rolling forward is the same call with a higher number. Call get_versions first to see what exists.",
    inputSchema: {
      type: "object",
      properties: {
        slug: SLUG,
        version: { type: "integer", minimum: 1, description: "Version number to make live, as reported by get_versions." },
      },
      required: ["slug", "version"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "update_access",
    title: "Set who can open an artifact",
    // Gated: this is the one tool that changes who sees something.
    requiresEnv: ACCESS_TOOL_VAR,
    description:
      "Replace who can open an artifact: either 'restricted' (its owner plus the named emails) or 'everyone' (any signed-in user of the instance). The email list is a replacement, not an addition — send the full list. Needs a token with the 'manage' scope. Disabled unless the server was started with " +
      `${ACCESS_TOOL_VAR}=1.`,
    inputSchema: {
      type: "object",
      properties: {
        slug: SLUG,
        visibility: {
          type: "string",
          enum: ["restricted", "everyone"],
          description: "'restricted' = owner plus the named emails only. 'everyone' = any signed-in user of this instance.",
        },
        emails: {
          type: "array",
          items: { type: "string" },
          maxItems: 200,
          description: "Full replacement list of emails granted access. Ignored when visibility is 'everyone'; pass [] to revoke everyone.",
        },
      },
      required: ["slug", "visibility"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "doctor",
    title: "Check configuration",
    description:
      "Check how this server is configured and whether the API is reachable: which endpoint it publishes to, whether a token is present (reported as its id only, never the secret), whether Cloudflare Access service-token headers are set, and the Node version. Run this first when a call fails with 401 or a connection error.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

const truthy = (value) => ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());

/** Tools this environment exposes, with the internal `requiresEnv` key stripped. */
export function toolsFor(env = {}) {
  return TOOLS.filter((tool) => !tool.requiresEnv || truthy(env[tool.requiresEnv])).map(
    ({ requiresEnv, ...rest }) => rest
  );
}

export function findTool(name, env = {}) {
  return toolsFor(env).find((tool) => tool.name === name) ?? null;
}

// --- Argument validation -----------------------------------------------------

function checkValue(key, raw, spec) {
  const label = `"${key}"`;
  switch (spec.type) {
    case "string":
      if (typeof raw !== "string") return `${label} must be a string`;
      if (spec.minLength !== undefined && raw.length < spec.minLength) return `${label} must not be empty`;
      if (spec.maxLength !== undefined && raw.length > spec.maxLength) return `${label} must be at most ${spec.maxLength} characters`;
      if (spec.enum && !spec.enum.includes(raw)) return `${label} must be one of: ${spec.enum.join(", ")}`;
      if (spec.pattern && !new RegExp(spec.pattern).test(raw)) return `${label} does not match ${spec.pattern}`;
      return null;
    case "integer":
      if (typeof raw !== "number" || !Number.isInteger(raw)) return `${label} must be an integer`;
      if (spec.minimum !== undefined && raw < spec.minimum) return `${label} must be at least ${spec.minimum}`;
      return null;
    case "boolean":
      return typeof raw === "boolean" ? null : `${label} must be true or false`;
    case "array": {
      if (!Array.isArray(raw)) return `${label} must be an array`;
      if (spec.maxItems !== undefined && raw.length > spec.maxItems) return `${label} must have at most ${spec.maxItems} items`;
      if (spec.items && raw.some((item) => typeof item !== spec.items.type)) {
        return `${label} must contain only ${spec.items.type} values`;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Validate a tool call against its own schema. Unknown keys are an error rather
 * than being ignored: a model that sends `slugs` instead of `slug` should be told
 * so, not have the call silently do something else.
 */
export function validateToolInput(tool, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, errors: ["arguments must be an object"], value: {} };
  }
  const schema = tool.inputSchema ?? {};
  const props = schema.properties ?? {};
  const errors = [];
  const value = {};

  for (const key of Object.keys(args)) {
    if (!(key in props)) errors.push(`unknown argument "${key}"`);
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) errors.push(`"${key}" is required`);
  }
  for (const [key, spec] of Object.entries(props)) {
    const raw = args[key];
    if (raw === undefined || raw === null) {
      if (spec.default !== undefined) value[key] = spec.default;
      continue;
    }
    const error = checkValue(key, raw, spec);
    if (error) errors.push(error);
    else value[key] = raw;
  }
  return { ok: errors.length === 0, errors, value };
}

// --- Secret hygiene ----------------------------------------------------------

/**
 * Replace any credential that made it into a string with a form that cannot
 * authenticate. Nothing in this file puts a token into text on purpose — this
 * catches the paths we do not author: an error message from `fetch`, a body
 * echoed back by a misconfigured proxy, a stack trace from a dependency.
 *
 * The token becomes `rtfx_<id>_…` (still enough to find and revoke it); an
 * Access service-token secret becomes `[redacted]`. Runs on every line the
 * server emits, on stdout and stderr alike.
 */
export function redactSecrets(text, config = null) {
  let out = typeof text === "string" ? text : String(text);
  const secrets = [];
  if (config?.token) secrets.push([config.token, redactToken(config.token)]);
  if (config?.access?.secret) secrets.push([config.access.secret, "[redacted]"]);
  if (config?.access?.id) secrets.push([config.access.id, "[redacted]"]);
  // A refresh token mints access tokens, so it is at least as sensitive as one —
  // and it does not match the `rtfx_<id>_<secret>` shape below, which is exactly
  // why it has to be named here rather than left to the pattern.
  if (config?.credential?.refresh_token) {
    secrets.push([config.credential.refresh_token, redactRefreshToken(config.credential.refresh_token)]);
  }
  for (const [secret, replacement] of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join(replacement);
  }
  // Anything else token-shaped — a token for a *different* instance, say — is
  // cut down to its id too, on the same reasoning. Refresh tokens carry no id
  // worth showing, so they go to a constant.
  return out
    .replace(/\brtfxr_[A-Za-z0-9_-]{16,}/g, "rtfxr_…")
    .replace(/\brtfx_([A-Za-z0-9]{4,})_[A-Za-z0-9_-]{8,}/g, "rtfx_$1_…");
}

// --- Calling the API ---------------------------------------------------------

/** A refusal to report as a tool result. Never carries a credential. */
export class ToolError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "ToolError";
    this.detail = extra.detail ?? null;
    this.hint = extra.hint ?? null;
    this.retryable = extra.retryable ?? false;
    this.status = extra.status ?? null;
  }
}

/**
 * The execution context. `fetchImpl` and `prepareBundle` are injected so this
 * module never touches the network or the filesystem itself — which is what lets
 * the test suite point `fetchImpl` at the real Worker.
 *
 * `credentials` is the same idea applied to the OAuth store: an optional
 * `{ read(issuer), write(issuer, credential) }` pair, supplied by `rtfx-mcp.mjs`
 * from a 0600 file and by the test suite from an object. Absent, the server
 * behaves exactly as it did before browser login existed — `RTFX_API_TOKEN` or
 * nothing.
 */
export function createContext({
  env = {},
  fetch: fetchImpl,
  prepareBundle,
  File: FileImpl,
  node = null,
  credentials = null,
  now = () => Date.now(),
} = {}) {
  const ctx = { env, fetchImpl, prepareBundle, FileImpl, node, credentials, now };
  // Resolved eagerly so `--help` and `describeEnv` have something to report
  // without awaiting. `resolveRuntimeConfig` re-derives it, with a refresh, on
  // the way into every call that actually needs a live credential.
  ctx.config = resolveConfig(env, { credential: readStoredCredential(ctx) });
  return ctx;
}

/** The stored credential for this context's endpoint, if a store was supplied. */
function readStoredCredential(ctx) {
  if (!ctx.credentials?.read) return null;
  const issuer = issuerFor(resolveConfig(ctx.env).endpoint);
  if (!issuer) return null;
  try {
    return ctx.credentials.read(issuer);
  } catch {
    // An unreadable store is the same as no store: `login` rewrites it, and a
    // crash here would take down a server that might not have needed it anyway.
    return null;
  }
}

/**
 * The config a call should run on, renewed if need be.
 *
 * This is the whole of the MCP server's OAuth integration, and it deliberately
 * sits on the *call* path rather than at startup. An MCP server started by a
 * client stays alive for the length of a session — far longer than the one-hour
 * access token — so a credential resolved once at boot would be stale for most
 * of its life. Checking here costs one file read per call and means a session
 * that was signed in when it started is still signed in hours later.
 *
 * `RTFX_API_TOKEN` short-circuits it entirely, including the file read.
 */
export async function resolveRuntimeConfig(ctx) {
  if (resolveConfig(ctx.env).hasToken) {
    ctx.config = resolveConfig(ctx.env);
    return ctx.config;
  }
  const credential = readStoredCredential(ctx);
  if (!credential) {
    ctx.config = resolveConfig(ctx.env);
    return ctx.config;
  }

  const nowMs = ctx.now();
  if (!needsRefresh(credential, nowMs)) {
    ctx.config = resolveConfig(ctx.env, { credential });
    return ctx.config;
  }

  let next;
  try {
    next = await refreshCredential({ credential, fetchImpl: ctx.fetchImpl, nowMs });
  } catch (e) {
    const oauth = e instanceof OAuthError ? e : null;
    throw new ToolError("the stored rtfx sign-in could not be renewed", {
      detail: oauth?.detail ?? e?.message ?? String(e),
      hint: oauth?.needsLogin
        ? "Run `/rtfx:login` (or `node scripts/rtfx.mjs login`) to sign in again."
        : (oauth?.hint ?? "Retry; if it persists the server is refusing the refresh."),
    });
  }
  // Written down before it is used: the server spends the presented refresh
  // token on the way to issuing this one, so a rotation this process fails to
  // persist would strand the credential on disk pointing at a spent token.
  try {
    ctx.credentials.write(credential.issuer ?? issuerFor(ctx.config.endpoint), next);
  } catch (e) {
    throw new ToolError("the renewed rtfx sign-in could not be saved", {
      detail: e?.message ?? String(e),
      hint: "Check that the credentials file is writable, then run `/rtfx:login` again.",
    });
  }
  ctx.config = resolveConfig(ctx.env, { credential: next });
  return ctx.config;
}

/** The live config, or a refusal naming both ways to fix it. */
async function requireToken(ctx) {
  const config = await resolveRuntimeConfig(ctx);
  if (!config.hasToken) {
    throw new ToolError("no rtfx credential is available", {
      hint: `Run \`/rtfx:login\` to sign in with a browser, or set ${TOKEN_VAR} in the MCP server's env block (a token from ${config.endpoint}/admin/integrations, scopes: read, publish).`,
    });
  }
  return config;
}

/** One HTTP attempt, with the transport failure already turned into a ToolError. */
async function attempt(ctx, cfg, path, init) {
  const url = apiUrl(cfg.endpoint, path);
  let res;
  try {
    res = await ctx.fetchImpl(url, {
      ...init,
      headers: { ...authHeaders(cfg), ...(init.headers ?? {}) },
    });
  } catch (e) {
    throw new ToolError(`could not reach ${cfg.endpoint}`, {
      detail: e?.message ?? String(e),
      hint: `Check ${ENDPOINT_VARS[0]} and that the host is reachable from here.`,
      retryable: true,
    });
  }
  try {
    return { res, url, body: await res.json(), json: true };
  } catch {
    return { res, url, body: {}, json: false };
  }
}

/**
 * One API call, on the machine surface — the same rule the CLI follows, for the
 * same reason: `/api/machine/...` authenticates the bearer token and nothing
 * else, so an agent needs no Cloudflare credential to publish. An instance that
 * predates the surface answers with a bare 404 and the call is retried once
 * against `/api`; every 404 the machine surface itself produces carries an
 * `error`, so a real "not yours" is never retried.
 */
async function api(ctx, path, init = {}) {
  const cfg = await requireToken(ctx);
  const machine = machineApiPath(path);
  let out = await attempt(ctx, cfg, machine, init);
  if (machine !== path && shouldRetryOnLegacyApi(out.res.status, out.body)) {
    out = await attempt(ctx, cfg, path, init);
  }
  // Something that is not the app answered — usually Cloudflare Access, whose
  // sign-in page a `fetch` follows and reports as an ordinary 200.
  if (!out.json) {
    const { message, hint } = describeNonJsonResponse(out.url, out.res.url);
    throw new ToolError(message, { hint, status: out.res.status });
  }
  if (!out.res.ok) {
    const described = describeApiError(out.res.status, out.body);
    throw new ToolError(`${out.res.status} ${described.error || "request failed"}`, described);
  }
  return out.body;
}

// --- Results -----------------------------------------------------------------

/**
 * A tool result: a line a person can read, then the same facts as JSON for the
 * model to act on. Two text blocks rather than `structuredContent`, so a client
 * that predates structured output still gets everything.
 */
export function toolResult(summaryLines, data, config = null) {
  const summary = (Array.isArray(summaryLines) ? summaryLines : [summaryLines]).filter(Boolean).join("\n");
  return {
    content: [
      { type: "text", text: redactSecrets(summary, config) },
      { type: "text", text: redactSecrets(JSON.stringify({ ok: true, ...data }, null, 2), config) },
    ],
  };
}

export function toolFailure(error, config = null) {
  const payload = {
    ok: false,
    error: error.message,
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.hint ? { hint: error.hint } : {}),
    ...(error.status ? { status: error.status } : {}),
    retryable: Boolean(error.retryable),
  };
  const lines = [`error: ${error.message}`];
  if (error.detail) lines.push(`detail: ${error.detail}`);
  if (error.hint) lines.push(`hint: ${error.hint}`);
  return {
    isError: true,
    content: [
      { type: "text", text: redactSecrets(lines.join("\n"), config) },
      { type: "text", text: redactSecrets(JSON.stringify(payload, null, 2), config) },
    ],
  };
}

// --- The tools themselves ----------------------------------------------------

async function publish(ctx, args) {
  let prepared;
  try {
    prepared = ctx.prepareBundle(args.path);
  } catch (e) {
    if (e instanceof BundleError) throw new ToolError(e.message, { hint: e.hint });
    throw new ToolError(`could not read ${args.path}`, { detail: e?.message ?? String(e) });
  }

  if (args.dry_run) {
    return toolResult(
      [
        `would publish ${args.path} (${prepared.bytes.length} bytes as ${prepared.field}), nothing uploaded`,
        ...prepared.entries.map((f) => `  + ${f}`),
        ...describeSkips(prepared.skipped).map((line) => `  - ${line}`),
      ],
      {
        command: "publish",
        dry_run: true,
        path: args.path,
        slug: args.slug ?? null,
        upload_bytes: prepared.bytes.length,
        max_upload_bytes: MAX_UPLOAD_BYTES,
        files: prepared.entries,
        skipped: prepared.skipped,
      },
      ctx.config
    );
  }

  const form = new FormData();
  // Only send a title when we have one to send: omitting it on a republish is
  // what keeps an existing artifact's title intact. A brand-new artifact with
  // neither title nor slug falls back to the file/folder name, as the CLI does.
  if (args.title) form.set("title", args.title);
  else if (!args.slug) form.set("title", basenameOf(args.path).replace(/\.(html?|zip)$/i, ""));
  if (args.slug) form.set("slug", args.slug);
  if (args.description) form.set("description", args.description);
  if (args.note) form.set("note", args.note);
  // `File` is only a global from Node 20 on; rtfx-mcp.mjs injects the
  // `node:buffer` one so Node 18 works too.
  const FileCtor = ctx.FileImpl ?? globalThis.File;
  form.set(prepared.field, new FileCtor([prepared.bytes], prepared.filename, { type: prepared.type }));

  const data = await api(ctx, "/api/artifacts", { method: "POST", body: form });
  return toolResult(
    [...describeSkips(prepared.skipped).map((line) => `skipped ${line}`), publishSummary(data)],
    { command: "publish", ...data, skipped: prepared.skipped },
    ctx.config
  );
}

/** Local, so this module stays free of a path dependency. */
function basenameOf(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path);
}

async function listArtifacts(ctx) {
  const data = await api(ctx, "/api/artifacts");
  const artifacts = data.artifacts ?? [];
  return toolResult(
    artifacts.length
      ? artifacts.map((a) => {
          const visibility = a.visibility === "everyone" ? "everyone" : "restricted";
          return `${a.slug}  v${a.current_version}  ${a.type}  ${visibility}  ${a.title}`;
        })
      : ["(no artifacts visible to this token)"],
    { command: "list_artifacts", ...data },
    ctx.config
  );
}

async function getVersions(ctx, args) {
  const data = await api(ctx, `/api/artifacts/${encodeURIComponent(args.slug)}/versions`);
  return toolResult(
    [
      ...(data.url ? [data.url] : []),
      ...(data.versions ?? []).map((v) => {
        const live = v.version === data.current ? " (live)" : "";
        return `  v${v.version}${live}  ${String(v.created_at).slice(0, 10)}  ${v.file_count} file(s)${v.note ? `  ${v.note}` : ""}`;
      }),
    ],
    { command: "get_versions", slug: args.slug, ...data },
    ctx.config
  );
}

async function rollback(ctx, args) {
  const data = await api(ctx, `/api/artifacts/${encodeURIComponent(args.slug)}/current`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: args.version }),
  });
  return toolResult(
    [`${data.slug} is live on v${data.current}`, ...(data.url ? [data.url] : [])],
    { command: "rollback", ...data },
    ctx.config
  );
}

async function updateAccess(ctx, args) {
  const emails = args.emails ?? [];
  const data = await api(ctx, `/api/artifacts/${encodeURIComponent(args.slug)}/access`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visibility: args.visibility, emails }),
  });
  return toolResult(
    [
      `${data.slug} is ${data.visibility}${data.visibility === "restricted" ? ` for ${(data.emails ?? []).length} named person/people` : ""}`,
      ...(data.allowlistWarning ? [`note: ${data.allowlistWarning}`] : []),
    ],
    { command: "update_access", ...data },
    ctx.config
  );
}

/**
 * Configuration report. Presence only: a token is reported as its id, which is
 * what the dashboard lists and what revoking it takes, and is useless for
 * authenticating. `CF_API_TOKEN` is listed as ignored rather than omitted, so
 * somebody who set it learns that it does nothing here.
 */
export function describeEnv(ctx) {
  return {
    endpoint: ctx.config.endpoint,
    endpoint_default: ctx.config.endpoint === DEFAULT_ENDPOINT,
    token_set: ctx.config.hasToken,
    token: ctx.config.hasToken ? redactToken(ctx.config.token) : null,
    credential_source: ctx.config.source ?? "none",
    // `describeCredential` reports the token *id*, never the token, and omits the
    // refresh token entirely — this object is rendered into a tool result.
    oauth: ctx.config.credential ? describeCredential(ctx.config.credential) : null,
    access_headers: Boolean(ctx.config.access),
    access_tool_enabled: truthy(ctx.env[ACCESS_TOOL_VAR]),
    cloudflare_management_token: "ignored",
    node: ctx.node ?? null,
    max_upload_bytes: MAX_UPLOAD_BYTES,
    tools: toolsFor(ctx.env).map((t) => t.name),
  };
}

/** How `doctor` names the credential it is running on. */
function sourceLine(facts) {
  if (facts.credential_source === "env") return `${TOKEN_VAR} (environment)`;
  if (facts.credential_source === "oauth") {
    const scopes = facts.oauth?.scopes?.length ? ` · ${facts.oauth.scopes.join(", ")}` : "";
    return `browser sign-in${scopes} · renews automatically`;
  }
  return "none";
}

async function doctor(ctx) {
  // Resolved (and renewed) first, so what this reports is the credential a
  // publish would actually use rather than whatever was true at startup.
  await resolveRuntimeConfig(ctx);
  const facts = { command: "doctor", ...describeEnv(ctx) };
  if (!ctx.config.hasToken) {
    throw new ToolError("no rtfx credential is available", {
      detail: `endpoint ${facts.endpoint}; tools ${facts.tools.join(", ")}`,
      hint: `Run \`/rtfx:login\` to sign in with a browser, or set ${TOKEN_VAR} in the MCP server's env block (a token from ${facts.endpoint}/admin/integrations, scopes: read, publish).`,
    });
  }
  const data = await api(ctx, "/api/artifacts");
  return toolResult(
    [
      `endpoint  ${facts.endpoint}`,
      `auth      ${sourceLine(facts)}`,
      `token     ${facts.token}`,
      `access    ${facts.access_headers ? "service-token headers set" : "not set (fine unless /api is Access-gated)"}`,
      `tools     ${facts.tools.join(", ")}`,
      `api       ok — ${(data.artifacts ?? []).length} artifact(s) visible to this credential`,
    ],
    { ...facts, reachable: true, artifact_count: (data.artifacts ?? []).length },
    ctx.config
  );
}

const HANDLERS = { publish, list_artifacts: listArtifacts, get_versions: getVersions, rollback, update_access: updateAccess, doctor };

/**
 * Run one tool. A *protocol* problem (unknown tool, arguments that do not match
 * the schema) throws `JsonRpcError` so the client sees -32602; a *tool* problem
 * (no token, 404, unreadable path) comes back as a result with `isError: true`,
 * which is what lets the model read the hint and try something else.
 */
export async function callTool(name, args, ctx) {
  const tool = findTool(name, ctx.env);
  if (!tool) {
    const known = toolsFor(ctx.env).map((t) => t.name);
    const gated = TOOLS.find((t) => t.name === name && t.requiresEnv);
    throw new JsonRpcError(
      -32602,
      gated
        ? `tool "${name}" is disabled on this server — start it with ${gated.requiresEnv}=1 to enable it`
        : `unknown tool "${name}" (available: ${known.join(", ")})`
    );
  }
  const { ok, errors, value } = validateToolInput(tool, args);
  if (!ok) throw new JsonRpcError(-32602, `invalid arguments for "${name}": ${errors.join("; ")}`);

  try {
    return await HANDLERS[name](ctx, value);
  } catch (e) {
    if (e instanceof JsonRpcError) throw e;
    if (e instanceof ToolError) return toolFailure(e, ctx.config);
    return toolFailure(new ToolError(e?.message ?? String(e)), ctx.config);
  }
}

// --- JSON-RPC ----------------------------------------------------------------

export class JsonRpcError extends Error {
  constructor(code, message, data = undefined) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

export function negotiateProtocol(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

export function initializeResult(params = {}) {
  return {
    protocolVersion: negotiateProtocol(params?.protocolVersion),
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
}

/**
 * Handle one parsed JSON-RPC message. Returns the response to send, or `null`
 * for a notification (which by definition gets no reply).
 */
export async function handleMessage(message, ctx) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return errorResponse(null, -32600, "invalid request: expected a JSON-RPC object");
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  try {
    const result = await route(method, params, ctx);
    if (result === SILENT) return null;
    if (isNotification) return null;
    return { jsonrpc: "2.0", id, result };
  } catch (e) {
    if (isNotification) return null;
    if (e instanceof JsonRpcError) {
      return errorResponse(
        id,
        e.code,
        redactSecrets(e.message, ctx.config),
        redactProtocolData(e.data, ctx.config)
      );
    }
    return errorResponse(id, -32603, redactSecrets(e?.message ?? String(e), ctx.config));
  }
}

/** Redact optional JSON-RPC error data without changing its shape. */
function redactProtocolData(data, config) {
  if (data === undefined) return undefined;
  if (typeof data === "string") return redactSecrets(data, config);
  try {
    return JSON.parse(redactSecrets(JSON.stringify(data), config));
  } catch {
    return redactSecrets(String(data), config);
  }
}

/** Marker for a method that is handled but answers nothing. */
const SILENT = Symbol("silent");

async function route(method, params, ctx) {
  if (typeof method !== "string") throw new JsonRpcError(-32600, "invalid request: method must be a string");
  switch (method) {
    case "initialize":
      return initializeResult(params);
    case "notifications/initialized":
    case "notifications/cancelled":
      return SILENT;
    case "ping":
      return {};
    case "tools/list":
      return { tools: toolsFor(ctx.env) };
    case "tools/call":
      return callTool(params?.name, params?.arguments, ctx);
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };
    default:
      throw new JsonRpcError(-32601, `method not found: ${method}`);
  }
}

export function errorResponse(id, code, message, data = undefined) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

/**
 * Parse one line of stdin into a message, or into the response to send back.
 * Batches are not supported: they were removed from the protocol, and accepting
 * them here would mean guessing at ordering semantics nothing sends.
 */
export function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return { skip: true };
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return { error: errorResponse(null, -32700, "parse error: not valid JSON") };
  }
  if (Array.isArray(message)) {
    return { error: errorResponse(null, -32600, "batched requests are not supported") };
  }
  return { message };
}
