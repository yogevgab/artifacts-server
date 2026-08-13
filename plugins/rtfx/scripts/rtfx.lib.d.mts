export const DEFAULT_ENDPOINT: string;
export const MAX_UPLOAD_BYTES: number;
export const ENDPOINT_VARS: readonly string[];
export const TOKEN_VAR: string;

export const SKIPPED_DIRS: ReadonlySet<string>;
export const SKIPPED_FILES: ReadonlySet<string>;
export const SECRET_PATTERNS: readonly RegExp[];

export const INCLUDE: "include";
export const SKIP_DIR: "skip-dir";
export const SKIP_FILE: "skip-file";
export const SKIP_SECRET: "skip-secret";

export type EntryVerdict = "include" | "skip-dir" | "skip-file" | "skip-secret";

export function classifyEntry(name: string, isDirectory: boolean): EntryVerdict;
export function isSensitivePath(path: string): boolean;

export function resolveEndpoint(env?: Record<string, string | undefined>): string;
export function tokenId(token: unknown): string | null;
export function redactToken(token: unknown): string;

export interface RtfxConfig {
  endpoint: string;
  token: string;
  access: { id: string; secret: string } | null;
  hasToken: boolean;
}

export function resolveConfig(env?: Record<string, string | undefined>): RtfxConfig;
export function authHeaders(config: RtfxConfig): Record<string, string>;
export function apiUrl(endpoint: string, path: string): string;

export const BOOLEAN_FLAGS: ReadonlySet<string>;

export interface ParsedArgs {
  flags: Record<string, string | true>;
  positional: string[];
  errors: string[];
}

export function parseArgs(argv: string[]): ParsedArgs;

export function crc32(bytes: Uint8Array): number;
export const ZIP_DOS_DATE: number;
export const ZIP_DOS_TIME: number;

export function createZip(
  files: Record<string, Uint8Array>,
  options?: { deflate?: (bytes: Uint8Array) => Uint8Array }
): Uint8Array;

export interface ApiErrorDescription {
  status: number;
  error: string;
  detail: string;
  retryable: boolean;
  hint: string;
}

export function describeApiError(status: number, body?: Record<string, unknown>): ApiErrorDescription;

export function publishSummary(data: {
  slug: string;
  version: number;
  type: string;
  file_count: number;
  url: string;
}): string;
