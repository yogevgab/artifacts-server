// What actually gets uploaded, and what is refused before it ever leaves the
// machine. This is the single implementation of the bundle safety model: the CLI
// (`rtfx.mjs`) and the MCP server (`rtfx-mcp.mjs`) both go through it, so there
// is exactly one place where "is this file a credential?" is decided.
//
// Like rtfx.lib.mjs, this file has **no `node:` imports**. The filesystem
// arrives as an injected `io` object, which is what lets the artifacts-server
// test suite drive the real walk over a virtual tree inside the Workers pool —
// the pool has no filesystem, and a safety filter that is only exercised by
// hand is a safety filter that regresses.
//
//   io.stat(path)     follows symlinks; used once, on the path handed in
//   io.lstat(path)    does NOT follow; used for every entry of the walk
//   io.readDir(path)  entry names, one segment each
//   io.readFile(path) Uint8Array
//   io.join(a, b)     platform path join
//   io.deflate(bytes) optional raw DEFLATE; stored entries if absent

import {
  MAX_UPLOAD_BYTES,
  INCLUDE,
  SKIP_DIR,
  SKIP_FILE,
  SKIP_SECRET,
  classifyEntry,
  isSensitivePath,
  createZip,
} from "./rtfx.lib.mjs";

/**
 * A refusal a caller can render. `hint` is the actionable half — the CLI prints
 * it under `hint:`, the MCP server returns it in the tool result — and neither
 * ever carries a credential, because nothing here reads one.
 */
export class BundleError extends Error {
  constructor(message, hint = null) {
    super(message);
    this.name = "BundleError";
    this.hint = hint;
  }
}

/** A symlink met during the walk. Never followed — see `collect`. */
export const SKIP_SYMLINK = "skip-symlink";

/** Why a path is missing from the bundle, in words a person can act on. */
export const SKIP_LABEL = {
  [SKIP_DIR]: "build/vcs directory",
  [SKIP_FILE]: "editor or OS file",
  [SKIP_SECRET]: "looks like a credential",
  [SKIP_SYMLINK]: "symbolic link outside the bundle boundary",
};

/**
 * Memory guards, not policy. The 50 MiB cap applies to the *compressed* upload,
 * so a directory is allowed to be bigger than it — but a walk that has already
 * read this much raw data is pointed at the wrong directory, and reading further
 * only buys an out-of-memory crash instead of an error message.
 */
export const MAX_WALK_BYTES = 4 * MAX_UPLOAD_BYTES;
export const MAX_WALK_FILES = 5000;

/** Last path segment, on either separator. */
export function basename(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/** Lowercased extension including the dot, or "" — `.tar.gz` reads as `.gz`. */
export function extname(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/**
 * Walk a directory into `{ "relative/path": bytes }`, reporting what was left
 * out. Skips are surfaced rather than silent: a bundle missing its `.env` is
 * correct, a bundle missing a stylesheet because of an over-eager filter is not,
 * and the only way to tell them apart is to print both.
 *
 * Relative paths are assembled from directory-entry names, never derived from
 * the platform path, so a bundle built on Windows carries the same `a/b.css`
 * keys as one built on macOS.
 *
 * Symlinks are recorded and skipped, never followed. Following one would let a
 * link inside a published folder pull in `~/.ssh/id_rsa` — a path the credential
 * filter would never even see, because the filter reads the *link's* name.
 */
export function collect(dir, io) {
  const out = { files: {}, skipped: [], bytes: 0, count: 0 };
  walk(dir, "", io, out);
  return out;
}

function walk(dir, prefix, io, out) {
  for (const name of io.readDir(dir)) {
    const full = io.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = io.lstat(full);

    if (st.isSymbolicLink()) {
      out.skipped.push({ path: rel, reason: SKIP_SYMLINK });
      continue;
    }
    const verdict = classifyEntry(name, st.isDirectory());
    if (verdict !== INCLUDE) {
      out.skipped.push({ path: rel, reason: verdict });
      continue;
    }
    if (st.isDirectory()) {
      walk(full, rel, io, out);
      continue;
    }

    const bytes = io.readFile(full);
    out.count += 1;
    out.bytes += bytes.length;
    if (out.count > MAX_WALK_FILES) {
      throw new BundleError(`more than ${MAX_WALK_FILES} files under ${dir}`, "Point at the built output directory, not a project or home directory.");
    }
    if (out.bytes > MAX_WALK_BYTES) {
      throw new BundleError(
        `more than ${Math.round(MAX_WALK_BYTES / 1024 / 1024)} MiB of files under ${dir}`,
        "Point at the built output directory, not a project or home directory."
      );
    }
    out.files[rel] = bytes;
  }
}

/**
 * Read the entry names out of a zip's central directory. A prebuilt zip is the
 * one input whose contents the client never chose, so it is read rather than
 * trusted: the names are what `inspectZip` then screens.
 */
export function zipEntryNames(bytes) {
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
    if (nameEnd > bytes.length) throw new BundleError("zip central directory is malformed");
    names.push(dec.decode(bytes.subarray(nameStart, nameEnd)));
    i = nameEnd + extraLen + commentLen - 1;
  }
  if (!names.length) throw new BundleError("zip archive has no readable central directory");
  return names.filter((name) => !name.endsWith("/"));
}

/**
 * Screen a prebuilt zip. Stricter than the directory walk on purpose: an agent
 * is often handed an archive it did not build, so *any* hidden segment is
 * refused outright rather than quietly dropped. Dropping an entry would change
 * what the archive is without telling anyone; refusing sends the person back to
 * the folder, where every skip is reported.
 */
export function inspectZip(bytes) {
  const entries = zipEntryNames(bytes);
  const sensitive = entries.filter(isSensitivePath);
  const hasIndex = entries.includes("index.html") || entries.some((name) => /(^|\/)index\.html$/i.test(name));
  return { entries, sensitive, hasIndex };
}

/**
 * Turn a path into the bytes and form field the API expects, or throw a
 * `BundleError` explaining why not.
 *
 * Returns `{ field, filename, type, bytes, entries, skipped }`, where `field` is
 * `"file"` for a single HTML page and `"bundle"` for a zip.
 */
export function prepareBundle(path, io) {
  let st;
  try {
    st = io.stat(path);
  } catch {
    throw new BundleError(`no such file or directory: ${path}`);
  }

  const prepared = st.isDirectory() ? fromDirectory(path, io) : fromFile(path, io);

  if (prepared.bytes.length > MAX_UPLOAD_BYTES) {
    throw new BundleError(
      `upload is ${(prepared.bytes.length / 1024 / 1024).toFixed(1)} MiB, over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB cap`,
      "Remove large assets, or host them elsewhere and reference them."
    );
  }
  return prepared;
}

function fromDirectory(path, io) {
  const { files, skipped } = collect(path, io);
  if (!Object.keys(files).length) throw new BundleError(`${path} contains no publishable files`);
  if (!files["index.html"]) {
    throw new BundleError(
      `${path} has no index.html at its root`,
      "A multi-file artifact is served from index.html. Point at the built output directory, not the project root."
    );
  }
  const zip = createZip(files, { deflate: io.deflate });
  return {
    field: "bundle",
    filename: "bundle.zip",
    type: "application/zip",
    bytes: zip,
    entries: Object.keys(files).sort(),
    skipped,
  };
}

function fromFile(path, io) {
  const bytes = io.readFile(path);
  const ext = extname(path);

  if (ext === ".zip") {
    const { entries, sensitive, hasIndex } = inspectZip(bytes);
    if (sensitive.length) {
      throw new BundleError(
        `zip contains a hidden, generated or credential-looking path: ${sensitive[0]}`,
        "Unzip it, remove secrets/build directories, and publish the cleaned folder so rtfx can report every skipped file."
      );
    }
    if (!hasIndex) {
      throw new BundleError(
        `${path} has no index.html`,
        "A multi-file artifact is served from index.html. Publish a zip or directory with index.html at its root, or under one common top-level folder."
      );
    }
    return { field: "bundle", filename: basename(path), type: "application/zip", bytes, entries: entries.sort(), skipped: [] };
  }

  if (ext === ".html" || ext === ".htm") {
    return { field: "file", filename: basename(path), type: "text/html", bytes, entries: [basename(path)], skipped: [] };
  }

  // A PDF is a single document rather than a site. The server decides the kind
  // from the leading bytes, not this extension, so a mislabelled file is caught
  // there too — this check exists to fail early with a useful message.
  if (ext === ".pdf") {
    const magic = String.fromCharCode(...bytes.slice(0, 4));
    if (magic !== "%PDF") {
      throw new BundleError(
        `${path} is named .pdf but does not start with %PDF`,
        "Check the file — publishing it would be refused by the server anyway."
      );
    }
    return { field: "file", filename: basename(path), type: "application/pdf", bytes, entries: [basename(path)], skipped: [] };
  }

  throw new BundleError(
    `unsupported file type "${ext || basename(path)}"`,
    "Publish a .html file, a .pdf, a .zip, or a directory containing index.html."
  );
}

/** One line per path left out of a bundle, for a human-readable report. */
export function describeSkips(skipped) {
  return skipped.map((s) => `${s.path}  (${SKIP_LABEL[s.reason] ?? s.reason})`);
}
