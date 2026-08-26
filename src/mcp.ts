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
 *   • **OAuth discovery is real.** A 401 from here names an RFC 9728
 *     protected-resource document that this app actually serves
 *     (`PROTECTED_RESOURCE_PATH`, src/oauth-routes.ts), so a compliant client
 *     can discover the authorization server, register itself and run the
 *     authorization-code + PKCE flow. The challenge and the document were added
 *     in the same change, and a test pins that the document answers 200 —
 *     advertising one we did not serve would send every compliant client into a
 *     discovery loop that ends in a 404.
 *
 * ## Why the tool surface is `doctor` and `publish`, and nothing else
 *
 * `publish` was absent from the first slice of this endpoint for a real reason,
 * not caution: the stdio tool takes a *path* on the machine running the client,
 * and a server-side MCP endpoint has no access to that machine's filesystem —
 * the only disk it could read is its own, which is emphatically not what the
 * caller means. A remote `publish(path)` would therefore be either a no-op or a
 * server-side file-disclosure primitive.
 *
 * What changed is the argument, not the appetite. The remote tool takes the
 * *content*: an HTML page as text, a PDF as base64, or a small multi-file site
 * as an explicit list of `{path, content}`. Those bytes came from the caller, so
 * there is nothing to disclose, and `path` (and its synonyms) are refused with
 * an explanation rather than merely being unknown arguments. Everything past
 * decoding is the multipart route's own code — `resolvePublishTarget` and
 * `storeUpload` in src/api.ts — so the two transports cannot drift on quotas,
 * ownership, suspension, versioning or retention.
 *
 * The inline path is deliberately small (see `MAX_INLINE_BYTES`): base64 inside
 * a JSON-RPC message is an expensive way to move a build output, and the local
 * plugin already does that well. This is for what a model just wrote.
 *
 * ## Managing what has been published
 *
 * Publishing is only half of what an agent holding a remote credential needs;
 * the other half is finding, inspecting, re-sharing, rolling back and removing
 * what it published. Those tools have no filesystem problem — they are ordinary
 * API calls — and they are now here: `list_artifacts`, `artifact_details`,
 * `artifact_statistics`, `share_artifact`, `rollback_artifact` and
 * `delete_artifact`.
 *
 * Three rules hold the surface together, and every one of them is pinned by a
 * test in test/mcp-http.test.ts:
 *
 *   • **The allow-list is a literal.** `REMOTE_TOOLS` is written out below, not
 *     filtered from the stdio server's `TOOLS`. A derived allow-list grows
 *     silently when its source grows.
 *   • **Scope is enforced by the handler, never by the advertised list.**
 *     `tools/list` is filtered for the caller's convenience, but a client may
 *     have cached an older list or simply call a name it read in a transcript,
 *     `TOOL_SCOPE` is checked again in `route` before any handler runs. Read
 *     tools take `read`, `publish` takes `publish`, and anything that changes
 *     existing access/live state — rollback included — or removes content takes
 *     `manage`.
 *   • **Reach is the REST surface's reach.** Every tool resolves the artifact
 *     through `manageableArtifact` or `visibleArtifacts` from src/api.ts, so an
 *     artifact the caller cannot manage is indistinguishable from one that does
 *     not exist, and there is no second implementation of that rule to drift.
 *
 * `delete_artifact` additionally takes `confirm_slug`, which must equal `slug`.
 * It is the one irreversible call here, and a model that has confused two slugs
 * gets one more chance to notice before the bytes go.
 *
 * Anything that manages users, tokens or workspaces is still absent, on the
 * same rule the rest of the machine surface follows — see `denyApiToken` in
 * src/api.ts. Those are not merely unlisted here: there is no handler at all.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { Env } from "./env";
import { requireApiToken, type AuthVars, type Identity } from "./auth";
import type { Scope } from "./tokens";
import { isAllowedOrigin } from "./cors";
import { hasScope } from "./authz";
import type { ArtifactRow, VersionRow } from "./env";
import {
  getViews,
  listGrants,
  listVersions,
  setAccess,
  versionCounts,
  viewCounts,
  viewsByVersion,
} from "./db";
import {
  artifactUrl,
  contentBase,
  manageableArtifact,
  normalizeAccessInput,
  purgeArtifact,
  resolvePublishTarget,
  rollbackArtifact,
  storeUpload,
  suspendedDenial,
  visibleArtifacts,
} from "./api";
import {
  processFiles,
  singleHtml,
  singlePdf,
  sniffKind,
  UploadError,
  MAX_INLINE_BYTES,
  MAX_INLINE_FILES,
  type ProcessedUpload,
  type UploadFile,
} from "./upload";
import { siteOrigin } from "./seo";
import { AS_METADATA_PATH, PROTECTED_RESOURCE_PATH } from "./oauth";
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

/**
 * The transport's message cap.
 *
 * It used to be 256 KiB, on the reasoning that every message here was a few
 * hundred bytes. `publish` changed that: its content arrives *inside* the
 * JSON-RPC message, and base64 costs a third on top. The cap is therefore sized
 * from the content limit it has to carry — {@link MAX_INLINE_BYTES} decoded,
 * plus base64 expansion, plus room for JSON escaping and the metadata around it
 * — and not a byte more. It is still a guard rather than a budget: the real
 * limit on what may be published this way is enforced against *decoded* bytes
 * in src/upload.ts, where a lying `Content-Length` cannot reach it.
 *
 * Note what this is not: a raise of the 50 MiB multipart upload limit. Sending
 * megabytes as base64 inside a tool call is expensive for the model and the
 * runtime alike, which is the honest reason the inline path stays small.
 */
export const MAX_MCP_BODY_BYTES = Math.ceil(MAX_INLINE_BYTES * (4 / 3)) + 512 * 1024;

// --- The remote tool surface -------------------------------------------------

/**
 * Written out as a literal rather than filtered from the stdio server's `TOOLS`.
 * An allow-list that is *derived* grows silently when its source grows; this one
 * cannot gain a tool without somebody editing this array. `test/mcp-http.test.ts`
 * pins that every other tool the stdio server exposes is absent here.
 */
/** Same shape the stdio server enforces, so a slug valid there is valid here. */
const REMOTE_SLUG = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
  description:
    'Artifact slug: lowercase letters, digits and single hyphens. This is the address — slug "q3-report" is served at /q3-report/. Omit it on a brand-new artifact to have one derived from the title; pass the existing slug to publish a new version of something you already own.',
} as const;

export const REMOTE_TOOLS: ToolDefinition[] = [
  {
    name: "doctor",
    title: "Check this connection",
    description:
      "Report how this remote MCP connection is authenticated and whether the instance answers: the endpoint, where artifacts are served from, the calling token's id (never its secret), the scopes it holds, and which tools this transport exposes. Run it first when a remote call fails. It publishes nothing and changes nothing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "publish",
    title: "Publish content you send with the call",
    description:
      "Publish an artifact from content carried IN THIS REQUEST, and return its stable URL. " +
      "The bytes travel as arguments to this call — this server runs in Cloudflare's network and " +
      "cannot read the machine your client is running on, so there is deliberately no `path` " +
      "argument and passing one is an error. To publish a folder that exists on disk, install the " +
      "local rtfx plugin, whose stdio server runs beside your files. " +
      "Send EITHER `content_text` or `content_base64` for a single HTML page or PDF, OR `files` for " +
      "a small multi-file site (which must contain a file whose path is exactly \"index.html\"). " +
      "A new slug creates the artifact at v1, private to its owner; publishing again to a slug you " +
      "own appends an immutable version, live at the same URL — so updating something means calling " +
      "this with the SAME slug, never a new one. Read the returned `url`; never assemble it yourself, " +
      "because the content host differs per instance.",
    inputSchema: {
      type: "object",
      properties: {
        slug: REMOTE_SLUG,
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Human-readable title. Required for a brand-new artifact. Omit when adding a version to an existing slug — that keeps the current title.",
        },
        description: { type: "string", maxLength: 500, description: "Optional one-line description shown in the dashboard." },
        note: { type: "string", maxLength: 200, description: "Optional note attached to this version only, e.g. what changed." },
        content_text: {
          type: "string",
          minLength: 1,
          description:
            "The document itself, as text — normally a complete HTML page. Stored as index.html. Use this for anything textual; base64 buys nothing and costs a third more.",
        },
        content_base64: {
          type: "string",
          minLength: 1,
          description:
            "The document itself, base64-encoded. Use for a PDF, or any bytes that are not text. A single HTML page should go in content_text instead.",
        },
        content_type: {
          type: "string",
          enum: ["text/html", "application/pdf"],
          description:
            "Optional declaration of what the bytes are. The bytes themselves decide how they are stored; if this disagrees with them the call is refused rather than guessed at.",
        },
        files: {
          type: "array",
          maxItems: MAX_INLINE_FILES,
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                minLength: 1,
                description:
                  'Artifact-relative path using "/", for example "index.html" or "assets/app.js". One file must be exactly "index.html".',
              },
              content_text: {
                type: "string",
                minLength: 1,
                description: "Text content for this file. Use exactly one of content_text or content_base64.",
              },
              content_base64: {
                type: "string",
                minLength: 1,
                description: "Base64/base64url bytes for this file. Use exactly one of content_text or content_base64.",
              },
            },
            required: ["path"],
            additionalProperties: false,
          },
          description:
            "A multi-file site, as [{path, content_text | content_base64}]. Paths are artifact-relative and must use \"/\" — one of them must be exactly \"index.html\". Credential-looking files, dotfiles and build directories are refused outright, not silently dropped. At most " +
            `${MAX_INLINE_FILES} files and ${Math.round(MAX_INLINE_BYTES / (1024 * 1024))}MB decoded in total; publish a larger build with the local rtfx plugin.`,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "list_artifacts",
    title: "List the artifacts this credential can reach",
    description:
      "List the artifacts this credential can manage — slug, title, URL, type, visibility, live " +
      "version, file count, size and when each was last updated. Use it to find the slug of " +
      "something already published before publishing a new version to it, instead of inventing a " +
      "new slug. Results are newest-first and paginated; pass `offset` from `next_offset` to page. " +
      "It never shows an artifact belonging to somebody else.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "How many artifacts to return (1-100). Defaults to 25. Anything larger is clamped to 100.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "How many artifacts to skip, for paging. Defaults to 0; use `next_offset` from the previous call.",
        },
        query: {
          type: "string",
          maxLength: 100,
          description: "Case-insensitive substring matched against slug, title and description. Omit to list everything.",
        },
        visibility: {
          type: "string",
          enum: ["restricted", "everyone"],
          description: "Only artifacts with this visibility. Omit for both.",
        },
        type: {
          type: "string",
          enum: ["single", "bundle", "pdf"],
          description: "Only artifacts of this kind: a single HTML page, a multi-file site, or a PDF. Omit for all three.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "artifact_details",
    title: "Inspect one artifact",
    description:
      "Everything known about one artifact you can manage: its row, its URL, its full version " +
      "history (marking which version is live and which have expired out of the plan's retention " +
      "window), who it is shared with, and how often it has been opened. Call this before " +
      "rolling back or re-sharing, so the version numbers and the email list you send are the ones " +
      "that actually exist. A slug you cannot manage answers not_found, exactly as if it did not exist.",
    inputSchema: {
      type: "object",
      properties: { slug: REMOTE_SLUG },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "artifact_statistics",
    title: "Counts and totals",
    description:
      "Aggregate numbers. With `slug`, the totals for that one artifact: versions, files, bytes, " +
      "views and how many people it is shared with. Without `slug`, the totals across every " +
      "artifact this credential can reach: how many there are, broken down by visibility and by " +
      "type, plus total versions, files, bytes and views. Use it to answer \"how much have I " +
      "published?\" without paging through list_artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          ...REMOTE_SLUG,
          description:
            "Optional. Statistics for this one artifact. Omit for totals across everything this credential can reach.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "share_artifact",
    title: "Set who can open an artifact",
    description:
      "Replace who may open an artifact: 'restricted' (its owner plus exactly the emails you " +
      "list) or 'everyone' (any signed-in user of this instance). THE EMAIL LIST IS A REPLACEMENT, " +
      "NOT AN ADDITION — send the full list every time, and send [] to revoke everybody. Call " +
      "artifact_details first to read the current list if you mean to add somebody to it. This " +
      "grants access; it does not invite anyone or create an account, so a recipient who cannot " +
      "already sign in to this instance still needs an administrator to invite them. Needs a token " +
      "with the 'manage' scope.",
    inputSchema: {
      type: "object",
      properties: {
        slug: REMOTE_SLUG,
        visibility: {
          type: "string",
          enum: ["restricted", "everyone"],
          description:
            "'restricted' = the owner plus the named emails only. 'everyone' = any signed-in user of this instance.",
        },
        emails: {
          type: "array",
          items: { type: "string" },
          maxItems: 200,
          description:
            "Full replacement list of emails granted access, each containing '@'. Lower-cased and de-duplicated. Ignored when visibility is 'everyone'; pass [] to revoke everyone.",
        },
      },
      required: ["slug", "visibility"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "rollback_artifact",
    title: "Make an earlier version live again",
    description:
      "Point an artifact's URL back at one of its earlier versions. Non-destructive: no version " +
      "is deleted, and rolling forward again is the same call with a higher number. Call " +
      "artifact_details first to see which versions exist and which have expired — an expired " +
      "version's files are gone and cannot be made live. Needs a token with the 'manage' scope, " +
      "because changing the live version is artifact management over an existing URL.",
    inputSchema: {
      type: "object",
      properties: {
        slug: REMOTE_SLUG,
        version: {
          type: "integer",
          minimum: 1,
          description: "Version number to make live, as reported by artifact_details.",
        },
      },
      required: ["slug", "version"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "delete_artifact",
    title: "Delete an artifact permanently",
    description:
      "PERMANENTLY delete an artifact: every version, every stored file, every access grant and " +
      "every share link. This cannot be undone and there is no trash — the URL stops working and " +
      "the bytes are gone. To guard against a confused slug, `confirm_slug` must be given and must " +
      "be exactly equal to `slug`; a mismatch deletes nothing. Ask the person you are working for " +
      "before calling this. Needs a token with the 'manage' scope.",
    inputSchema: {
      type: "object",
      properties: {
        slug: REMOTE_SLUG,
        confirm_slug: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description: "Must be character-for-character identical to `slug`. Anything else refuses the call and deletes nothing.",
        },
      },
      required: ["slug", "confirm_slug"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

/**
 * The scope each remote tool needs. `publish` is listed as well as checked
 * (see `publish` below) because a tool a token can never call is worse than
 * absent: the model spends a turn discovering the refusal, and a refusal is an
 * ambiguous signal — it reads as "this instance is broken" as easily as "this
 * credential is read-only".
 */
const TOOL_SCOPE: Record<string, Scope> = {
  publish: "publish",
  list_artifacts: "read",
  artifact_details: "read",
  artifact_statistics: "read",
  share_artifact: "manage",
  rollback_artifact: "manage",
  delete_artifact: "manage",
};

/**
 * The tools this particular caller may see. A read-only token is shown `doctor`
 * alone, which is exactly the surface this endpoint had before publishing
 * existed. `tools/list` runs after the bearer gate, so the scopes are known by
 * the time it is answered.
 */
export function remoteToolsFor(identity: Identity | null): ToolDefinition[] {
  return REMOTE_TOOLS.filter((tool) => {
    const scope = TOOL_SCOPE[tool.name];
    return !scope || hasScope(identity, scope);
  });
}

/** Tool names the stdio server has and this transport deliberately does not. */
export const LOCAL_ONLY_TOOLS = TOOLS.map((t) => t.name).filter(
  (name) => !REMOTE_TOOLS.some((remote) => remote.name === name)
);

/**
 * Shown to the model at connect time. It has one job beyond describing `doctor`:
 * tell an agent that reached for a remote `publish` where publishing actually
 * lives, so it redirects instead of retrying.
 */
export const HTTP_INSTRUCTIONS = `Publish and manage rtfx.pro artifacts over HTTP.

PUBLISHING HERE MEANS SENDING CONTENT. The "publish" tool takes the bytes as arguments — an HTML
page in "content_text", a PDF in "content_base64", or a small multi-file site in "files" — and
returns the artifact's stable URL. It does NOT take a path: this server runs in Cloudflare's
network and cannot read the machine your client runs on, so a path here would name the server's
disk rather than yours, and is refused. To publish a directory that exists on disk (a build output,
a site you did not author in this conversation), install the local rtfx plugin
(/plugin marketplace add yogevgab/artifacts-server, then /plugin install rtfx@rtfx): its stdio MCP
server runs beside your files and takes a path.

Publishing to a NEW slug creates the artifact at v1, private to its owner. Publishing again to a
slug you own appends an immutable version, live at the same URL — so updating something means
calling publish with the SAME slug, never inventing a new one. Publishing to someone else's slug is
refused with 409. Read the returned URL from the result; never assemble it yourself, because the
content host differs per instance.

Inline content is capped (a few MB, a few dozen files) because every byte travels as base64 inside
a JSON-RPC message. Credential-looking files, dotfiles and build directories are refused outright
rather than silently dropped.

Artifact management is also available here: use "list_artifacts" to find existing work,
"artifact_details" before sharing or rollback, "artifact_statistics" for counts, and — with a
"manage" scoped credential — "share_artifact", "rollback_artifact" and "delete_artifact". Delete is
permanent and requires confirm_slug to equal slug.

"doctor" reports how this connection is authenticated, what it may do, and the exact limits.

Authentication is an "Authorization: Bearer <token>" header, and the token needs the "publish"
scope to publish. The token can be minted by hand at /admin/integrations, or obtained by OAuth:
this server is its own authorization server, advertises RFC 9728 / RFC 8414 discovery metadata, and
supports dynamic client registration with authorization-code + PKCE. Either way the credential is
the same kind of scoped, revocable token.`;

export const HTTP_READ_ONLY_INSTRUCTIONS = `Read rtfx.pro artifact metadata over HTTP.

This credential does not have the "publish" or "manage" scope, so this connection cannot publish,
share, roll back or delete. It can still run "doctor", "list_artifacts", "artifact_details" and
"artifact_statistics" for artifacts this credential can reach.

Remote HTTP publishing is available only to a token with the "publish" scope and only by sending
content in the tool call ("content_text", "content_base64", or "files"). It never takes a filesystem
path: this server runs in Cloudflare's network and cannot read the machine your client runs on. To
publish a directory that exists on disk, install the local rtfx plugin, whose stdio MCP server runs
beside your files.`;

function httpInstructionsFor(identity: Identity | null): string {
  return hasScope(identity, "publish") ? HTTP_INSTRUCTIONS : HTTP_READ_ONLY_INSTRUCTIONS;
}

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
  const contentOrigin = contentBase(c);

  let artifactCount: number | null = null;
  if (token.scopes.includes("read")) {
    artifactCount = (await visibleArtifacts(c)).length;
  }

  const facts = {
    command: "doctor",
    transport: "http",
    endpoint,
    content_base: contentOrigin,
    /** Presentation only — the id, never the secret. */
    token: `rtfx_${token.id}_…`,
    token_id: token.id,
    scopes: token.scopes,
    is_admin: identity.isAdmin,
    account_id: identity.accountId ?? null,
    auth: "bearer_token",
    /**
     * Stated as a fact rather than omitted, so a client knows what it may do.
     * `authorization_code` means the discovery documents below are real and the
     * browser flow works; it does not mean this particular token came from it.
     */
    oauth: "authorization_code",
    oauth_protected_resource: `${endpoint}${PROTECTED_RESOURCE_PATH}`,
    oauth_authorization_server: `${endpoint}${AS_METADATA_PATH}`,
    tools: remoteToolsFor(identity).map((t) => t.name),
    /** The transport can publish. Whether *this* credential may is the next line. */
    publish_supported: true,
    can_publish: token.scopes.includes("publish"),
    /**
     * Stated so a model does not have to infer it from the schema: over HTTP,
     * publishing means sending content. There is no path argument.
     */
    publish_mode: "content",
    max_inline_bytes: MAX_INLINE_BYTES,
    max_inline_files: MAX_INLINE_FILES,
    local_only_tools: LOCAL_ONLY_TOOLS,
    reachable: true,
    artifact_count: artifactCount,
  };

  return result(
    [
      `endpoint  ${facts.endpoint}`,
      `content   ${facts.content_base}`,
      `token     ${facts.token}  (scopes: ${facts.scopes.join(", ") || "none"})`,
      `transport http (remote) — bearer token; OAuth sign-in is available (authorization_code + PKCE)`,
      `tools     ${facts.tools.join(", ")}`,
      facts.can_publish
        ? `publish   available — send content (content_text, content_base64 or files), never a path; ` +
          `up to ${Math.round(MAX_INLINE_BYTES / (1024 * 1024))}MB and ${MAX_INLINE_FILES} files inline. ` +
          `Publish a large build directory with the local rtfx plugin instead.`
        : `publish   this token lacks the "publish" scope, so the publish tool is not offered`,
      artifactCount === null
        ? `api       ok — this token has no "read" scope, so nothing was listed`
        : `api       ok — ${artifactCount} artifact(s) visible to this token`,
    ],
    facts
  );
}

// --- The remote publish tool -------------------------------------------------

/**
 * A refusal the model can act on, returned as an `isError` tool result rather
 * than a JSON-RPC error. The distinction matters: a JSON-RPC error says "this
 * call was malformed", which is a statement about the client, while "your
 * workspace is full" is a statement about the world that the model should read
 * and respond to. MCP asks for the second to come back as a result.
 */
class ToolError extends Error {
  constructor(
    message: string,
    readonly extra: { detail?: string; hint?: string; status?: number; error?: string } = {}
  ) {
    super(message);
  }
}

function failure(e: ToolError): ToolCallResult {
  const payload = {
    ok: false,
    error: e.extra.error ?? e.message,
    ...(e.extra.detail ? { detail: e.extra.detail } : {}),
    ...(e.extra.hint ? { hint: e.extra.hint } : {}),
    ...(e.extra.status ? { status: e.extra.status } : {}),
  };
  const lines = [`error: ${e.message}`];
  if (e.extra.detail && e.extra.detail !== e.message) lines.push(`detail: ${e.extra.detail}`);
  if (e.extra.hint) lines.push(`hint: ${e.extra.hint}`);
  return {
    isError: true,
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "text", text: JSON.stringify(payload, null, 2) },
    ],
  };
}

/**
 * Arguments that only make sense if the server could read the caller's disk.
 * The schema is closed, so any of these would already be refused as an unknown
 * argument — but "unknown argument" is the wrong lesson. A model that sent
 * `path` does not need to be told it misspelled something; it needs to be told
 * that this transport publishes bytes and where the path-shaped tool lives.
 */
const PATH_SHAPED_ARGS = ["path", "file", "file_path", "filepath", "directory", "dir", "folder", "zip"];

function pathRefusal(args: any): string | null {
  if (!args || typeof args !== "object") return null;
  const offending = PATH_SHAPED_ARGS.filter((key) => key in args);
  if (offending.length === 0) return null;
  return (
    `remote publish does not take a filesystem path (${offending.map((k) => `"${k}"`).join(", ")}). ` +
    `This server runs in Cloudflare's network and cannot read the machine your client is running on — ` +
    `a path here would name the SERVER's disk, not yours. Send the content instead, as "content_text", ` +
    `"content_base64" or "files". To publish a directory that exists on disk, install the local rtfx ` +
    `plugin, whose stdio MCP server runs beside your files.`
  );
}

/** Decode base64 (standard or URL alphabet) with an explicit size guard. */
function decodeBase64(value: string, label: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized) throw new ToolError(`${label} is empty`, { error: "empty_content" });
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || /=[^=]/.test(normalized)) {
    throw new ToolError(`${label} is not valid base64`, {
      error: "invalid_base64",
      hint: "send plain text as content_text instead, or base64-encode the bytes properly",
    });
  }
  const remainder = normalized.length % 4;
  if (remainder === 1) {
    throw new ToolError(`${label} is not valid base64`, {
      error: "invalid_base64",
      hint: "base64 length cannot be 1 modulo 4; send padded or unpadded standard/base64url bytes",
    });
  }
  const compact = normalized + (remainder ? "=".repeat(4 - remainder) : "");
  // Checked before `atob` allocates: the decoded length is derivable from the
  // encoded length, so there is no reason to materialize an oversized buffer
  // first and measure it afterwards. Subtract padding for an exact upper bound.
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  const decodedLength = (compact.length / 4) * 3 - padding;
  if (decodedLength > MAX_INLINE_BYTES) {
    throw new ToolError(`${label} exceeds the max inline size of ${MAX_INLINE_BYTES} bytes`, {
      error: "payload_too_large",
    });
  }
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    throw new ToolError(`${label} is not valid base64`, { error: "invalid_base64" });
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function encodeText(value: string, label: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_INLINE_BYTES) {
    throw new ToolError(`${label} exceeds the max inline size of ${MAX_INLINE_BYTES} bytes`);
  }
  return bytes;
}

/**
 * The bytes of one content-carrying object: exactly one of `content_text` or
 * `content_base64`. Both is an error rather than a precedence rule — a model
 * that sent both does not know which one it meant, and picking for it publishes
 * something nobody chose.
 */
function contentBytes(source: any, label: string): Uint8Array {
  const hasText = typeof source?.content_text === "string";
  const hasBase64 = typeof source?.content_base64 === "string";
  if (hasText && hasBase64) {
    throw new ToolError(`${label} has both content_text and content_base64 — send exactly one`);
  }
  if (hasText) return encodeText(source.content_text, `${label} content_text`);
  if (hasBase64) return decodeBase64(source.content_base64, `${label} content_base64`);
  throw new ToolError(`${label} must have either content_text or content_base64`);
}

const FILE_KEYS = new Set(["path", "content_text", "content_base64"]);

/** Validate the `files` array by hand — the schema layer only checks it is an array of objects. */
function inlineFiles(raw: unknown): UploadFile[] {
  const list = raw as any[];
  return list.map((entry, i) => {
    const label = `files[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ToolError(`${label} must be an object with a "path" and content`);
    }
    for (const key of Object.keys(entry)) {
      if (!FILE_KEYS.has(key)) throw new ToolError(`${label} has an unknown key "${key}"`);
    }
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      throw new ToolError(`${label} must have a non-empty "path"`);
    }
    return { path: entry.path, bytes: contentBytes(entry, label) };
  });
}

/** Map the declared `content_type`, when there is one, onto what the bytes say. */
function checkDeclaredType(declared: string | undefined, kind: string): void {
  if (!declared) return;
  if (declared === "application/pdf" && kind === "pdf") return;
  // Plain text/HTML-like content without a leading "<" sniffs as unknown, but
  // the publish pipeline intentionally stores unknown single documents as HTML.
  // A truthful `text/html` declaration should therefore reject only bytes that
  // positively identify as a different kind.
  if (declared === "text/html" && (kind === "html" || kind === "unknown")) return;
  throw new ToolError(
    `content_type says ${declared}, but the bytes are ${kind === "pdf" ? "a PDF" : kind === "zip" ? "a zip archive" : kind === "html" ? "HTML" : "neither HTML nor a PDF"}`,
    { error: "content_type_mismatch", hint: "omit content_type and let the bytes decide, or send the bytes you meant" }
  );
}

/**
 * The remote `publish`.
 *
 * Everything below the content decoding is the *same* code the multipart route
 * runs — `resolvePublishTarget` and `storeUpload` from src/api.ts — so slug
 * rules, ownership, workspace suspension, plan quotas, version numbering,
 * retention and the response shape cannot differ between the two transports.
 * What is genuinely new here is only the front half: how bytes arrive, and what
 * this endpoint refuses to accept as a way of naming them.
 */
async function publish(c: Context<Vars>, args: any): Promise<ToolCallResult> {
  const identity = c.get("identity");
  // Checked here as well as reflected in `tools/list`, because a tool list is
  // advisory: a client may have cached an older one, or simply call a name it
  // read in a transcript. Authorization is never left to what we advertised.
  if (!hasScope(identity, "publish")) {
    return failure(
      new ToolError('this token lacks the "publish" scope', {
        error: "insufficient_scope",
        status: 403,
        hint: "mint a token with the publish scope at /admin/integrations, or sign in again and grant it",
      })
    );
  }

  try {
    const hasFiles = Array.isArray(args?.files);
    const hasSingle = typeof args?.content_text === "string" || typeof args?.content_base64 === "string";
    if (hasFiles && hasSingle) {
      throw new ToolError(
        "send either a single document (content_text/content_base64) or a multi-file site (files), not both"
      );
    }
    if (!hasFiles && !hasSingle) {
      throw new ToolError("nothing to publish", {
        detail:
          'provide "content_text" (an HTML page), "content_base64" (a PDF), or "files" (a multi-file site)',
        hint: "this transport publishes the bytes you send; it cannot read a path on your machine",
      });
    }

    // Metadata first: a caller who cannot publish to this slug at all should
    // learn that before spending anything on decoding megabytes of content.
    const target = await resolvePublishTarget(c, { slug: args?.slug, title: args?.title });
    if (target instanceof Response) throw await responseError(target);

    let processed: ProcessedUpload;
    if (hasFiles) {
      if (args.files.length === 0) throw new ToolError("files is empty");
      processed = processFiles(inlineFiles(args.files));
    } else {
      const bytes = contentBytes(args, "publish");
      const kind = sniffKind("", bytes);
      checkDeclaredType(args?.content_type, kind);
      if (kind === "zip") {
        // Refused rather than unzipped: a zip that reached us as base64 inside
        // a JSON message was assembled by the model, so the multi-file surface
        // it should have used is `files` — which reports every path it takes
        // instead of quietly dropping the ones a zip walk would.
        throw new ToolError("that content is a zip archive, which this transport does not accept", {
          hint: 'send the site as "files": [{path, content_text}], or publish the zip with the local rtfx plugin',
        });
      }
      processed = kind === "pdf" ? singlePdf(bytes) : singleHtml(bytes);
    }

    const res = await storeUpload(c, target, processed, {
      title: args?.title,
      description: args?.description,
      note: args?.note,
    });
    if (!res.ok) throw await responseError(res);

    const data = (await res.json()) as {
      slug: string;
      url: string;
      type: string;
      file_count: number;
      version: number;
    };
    return result(
      [
        `published ${data.slug} v${data.version} (${data.type}, ${data.file_count} file(s))`,
        data.url,
        data.version === 1
          ? "private to you until you share it — set access from the dashboard"
          : "same URL as before; the previous version is still retrievable",
      ],
      { command: "publish", transport: "http", ...data, files: processed.files.map((f) => f.path) }
    );
  } catch (e) {
    if (e instanceof ToolError) return failure(e);
    if (e instanceof UploadError) return failure(new ToolError(e.message, { error: "bad_request" }));
    return failure(new ToolError(e instanceof Error ? e.message : String(e), { error: "internal_error" }));
  }
}

function pageArgs(args: any): { limit: number; offset: number } {
  const rawLimit = Number(args?.limit ?? 25);
  const rawOffset = Number(args?.offset ?? 0);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 25;
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return { limit, offset };
}

function artifactSummary(c: Context<Vars>, row: ArtifactRow): Record<string, unknown> {
  return {
    slug: row.slug,
    title: row.title,
    description: row.description,
    url: artifactUrl(c, row.slug),
    type: row.type,
    visibility: row.visibility,
    current_version: row.current_version,
    file_count: row.file_count,
    size_bytes: row.size_bytes,
    created_by: row.created_by,
    owner_email: row.owner_email,
    account_id: row.account_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function versionSummary(v: VersionRow, current: number): Record<string, unknown> {
  return {
    version: v.version,
    current: v.version === current,
    type: v.type,
    entry: v.entry,
    file_count: v.file_count,
    size_bytes: v.size_bytes,
    note: v.note,
    created_by: v.created_by,
    created_at: v.created_at,
    expired: !!v.expired_at,
    expired_at: v.expired_at,
  };
}

async function listArtifactsTool(c: Context<Vars>, args: any): Promise<ToolCallResult> {
  const { limit, offset } = pageArgs(args);
  const q = typeof args?.query === "string" ? args.query.trim().toLowerCase() : "";
  let rows = await visibleArtifacts(c);
  if (args?.visibility) rows = rows.filter((r) => r.visibility === args.visibility);
  if (args?.type) rows = rows.filter((r) => r.type === args.type);
  if (q) {
    rows = rows.filter((r) =>
      [r.slug, r.title, r.description ?? ""].some((value) => value.toLowerCase().includes(q))
    );
  }
  const total = rows.length;
  const page = rows.slice(offset, offset + limit);
  const views = await viewCounts(c.env);
  const versions = await versionCounts(c.env);
  const artifacts = page.map((row) => ({
    ...artifactSummary(c, row),
    versions: versions.get(row.slug)?.versions ?? 0,
    expired_versions: versions.get(row.slug)?.expired ?? 0,
    views: views.get(row.slug)?.total ?? 0,
    unique_viewers: views.get(row.slug)?.unique ?? 0,
  }));
  const nextOffset = offset + page.length < total ? offset + page.length : null;
  return result(
    [
      `listed ${page.length} of ${total} artifact(s) visible to this token`,
      nextOffset === null ? "end of list" : `next_offset ${nextOffset}`,
    ],
    { command: "list_artifacts", transport: "http", content_base: contentBase(c), limit, offset, next_offset: nextOffset, total, artifacts }
  );
}

async function artifactDetailsTool(c: Context<Vars>, args: any): Promise<ToolCallResult> {
  const slug = String(args?.slug ?? "");
  const art = await manageableArtifact(c, slug);
  if (!art) return failure(new ToolError("artifact not found", { error: "not_found", status: 404 }));
  const [versions, grants, views, perVersion] = await Promise.all([
    listVersions(c.env, slug),
    listGrants(c.env, slug),
    getViews(c.env, slug, 20),
    viewsByVersion(c.env, slug),
  ]);
  return result(
    [
      `${art.slug} — ${art.title}`,
      artifactUrl(c, slug),
      `${versions.length} version(s); current v${art.current_version}; ${views.total} view(s); ${grants.length} explicit grant(s)`,
    ],
    {
      command: "artifact_details",
      transport: "http",
      artifact: artifactSummary(c, art),
      versions: versions.map((v) => versionSummary(v, art.current_version)),
      access: { visibility: art.visibility, emails: grants },
      views: { ...views, by_version: perVersion },
    }
  );
}

function addTotals(totals: Record<string, number>, key: string | null | undefined): void {
  const k = key || "unknown";
  totals[k] = (totals[k] ?? 0) + 1;
}

async function artifactStatisticsTool(c: Context<Vars>, args: any): Promise<ToolCallResult> {
  if (typeof args?.slug === "string" && args.slug.trim()) {
    const slug = args.slug.trim();
    const art = await manageableArtifact(c, slug);
    if (!art) return failure(new ToolError("artifact not found", { error: "not_found", status: 404 }));
    const [versions, grants, views] = await Promise.all([listVersions(c.env, slug), listGrants(c.env, slug), getViews(c.env, slug, 0)]);
    const totals = {
      slug,
      url: artifactUrl(c, slug),
      versions: versions.length,
      expired_versions: versions.filter((v) => v.expired_at).length,
      files: versions.reduce((n, v) => n + v.file_count, 0),
      bytes: versions.reduce((n, v) => n + v.size_bytes, 0),
      live_files: art.file_count,
      live_bytes: art.size_bytes,
      views: views.total,
      unique_viewers: views.unique,
      explicit_grants: grants.length,
      visibility: art.visibility,
      type: art.type,
      updated_at: art.updated_at,
    };
    return result([`${slug}: ${totals.versions} version(s), ${totals.views} view(s), ${totals.bytes} stored byte(s)`], {
      command: "artifact_statistics",
      transport: "http",
      scope: "artifact",
      totals,
    });
  }

  const rows = await visibleArtifacts(c);
  const views = await viewCounts(c.env);
  const versions = await versionCounts(c.env);
  const byVisibility: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let totalVersions = 0;
  let expiredVersions = 0;
  let totalViews = 0;
  let uniqueViewers = 0;
  for (const row of rows) {
    addTotals(byVisibility, row.visibility);
    addTotals(byType, row.type);
    totalVersions += versions.get(row.slug)?.versions ?? 0;
    expiredVersions += versions.get(row.slug)?.expired ?? 0;
    totalViews += views.get(row.slug)?.total ?? 0;
    uniqueViewers += views.get(row.slug)?.unique ?? 0;
  }
  const totals = {
    artifacts: rows.length,
    versions: totalVersions,
    expired_versions: expiredVersions,
    live_files: rows.reduce((n, r) => n + r.file_count, 0),
    live_bytes: rows.reduce((n, r) => n + r.size_bytes, 0),
    views: totalViews,
    unique_viewers: uniqueViewers,
    by_visibility: byVisibility,
    by_type: byType,
    most_recent_update: rows[0]?.updated_at ?? null,
  };
  return result([`${totals.artifacts} artifact(s), ${totals.versions} version(s), ${totals.views} view(s)`], {
    command: "artifact_statistics",
    transport: "http",
    scope: "all_visible",
    totals,
  });
}

async function shareArtifactTool(c: Context<Vars>, args: any): Promise<ToolCallResult> {
  const slug = String(args?.slug ?? "");
  const art = await manageableArtifact(c, slug);
  if (!art) return failure(new ToolError("artifact not found", { error: "not_found", status: 404 }));
  const parsed = normalizeAccessInput({ visibility: args?.visibility, emails: args?.emails });
  if ("error" in parsed) return failure(new ToolError(parsed.error, { error: "bad_request", status: 400 }));
  const emails = parsed.visibility === "everyone" ? [] : parsed.emails;
  await setAccess(c.env, slug, parsed.visibility, emails, new Date().toISOString());
  const grants = await listGrants(c.env, slug);
  return result([`${slug} access set to ${parsed.visibility}`, `${grants.length} explicit grant(s)`], {
    command: "share_artifact",
    transport: "http",
    slug,
    url: artifactUrl(c, slug),
    visibility: parsed.visibility,
    emails: grants,
  });
}

async function rollbackArtifactTool(c: Context<Vars>, args: any): Promise<ToolCallResult> {
  const slug = String(args?.slug ?? "");
  const art = await manageableArtifact(c, slug);
  if (!art) return failure(new ToolError("artifact not found", { error: "not_found", status: 404 }));
  const suspended = await suspendedDenial(c, art.account_id ?? null);
  if (suspended) return failure(await responseError(suspended));
  const version = Number(args?.version);
  if (!Number.isInteger(version) || version < 1) {
    return failure(new ToolError("version must be a positive integer", { error: "bad_request", status: 400 }));
  }
  const rolled = await rollbackArtifact(c.env, slug, version);
  if (!rolled.ok) return failure(new ToolError(rolled.detail, { error: rolled.error, status: rolled.status }));
  return result([`${slug} is now serving v${version}`, artifactUrl(c, slug)], {
    command: "rollback_artifact",
    transport: "http",
    slug,
    current: version,
    url: artifactUrl(c, slug),
  });
}

async function deleteArtifactTool(c: Context<Vars>, args: any): Promise<ToolCallResult> {
  const slug = String(args?.slug ?? "");
  const confirm = String(args?.confirm_slug ?? "");
  if (confirm !== slug) {
    return failure(new ToolError("confirm_slug must exactly match slug; nothing was deleted", {
      error: "confirmation_required",
      status: 400,
    }));
  }
  const art = await manageableArtifact(c, slug);
  if (!art) return failure(new ToolError("artifact not found", { error: "not_found", status: 404 }));
  const removed = await purgeArtifact(c.env, slug);
  return result([`deleted ${slug}`, `${removed.versions} version(s), ${removed.files} file(s), ${removed.bytes} byte(s) removed`], {
    command: "delete_artifact",
    transport: "http",
    deleted: slug,
    ...removed,
  });
}

async function callTool(c: Context<Vars>, name: string, args: any): Promise<ToolCallResult> {
  switch (name) {
    case "doctor":
      return doctor(c);
    case "publish":
      return publish(c, args ?? {});
    case "list_artifacts":
      return listArtifactsTool(c, args ?? {});
    case "artifact_details":
      return artifactDetailsTool(c, args ?? {});
    case "artifact_statistics":
      return artifactStatisticsTool(c, args ?? {});
    case "share_artifact":
      return shareArtifactTool(c, args ?? {});
    case "rollback_artifact":
      return rollbackArtifactTool(c, args ?? {});
    case "delete_artifact":
      return deleteArtifactTool(c, args ?? {});
    default:
      throw new RpcError(-32602, unknownToolMessage(name));
  }
}

/** Turn an API refusal (already shaped by src/api.ts) into a tool-level error. */
async function responseError(res: Response): Promise<ToolError> {
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    /* a non-JSON body from our own routes would be a bug; fall through to the status */
  }
  return new ToolError(body?.detail ?? body?.error ?? `request failed with ${res.status}`, {
    error: body?.error ?? "request_failed",
    status: res.status,
  });
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
      `Install the rtfx Claude Code plugin, whose stdio MCP server exposes it — or call the same ` +
      `thing directly on the REST API at /api/machine, with this token.`
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
        instructions: httpInstructionsFor(c.get("identity")),
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: remoteToolsFor(c.get("identity")) };
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };
    case "tools/call": {
      const name = params?.name;
      const tool = REMOTE_TOOLS.find((t) => t.name === name);
      if (!tool) throw new RpcError(-32602, unknownToolMessage(name));
      // Before the schema, because the schema's answer ("unknown argument") is
      // true but useless: a `path` here is a misunderstanding about what this
      // transport is, and it gets told so in those terms.
      const args = params?.arguments ?? {};
      const refusal = pathRefusal(args);
      if (refusal) throw new RpcError(-32602, refusal);
      // Closed schema: an unknown argument is refused before the handler runs,
      // so a hallucinated argument on `doctor` is an error rather than an
      // ignored field that makes the call look like it did something with a file.
      const { ok, errors } = validateToolInput(tool, args);
      if (!ok) throw new RpcError(-32602, `invalid arguments for "${name}": ${errors.join("; ")}`);
      const requiredScope = TOOL_SCOPE[name];
      if (requiredScope && !hasScope(c.get("identity"), requiredScope)) {
        return failure(
          new ToolError(`this token lacks the "${requiredScope}" scope`, {
            error: "insufficient_scope",
            status: 403,
            hint: `mint a token with the ${requiredScope} scope at /admin/integrations, or sign in again and grant it`,
          })
        );
      }
      return callTool(c, name, args);
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
//   2. The RFC 9728 challenge decoration, which has to wrap the gate below it.
//   3. Method check — a GET must answer 405, not the gate's 401.
//   4. The bearer gate, shared verbatim with /api/machine/*.
mcpRoutes.use(MCP_PATH, mcpCors);

/**
 * RFC 9728 §5.1 / MCP authorization: every *** from this endpoint names the
 * protected-resource document that describes it, so a client with no credential
 * can discover the authorization server instead of simply failing.
 *
 * Done by decorating the gate's response rather than by widening
 * `requireApiToken`, because that middleware is shared verbatim with
 * `/api/machine/*` — a surface with no authorization server in front of it,
 * whose 401 must not start a discovery flow.
 *
 * The URL is built from the origin the request actually arrived on, matching
 * what the documents themselves advertise (see the header of
 * src/oauth-routes.ts): a challenge naming a different host than the one the
 * client is talking to is a challenge it cannot act on.
 */
mcpRoutes.use(MCP_PATH, async (c, next) => {
  await next();
  if (c.res.status !== 401) return;
  const existing = c.res.headers.get("WWW-Authenticate") ?? "Bearer";
  const metadata = `${new URL(c.req.url).origin}${PROTECTED_RESOURCE_PATH}`;
  c.header("WWW-Authenticate", `${existing}, resource_metadata="${metadata}"`);
});

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
