import type { PreparedBundle } from "./rtfx.bundle.d.mts";
import type { RtfxConfig } from "./rtfx.lib.d.mts";
import type { OAuthCredential } from "./rtfx.oauth.lib.d.mts";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  /** Present only on the internal TOOLS list; stripped by `toolsFor`. */
  requiresEnv?: string;
}

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolCallResult {
  content: ToolContent[];
  isError?: boolean;
}

export const SERVER_INFO: { name: string; title: string; version: string };
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[];
export const LATEST_PROTOCOL_VERSION: string;
export const ACCESS_TOOL_VAR: string;
export const INSTRUCTIONS: string;
export const TOOLS: readonly ToolDefinition[];

export function toolsFor(env?: Record<string, string | undefined>): ToolDefinition[];
export function findTool(name: string, env?: Record<string, string | undefined>): ToolDefinition | null;

export function validateToolInput(
  tool: ToolDefinition,
  args: unknown
): { ok: boolean; errors: string[]; value: Record<string, unknown> };

export function redactSecrets(text: unknown, config?: RtfxConfig | null): string;

export class ToolError extends Error {
  detail: string | null;
  hint: string | null;
  retryable: boolean;
  status: number | null;
  constructor(message: string, extra?: { detail?: string; hint?: string; retryable?: boolean; status?: number });
}

export class JsonRpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown);
}

export interface McpContext {
  env: Record<string, string | undefined>;
  config: RtfxConfig;
  fetchImpl: typeof fetch;
  prepareBundle: (path: string) => PreparedBundle;
  FileImpl?: typeof File;
  node: string | null;
  credentials?: {
    read: (issuer: string) => OAuthCredential | null;
    write: (issuer: string, credential: OAuthCredential) => unknown;
  } | null;
  now?: () => number;
}

export function createContext(options: {
  env?: Record<string, string | undefined>;
  fetch: typeof fetch;
  prepareBundle: (path: string) => PreparedBundle;
  File?: typeof File;
  node?: string | null;
  credentials?: {
    read: (issuer: string) => OAuthCredential | null;
    write: (issuer: string, credential: OAuthCredential) => unknown;
  } | null;
  now?: () => number;
}): McpContext;

export function resolveRuntimeConfig(ctx: McpContext): Promise<RtfxConfig>;

export function toolResult(
  summaryLines: string | string[],
  data: Record<string, unknown>,
  config?: RtfxConfig | null
): ToolCallResult;

export function toolFailure(error: ToolError, config?: RtfxConfig | null): ToolCallResult;

export function describeEnv(ctx: McpContext): {
  endpoint: string;
  endpoint_default: boolean;
  token_set: boolean;
  token: string | null;
  credential_source: string;
  oauth: ReturnType<typeof import("./rtfx.oauth.lib.d.mts").describeCredential> | null;
  access_headers: boolean;
  access_tool_enabled: boolean;
  cloudflare_management_token: string;
  node: string | null;
  max_upload_bytes: number;
  tools: string[];
};

export function callTool(name: string, args: unknown, ctx: McpContext): Promise<ToolCallResult>;

export function negotiateProtocol(requested: unknown): string;

export function initializeResult(params?: Record<string, unknown>): {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: { name: string; title: string; version: string };
  instructions: string;
};

export function handleMessage(
  message: unknown,
  ctx: McpContext
): Promise<Record<string, any> | null>;

export function errorResponse(
  id: unknown,
  code: number,
  message: string,
  data?: unknown
): { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string; data?: unknown } };

export function parseLine(line: string): {
  skip?: boolean;
  error?: ReturnType<typeof errorResponse>;
  message?: Record<string, any>;
};
