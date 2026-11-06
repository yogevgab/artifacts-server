export type SkipReason = "skip-dir" | "skip-file" | "skip-secret" | "skip-symlink";

export interface Skip {
  path: string;
  reason: SkipReason | string;
}

/** The filesystem, injected — see the note at the top of rtfx.bundle.mjs. */
export interface BundleIo {
  stat(path: string): { isDirectory(): boolean };
  lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean };
  readDir(path: string): string[];
  readFile(path: string): Uint8Array;
  join(dir: string, name: string): string;
  deflate?: (bytes: Uint8Array) => Uint8Array;
}

export interface PreparedBundle {
  field: "file" | "bundle";
  filename: string;
  type: string;
  bytes: Uint8Array;
  entries: string[];
  skipped: Skip[];
}

export class BundleError extends Error {
  hint: string | null;
}

export const SKIP_SYMLINK: "skip-symlink";
export const SKIP_LABEL: Readonly<Record<string, string>>;
export const MAX_WALK_BYTES: number;
export const MAX_WALK_FILES: number;

export function basename(path: string): string;
export function extname(path: string): string;

export function collect(
  dir: string,
  io: BundleIo
): { files: Record<string, Uint8Array>; skipped: Skip[]; bytes: number; count: number };

export function zipEntryNames(bytes: Uint8Array): string[];

export function inspectZip(bytes: Uint8Array): {
  entries: string[];
  sensitive: string[];
  hasIndex: boolean;
};

export function prepareBundle(path: string, io: BundleIo): PreparedBundle;

export function describeSkips(skipped: Skip[]): string[];
