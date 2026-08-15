/**
 * Remote MCP over Streamable HTTP — `POST /mcp`.
 *
 * The foundation slice of the hosted-MCP direction (see
 * [`docs/REMOTE_MCP_OAUTH.md`](../docs/REMOTE_MCP_OAUTH.md)). It is deliberately
 * a *bridge*, not the destination:
 *
 *   • **Transport is real.** A client that speaks MCP's Streamable HTTP
 *     transport can connect, `initialize`, list tools and call one.
 *   • **Authentication is a bearer `rtfx_…` token** — the same credential the
 *     stdio plugin reads from `RTFX_API_TOKEN`, presented in an `Authorization`
 *     header instead. It is gated by `requireApiToken`, the identical middleware
 *     that guards `/api/machine/*`, so this endpoint can never be a looser door
 *     into the product than the one that already exists.
 *   • **OAuth is NOT implemented.** There is no authorization server here, no
 *     `/.well-known` metadata, and `claude mcp login rtfx` does not work. A 401
 *     from here carries a plain `WWW-Authenticate: Bearer` challenge and
 *     deliberately no `resource_metadata` parameter, because advertising a
 *     metadata document we do not serve would send every compliant client into a
 *     discovery loop that ends in a 404.
 *
 * ## Why the tool surface is one read-only tool
 *
 * `publish` takes a path on the machine running the *client*. A server-side MCP
 * endpoint has no access to that machine's filesystem — the only disk it could
 * read is its own, which is emphatically not what the caller means. Exposing a
 * remote `publish(path)` would therefore be either a no-op or a server-side file
 * disclosure primitive, so it is absent rather than stubbed. The same reasoning
 * rules out anything that would need to *stream files upward* before the upload
 * semantics for that are designed.
 *
 * `list_artifacts`, `get_versions` and `rollback` have no such problem — they are
 * pure API calls — but they are held back too, on a narrower principle: this
 * endpoint's blast radius should stay at "reports on the credential you already
 * hold" until OAuth decides how a remote credential is minted and scoped. Adding
 * a read tool later is a one-line change to REMOTE_TOOLS plus a scope check;
 * removing one after clients depend on it is not.
 *
 * `update_access` and anything that manages users, tokens or workspaces are
 * absent on the same rule the rest of the machine surface follows — see
 * `denyApiToken` in src/api.ts. They are not merely unlisted here: there is no
 * handler for them at all.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { Env } from "./env";
import { requireApiToken, accountsFor, type AuthVars } from "./auth";
import { isAllowedOrigin } from "./cors";
import { isPlatformAdmin } from "./authz";
import { accountIdsWithAtLeast, MANAGE_ARTIFACTS } from "./accounts";
import { listArtifacts, listArtifactsForCaller } from "./db";
import { firstContentHostname } from "./host";
import { siteOrigin } from "./seo";
import {
  SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOLS,
  errorResponse,
  negotiateProtocol,
  validateToolInput,
  type ToolCallResult,
  type ToolDefinition,
} from "../plugins/rtfx/scripts/rtfx.mcp.lib.mjs";

type Vars = { Bindings: Env; Variables: AuthVars };

/**
 * The one path this module owns. Registered in `MANAGEMENT_PREFIXES`
 * (src/host.ts) so a content host — which serves untrusted uploaded HTML —
 * answers 404 for it, exactly as it does for `/api`.
 */
export const MCP_PATH = "/mcp";

/** JSON-RPC bodies here are a few hundred bytes; this is a guard, not a budget. */
export const MAX_MCP_BODY_BYTES = 256 * 1024;

// --- The remote tool surface -------------------------------------------------

/**
 * Written out as a literal rather than filtered from the stdio server's `TOOLS`.
 * An allow-list that is *derived* grows silently when its source grows; this one
 * cannot gain a tool without somebody editing this array. `test/mcp-http.test.ts`
 * pins that every other tool the stdio server exposes is absent here.
 */
export const REMOTE_TOOLS: ToolDefinition[] = [
  {
    name: "doctor",
    title: "Check this connection",
    description:
      "Report how this remote MCP connection is authenticated and whether the instance answers: the endpoint, where artifacts are served from, the calling token's id (never its secret), the scopes it holds, and which tools this transport exposes. Run it first when a remote call fails. It publishes nothing and changes nothing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

/** Tool names the stdio server has and this transport deliberately does not. */
export const LOCAL_ONLY_TOOLS = TOOLS.map((t) => t.name).filter(
  (name) => !REMOTE_TOOLS.some((remote) => remote.name === name)
);

/**
 * Shown to the model at connect time. It has one job beyond describing `doctor`:
 * tell an agent that reached for a remote `publish` where publishing actually
 * lives, so it redirects instead of retrying.
 */
export const HTTP_INSTRUCTIONS = `Remote diagnostics for rtfx.pro, over HTTP.

This endpoint is the FOUNDATION of rtfx's hosted MCP server, not its publishing surface. It exposes
one tool, "doctor", which reports how the calling credential is configured and whether this instance
answers.

Publishing is deliberately absent here, and adding it is not a matter of enabling a flag: "publish"
takes a path on the machine running the client, and this server cannot read that machine's disk. To
publish, use the local rtfx plugin (/plugin marketplace add yogevgab/artifacts-server, then
/plugin install rtfx@rtfx), which runs beside your files and speaks the same protocol over stdio.

Authentication is an "Authorization: Bearer <rtfx token>" header, using a token minted at
/admin/integrations. OAuth browser sign-in ("claude mcp login") is not implemented yet.`;

// --- Cross-origin policy -----------------------------------------------------

/** The only methods this endpoint implements. */
export const MCP_ALLOWED_METHODS = "POST, OPTIONS";

/**
 * `MCP-Protocol-Version` is sent by clients from revision 2025-06-18 onward;
 * `Accept` is on the list because MCP clients send `application/json,
 * text/event-stream`, which is not a CORS-safelisted value. Nothing else is
 * permitted, so a novel header cannot be smuggled past the preflight.
 */
export const MCP_ALLOWED_HEADERS = "Authorization, Content-Type, Accept, MCP-Protocol-Version";

export const MCP_PREFLIGHT_MAX_AGE = "600";

/**
 * Preflight, plus DNS-rebinding protection.
 *
 * Mounted before the gate for the reason `apiCors` is (see src/cors.ts): a
 * preflight carries no credentials by definition, so authenticating one refuses
 * a request that would have been authorized.
 *
 * The second half is what the MCP specification asks every local/remote HTTP
 * server to do — validate `Origin`. A request that carries an `Origin` we do not
 * recognize is refused outright rather than merely denied CORS headers: the
 * credential here is a bearer token, which a browser never attaches on its own,
 * so an `Origin` we do not know means a page we do not control is driving the
 * request and there is nothing to gain by answering it. A request with *no*
 * `Origin` — Claude Code, curl, any non-browser client — is the ordinary case
 * and is untouched.
 *
 * `isAllowedOrigin` is shared with `/api`, which means a content host can never
 * be an allowed origin here either (see `appOrigins`), and `*` is never emitted.
 */
export const mcpCors: MiddlewareHandler<Vars> = async (c, next) => {
  const origin = c.req.header("Origin");
  const allowed = isAllowedOrigin(c.env, c.req.url, origin);

  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...(allowed
          ? {
              "Access-Control-Allow-Origin": origin!,
              "Access-Control-Allow-Credentials": "true",
            }
          : {}),
        "Access-Control-Allow-Methods": MCP_ALLOWED_METHODS,
        "Access-Control-Allow-Headers": MCP_ALLOWED_HEADERS,
        "Access-Control-Max-Age": MCP_PREFLIGHT_MAX_AGE,
        Vary: "Origin",
      },
    });
  }

  if (origin && !allowed) {
    return c.json(
      {
        error: "forbidden_origin",
        detail: "this MCP endpoint does not accept requests from that origin",
      },
      403,
      { Vary: "Origin" }
    );
  }

  await next();

  if (allowed) {
    c.res.headers.set("Access-Control-Allow-Origin", origin!);
    c.res.headers.set("Access-Control-Allow-Credentials", "true");
  }
  if (origin) c.res.headers.append("Vary", "Origin");
};

// --- Reading the request -----------------------------------------------------

/**
 * The body, or null if it is over `maxBytes`.
 *
 * A declared `Content-Length` can be absent, wrong or a lie (chunked encoding, a
 * misbehaving proxy), so the header check is only a fast path and the real cap is
 * counted against bytes actually read — the same rule `/api/artifacts` follows
 * for uploads.
 */
async function readLimited(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return "";

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    seen += value.byteLength;
    if (seen > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(seen);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

// --- The tool itself ---------------------------------------------------------

/**
 * A tool result in the shape the stdio server produces: a line a person can
 * read, then the same facts as JSON for the model. Kept identical so a client
 * that already parses rtfx tool results does not need a second code path.
 */
function result(summaryLines: string[], data: Record<string, unknown>): ToolCallResult {
  return {
    content: [
      { type: "text", text: summaryLines.filter(Boolean).join("\n") },
      { type: "text", text: JSON.stringify({ ok: true, ...data }, null, 2) },
    ],
  };
}

/**
 * The remote `doctor`.
 *
 * Reports the token's **id**, which is what the dashboard lists and what
 * revoking it takes, and is useless for authenticating. The secret is never in
 * scope here at all: `requireApiToken` resolved it to a row before this ran, and
 * the only thing carried forward is `identity.token.id`.
 *
 * `artifact_count` is the end-to-end reachability proof — it exercises D1 with
 * the caller's real authorization — so it is only attempted for a token holding
 * the `read` scope, and reported as null otherwise. It repeats the visibility
 * rule from `GET /api/artifacts` rather than inventing a second one.
 */
async function doctor(c: Context<Vars>): Promise<ToolCallResult> {
  const identity = c.get("identity");
  const token = identity.token!;
  const endpoint = siteOrigin(c.env);
  const url = new URL(c.req.url);
  const contentBase = `${url.protocol}//${firstContentHostname(c.env) ?? url.host}`;

  let artifactCount: number | null = null;
  if (token.scopes.includes("read")) {
    const rows = isPlatformAdmin(identity)
      ? await listArtifacts(c.env)
      : await listArtifactsForCaller(
          c.env,
          identity.email,
          accountIdsWithAtLeast((await accountsFor(c)).roles, MANAGE_ARTIFACTS)
        );
    artifactCount = rows.length;
  }

  const facts = {
    command: "doctor",
    transport: "http",
    endpoint,
    content_base: contentBase,
    /** Presentation only — the id, never the secret. */
    token: `rtfx_${token.id}_…`,
    token_id: token.id,
    scopes: token.scopes,
    is_admin: identity.isAdmin,
    account_id: identity.accountId ?? null,
    auth: "bearer_token",
    /** Stated as a fact rather than omitted, so a client stops looking for it. */
    oauth: "not_implemented",
    tools: REMOTE_TOOLS.map((t) => t.name),
    publish_supported: false,
    local_only_tools: LOCAL_ONLY_TOOLS,
    reachable: true,
    artifact_count: artifactCount,
  };

  return result(
    [
      `endpoint  ${facts.endpoint}`,
      `content   ${facts.content_base}`,
      `token     ${facts.token}  (scopes: ${facts.scopes.join(", ") || "none"})`,
      `transport http (remote) — bearer token; OAuth sign-in is not implemented`,
      `tools     ${facts.tools.join(", ")}`,
      `publish   not available over HTTP — use the local rtfx plugin, which can read your files`,
      artifactCount === null
        ? `api       ok — this token has no "read" scope, so nothing was listed`
        : `api       ok — ${artifactCount} artifact(s) visible to this token`,
    ],
    facts
  );
}

// --- JSON-RPC ----------------------------------------------------------------

/** A JSON-RPC error carried out of `route` without an HTTP status of its own. */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * Why a tool this transport does not have is missing, in words the model can act
 * on. A tool that exists locally gets the real reason and the alternative; an
 * invented name gets the available list.
 */
function unknownToolMessage(name: unknown): string {
  const available = REMOTE_TOOLS.map((t) => t.name).join(", ");
  if (typeof name === "string" && LOCAL_ONLY_TOOLS.includes(name)) {
    return (
      `tool "${name}" is not available over the remote HTTP transport (available: ${available}). ` +
      `It acts on files on the machine running the client, which this server cannot read — ` +
      `install the rtfx Claude Code plugin, whose stdio MCP server runs beside your files.`
    );
  }
  return `unknown tool "${String(name)}" (available: ${available})`;
}

async function route(c: Context<Vars>, method: unknown, params: any): Promise<unknown> {
  if (typeof method !== "string") {
    throw new RpcError(-32600, "invalid request: method must be a string");
  }
  switch (method) {
    case "initialize":
      return {
        protocolVersion: negotiateProtocol(params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: HTTP_INSTRUCTIONS,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: REMOTE_TOOLS };
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };
    case "tools/call": {
      const name = params?.name;
      const tool = REMOTE_TOOLS.find((t) => t.name === name);
      if (!tool) throw new RpcError(-32602, unknownToolMessage(name));
      // Closed schema: an unknown argument is refused before the handler runs,
      // so a hallucinated `path` on `doctor` is an error rather than an ignored
      // field that makes the call look like it did something with a file.
      const { ok, errors } = validateToolInput(tool, params?.arguments);
      if (!ok) throw new RpcError(-32602, `invalid arguments for "${name}": ${errors.join("; ")}`);
      return doctor(c);
    }
    default:
      throw new RpcError(-32601, `method not found: ${method}`);
  }
}

// --- The route ---------------------------------------------------------------

const JSON_HEADERS = { "Cache-Control": "no-store" };

export const mcpRoutes = new Hono<Vars>();

// Order is load-bearing, and each of these runs before the one after it:
//   1. CORS/preflight and Origin validation — must precede authentication.
//   2. Method check — a GET must answer 405, not the gate's 401.
//   3. The bearer gate, shared verbatim with /api/machine/*.
mcpRoutes.use(MCP_PATH, mcpCors);

mcpRoutes.use(MCP_PATH, async (c, next) => {
  if (c.req.method === "POST") return next();
  return c.json(
    {
      error: "method_not_allowed",
      detail: "this MCP endpoint speaks Streamable HTTP: POST one JSON-RPC message per request. It offers no server-initiated SSE stream and no session to delete.",
    },
    405,
    { Allow: MCP_ALLOWED_METHODS, ...JSON_HEADERS }
  );
});

mcpRoutes.use(MCP_PATH, requireApiToken);

mcpRoutes.post(MCP_PATH, async (c) => {
  // A client that names a protocol revision we do not speak is told so at the
  // HTTP layer, which is where the specification puts it — it is a statement
  // about the connection, not about any one message.
  const declared = c.req.header("MCP-Protocol-Version");
  if (declared && !SUPPORTED_PROTOCOL_VERSIONS.includes(declared)) {
    return c.json(
      {
        error: "unsupported_protocol_version",
        detail: `this server speaks ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
        supported: SUPPORTED_PROTOCOL_VERSIONS,
      },
      400,
      JSON_HEADERS
    );
  }

  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return c.json(
      { error: "unsupported_media_type", detail: "send Content-Type: application/json" },
      415,
      JSON_HEADERS
    );
  }

  const raw = await readLimited(c.req.raw, MAX_MCP_BODY_BYTES);
  if (raw === null) {
    return c.json(
      { error: "payload_too_large", detail: `a JSON-RPC message may not exceed ${MAX_MCP_BODY_BYTES} bytes` },
      413,
      JSON_HEADERS
    );
  }

  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return c.json(errorResponse(null, -32700, "parse error: not valid JSON"), 200, JSON_HEADERS);
  }

  // Batches were removed from the protocol, and accepting them here would mean
  // guessing at ordering semantics nothing sends. Same answer the stdio server
  // gives (`parseLine`), so the two transports cannot disagree.
  if (Array.isArray(message)) {
    return c.json(errorResponse(null, -32600, "batched requests are not supported"), 200, JSON_HEADERS);
  }
  if (!message || typeof message !== "object") {
    return c.json(
      errorResponse(null, -32600, "invalid request: expected a JSON-RPC object"),
      200,
      JSON_HEADERS
    );
  }

  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: any };
  const isNotification = id === undefined || id === null;

  try {
    const value = await route(c, method, params);
    // A notification gets no reply by definition; the transport acknowledges it
    // with 202 and an empty body.
    if (isNotification) return new Response(null, { status: 202, headers: JSON_HEADERS });
    return c.json({ jsonrpc: "2.0", id, result: value }, 200, JSON_HEADERS);
  } catch (e) {
    if (isNotification) return new Response(null, { status: 202, headers: JSON_HEADERS });
    if (e instanceof RpcError) {
      return c.json(errorResponse(id, e.code, e.message), 200, JSON_HEADERS);
    }
    return c.json(
      errorResponse(id, -32603, e instanceof Error ? e.message : String(e)),
      200,
      JSON_HEADERS
    );
  }
});
