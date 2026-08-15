import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { deflateSync, strToU8, strFromU8, unzipSync } from "fflate";
import app from "../src/index";
import { initDb, clearR2, req, as } from "./fixtures";
import { createZip } from "../plugins/rtfx/scripts/rtfx.lib.mjs";
import { prepareBundle, type BundleIo } from "../plugins/rtfx/scripts/rtfx.bundle.mjs";
import {
  ACCESS_TOOL_VAR,
  LATEST_PROTOCOL_VERSION,
  SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOLS,
  callTool,
  createContext,
  describeEnv,
  findTool,
  handleMessage,
  initializeResult,
  negotiateProtocol,
  parseLine,
  redactSecrets,
  toolsFor,
  validateToolInput,
  type McpContext,
  type ToolCallResult,
} from "../plugins/rtfx/scripts/rtfx.mcp.lib.mjs";
import { checkMcpAgreement, checkMcpConfig, checkPluginRootRefs } from "../scripts/validate-plugin.lib.mjs";

/**
 * Issue #39: the MCP server. It exists so an MCP client — Claude Desktop, Claude
 * Code, anything — can publish as a tool call instead of a shell command, and it
 * is a *wrapper*, not a second implementation: the same `rtfx.lib.mjs` resolves
 * credentials and the same `rtfx.bundle.mjs` decides what may be uploaded.
 *
 * That is what these tests are shaped around. Four things must hold:
 *
 *  1. **The schemas are closed and explicit.** A malformed call is refused with
 *     -32602 before any filesystem or network work happens.
 *  2. **No credential leaves the process.** Not in a result, not in an error, not
 *     in a log line. A token is only ever reported as its id.
 *  3. **The safety filters cannot be bypassed by going through MCP.** The walk is
 *     driven here over a *virtual* filesystem — the Workers pool has no real one —
 *     so `.env`, `node_modules` and symlinks are proven to be dropped by the same
 *     code the CLI runs.
 *  4. **The happy paths actually work**, against the real Worker: `fetchImpl` is
 *     wired to `app.request`, so publish/list/versions/rollback go through real
 *     authentication, real R2 and real D1 rather than a mock of them.
 */

const ENDPOINT = "http://localhost";

/** `fetch` for the context, answered by this repo's Worker. */
const workerFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  app.request(input as string, init, env as any)) as unknown as typeof fetch;

/**
 * A filesystem in memory, shaped exactly like the one `rtfx.bundle.mjs` asks for.
 * The point is that the real walk runs — classifyEntry, the symlink check, the
 * zip writer — with only the four I/O calls replaced.
 */
function makeIo(
  files: Record<string, string | Uint8Array>,
  options: { symlinks?: string[] } = {}
): BundleIo {
  const trim = (p: string) => p.replace(/\/+$/, "");
  const bytes = new Map<string, Uint8Array>();
  for (const [path, value] of Object.entries(files)) {
    bytes.set(trim(path), typeof value === "string" ? strToU8(value) : value);
  }
  const symlinks = new Set((options.symlinks ?? []).map(trim));
  const dirs = new Set<string>();
  for (const path of [...bytes.keys(), ...symlinks]) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const entry = (raw: string) => {
    const path = trim(raw);
    const isDir = dirs.has(path);
    const isLink = symlinks.has(path);
    if (!isDir && !isLink && !bytes.has(path)) throw new Error(`ENOENT: ${path}`);
    return { isDirectory: () => isDir, isSymbolicLink: () => isLink };
  };
  return {
    stat: (path) => entry(path),
    lstat: (path) => entry(path),
    readDir: (path) => {
      const prefix = `${trim(path)}/`;
      const names = new Set<string>();
      for (const known of [...bytes.keys(), ...symlinks, ...dirs]) {
        if (known.startsWith(prefix)) names.add(known.slice(prefix.length).split("/")[0]);
      }
      return [...names].sort();
    },
    readFile: (path) => {
      const found = bytes.get(trim(path));
      if (!found) throw new Error(`ENOENT: ${path}`);
      return found;
    },
    join: (dir, name) => `${trim(dir)}/${name}`,
    deflate: (raw) => deflateSync(raw),
  };
}

/** A token that came from the real token API, so auth is really exercised. */
async function mintToken(scopes: string[] = ["read", "publish"]): Promise<string> {
  const res = await req(
    "/api/tokens",
    as("admin@test.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `mcp-${scopes.join("-")}`, owner_email: "admin@test.com", scopes }),
    })
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

function context(
  overrides: Record<string, string | undefined> = {},
  io: BundleIo = makeIo({}),
  FileImpl: typeof File = File
): McpContext {
  return createContext({
    env: { ARTIFACTS_URL: ENDPOINT, ...overrides },
    fetch: workerFetch,
    prepareBundle: (path) => prepareBundle(path, io),
    File: FileImpl,
    node: "v18.20.4",
  });
}

/** The JSON half of a tool result — what the model actually reads. */
const payload = (result: ToolCallResult): any => JSON.parse(result.content[result.content.length - 1].text);
const summary = (result: ToolCallResult): string => result.content[0].text;

// --- Tool surface ------------------------------------------------------------

describe("the tool surface", () => {
  it("exposes publishing and history, and hides sharing by default", () => {
    expect(toolsFor({}).map((t) => t.name)).toEqual([
      "publish",
      "list_artifacts",
      "get_versions",
      "rollback",
      "doctor",
    ]);
  });

  it("adds update_access only when the server was started with the opt-in", () => {
    expect(findTool("update_access", {})).toBeNull();
    expect(findTool("update_access", { [ACCESS_TOOL_VAR]: "1" })?.name).toBe("update_access");
    // Anything other than an affirmative leaves it off.
    for (const value of ["0", "false", "", "maybe"]) {
      expect(findTool("update_access", { [ACCESS_TOOL_VAR]: value }), value).toBeNull();
    }
  });

  it("never leaks the internal gating key into what a client sees", () => {
    for (const tool of toolsFor({ [ACCESS_TOOL_VAR]: "1" })) {
      expect(tool).not.toHaveProperty("requiresEnv");
    }
  });

  it("gives every tool a closed schema, so a stray argument is an error not a guess", () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      for (const [key, spec] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect(typeof (spec as any).type, `${tool.name}.${key}`).toBe("string");
        expect((spec as any).description, `${tool.name}.${key} needs a description`).toBeTruthy();
      }
      for (const required of tool.inputSchema.required ?? []) {
        expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).toContain(required);
      }
    }
  });

  it("describes each tool well enough to be picked without a doc, and hints its blast radius", () => {
    for (const tool of TOOLS) {
      expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length, tool.name).toBeGreaterThan(80);
      expect(tool.annotations, tool.name).toBeDefined();
      expect(typeof tool.annotations!.readOnlyHint, tool.name).toBe("boolean");
    }
    const readOnly = TOOLS.filter((t) => t.annotations!.readOnlyHint).map((t) => t.name);
    expect(readOnly).toEqual(["list_artifacts", "get_versions", "doctor"]);
  });

  it("offers no way to mint a token or manage people — the API refuses those to a token anyway", () => {
    const names = TOOLS.map((t) => t.name).join(" ");
    expect(names).not.toMatch(/token/);
    expect(names).not.toMatch(/user|invite|member|account/);
    expect(names).not.toMatch(/delete|destroy/);
  });
});

describe("argument validation", () => {
  const publish = findTool("publish", {})!;
  const rollback = findTool("rollback", {})!;

  it("accepts a well-formed call and applies declared defaults", () => {
    const { ok, value } = validateToolInput(publish, { path: "./dist", slug: "q3-report" });
    expect(ok).toBe(true);
    expect(value).toEqual({ path: "./dist", slug: "q3-report", dry_run: false });
  });

  it("rejects an unknown argument instead of silently ignoring it", () => {
    const { ok, errors } = validateToolInput(publish, { path: "./dist", slugs: "q3" });
    expect(ok).toBe(false);
    expect(errors[0]).toMatch(/unknown argument "slugs"/);
  });

  it("rejects a missing required argument", () => {
    expect(validateToolInput(publish, {}).errors).toContain('"path" is required');
    expect(validateToolInput(rollback, { slug: "q3" }).errors).toContain('"version" is required');
  });

  it("holds slugs to the shape the server will accept, before any upload happens", () => {
    for (const slug of ["Q3-Report", "q3_report", "-q3", "q3--report", "q3 report", ""]) {
      expect(validateToolInput(publish, { path: "x", slug }).ok, slug).toBe(false);
    }
    for (const slug of ["q3", "q3-report", "a1-b2-c3"]) {
      expect(validateToolInput(publish, { path: "x", slug }).ok, slug).toBe(true);
    }
  });

  it("holds a version to a positive integer, so '2' and 2.5 are refused", () => {
    expect(validateToolInput(rollback, { slug: "q3", version: "2" }).errors[0]).toMatch(/integer/);
    expect(validateToolInput(rollback, { slug: "q3", version: 2.5 }).errors[0]).toMatch(/integer/);
    expect(validateToolInput(rollback, { slug: "q3", version: 0 }).errors[0]).toMatch(/at least 1/);
    expect(validateToolInput(rollback, { slug: "q3", version: 2 }).ok).toBe(true);
  });

  it("holds an enum, an array's item type and a boolean", () => {
    const access = findTool("update_access", { [ACCESS_TOOL_VAR]: "1" })!;
    expect(validateToolInput(access, { slug: "q3", visibility: "public" }).errors[0]).toMatch(/one of/);
    expect(
      validateToolInput(access, { slug: "q3", visibility: "restricted", emails: ["a@b.com", 5] }).errors[0]
    ).toMatch(/only string/);
    expect(validateToolInput(publish, { path: "x", dry_run: "yes" }).errors[0]).toMatch(/true or false/);
  });

  it("treats a non-object argument bag as invalid", () => {
    expect(validateToolInput(publish, ["./dist"]).errors[0]).toMatch(/must be an object/);
    expect(validateToolInput(findTool("doctor", {})!, null).ok).toBe(true);
  });
});

// --- Secrets -----------------------------------------------------------------

describe("no credential can leave the process", () => {
  const TOKEN = "rtfx_9f2c1ab30d4e_Xj7aBcDeFgHiJkLmNoP";

  it("cuts a token down to its id wherever it appears in text", () => {
    const cfg = context({ RTFX_API_TOKEN: TOKEN }).config;
    const text = redactSecrets(`failed with token ${TOKEN} on retry`, cfg);
    expect(text).not.toContain("Xj7aBcDeFgHiJkLmNoP");
    expect(text).toContain("rtfx_9f2c1ab30d4e_…");
  });

  it("redacts a token even when the config does not know about it", () => {
    // A token for another instance, echoed back by something we do not control.
    expect(redactSecrets("saw rtfx_deadbeef12_ZZZsecrettail99 in the body", null)).toBe(
      "saw rtfx_deadbeef12_… in the body"
    );
  });

  it("redacts Cloudflare Access service-token headers too", () => {
    const cfg = context({
      RTFX_API_TOKEN: TOKEN,
      CF_ACCESS_CLIENT_ID: "0123456789abcdef0123456789abcdef.access",
      CF_ACCESS_CLIENT_SECRET: "an-access-service-token-secret",
    }).config;
    const text = redactSecrets("id 0123456789abcdef0123456789abcdef.access secret an-access-service-token-secret", cfg);
    expect(text).not.toContain("an-access-service-token-secret");
    expect(text).not.toContain("0123456789abcdef0123456789abcdef.access");
  });

  it("reports configuration as presence and an id, never a value", () => {
    const facts = describeEnv(
      context({
        RTFX_API_TOKEN: TOKEN,
        CF_ACCESS_CLIENT_ID: "0123456789abcdef0123456789abcdef.access",
        CF_ACCESS_CLIENT_SECRET: "access-service-token-secret-value",
      })
    );
    expect(facts.token_set).toBe(true);
    expect(facts.token).toBe("rtfx_9f2c1ab30d4e_…");
    expect(facts.access_headers).toBe(true);
    const json = JSON.stringify(facts);
    expect(json).not.toContain("Xj7aBcDeFgHiJkLmNoP");
    expect(json).not.toContain("access-service-token-secret-value");
    expect(json).not.toContain("0123456789abcdef0123456789abcdef.access");
  });

  it("ignores a Cloudflare management token entirely", () => {
    const ctx = context({ RTFX_API_TOKEN: TOKEN, CF_API_TOKEN: "cf-management-token-value" });
    expect(JSON.stringify(describeEnv(ctx))).not.toContain("cf-management-token-value");
    expect(JSON.stringify(ctx.config)).not.toContain("cf-management-token-value");
    expect(describeEnv(ctx).cloudflare_management_token).toBe("ignored");
  });

  it("says what is missing without echoing anything, when no token is set", async () => {
    const result = await callTool("doctor", {}, context());
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/no rtfx credential is available/);
    expect(payload(result).hint).toMatch(/\/rtfx:login/);
    expect(JSON.stringify(result)).not.toMatch(/rtfx_[A-Za-z0-9]+_[A-Za-z0-9_-]{8,}/);
  });

  it("keeps a bad token out of the 401 it produces", async () => {
    await initDb();
    const ctx = context({ RTFX_API_TOKEN: "rtfx_notreal99_ThisIsNotARealSecret" });
    const result = await callTool("list_artifacts", {}, ctx);
    expect(result.isError).toBe(true);
    expect(payload(result).status).toBe(401);
    expect(payload(result).retryable).toBe(false);
    expect(JSON.stringify(result)).not.toContain("ThisIsNotARealSecret");
  });

  it("uses a stored OAuth credential when the environment has no token", async () => {
    await initDb();
    const token = await mintToken(["read", "publish"]);
    const writes: any[] = [];
    const ctx = createContext({
      env: { ARTIFACTS_URL: ENDPOINT },
      fetch: workerFetch,
      prepareBundle: (path) => prepareBundle(path, makeIo({})),
      File,
      node: "v18.20.4",
      credentials: {
        read: () => ({
          issuer: ENDPOINT,
          access_token: token,
          refresh_token: "rtfxr_not_used",
          expires_at: "2099-01-01T00:00:00.000Z",
          scopes: ["rtfx:read", "rtfx:publish"],
          token_endpoint: `${ENDPOINT}/oauth/token`,
        }),
        write: (_issuer: string, credential: any) => writes.push(credential),
      },
    });

    const result = await callTool("doctor", {}, ctx);
    expect(result.isError).not.toBe(true);
    expect(summary(result)).toMatch(/browser sign-in/);
    expect(payload(result).credential_source).toBe("oauth");
    expect(payload(result).token).toMatch(/^rtfx_[a-z0-9]+_…$/);
    expect(JSON.stringify(result)).not.toContain(token.split("_").at(-1)!);
    expect(writes).toEqual([]);
  });

  it("refreshes an expired stored OAuth credential only once for MCP publish", async () => {
    const calls: string[] = [];
    const writes: any[] = [];
    const ctx = createContext({
      env: { ARTIFACTS_URL: ENDPOINT },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/oauth/token")) {
          return new Response(
            JSON.stringify({
              access_token: "rtfx_newid_nextSecret",
              refresh_token: "rtfxr_nextRefresh",
              expires_in: 3600,
              scope: "rtfx:read rtfx:publish",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.endsWith("/api/artifacts")) {
          expect(init?.headers).toMatchObject({ Authorization: "Bearer rtfx_newid_nextSecret" });
          return new Response(
            JSON.stringify({ slug: "site", version: 1, url: "https://a.rtfx.pro/site/", kind: "bundle", files: 1 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch,
      prepareBundle: (path) => prepareBundle(path, makeIo({ "/site/index.html": "<h1>ok</h1>" })),
      File,
      node: "v18.20.4",
      credentials: {
        read: () => ({
          issuer: ENDPOINT,
          access_token: "rtfx_oldid_oldSecret",
          refresh_token: "rtfxr_spentOnceOnly",
          expires_at: "2000-01-01T00:00:00.000Z",
          scopes: ["rtfx:read", "rtfx:publish"],
          token_endpoint: `${ENDPOINT}/oauth/token`,
        }),
        write: (_issuer: string, credential: any) => writes.push(credential),
      },
    });

    const result = await callTool("publish", { path: "/site", slug: "site" }, ctx);

    expect(result.isError).not.toBe(true);
    expect(calls.filter((call) => call.endsWith("/oauth/token"))).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].refresh_token).toBe("rtfxr_nextRefresh");
    expect(summary(result)).toContain("https://a.rtfx.pro/site/");
  });

  it("redacts stored OAuth refresh tokens", () => {
    const text = redactSecrets("refresh rtfxr_superSecretRefreshTokenValue", { credential: { refresh_token: "rtfxr_superSecretRefreshTokenValue" } } as any);
    expect(text).toBe("refresh rtfxr_…");
  });

  it("redacts protocol errors too, including user-controlled method, tool and argument names", async () => {
    const ctx = context({ RTFX_API_TOKEN: TOKEN });

    const method = await handleMessage({ jsonrpc: "2.0", id: 1, method: TOKEN }, ctx);
    const tool = await handleMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: TOKEN, arguments: {} } },
      ctx
    );
    const args = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "publish", arguments: { path: "/site", [TOKEN]: "secret-shaped-key" } },
      },
      ctx
    );

    for (const res of [method, tool, args]) {
      const text = JSON.stringify(res);
      expect(text).not.toContain("Xj7aBcDeFgHiJkLmNoP");
      expect(text).toContain("rtfx_9f2c1ab30d4e_…");
    }
  });
});

// --- Protocol ----------------------------------------------------------------

describe("the JSON-RPC surface", () => {
  it("initializes with a tools capability and instructions the model can act on", () => {
    const result = initializeResult({ protocolVersion: "2025-06-18" });
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toHaveProperty("tools");
    expect(result.serverInfo).toEqual(SERVER_INFO);
    // The instructions are load-bearing: without the re-publish rule an agent
        // invents a new slug for every update.
    expect(result.instructions).toMatch(/same slug/i);
    expect(result.instructions).toMatch(/index\.html/);
  });

  it("echoes a protocol version it knows and falls back to its own otherwise", () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) expect(negotiateProtocol(version)).toBe(version);
    expect(negotiateProtocol("1999-01-01")).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocol(undefined)).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("lists tools over the wire", async () => {
    const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, context());
    expect(res!.result.tools.map((t: { name: string }) => t.name)).toContain("publish");
  });

  it("answers ping, and empty lists for the capabilities it does not advertise", async () => {
    const ctx = context();
    expect((await handleMessage({ jsonrpc: "2.0", id: 1, method: "ping" }, ctx))!.result).toEqual({});
    expect((await handleMessage({ jsonrpc: "2.0", id: 2, method: "resources/list" }, ctx))!.result).toEqual({ resources: [] });
    expect((await handleMessage({ jsonrpc: "2.0", id: 3, method: "prompts/list" }, ctx))!.result).toEqual({ prompts: [] });
  });

  it("replies to nothing that has no id", async () => {
    const ctx = context();
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx)).toBeNull();
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled" }, ctx)).toBeNull();
    // Even an unknown notification: a notification never gets a reply, and an
    // error response to one would be an unmatched id on the client's side.
    expect(await handleMessage({ jsonrpc: "2.0", method: "who/knows" }, ctx)).toBeNull();
  });

  it("returns -32601 for a method it does not implement", async () => {
    const res = await handleMessage({ jsonrpc: "2.0", id: 7, method: "resources/read" }, context());
    expect(res!.error.code).toBe(-32601);
    expect(res!.id).toBe(7);
  });

  it("returns -32602 for an unknown tool, naming the ones that exist", async () => {
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "delete_everything", arguments: {} } },
      context()
    );
    expect(res!.error.code).toBe(-32602);
    expect(res!.error.message).toMatch(/unknown tool/);
    expect(res!.error.message).toMatch(/publish/);
  });

  it("explains how to enable a gated tool rather than pretending it does not exist", async () => {
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "update_access", arguments: {} } },
      context()
    );
    expect(res!.error.code).toBe(-32602);
    expect(res!.error.message).toMatch(new RegExp(`${ACCESS_TOOL_VAR}=1`));
  });

  it("returns -32602 for arguments that do not match the schema, before doing any work", async () => {
    const io = makeIo({ "/site/index.html": "<h1>hi</h1>" });
    const spy = vi.fn();
    const ctx = { ...context({}, io), prepareBundle: spy } as unknown as McpContext;
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "publish", arguments: { path: "/site", slug: "Bad Slug" } } },
      ctx
    );
    expect(res!.error.code).toBe(-32602);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a non-object message and unparseable input as protocol errors", async () => {
    expect((await handleMessage("hello", context()))!.error.code).toBe(-32600);
    expect(parseLine("not json").error!.error.code).toBe(-32700);
    expect(parseLine("[{}]").error!.error.message).toMatch(/batched/);
    expect(parseLine("   ").skip).toBe(true);
    expect(parseLine('{"jsonrpc":"2.0","id":1,"method":"ping"}').message!.method).toBe("ping");
  });

  it("frames every response as one line, as the stdio transport requires", async () => {
    const ctx = context({ RTFX_API_TOKEN: "rtfx_abc123_secretvalue" });
    const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, ctx);
    // INSTRUCTIONS is multi-line prose; the framing survives it because
    // JSON.stringify escapes the newlines.
    expect(JSON.stringify(res)).not.toContain("\n");
  });
});

// --- Which surface the tools actually call -----------------------------------
//
// The reason this matters is the whole point of `/api/machine`: on an
// Access-gated deployment, `/api` is answered by Cloudflare Access before the
// Worker sees the request, so an agent holding only an `rtfx_…` token cannot
// publish there. These tests pin that the tools go to the machine surface, that
// they still work against an instance too old to have one, and that an Access
// interception is reported as itself instead of as an empty result.

describe("the tools publish through the machine API", () => {
  let token: string;

  beforeEach(async () => {
    await initDb();
    await clearR2();
    token = await mintToken();
  });

  /** A fetch that records every URL before handing off to the real Worker. */
  function recordingFetch(seen: string[]) {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      return workerFetch(input as string, init);
    }) as unknown as typeof fetch;
  }

  it("calls /api/machine, and only that, for every artifact operation", async () => {
    const seen: string[] = [];
    const ctx = {
      ...context({ RTFX_API_TOKEN: token }, makeIo({ "/tmp/page.html": "<h1>hi</h1>" })),
      fetchImpl: recordingFetch(seen),
    };
    await callTool("publish", { path: "/tmp/page.html", slug: "machine-made", title: "Made" }, ctx);
    await callTool("list_artifacts", {}, ctx);
    await callTool("get_versions", { slug: "machine-made" }, ctx);
    await callTool("rollback", { slug: "machine-made", version: 1 }, ctx);

    expect(seen).toHaveLength(4);
    for (const url of seen) expect(url).toContain("/api/machine/artifacts");
    // No call fell back to the Access-gated dashboard path.
    expect(seen.some((u) => new URL(u).pathname.startsWith("/api/artifacts"))).toBe(false);
  });

  /**
   * An instance older than the machine surface has no such route, so it answers
   * with the framework's bare 404 — no `error` field. That, and only that, is
   * retried against `/api`, so a plugin can be newer than the server it talks to.
   */
  it("falls back to /api against an instance that predates the machine surface", async () => {
    const seen: string[] = [];
    const oldServer = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (new URL(url).pathname.startsWith("/api/machine/")) {
        return Promise.resolve(new Response("404 Not Found", { status: 404 }));
      }
      return workerFetch(url, init);
    }) as unknown as typeof fetch;

    const ctx = {
      ...context({ RTFX_API_TOKEN: token }, makeIo({ "/tmp/page.html": "<h1>hi</h1>" })),
      fetchImpl: oldServer,
    };
    const result = payload(await callTool("publish", { path: "/tmp/page.html", title: "Legacy" }, ctx));
    expect(result.ok).toBe(true);
    expect(result.version).toBe(1);
    expect(seen.map((u) => new URL(u).pathname)).toEqual(["/api/machine/artifacts", "/api/artifacts"]);
  });

  it("does not retry a real 404 — an artifact that isn't yours stays a 404", async () => {
    const seen: string[] = [];
    const ctx = { ...context({ RTFX_API_TOKEN: token }), fetchImpl: recordingFetch(seen) };
    const result = payload(await callTool("get_versions", { slug: "not-mine" }, ctx));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(seen).toHaveLength(1);
  });

  /**
   * What an operator sees if they publish the machine surface without putting it
   * on an Access Bypass policy: Access answers with a sign-in page, `fetch`
   * follows the redirect, and the tool would otherwise report "published
   * undefined" or an empty artifact list.
   */
  it("names Cloudflare Access when Access answers instead of the app", async () => {
    const challenged = (() =>
      Promise.resolve(
        Object.defineProperty(new Response("<html>sign in</html>", { status: 200 }), "url", {
          value: "https://team.cloudflareaccess.com/cdn-cgi/access/login/rtfx.pro",
        })
      )) as unknown as typeof fetch;
    const ctx = { ...context({ RTFX_API_TOKEN: token }), fetchImpl: challenged };

    const result = payload(await callTool("list_artifacts", {}, ctx));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Cloudflare Access/);
    expect(result.hint).toMatch(/Bypass/);
    expect(result.artifacts).toBeUndefined();
  });
});

// --- The real thing ----------------------------------------------------------

describe("publish, list, versions and rollback against the real API", () => {
  let token: string;

  beforeEach(async () => {
    await initDb();
    await clearR2();
    token = await mintToken();
  });

  const SITE = {
    "/build/index.html": "<h1>quarterly</h1><link rel=stylesheet href=assets/app.css>",
    "/build/assets/app.css": "body{margin:0}",
  };

  it("publishes a directory as v1 and reports the URL the API chose", async () => {
    const ctx = context({ RTFX_API_TOKEN: token }, makeIo(SITE));
    const result = await callTool("publish", { path: "/build", slug: "quarterly", title: "Quarterly" }, ctx);

    expect(result.isError).toBeUndefined();
    const data = payload(result);
    expect(data).toMatchObject({ ok: true, slug: "quarterly", version: 1, type: "bundle", file_count: 2 });
    expect(data.url).toContain("/quarterly/");
    expect(summary(result)).toContain("published quarterly v1");

    // The bytes really landed, and are really served.
    const page = await req("/quarterly/", as("admin@test.com"));
    expect(await page.text()).toContain("quarterly");
    expect((await req("/quarterly/assets/app.css", as("admin@test.com"))).status).toBe(200);
  });

  it("publishes a single HTML file as the `file` field", async () => {
    const ctx = context({ RTFX_API_TOKEN: token }, makeIo({ "/tmp/report.html": "<h1>one file</h1>" }));
    const data = payload(await callTool("publish", { path: "/tmp/report.html", slug: "one-file", title: "One" }, ctx));
    expect(data).toMatchObject({ type: "single", file_count: 1, version: 1 });
    expect(await (await req("/one-file/", as("admin@test.com"))).text()).toContain("one file");
  });

  it("falls back to the file name for a title when neither title nor slug is given", async () => {
    const ctx = context({ RTFX_API_TOKEN: token }, makeIo({ "/tmp/Sales Deck.html": "<h1>deck</h1>" }));
    const data = payload(await callTool("publish", { path: "/tmp/Sales Deck.html" }, ctx));
    expect(data.slug).toBe("sales-deck");
  });

  it("re-publishing the same slug appends a version and keeps the URL and title", async () => {
    const ctx = context({ RTFX_API_TOKEN: token }, makeIo(SITE));
    const first = payload(await callTool("publish", { path: "/build", slug: "quarterly", title: "Quarterly" }, ctx));

    const changed = context(
      { RTFX_API_TOKEN: token },
      makeIo({ ...SITE, "/build/index.html": "<h1>quarterly v2</h1>" })
    );
    const second = payload(
      await callTool("publish", { path: "/build", slug: "quarterly", note: "revised charts" }, changed)
    );
    expect(second.version).toBe(2);
    expect(second.url).toBe(first.url);

    const listed = payload(await callTool("list_artifacts", {}, ctx));
    expect(listed.artifacts).toHaveLength(1);
    expect(listed.artifacts[0]).toMatchObject({ slug: "quarterly", current_version: 2, title: "Quarterly" });
    expect(summary(await callTool("list_artifacts", {}, ctx))).toContain("quarterly  v2");

    const versions = payload(await callTool("get_versions", { slug: "quarterly" }, ctx));
    expect(versions.current).toBe(2);
    expect(versions.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(versions.versions[0].note).toBe("revised charts");

    const rolled = payload(await callTool("rollback", { slug: "quarterly", version: 1 }, ctx));
    expect(rolled).toMatchObject({ slug: "quarterly", current: 1 });
    expect(rolled.url).toBe(first.url);
    expect(await (await req("/quarterly/", as("admin@test.com"))).text()).toContain("<h1>quarterly</h1>");
  });

  it("reports an empty list as a sentence rather than nothing at all", async () => {
    const result = await callTool("list_artifacts", {}, context({ RTFX_API_TOKEN: token }));
    expect(summary(result)).toContain("no artifacts");
    expect(payload(result).artifacts).toEqual([]);
  });

  it("doctor reaches the API and reports the id, endpoint and tool list", async () => {
    const result = await callTool("doctor", {}, context({ RTFX_API_TOKEN: token }));
    const data = payload(result);
    expect(data.reachable).toBe(true);
    expect(data.endpoint).toBe(ENDPOINT);
    expect(data.token).toMatch(/^rtfx_[a-z0-9]+_…$/);
    expect(data.node).toBe("v18.20.4");
    expect(data.tools).not.toContain("update_access");
    // Everything after `rtfx_<id>_` is the secret. Split on "_" would not do:
    // the secret is base64url, so it may itself begin with an underscore, and
    // then `[2]` is "" — which every string contains, failing this ~1 run in 64.
    const secret = token.slice(token.indexOf("_", token.indexOf("_") + 1) + 1);
    expect(secret.length).toBeGreaterThan(16);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("turns an unknown slug into a 404 with a hint, not a crash", async () => {
    const ctx = context({ RTFX_API_TOKEN: token });
    const result = await callTool("get_versions", { slug: "never-published" }, ctx);
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ ok: false, status: 404, retryable: false });
    expect(payload(result).hint).toMatch(/list/);
  });

  it("marks a server fault retryable and a credential fault not", async () => {
    const ctx = {
      ...context({ RTFX_API_TOKEN: token }),
      fetchImpl: async () => new Response(JSON.stringify({ error: "storage" }), { status: 503 }),
    } as unknown as McpContext;
    expect(payload(await callTool("list_artifacts", {}, ctx)).retryable).toBe(true);
  });

  it("reports an unreachable endpoint as retryable, naming the variable to check", async () => {
    const ctx = {
      ...context({ RTFX_API_TOKEN: token }),
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
      },
    } as unknown as McpContext;
    const result = await callTool("list_artifacts", {}, ctx);
    expect(payload(result)).toMatchObject({ retryable: true });
    expect(payload(result).hint).toMatch(/ARTIFACTS_URL/);
  });

  it("cannot take over somebody else's slug", async () => {
    await req(
      "/api/artifacts",
      as("someone@else.com", {
        method: "POST",
        body: (() => {
          const fd = new FormData();
          fd.set("slug", "taken");
          fd.set("title", "Theirs");
          fd.set("file", new File([strToU8("<p>theirs</p>")], "page.html", { type: "text/html" }));
          return fd;
        })(),
      })
    );
    const ctx = context({ RTFX_API_TOKEN: token }, makeIo(SITE));
    const result = await callTool("publish", { path: "/build", slug: "taken", title: "Mine" }, ctx);
    expect(result.isError).toBe(true);
    expect(payload(result).status).toBe(409);
    expect(await (await req("/taken/", as("someone@else.com"))).text()).toContain("theirs");
  });

  it("uses the injected File constructor, which is what makes Node 18 work", async () => {
    let made = 0;
    class CountedFile extends File {
      constructor(...args: ConstructorParameters<typeof File>) {
        super(...args);
        made += 1;
      }
    }
    const ctx = context({ RTFX_API_TOKEN: token }, makeIo(SITE), CountedFile as unknown as typeof File);
    expect(payload(await callTool("publish", { path: "/build", slug: "injected", title: "Injected" }, ctx)).version).toBe(1);
    expect(made).toBe(1);
  });
});

// --- Scopes ------------------------------------------------------------------

describe("a token cannot exceed its scopes through MCP", () => {
  beforeEach(async () => {
    await initDb();
    await clearR2();
  });

  it("a read-only token can list but not publish", async () => {
    const ctx = context({ RTFX_API_TOKEN: await mintToken(["read"]) }, makeIo({ "/b/index.html": "<h1>x</h1>" }));
    expect((await callTool("list_artifacts", {}, ctx)).isError).toBeUndefined();
    const result = await callTool("publish", { path: "/b", slug: "nope", title: "Nope" }, ctx);
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ status: 403, error: expect.stringContaining("insufficient_scope") });
    expect(payload(result).hint).toMatch(/scope/i);
  });

  it("update_access needs the manage scope even when the tool is enabled", async () => {
    const io = makeIo({ "/b/index.html": "<h1>x</h1>" });
    const publishOnly = context({ RTFX_API_TOKEN: await mintToken(["read", "publish"]), [ACCESS_TOOL_VAR]: "1" }, io);
    expect(payload(await callTool("publish", { path: "/b", slug: "shared", title: "Shared" }, publishOnly)).version).toBe(1);

    const refused = await callTool("update_access", { slug: "shared", visibility: "everyone" }, publishOnly);
    expect(refused.isError).toBe(true);
    expect(payload(refused)).toMatchObject({ status: 403 });

    const manager = context({ RTFX_API_TOKEN: await mintToken(["read", "publish", "manage"]), [ACCESS_TOOL_VAR]: "1" }, io);
    const granted = payload(await callTool("update_access", { slug: "shared", visibility: "restricted", emails: ["dana@example.com"] }, manager));
    expect(granted).toMatchObject({ slug: "shared", visibility: "restricted", emails: ["dana@example.com"] });
    expect((await req("/shared/", as("dana@example.com"))).status).toBe(200);

    // The list is a replacement, as the schema says — [] revokes.
    const revoked = payload(await callTool("update_access", { slug: "shared", visibility: "restricted", emails: [] }, manager));
    expect(revoked.emails).toEqual([]);
    expect((await req("/shared/", as("dana@example.com"))).status).toBe(404);
  });
});

// --- Bundle safety -----------------------------------------------------------

describe("going through MCP does not bypass the bundle safety model", () => {
  let token: string;

  beforeEach(async () => {
    await initDb();
    await clearR2();
    token = await mintToken();
  });

  const MESSY = {
    "/proj/index.html": "<h1>site</h1>",
    "/proj/assets/app.css": "body{margin:0}",
    "/proj/.env": "RTFX_API_TOKEN=rtfx_realid00_averyrealsecretvalue",
    "/proj/.env.production": "SECRET=2",
    "/proj/deploy.key": "-----BEGIN PRIVATE KEY-----",
    "/proj/server.pem": "cert",
    "/proj/.DS_Store": "junk",
    "/proj/node_modules/left-pad/index.js": "module.exports=1",
    "/proj/.git/config": "[core]",
  };

  it("drops credentials, build directories and OS droppings — and says so", async () => {
    const ctx = context({ RTFX_API_TOKEN: token }, makeIo(MESSY, { symlinks: ["/proj/link-to-home"] }));
    const result = await callTool("publish", { path: "/proj", slug: "messy", title: "Messy" }, ctx);

    const data = payload(result);
    expect(data.file_count).toBe(2);
    const reasons = Object.fromEntries(data.skipped.map((s: any) => [s.path, s.reason]));
    expect(reasons).toMatchObject({
      ".env": "skip-secret",
      ".env.production": "skip-secret",
      "deploy.key": "skip-secret",
      "server.pem": "skip-secret",
      ".DS_Store": "skip-file",
      node_modules: "skip-dir",
      ".git": "skip-dir",
      "link-to-home": "skip-symlink",
    });
    // Every skip is reported to the person, not just recorded.
    expect(summary(result)).toContain("skipped .env  (looks like a credential)");
    expect(summary(result)).toContain("link-to-home  (symbolic link outside the bundle boundary)");

    // And nothing sensitive was actually stored or is actually served.
    for (const path of [".env", "deploy.key", "node_modules/left-pad/index.js", ".git/config"]) {
      expect(await env.FILES.get(`messy/v1/${path}`), path).toBeNull();
      expect((await req(`/messy/${path}`, as("admin@test.com"))).status, path).toBe(404);
    }
    expect(JSON.stringify(result)).not.toContain("averyrealsecretvalue");
  });

  it("refuses a prebuilt zip that hides a credential, rather than filtering it silently", async () => {
    const zip = createZip({ "index.html": strToU8("<h1>x</h1>"), ".env": strToU8("SECRET=1") });
    const ctx = context({ RTFX_API_TOKEN: token }, makeIo({ "/tmp/site.zip": zip }));
    const result = await callTool("publish", { path: "/tmp/site.zip", slug: "zipped", title: "Zipped" }, ctx);

    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/credential-looking path: \.env/);
    expect(payload(result).hint).toMatch(/publish the cleaned folder/);
    expect((await req("/zipped/", as("admin@test.com"))).status).toBe(404);
  });

  it("accepts a clean prebuilt zip as-is", async () => {
    const zip = createZip({ "index.html": strToU8("<h1>clean zip</h1>"), "assets/a.js": strToU8("1") }, { deflate: deflateSync });
    const ctx = context({ RTFX_API_TOKEN: token }, makeIo({ "/tmp/clean.zip": zip }));
    expect(payload(await callTool("publish", { path: "/tmp/clean.zip", slug: "clean", title: "Clean" }, ctx)).file_count).toBe(2);
    expect(await (await req("/clean/", as("admin@test.com"))).text()).toContain("clean zip");
  });

  it("refuses a directory with no root index.html, an empty one, and an unsupported file", async () => {
    const cases: [Record<string, string>, string, RegExp][] = [
      [{ "/no-index/readme.txt": "x" }, "/no-index", /no index\.html at its root/],
      [{ "/blank/.DS_Store": "x" }, "/blank", /no publishable files/],
      [{ "/tmp/notes.txt": "x" }, "/tmp/notes.txt", /unsupported file type "\.txt"/],
    ];
    for (const [files, path, expected] of cases) {
      const ctx = context({ RTFX_API_TOKEN: token }, makeIo(files));
      const result = await callTool("publish", { path, slug: "x-slug", title: "X" }, ctx);
      expect(result.isError, path).toBe(true);
      expect(payload(result).error, path).toMatch(expected);
    }
  });

  it("says so plainly when the path is not there", async () => {
    const ctx = context({ RTFX_API_TOKEN: token }, makeIo({}));
    const result = await callTool("publish", { path: "/nope", slug: "x-slug", title: "X" }, ctx);
    expect(payload(result).error).toBe("no such file or directory: /nope");
  });

  it("dry_run reports what would go and what would not, uploading nothing and needing no token", async () => {
    const io = makeIo(MESSY, { symlinks: ["/proj/link-to-home"] });
    const fetchSpy = vi.fn();
    const ctx = { ...context({}, io), fetchImpl: fetchSpy } as unknown as McpContext;

    const result = await callTool("publish", { path: "/proj", dry_run: true }, ctx);
    expect(result.isError).toBeUndefined();
    const data = payload(result);
    expect(data.dry_run).toBe(true);
    expect(data.files).toEqual(["assets/app.css", "index.html"]);
    expect(data.skipped.map((s: any) => s.path)).toContain(".env");
    expect(data.upload_bytes).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("averyrealsecretvalue");
  });

  it("the zip the walk produces is a real zip, holding exactly the kept files", () => {
    const prepared = prepareBundle("/proj", makeIo(MESSY, { symlinks: ["/proj/link-to-home"] }));
    expect(Object.keys(unzipSync(prepared.bytes)).sort()).toEqual(["assets/app.css", "index.html"]);
    expect(strFromU8(unzipSync(prepared.bytes)["index.html"])).toBe("<h1>site</h1>");
  });

  it("builds artifact-relative paths from entry names, so a nested tree keeps its shape", () => {
    const prepared = prepareBundle(
      "/deep",
      makeIo({
        "/deep/index.html": "<h1>d</h1>",
        "/deep/a/b/c/style.css": "x",
      })
    );
    expect(prepared.entries).toEqual(["a/b/c/style.css", "index.html"]);
  });
});

// --- The shipped configuration ----------------------------------------------

describe("the plugin's .mcp.json rules", () => {
  const exists = (ref: string) => ref === "scripts/rtfx-mcp.mjs";
  const config = { mcpServers: { rtfx: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/rtfx-mcp.mjs"] } } };

  it("accepts the shipped shape", () => {
    expect(checkMcpConfig(".mcp.json", config, exists).errors).toEqual([]);
  });

  it("catches a server pointing at a script that is not there", () => {
    const moved = { mcpServers: { rtfx: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/gone.mjs"] } } };
    expect(checkMcpConfig(".mcp.json", moved, exists).errors[0]).toMatch(/does not exist/);
  });

  it("catches a script path that would resolve against the user's cwd", () => {
    const bare = { mcpServers: { rtfx: { command: "node", args: ["scripts/rtfx-mcp.mjs"] } } };
    expect(checkMcpConfig(".mcp.json", bare, exists).errors[0]).toMatch(/CLAUDE_PLUGIN_ROOT/);
  });

  it("refuses a credential typed into the committed env block", () => {
    const leaky = {
      mcpServers: { rtfx: { command: "node", args: [], env: { RTFX_API_TOKEN: "rtfx_9f2c1ab30d4e_Xj7aBcDeFgHiJkLmNoP" } } },
    };
    expect(checkMcpConfig(".mcp.json", leaky, exists).errors[0]).toMatch(/hard-codes RTFX_API_TOKEN/);
    // An indirection or a visible placeholder is the acceptable form.
    for (const value of ["${RTFX_API_TOKEN}", "rtfx_…"]) {
      const fine = { mcpServers: { rtfx: { command: "node", args: [], env: { RTFX_API_TOKEN: value } } } };
      expect(checkMcpConfig(".mcp.json", fine, exists).errors, value).toEqual([]);
    }
  });

  it("catches a missing command, a bad name and a malformed file", () => {
    expect(checkMcpConfig(".mcp.json", { mcpServers: { rtfx: {} } }, exists).errors[0]).toMatch(/needs a `command`/);
    expect(checkMcpConfig(".mcp.json", { mcpServers: { "Rtfx Server": { command: "node" } } }, exists).errors[0]).toMatch(/kebab-case/);
    expect(checkMcpConfig(".mcp.json", {}, exists).errors[0]).toMatch(/mcpServers/);
    expect(checkMcpConfig(".mcp.json", "nope", exists).errors[0]).toMatch(/JSON object/);
  });

  it("requires plugin.json and .mcp.json to declare the same servers, whatever the key order", () => {
    const servers = config.mcpServers;
    expect(checkMcpAgreement(servers, servers).errors).toEqual([]);
    // Same config, keys written the other way round: still agreement.
    const reordered = { rtfx: { args: ["${CLAUDE_PLUGIN_ROOT}/scripts/rtfx-mcp.mjs"], command: "node" } };
    expect(checkMcpAgreement(servers, reordered).errors).toEqual([]);
    // A real difference must fail: whichever the loader reads, the other is a lie.
    expect(checkMcpAgreement(servers, { rtfx: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/other.mjs"] } }).errors[0]).toMatch(
      /disagree/
    );
    // Only one of the two present is fine.
    expect(checkMcpAgreement(servers, undefined).errors).toEqual([]);
  });

  it("holds every plugin script — not just the publisher — to an absolute plugin-root path", () => {
    const exists2 = () => true;
    expect(checkPluginRootRefs("c.md", "node scripts/rtfx-mcp.mjs", exists2).errors[0]).toMatch(/CLAUDE_PLUGIN_ROOT/);
    expect(
      checkPluginRootRefs("c.md", 'node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx-mcp.mjs"', exists2).errors
    ).toEqual([]);
  });
});
