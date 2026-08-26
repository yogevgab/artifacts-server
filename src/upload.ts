import { Unzip, UnzipInflate, type UnzipFile, type FlateError } from "fflate";
// The single definition of "this filename looks like a credential", shared with
// the CLI and the stdio plugin (plugins/rtfx/scripts/rtfx.lib.mjs). A second
// copy here would be a second thing to keep in step, and the failure mode of
// drift is a leaked `.env` — so the server imports the same list rather than
// restating it.
import { isSensitivePath } from "../plugins/rtfx/scripts/rtfx.lib.mjs";

export type UploadFile = { path: string; bytes: Uint8Array };

export class UploadError extends Error {}

export interface ProcessedUpload {
  files: UploadFile[];
  entry: string;
  type: "single" | "bundle" | "pdf";
}

/**
 * What was actually uploaded, decided by the bytes rather than the filename.
 *
 * A filename is a claim by the uploader; magic bytes are a fact. Trusting the
 * extension would let `evil.pdf` contain HTML that then renders as a document
 * with our chrome around it.
 */
export type UploadKind = "pdf" | "html" | "zip" | "unknown";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const ZIP_MAGIC = [0x50, 0x4b]; // PK

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

export function sniffKind(_name: string, bytes: Uint8Array): UploadKind {
  if (startsWith(bytes, PDF_MAGIC)) return "pdf";
  if (startsWith(bytes, ZIP_MAGIC)) return "zip";
  // Not magic-byte detectable, so fall back to a cheap structural check on the
  // leading non-whitespace character. Good enough: HTML is the default anyway.
  const head = new TextDecoder().decode(bytes.slice(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<")) return "html";
  return "unknown";
}

/**
 * Wrap a PDF as an artifact. Stored under a fixed entry name so the viewer
 * always knows where to point, regardless of what the file was called.
 */
export function singlePdf(bytes: Uint8Array): ProcessedUpload {
  if (!startsWith(bytes, PDF_MAGIC)) {
    throw new UploadError("that file is not a PDF (it does not start with %PDF)");
  }
  return { files: [{ path: "document.pdf", bytes }], entry: "document.pdf", type: "pdf" };
}

/** Max size (bytes) of the raw upload as received (compressed .zip or a single .html), checked before reading the request body. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB

export interface ZipLimits {
  /** Max number of file entries a bundle may contain. */
  maxEntries: number;
  /** Max decompressed size of any single file. */
  maxFileBytes: number;
  /** Max total decompressed size of all files combined (zip-bomb guard). */
  maxTotalBytes: number;
}

const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 5000,
  maxFileBytes: 50 * 1024 * 1024, // 50 MiB
  maxTotalBytes: 200 * 1024 * 1024, // 200 MiB
};

// R2 object keys are capped at 1024 UTF-8 bytes; leave headroom for the
// "<slug>/v<version>/" prefix we store files under.
const MAX_PATH_BYTES = 900;

// Number of raw (still-compressed) zip bytes fed into the streaming unzipper
// per push() call. fflate's sync Inflate decompresses whatever input it's
// handed in a single call before yielding output, so this bounds how much
// decompressed data any one call can produce before we get a chance to check
// it against the size limits below — it caps the damage a single call can do
// instead of letting one entry inflate unboundedly before we notice.
const UNZIP_FEED_CHUNK_BYTES = 64 * 1024;

/** Wrap a single HTML file as an artifact whose entry is index.html. */
export function singleHtml(bytes: Uint8Array): ProcessedUpload {
  return { files: [{ path: "index.html", bytes }], entry: "index.html", type: "single" };
}

/**
 * Normalize a zip entry path to a safe, relative, "/"-joined path, or return
 * null if it's unsafe (absolute, traversal, contains a null/control byte,
 * backslashes, or is too long for an R2 key).
 */
export function normalizeEntryPath(path: string): string | null {
  if (!path || path.length > MAX_PATH_BYTES) return null;
  if (path.includes("\\")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(path)) return null;
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return null; // POSIX or Windows absolute

  const segments: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null; // traversal
    segments.push(seg);
  }
  if (segments.length === 0) return null;

  const normalized = segments.join("/");
  if (new TextEncoder().encode(normalized).length > MAX_PATH_BYTES) return null;
  return normalized;
}

/**
 * Unzip a bundle. Strips a single common top-level directory if the archive is
 * nested (e.g. "site/index.html" -> "index.html"). Requires a root index.html.
 *
 * Entry-count and decompressed-size limits are enforced against the ACTUAL
 * bytes fflate decompresses, never against the zip's own declared size
 * (local/central-directory `originalSize`) — that value is attacker-
 * controlled and can lie, e.g. declare a few bytes while the deflate stream
 * it points at actually inflates to gigabytes. We drive fflate's streaming
 * `Unzip`/`UnzipInflate` API ourselves, feeding the raw zip in bounded
 * chunks (see UNZIP_FEED_CHUNK_BYTES) so we observe real output incrementally
 * and can abort mid-decompression the moment it crosses a limit, instead of
 * only finding out after the whole (possibly bomb-like) entry is inflated.
 */
export function processZip(buf: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ProcessedUpload {
  let entryCount = 0;
  let totalBytes = 0;
  let violation: string | null = null;
  let files: UploadFile[] = [];

  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file: UnzipFile) => {
    if (violation) return; // already rejected; don't bother decompressing anything else
    const name = file.name;
    if (name.endsWith("/")) return; // directory entries carry no content

    // Traversal/absolute/unsafe paths are always explicitly rejected — checked
    // before the hidden-file heuristic below so a path like "a/../../evil"
    // can't slip through by also matching the "hidden dotfile" pattern.
    const path = normalizeEntryPath(name);
    if (path === null) {
      violation = `Unsafe or invalid file path in archive: "${name}"`;
      return;
    }

    // Hygiene: skip macOS resource forks and hidden files/dirs (e.g. ".git/" or
    // a root `.env`). Root dotfiles must be treated the same as nested dotfiles:
    // agents often publish archives they did not assemble themselves.
    if (path.split("/").some((seg) => seg === "__MACOSX" || seg.startsWith("."))) return;

    entryCount++;
    if (entryCount > limits.maxEntries) {
      violation = `Zip archive has too many files (max ${limits.maxEntries})`;
      return;
    }

    let fileBytes = 0;
    const chunks: Uint8Array[] = [];
    file.ondata = (err: FlateError | null, chunk: Uint8Array | null, final: boolean) => {
      if (violation) return;
      if (err) {
        violation = `Failed to decompress "${name}": ${err.message}`;
        return;
      }
      if (chunk && chunk.length) {
        fileBytes += chunk.length;
        totalBytes += chunk.length;
        // Checked against real decompressed output as it streams in, so a
        // forged/absent declared size can't buy an entry a free pass.
        if (fileBytes > limits.maxFileBytes) {
          violation = `File "${name}" exceeds the max decompressed size of ${limits.maxFileBytes} bytes`;
          return;
        }
        if (totalBytes > limits.maxTotalBytes) {
          violation = `Zip archive exceeds the max total decompressed size of ${limits.maxTotalBytes} bytes`;
          return;
        }
        chunks.push(chunk);
      }
      if (final && !violation) {
        const bytes = new Uint8Array(fileBytes);
        let offset = 0;
        for (const c of chunks) {
          bytes.set(c, offset);
          offset += c.length;
        }
        files.push({ path, bytes });
      }
    };
    file.start();
  };

  // Feed the archive in bounded chunks rather than all at once, and stop
  // feeding the instant a violation is recorded, so a hostile entry can only
  // ever produce a little more than one chunk's worth of decompressed output
  // beyond the limit before we bail — not its full (possibly huge) size.
  for (let offset = 0; offset < buf.length && !violation; offset += UNZIP_FEED_CHUNK_BYTES) {
    const end = Math.min(offset + UNZIP_FEED_CHUNK_BYTES, buf.length);
    unzipper.push(buf.subarray(offset, end), end === buf.length);
  }
  if (buf.length === 0) unzipper.push(new Uint8Array(0), true);
  if (violation) throw new UploadError(violation);
  if (files.length === 0) throw new UploadError("Zip archive is empty");

  // Detect a common top-level directory shared by every entry and strip it.
  const topDirs = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  if (topDirs.size === 1 && !topDirs.has("")) {
    const prefix = `${[...topDirs][0]}/`;
    files = files.map((f) => ({ path: f.path.slice(prefix.length), bytes: f.bytes }));
  }

  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) throw new UploadError(`Duplicate file path after normalization: "${f.path}"`);
    seen.add(f.path);
  }

  if (!files.some((f) => f.path === "index.html")) {
    throw new UploadError("Bundle must contain an index.html at its root");
  }
  return { files, entry: "index.html", type: "bundle" };
}


// --- Files supplied inline, as content ---------------------------------------

/**
 * How many files one inline bundle may carry, and how many decoded bytes it may
 * total. Far below the zip limits on purpose: this path exists for a model
 * assembling a small site inside a JSON tool call, not for shipping a build
 * output — every byte here first travelled as base64 inside a JSON-RPC message,
 * and the caller pays for it twice (once in tokens, once in memory).
 */
export const MAX_INLINE_FILES = 50;
export const MAX_INLINE_BYTES = 5 * 1024 * 1024; // 5 MiB decoded, across all files

/**
 * Turn an explicit list of `{ path, bytes }` into a bundle.
 *
 * Deliberately stricter than {@link processZip} on two points, because the two
 * have different provenance. A zip is usually something the caller *found* —
 * so stray dotfiles and macOS forks are silently dropped, and a nested top
 * directory is stripped, because refusing would punish somebody for an archive
 * they did not assemble. This list is something the caller *wrote*, one path at
 * a time, in the request itself: silently dropping an entry from it would make
 * the result a lie about what was published, and there is no such thing as an
 * accidental `.env` in a hand-authored array. So every rejection here is loud.
 */
export function processFiles(files: UploadFile[]): ProcessedUpload {
  if (files.length === 0) throw new UploadError("no files were supplied");
  if (files.length > MAX_INLINE_FILES) {
    throw new UploadError(`too many files (${files.length}); at most ${MAX_INLINE_FILES} may be sent inline`);
  }

  const out: UploadFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const file of files) {
    const path = normalizeEntryPath(file.path);
    if (path === null) {
      throw new UploadError(`unsafe or invalid file path: "${file.path}"`);
    }
    // Refused, not dropped: see the note above. `isSensitivePath` also covers
    // any dot-prefixed segment, `__MACOSX`, and build/VCS directories.
    if (isSensitivePath(path)) {
      throw new UploadError(
        `refusing to publish "${path}": it looks like a credential, a hidden file, or a build/VCS directory`
      );
    }
    if (seen.has(path)) throw new UploadError(`duplicate file path: "${path}"`);
    seen.add(path);

    totalBytes += file.bytes.byteLength;
    if (totalBytes > MAX_INLINE_BYTES) {
      throw new UploadError(`inline files exceed the max total size of ${MAX_INLINE_BYTES} bytes`);
    }
    out.push({ path, bytes: file.bytes });
  }

  if (!out.some((f) => f.path === "index.html")) {
    throw new UploadError(
      'a multi-file artifact must include a file whose path is exactly "index.html" (no leading directory)'
    );
  }
  return { files: out, entry: "index.html", type: "bundle" };
}
