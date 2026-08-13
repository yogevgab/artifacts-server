import { Unzip, UnzipInflate, type UnzipFile, type FlateError } from "fflate";

export type UploadFile = { path: string; bytes: Uint8Array };

export class UploadError extends Error {}

export interface ProcessedUpload {
  files: UploadFile[];
  entry: string;
  type: "single" | "bundle";
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
function normalizeEntryPath(path: string): string | null {
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
