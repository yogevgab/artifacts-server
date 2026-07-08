import { unzipSync } from "fflate";

export type UploadFile = { path: string; bytes: Uint8Array };

export class UploadError extends Error {}

export interface ProcessedUpload {
  files: UploadFile[];
  entry: string;
  type: "single" | "bundle";
}

/** Wrap a single HTML file as an artifact whose entry is index.html. */
export function singleHtml(bytes: Uint8Array): ProcessedUpload {
  return { files: [{ path: "index.html", bytes }], entry: "index.html", type: "single" };
}

/**
 * Unzip a bundle. Strips a single common top-level directory if the archive is
 * nested (e.g. "site/index.html" -> "index.html"). Requires a root index.html.
 */
export function processZip(buf: Uint8Array): ProcessedUpload {
  const raw = unzipSync(buf);
  // Keep only real files (skip directory entries, which have empty contents and trailing slash).
  let files: UploadFile[] = Object.entries(raw)
    .filter(([name]) => !name.endsWith("/") && !name.startsWith("__MACOSX/") && !name.includes("/."))
    .map(([path, bytes]) => ({ path, bytes }));
  if (files.length === 0) throw new UploadError("Zip archive is empty");

  // Detect a common top-level directory shared by every entry and strip it.
  const topDirs = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  if (topDirs.size === 1 && !topDirs.has("")) {
    const prefix = `${[...topDirs][0]}/`;
    files = files.map((f) => ({ path: f.path.slice(prefix.length), bytes: f.bytes }));
  }
  if (!files.some((f) => f.path === "index.html")) {
    throw new UploadError("Bundle must contain an index.html at its root");
  }
  return { files, entry: "index.html", type: "bundle" };
}
