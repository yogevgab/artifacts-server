// Pure helpers behind the rtfx publisher. No filesystem, no network, no
// dependencies — everything here is a plain function over plain data, so the
// artifacts-server test suite can exercise it inside the Workers pool while the
// plugin itself ships standalone to a machine that has never seen this repo.
//
// Kept deliberately free of `node:` imports: `rtfx.mjs` owns fs/zlib/fetch.

/** Where a plugin publishes when nothing says otherwise. */
export const DEFAULT_ENDPOINT = "https://rtfx.pro";

/** Server-side cap on a single upload (mirrors MAX_UPLOAD_BYTES in src/upload.ts). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Endpoint env vars, in the order they win. */
export const ENDPOINT_VARS = ["ARTIFACTS_URL", "RTFX_URL"];

/** The only credential the plugin requires. */
export const TOKEN_VAR = "RTFX_API_TOKEN";

/**
 * Directories never worth uploading. Skipping them is not cosmetic: an agent
 * pointed at a project root would otherwise try to publish node_modules and get
 * a 413 instead of a page.
 */
export const SKIPPED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".wrangler",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".idea",
  ".vscode",
]);

/** Editor/OS droppings that would otherwise become artifact files. */
export const SKIPPED_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * Files that look like credentials. A published artifact is served to whoever
 * has been granted it, so sweeping a stray `.env` into a bundle is a leak —
 * these are dropped and reported, never uploaded.
 */
export const SECRET_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^\.dev\.vars$/i,
  /^\.npmrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
];

/** What `classifyEntry` decided about one directory entry. */
export const INCLUDE = "include";
export const SKIP_DIR = "skip-dir";
export const SKIP_FILE = "skip-file";
export const SKIP_SECRET = "skip-secret";

/**
 * Decide whether one entry of a directory walk belongs in the bundle.
 * `name` is a single path segment, never a full path.
 */
export function classifyEntry(name, isDirectory) {
  if (isDirectory) return SKIPPED_DIRS.has(name) ? SKIP_DIR : INCLUDE;
  if (SKIPPED_FILES.has(name)) return SKIP_FILE;
  if (SECRET_PATTERNS.some((re) => re.test(name))) return SKIP_SECRET;
  return INCLUDE;
}

/**
 * Decide whether a full artifact-relative path is too risky to upload. This is
 * used for prebuilt zips, where the client sees paths rather than filesystem
 * directory entries. It is intentionally stricter than `classifyEntry`: any
 * dotfile/hidden directory segment is treated as sensitive because agents often
 * receive archives they did not create themselves.
 */
export function isSensitivePath(path) {
  const segments = String(path).split("/").filter(Boolean);
  if (!segments.length) return false;
  for (const segment of segments) {
    if (segment === "__MACOSX") return true;
    if (segment.startsWith(".")) return true;
    const verdict = classifyEntry(segment, false);
    if (verdict === SKIP_SECRET || verdict === SKIP_FILE) return true;
    if (SKIPPED_DIRS.has(segment)) return true;
  }
  return false;
}

/**
 * Resolve the instance URL from the environment. `ARTIFACTS_URL` is the name the
 * repo CLI already uses and wins; `RTFX_URL` is accepted as an alias so a person
 * who only ever saw rtfx.pro branding guesses right.
 */
export function resolveEndpoint(env = {}) {
  const raw = ENDPOINT_VARS.map((k) => env[k]).find((v) => typeof v === "string" && v.trim()) ?? DEFAULT_ENDPOINT;
  const trimmed = String(raw).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${ENDPOINT_VARS[0]} is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${ENDPOINT_VARS[0]} must be http(s), got ${parsed.protocol}`);
  }
  return trimmed;
}

/**
 * A token reads `rtfx_<id>_<secret>`. Only the id is ever safe to display — it
 * is what `artifacts tokens` lists and what `token-revoke` takes — so this
 * returns the id alone and callers print `rtfx_<id>_…`.
 */
export function tokenId(token) {
  if (typeof token !== "string") return null;
  const m = /^rtfx_([a-z0-9]+)_/i.exec(token.trim());
  return m ? m[1] : null;
}

/** A printable form of a token that cannot be used to authenticate. */
export function redactToken(token) {
  const id = tokenId(token);
  return id ? `rtfx_${id}_…` : "(unrecognised token format)";
}

/**
 * Full credential/endpoint resolution. Cloudflare Access service-token headers
 * are optional pass-through, for instances that still gate `/api` at the edge
 * (the production posture described in docs/HERMES_CLOUD.md §2). They are *not*
 * a Cloudflare management token and grant nothing inside the app — the bearer
 * token alone decides identity and scope.
 */
export function resolveConfig(env = {}) {
  const endpoint = resolveEndpoint(env);
  const token = typeof env[TOKEN_VAR] === "string" ? env[TOKEN_VAR].trim() : "";
  const accessId = (env.CF_ACCESS_CLIENT_ID ?? "").trim();
  const accessSecret = (env.CF_ACCESS_CLIENT_SECRET ?? "").trim();
  const access = accessId && accessSecret ? { id: accessId, secret: accessSecret } : null;
  return { endpoint, token, access, hasToken: Boolean(token) };
}

/** Request headers for a resolved config. Never logged. */
export function authHeaders(config) {
  const headers = {};
  if (config.access) {
    headers["CF-Access-Client-Id"] = config.access.id;
    headers["CF-Access-Client-Secret"] = config.access.secret;
  }
  if (config.token) headers["Authorization"] = `Bearer ${config.token}`;
  return headers;
}

/** Join an endpoint and an API path without doubling or dropping slashes. */
export function apiUrl(endpoint, path) {
  return `${endpoint.replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

/**
 * Argument parsing, matching cli/artifacts.mjs so a person moving between the
 * two is never surprised: `--flag value`, plus a fixed set of valueless flags.
 */
export const BOOLEAN_FLAGS = new Set(["json", "help", "dry-run", "overwrite"]);

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) errors.push(`--${key} needs a value`);
    else flags[key] = value;
  }
  return { flags, positional, errors };
}

// --- ZIP ---------------------------------------------------------------------
//
// A multi-file artifact is uploaded as a zip. The repo CLI uses fflate for this;
// the plugin cannot, because it installs on its own with no node_modules, so it
// writes the container itself. Deflate is injected (`node:zlib` in the CLI, any
// raw-deflate function in tests), and an entry falls back to stored whenever
// compression would not actually shrink it.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A fixed DOS timestamp (1 Jan 2020) instead of "now", so publishing the same
 * files twice produces byte-identical bytes. Determinism is worth more here than
 * an mtime nobody reads: it makes "did anything actually change?" answerable.
 */
export const ZIP_DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
export const ZIP_DOS_TIME = 0;

const MAX_ZIP_ENTRIES = 0xffff; // no ZIP64 here; the 50 MiB cap lands first anyway

/**
 * Build a zip from `{ "path/in/zip": Uint8Array }`.
 * `deflate` is optional and must produce a *raw* DEFLATE stream.
 */
export function createZip(files, options = {}) {
  const deflate = typeof options.deflate === "function" ? options.deflate : null;
  const names = Object.keys(files).sort();
  if (!names.length) throw new Error("refusing to build an empty zip");
  if (names.length > MAX_ZIP_ENTRIES) {
    throw new Error(`too many files (${names.length}); the zip format used here holds ${MAX_ZIP_ENTRIES}`);
  }

  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const name of names) {
    const raw = files[name];
    const nameBytes = encoder.encode(name);
    const crc = crc32(raw);

    let method = 0;
    let data = raw;
    if (deflate && raw.length > 0) {
      const packed = deflate(raw);
      if (packed && packed.length < raw.length) {
        method = 8;
        data = packed;
      }
    }

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, method, true);
    lv.setUint16(10, ZIP_DOS_TIME, true);
    lv.setUint16(12, ZIP_DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, method, true);
    cv.setUint16(12, ZIP_DOS_TIME, true);
    cv.setUint16(14, ZIP_DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attributes
    cv.setUint32(38, 0, true); // external attributes
    cv.setUint32(42, offset, true); // local header offset
    cd.set(nameBytes, 46);

    parts.push(local, data);
    central.push(cd);
    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory
  ev.setUint16(4, 0, true); // this disk
  ev.setUint16(6, 0, true); // disk with central directory
  ev.setUint16(8, names.length, true);
  ev.setUint16(10, names.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true); // comment length

  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let cursor = 0;
  for (const chunk of all) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

// --- Outcomes ----------------------------------------------------------------

/**
 * Turn an API failure into something an agent can act on. The mapping mirrors
 * the error table in docs/HERMES_CLOUD.md §6; the point of `retryable` is that
 * an agent should stop rather than loop on an unfixable credential.
 */
export function describeApiError(status, body = {}) {
  const error = body.error ?? "";
  const detail = body.detail ?? "";
  const base = { status, error, detail, retryable: false };
  switch (true) {
    case status === 401:
      return { ...base, hint: `${TOKEN_VAR} is unknown, revoked or expired — mint a new token; retrying will not help.` };
    case status === 403 && error === "insufficient_scope":
      return { ...base, hint: "The token lacks the scope for this call. Publishing needs `publish`; access changes need `manage`." };
    case status === 403 && error === "account_disabled":
      return { ...base, hint: "The account this token acts as has been paused. Ask an admin to re-enable it." };
    case status === 403:
      return { ...base, hint: "Refused. Managing people or tokens needs a browser login, not an API token. If the instance gates /api behind Cloudflare Access, also set CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET." };
    case status === 404:
      return { ...base, hint: "That slug does not exist, or is not yours. Run `list` to see what this token can reach." };
    case status === 409:
      return { ...base, hint: "Somebody else owns that slug. Pick a different one — republishing cannot take it over." };
    case status === 413:
      return { ...base, hint: `The upload is over the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MiB cap. Drop large assets or publish a smaller bundle.` };
    case status === 400:
      return { ...base, hint: "Bad request — a new artifact needs --title, and a slug must be lowercase letters, digits and hyphens." };
    case status >= 500:
      return { ...base, retryable: true, hint: "The server failed. Retry once; if it persists it is not a client problem." };
    default:
      return { ...base, hint: "Unexpected response — see detail." };
  }
}

/** The line every publish exists to produce. */
export function publishSummary(data) {
  const files = data.file_count === 1 ? "1 file" : `${data.file_count} files`;
  return `published ${data.slug} v${data.version} (${data.type}, ${files})\n${data.url}`;
}
