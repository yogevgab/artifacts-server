import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { strToU8, zipSync } from "fflate";
import app from "../src/index";
import { initDb, clearR2, req, as, withToken, htmlForm } from "./fixtures";
import {
  HTTP_INSTRUCTIONS,
  HTTP_READ_ONLY_INSTRUCTIONS,
  LOCAL_ONLY_TOOLS,
  MAX_MCP_BODY_BYTES,
  MCP_PATH,
  REMOTE_TOOLS,
} from "../src/mcp";
import { TOOLS, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from "../plugins/rtfx/scripts/rtfx.mcp.lib.mjs";

/**
 * Remote MCP over Streamable HTTP — `POST /mcp` (src/mcp.ts).
 *
 * This is the foundation slice of the hosted-MCP direction, and these tests are
 * shaped around what "foundation" has to mean if it is to be safe to expose:
 *
 *  1. **The transport is really the transport.** initialize/tools/list/tools/call
 *     and the JSON-RPC error codes behave the way an MCP client expects, and
 *     match the stdio server where the two answer the same question.
 *  2. **The gate is the machine surface's gate, not a new one.** A bearer token
 *     and nothing else: no session cookie, no dev impersonation, no Access
 *     assertion. Anything `/api/machine/*` refuses, this refuses identically.
 *  3. **The remote surface is deliberately content-based.** It exposes `doctor`
 *     and `publish`, but `publish` takes content bytes in the request, never a
 *     filesystem path that would name the server's disk.
 *  4. **What it claims about OAuth is true.** A 401 names an RFC 9728
 *     protected-resource document, and that document answers 200 on the same
 *     origin. The authorization server itself is tested in test/oauth.test.ts.
 */

const ADMIN = "admin@test.com"; // matches ADMIN_EMAILS in vitest.config.ts
const BOB = "bob@beta.com";

beforeEach(async () => {
  await initDb();
  await clearR2();
});

async function tokenFor(email: string, body: Record<string, unknown> = { name: "mcp" }) {
  const res = await req(
    "/api/tokens",
    as(email, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  expect(res.status).toBe(201);
  return (await res.json<any>()) as { token: string; id: string };
}

/** One JSON-RPC message, over HTTP, with a bearer token. */
const rpc = (token: string | null, message: unknown, init: RequestInit = {}) =>
  req(MCP_PATH, {
    method: "POST",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
    body: typeof message === "string" ? message : JSON.stringify(message),
  });

const json = async (res: Response) => await res.json<any>();

// --- Protocol ----------------------------------------------------------------

describe("the Streamable HTTP transport", () => {
  it("initializes with instructions matching this credential's scopes", async () => {
    const readOnly = await tokenFor(BOB, { name: "reader", scopes: ["read"] });
    const publish = await tokenFor(BOB, { name: "publisher", scopes: ["read", "publish"] });
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    };

    const readRes = await rpc(readOnly.token, message);
    expect(readRes.status).toBe(200);
    const readBody = await json(readRes);
    expect(readBody.jsonrpc).toBe("2.0");
    expect(readBody.id).toBe(1);
    expect(readBody.result.protocolVersion).toBe("2025-06-18");
    expect(readBody.result.serverInfo.name).toBe("rtfx");
    expect(readBody.result.capabilities.tools).toBeTruthy();
    expect(readBody.result.instructions).toBe(HTTP_READ_ONLY_INSTRUCTIONS);
    expect(readBody.result.instructions).toContain('exposes "doctor" only');

    const publishBody = await json(await rpc(publish.token, message));
    expect(publishBody.result.instructions).toBe(HTTP_INSTRUCTIONS);
    expect(publishBody.result.instructions).toContain("PUBLISHING HERE MEANS SENDING CONTENT");
  });

  it("falls back to the latest revision it speaks for an unknown one", async () => {
    const { token } = await tokenFor(BOB);
    const body = await json(
      await rpc(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } })
    );
    expect(body.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(body.result.protocolVersion);
  });

  it("acknowledges a notification with 202 and no body", async () => {
    const { token } = await tokenFor(BOB);
    const res = await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("answers ping, and the empty resource/prompt lists a client probes for", async () => {
    const { token } = await tokenFor(BOB);
    expect((await json(await rpc(token, { jsonrpc: "2.0", id: 1, method: "ping" }))).result).toEqual({});
    expect(
      (await json(await rpc(token, { jsonrpc: "2.0", id: 2, method: "resources/list" }))).result
    ).toEqual({ resources: [] });
    expect(
      (await json(await rpc(token, { jsonrpc: "2.0", id: 3, method: "prompts/list" }))).result
    ).toEqual({ prompts: [] });
  });

  it("reports the standard JSON-RPC errors, with the id it was given", async () => {
    const { token } = await tokenFor(BOB);

    const unknownMethod = await json(await rpc(token, { jsonrpc: "2.0", id: 7, method: "wallet/drain" }));
    expect(unknownMethod.id).toBe(7);
    expect(unknownMethod.error.code).toBe(-32601);

    const parse = await json(await rpc(token, "{not json"));
    expect(parse.error.code).toBe(-32700);

    const batch = await json(await rpc(token, [{ jsonrpc: "2.0", id: 1, method: "ping" }]));
    expect(batch.error.code).toBe(-32600);

    const scalar = await json(await rpc(token, "42"));
    expect(scalar.error.code).toBe(-32600);

    const noMethod = await json(await rpc(token, { jsonrpc: "2.0", id: 9 }));
    expect(noMethod.error.code).toBe(-32600);
  });

  it("refuses a protocol revision it does not speak, at the HTTP layer", async () => {
    const { token } = await tokenFor(BOB);
    const res = await rpc(token, { jsonrpc: "2.0", id: 1, method: "ping" }, {
      headers: { "MCP-Protocol-Version": "1999-01-01" },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("unsupported_protocol_version");

    // …and accepts every revision it advertises.
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      const ok = await rpc(token, { jsonrpc: "2.0", id: 1, method: "ping" }, {
        headers: { "MCP-Protocol-Version": version },
      });
      expect(ok.status, version).toBe(200);
    }
  });

  it("is POST-only: no SSE stream to GET, no session to DELETE", async () => {
    const { token } = await tokenFor(BOB);
    for (const method of ["GET", "DELETE", "PUT", "PATCH"]) {
      const res = await req(MCP_PATH, withToken(token, { method }));
      expect(res.status, method).toBe(405);
      expect(res.headers.get("Allow"), method).toContain("POST");
      expect((await json(res)).error, method).toBe("method_not_allowed");
    }
  });

  it("requires JSON, and caps the message size", async () => {
    const { token } = await tokenFor(BOB);

    const wrongType = await req(MCP_PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(wrongType.status).toBe(415);

    const huge = await rpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: { pad: "x".repeat(MAX_MCP_BODY_BYTES + 1) },
    });
    expect(huge.status).toBe(413);
    expect((await json(huge)).error).toBe("payload_too_large");
  });
});

// --- The tool surface --------------------------------------------------------

describe("the remote tool surface", () => {
  it("exposes doctor and publish to a token with publish scope", async () => {
    const { token } = await tokenFor(BOB, { name: "publisher", scopes: ["read", "publish"] });
    const body = await json(await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(body.result.tools.map((t: any) => t.name)).toEqual(["doctor", "publish"]);
    // Closed schemas, so hallucinated arguments are errors and not silent no-ops.
    for (const tool of body.result.tools) expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(body.result.tools[0].annotations.readOnlyHint).toBe(true);
    expect(body.result.tools[1].annotations.readOnlyHint).toBe(false);
    expect(body.result.tools[1].inputSchema.properties.path).toBeUndefined();
    expect(body.result.tools[1].inputSchema.properties.files.items.properties.path).toBeTruthy();
    expect(body.result.tools[1].inputSchema.properties.files.items.properties.content_text).toBeTruthy();
    expect(body.result.tools[1].inputSchema.properties.files.items.properties.content_base64).toBeTruthy();
    expect(body.result.tools[1].inputSchema.properties.files.items.additionalProperties).toBe(false);
    expect(body.result.tools[1].inputSchema.properties.files.items.required).toEqual(["path"]);
    expect(body.result.tools[1].description).toContain("content carried IN THIS REQUEST");
  });

  it("hides publish from a read-only token", async () => {
    const { token } = await tokenFor(BOB, { name: "reader", scopes: ["read"] });
    const body = await json(await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(body.result.tools.map((t: any) => t.name)).toEqual(["doctor"]);
  });

  /**
   * The property that has to survive somebody adding a tool to the stdio server
   * without thinking about this transport: the remote list is a literal, and
   * every stdio tool that is not on it must be genuinely unreachable here.
   */
  it("refuses every tool the stdio server has that this one does not", async () => {
    const { token } = await tokenFor(BOB, { name: "all", scopes: ["read", "publish", "manage"] });
    expect(LOCAL_ONLY_TOOLS.length).toBeGreaterThan(0);
    expect(LOCAL_ONLY_TOOLS).toEqual(
      expect.arrayContaining(["list_artifacts", "get_versions", "rollback", "update_access"])
    );
    expect(LOCAL_ONLY_TOOLS).not.toContain("publish");

    for (const name of LOCAL_ONLY_TOOLS) {
      const body = await json(
        await rpc(token, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { path: "/etc", slug: "x", version: 1, visibility: "everyone" } },
        })
      );
      expect(body.error.code, name).toBe(-32602);
      expect(body.result, name).toBeUndefined();
    }
    // Nothing was published, read or re-addressed on the way through.
    expect(await env.DB.prepare("SELECT slug FROM artifacts").first()).toBeNull();
  });

  /**
   * `publish` is the one an agent will actually reach for, so the refusal has to
   * say where publishing lives instead of just "unknown tool" — and it must never
   * read a path off the server's own filesystem.
   */
  it("tells an agent that reached for publish where publishing actually lives", async () => {
    const { token } = await tokenFor(BOB, { name: "p", scopes: ["read", "publish"] });
    const body = await json(
      await rpc(token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "publish", arguments: { path: "/etc/passwd", slug: "leak" } },
      })
    );
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("cannot read");
    expect(body.error.message).toContain("plugin");
    expect(await env.DB.prepare("SELECT slug FROM artifacts").first()).toBeNull();
  });

  it("refuses an unknown tool, and an argument no tool declares", async () => {
    const { token } = await tokenFor(BOB);
    const unknown = await json(
      await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } })
    );
    expect(unknown.error.code).toBe(-32602);
    expect(unknown.error.message).toContain("doctor");

    const extra = await json(
      await rpc(token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "doctor", arguments: { nope: true } },
      })
    );
    expect(extra.error.code).toBe(-32602);
    expect(extra.error.message).toContain("unknown argument");
  });

  it("matches the stdio server on the tools they both declare unchanged", () => {
    for (const remote of REMOTE_TOOLS) {
      const local = TOOLS.find((t) => t.name === remote.name);
      expect(local, remote.name).toBeTruthy();
      if (remote.name === "doctor") {
        // Same closed, empty schema — the transports must not disagree about what
        // a call named `doctor` may carry.
        expect(remote.inputSchema).toEqual(local!.inputSchema);
      } else if (remote.name === "publish") {
        // Same name, deliberately different contract: remote publishing receives
        // content bytes in the MCP call, never a filesystem path.
        expect(remote.inputSchema.properties?.path).toBeUndefined();
        expect(local!.inputSchema.properties?.path).toBeTruthy();
      }
    }
  });
});


// --- publish -----------------------------------------------------------------

describe("publish", () => {
  const call = (token: string, args: Record<string, unknown>) =>
    rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "publish", arguments: args } });
  const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

  it("publishes a single HTML page from content_text", async () => {
    const { token } = await tokenFor(BOB, { name: "p", scopes: ["read", "publish"] });
    const body = await json(
      await call(token, {
        slug: "remote-page",
        title: "Remote Page",
        content_text: "<!doctype html><html><body><h1>Remote publish</h1></body></html>",
      })
    );

    expect(body.error).toBeUndefined();
    const facts = JSON.parse(body.result.content[body.result.content.length - 1].text);
    expect(facts.ok).toBe(true);
    expect(facts.command).toBe("publish");
    expect(facts.transport).toBe("http");
    expect(facts.slug).toBe("remote-page");
    expect(facts.version).toBe(1);
    expect(facts.type).toBe("single");
    expect(facts.files).toEqual(["index.html"]);
    expect(facts.url).toContain("/remote-page/");

    const row = await env.DB.prepare("SELECT slug, type, file_count, owner_email, current_version FROM artifacts WHERE slug = ?")
      .bind("remote-page")
      .first<any>();
    expect(row).toMatchObject({ slug: "remote-page", type: "single", file_count: 1, owner_email: BOB, current_version: 1 });
    expect(await env.FILES.get("remote-page/v1/index.html")).toBeTruthy();
  });

  it("publishes PDF bytes from padded or unpadded base64, and accepts text/html for plain text", async () => {
    const { token } = await tokenFor(BOB, { name: "p", scopes: ["read", "publish"] });
    const pdfBytes = strToU8("%PDF-1.7\n% minimal test pdf\n%%EOF");
    const pdf = await json(
      await call(token, {
        slug: "remote-pdf",
        title: "Remote PDF",
        content_base64: base64(pdfBytes).replace(/=+$/, ""),
        content_type: "application/pdf",
      })
    );
    const pdfFacts = JSON.parse(pdf.result.content[pdf.result.content.length - 1].text);
    expect(pdfFacts.type).toBe("pdf");
    expect(pdfFacts.files).toEqual(["document.pdf"]);
    expect(await env.FILES.get("remote-pdf/v1/document.pdf")).toBeTruthy();

    const textHtml = await json(
      await call(token, {
        slug: "remote-plain-html",
        title: "Remote Plain HTML",
        content_text: "Hello world",
        content_type: "text/html",
      })
    );
    const htmlFacts = JSON.parse(textHtml.result.content[textHtml.result.content.length - 1].text);
    expect(htmlFacts.type).toBe("single");
    expect(await env.FILES.get("remote-plain-html/v1/index.html")).toBeTruthy();
  });

  it("appends a new version when publishing content to the same slug", async () => {
    const { token } = await tokenFor(BOB, { name: "p", scopes: ["read", "publish"] });
    await call(token, { slug: "versioned", title: "Versioned", content_text: "<h1>v1</h1>" });
    const body = await json(await call(token, { slug: "versioned", content_text: "<h1>v2</h1>", note: "second" }));
    const facts = JSON.parse(body.result.content[body.result.content.length - 1].text);
    expect(facts.version).toBe(2);
    expect(await env.FILES.get("versioned/v1/index.html")).toBeTruthy();
    expect(await env.FILES.get("versioned/v2/index.html")).toBeTruthy();
  });

  it("publishes a small multi-file site from explicit inline files", async () => {
    const { token } = await tokenFor(BOB, { name: "p", scopes: ["read", "publish"] });
    const body = await json(
      await call(token, {
        slug: "remote-site",
        title: "Remote Site",
        files: [
          { path: "index.html", content_text: "<h1>home</h1><script src=\"app.js\"></script>" },
          { path: "app.js", content_text: "console.log('ok')" },
        ],
      })
    );
    const facts = JSON.parse(body.result.content[body.result.content.length - 1].text);
    expect(facts.type).toBe("bundle");
    expect(facts.file_count).toBe(2);
    expect(facts.files).toEqual(["index.html", "app.js"]);
    expect(await env.FILES.get("remote-site/v1/index.html")).toBeTruthy();
    expect(await env.FILES.get("remote-site/v1/app.js")).toBeTruthy();
  });

  it("rejects missing publish scope and path-shaped remote publishing", async () => {
    const readOnly = await tokenFor(BOB, { name: "r", scopes: ["read"] });
    const insufficient = await json(await call(readOnly.token, { slug: "no", title: "No", content_text: "<h1>no</h1>" }));
    expect(insufficient.result.isError).toBe(true);
    expect(insufficient.result.content[0].text).toContain("publish");

    const publisher = await tokenFor(BOB, { name: "p", scopes: ["read", "publish"] });
    const pathAttempt = await json(
      await call(publisher.token, { slug: "leak", title: "Leak", path: "/etc/passwd", content_text: "<h1>x</h1>" })
    );
    expect(pathAttempt.error.code).toBe(-32602);
    expect(pathAttempt.error.message).toContain("SERVER's disk");
    expect(await env.DB.prepare("SELECT slug FROM artifacts WHERE slug IN ('no', 'leak')").first()).toBeNull();
  });

  it("surfaces shared API publish refusals as stable tool errors", async () => {
    const bob = await tokenFor(BOB, { name: "bob", scopes: ["read", "publish"] });
    await call(bob.token, { slug: "owned", title: "Owned", content_text: "<h1>owner</h1>" });

    const carol = await tokenFor("carol@gamma.com", { name: "carol", scopes: ["read", "publish"] });
    const taken = await json(await call(carol.token, { slug: "owned", title: "Taken", content_text: "<h1>take</h1>" }));
    expect(taken.result.isError).toBe(true);
    const payload = JSON.parse(taken.result.content[1].text);
    expect(payload.error).toBe("slug_taken");
    expect(payload.status).toBe(409);
  });

  it("rejects unsafe inline bundle paths and oversized inline content", async () => {
    const { token } = await tokenFor(BOB, { name: "p", scopes: ["read", "publish"] });
    const secret = await json(
      await call(token, {
        slug: "secret-site",
        title: "Secret Site",
        files: [
          { path: "index.html", content_text: "<h1>ok</h1>" },
          { path: ".env", content_text: "TOKEN=secret" },
        ],
      })
    );
    expect(secret.result.isError).toBe(true);
    expect(secret.result.content[0].text).toContain("refusing to publish");
    expect(JSON.parse(secret.result.content[1].text).error).toBe("bad_request");

    const traversal = await json(
      await call(token, {
        slug: "traversal-site",
        title: "Traversal Site",
        files: [
          { path: "index.html", content_text: "<h1>ok</h1>" },
          { path: "../secret.txt", content_text: "no" },
        ],
      })
    );
    expect(traversal.result.isError).toBe(true);
    expect(traversal.result.content[0].text).toContain("unsafe or invalid file path");

    const tooMany = await json(
      await call(token, {
        slug: "too-many-files",
        title: "Too Many Files",
        files: Array.from({ length: 51 }, (_, i) => ({ path: i === 0 ? "index.html" : `f${i}.txt`, content_text: "x" })),
      })
    );
    expect(tooMany.error.code).toBe(-32602);
    expect(tooMany.error.message).toContain("files");

    const tooLargeFiles = await json(
      await call(token, {
        slug: "too-large-files",
        title: "Too Large Files",
        files: [
          { path: "index.html", content_text: "x".repeat(3 * 1024 * 1024) },
          { path: "app.js", content_text: "x".repeat(3 * 1024 * 1024) },
        ],
      })
    );
    expect(tooLargeFiles.result.isError).toBe(true);
    expect(tooLargeFiles.result.content[0].text).toContain("max total size");

    const hugeRes = await call(token, { slug: "huge", title: "Huge", content_text: "x".repeat(MAX_MCP_BODY_BYTES) });
    expect(hugeRes.status).toBe(413);
    expect((await json(hugeRes)).error).toBe("payload_too_large");
  });

  it("rejects invalid base64, zip bytes, content-type mismatches and ambiguous content choices", async () => {
    const { token } = await tokenFor(BOB, { name: "p", scopes: ["read", "publish"] });

    const badBase64 = await json(
      await call(token, { slug: "bad-base64", title: "Bad Base64", content_base64: "@@not-base64@@" })
    );
    expect(badBase64.result.isError).toBe(true);
    expect(badBase64.result.content[0].text).toContain("not valid base64");
    expect(JSON.parse(badBase64.result.content[1].text).error).toBe("invalid_base64");

    const zipped = zipSync({ "index.html": strToU8("<h1>zip</h1>") });
    const zip = await json(await call(token, { slug: "zip-inline", title: "Zip Inline", content_base64: base64(zipped) }));
    expect(zip.result.isError).toBe(true);
    expect(zip.result.content[0].text).toContain("zip archive");

    const bothSingle = await json(
      await call(token, { slug: "both-single", title: "Both", content_text: "x", content_base64: base64(strToU8("x")) })
    );
    expect(bothSingle.result.isError).toBe(true);
    expect(bothSingle.result.content[0].text).toContain("both content_text and content_base64");

    const filesAndSingle = await json(
      await call(token, {
        slug: "files-and-single",
        title: "Both",
        content_text: "x",
        files: [{ path: "index.html", content_text: "<h1>ok</h1>" }],
      })
    );
    expect(filesAndSingle.result.isError).toBe(true);
    expect(filesAndSingle.result.content[0].text).toContain("not both");

    const mismatch = await json(
      await call(token, {
        slug: "mismatch",
        title: "Mismatch",
        content_text: "%PDF-1.7 fake",
        content_type: "text/html",
      })
    );
    expect(mismatch.result.isError).toBe(true);
    expect(mismatch.result.content[0].text).toContain("content_type says text/html");
    expect(JSON.parse(mismatch.result.content[1].text).error).toBe("content_type_mismatch");

    expect(
      await env.DB.prepare(
        "SELECT slug FROM artifacts WHERE slug IN ('bad-base64', 'mismatch', 'zip-inline', 'both-single', 'files-and-single')"
      ).first()
    ).toBeNull();
  });
});

// --- doctor ------------------------------------------------------------------

describe("doctor", () => {
  const call = (token: string) =>
    rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "doctor" } });

  it("reports the connection, and counts what the token can read", async () => {
    const { token, id } = await tokenFor(BOB, { name: "d", scopes: ["read", "publish"] });
    await req(
      "/api/machine/artifacts",
      withToken(token, { method: "POST", body: htmlForm({ title: "one", slug: "one" }, "x.html", strToU8("<h1>hi</h1>")) })
    );

    const body = await json(await call(token));
    const facts = JSON.parse(body.result.content[body.result.content.length - 1].text);
    expect(facts.ok).toBe(true);
    expect(facts.command).toBe("doctor");
    expect(facts.transport).toBe("http");
    expect(facts.token_id).toBe(id);
    expect(facts.token).toBe(`rtfx_${id}_…`);
    expect(facts.scopes).toEqual(["read", "publish"]);
    expect(facts.auth).toBe("bearer_token");
    expect(facts.oauth).toBe("authorization_code");
    expect(facts.oauth_protected_resource).toContain(
      "/.well-known/oauth-protected-resource/mcp"
    );
    expect(facts.oauth_authorization_server).toContain(
      "/.well-known/oauth-authorization-server"
    );
    expect(facts.publish_supported).toBe(true);
    expect(facts.tools).toEqual(["doctor", "publish"]);
    expect(facts.reachable).toBe(true);
    expect(facts.artifact_count).toBe(1);
    expect(facts.content_base).toBeTruthy();
    // A person-readable line first, JSON second — the stdio server's shape.
    expect(body.result.content[0].text).toContain("endpoint");
    expect(body.result.isError).toBeUndefined();
  });

  /** The rule the whole credential story rests on: the secret never comes back. */
  it("never echoes the token, in any part of the response", async () => {
    const { token } = await tokenFor(BOB, { name: "d" });
    const res = await call(token);
    const text = await res.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.split("_")[2]);
    for (const value of res.headers.values()) expect(value).not.toContain(token);
  });

  it("works without the read scope, and says nothing was listed", async () => {
    const { token } = await tokenFor(BOB, { name: "write-only", scopes: ["publish"] });
    const body = await json(await call(token));
    const facts = JSON.parse(body.result.content[body.result.content.length - 1].text);
    expect(facts.scopes).toEqual(["publish"]);
    expect(facts.artifact_count).toBeNull();
    expect(body.result.content[0].text).toContain("no \"read\" scope");
  });

  it("counts only what the caller may reach, not the instance", async () => {
    await req("/api/artifacts", as(ADMIN, { method: "POST", body: htmlForm({ title: "a", slug: "admins" }, "x.html", strToU8("<p>a</p>")) }));
    const { token } = await tokenFor(BOB, { name: "bobs" });
    const body = await json(await call(token));
    const facts = JSON.parse(body.result.content[body.result.content.length - 1].text);
    expect(facts.artifact_count).toBe(0);
  });
});

// --- Authentication ----------------------------------------------------------

describe("the gate is the machine surface's gate", () => {
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

  it("refuses a request with no credential, with a Bearer challenge", async () => {
    const res = await rpc(null, ping);
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("unauthorized");
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  /**
   * The honesty check, now pointing the other way. MCP clients read
   * `resource_metadata` off this header and go looking for the document it
   * names; naming one we did not serve would send every compliant client into a
   * discovery 404. So the assertion is not "the header contains a URL" but "the
   * URL in the header is fetchable and describes this endpoint".
   */
  it("advertises a protected-resource document that it actually serves", async () => {
    const challenge = (await rpc(null, ping)).headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain("Bearer");

    const named = /resource_metadata="([^"]+)"/.exec(challenge);
    expect(named, challenge).not.toBeNull();
    const url = new URL(named![1]);
    expect(url.pathname).toBe("/.well-known/oauth-protected-resource/mcp");

    const doc = await req(url.pathname);
    expect(doc.status).toBe(200);
    const body = await doc.json<any>();
    expect(new URL(body.resource).pathname).toBe(MCP_PATH);
    expect(body.authorization_servers).toEqual([url.origin]);
  });

  /**
   * The challenge is built from the origin the request arrived on, not from a
   * configured base URL: a client talking to a preview host must be sent to that
   * host's documents, or audience validation compares two different strings.
   */
  it("names the origin the request actually arrived on", async () => {
    const res = await app.request(
      "https://preview.example.com/mcp",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ping) },
      env as any
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://preview.example.com/.well-known/oauth-protected-resource/mcp"'
    );
  });

  /** Discovery documents we deliberately do not serve stay unserved. */
  it("serves no OpenID configuration", async () => {
    expect((await req("/.well-known/openid-configuration")).status).not.toBe(200);
  });

  it("refuses an unknown, malformed, revoked or expired token", async () => {
    expect((await rpc("nonsense", ping)).status).toBe(401);
    const unknown = await rpc("rtfx_deadbeefdead_notarealtokenatall", ping);
    expect(unknown.status).toBe(401);
    expect((await json(unknown)).error).toBe("invalid_token");

    const { token, id } = await tokenFor(BOB, { name: "doomed" });
    expect((await rpc(token, ping)).status).toBe(200);
    await req(`/api/tokens/${id}`, as(BOB, { method: "DELETE" }));
    expect((await rpc(token, ping)).status).toBe(401);

    const expiring = await tokenFor(BOB, { name: "expiring", expires_in_days: 1 });
    await env.DB.prepare("UPDATE api_tokens SET expires_at = ? WHERE name = 'expiring'")
      .bind("2020-01-01T00:00:00.000Z")
      .run();
    expect((await rpc(expiring.token, ping)).status).toBe(401);
  });

  /**
   * The CSRF property, inherited from `/api/machine`. `/mcp` is meant to be
   * reachable without Cloudflare Access in front of it, so honouring a session
   * identity would let any website drive a signed-in person's browser into it.
   * A browser attaches cookies by itself and never an `Authorization` header.
   */
  it("refuses a signed-in browser identity, and an Access service token", async () => {
    const session = await req(MCP_PATH, as(ADMIN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ping),
    }));
    expect(session.status).toBe(401);

    const serviceToken = await req(MCP_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Access-Client-Id": "admin-token.access",
        "CF-Access-Client-Secret": "not-a-real-secret",
        "Cf-Access-Jwt-Assertion": "header.payload.signature",
        Cookie: "CF_Authorization=header.payload.signature",
      },
      body: JSON.stringify(ping),
    });
    expect(serviceToken.status).toBe(401);
  });

  it("refuses a paused account's token, and says why", async () => {
    const { token } = await tokenFor(BOB, { name: "soon-paused" });
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users (email, role, status, created_at, disabled_at)
       VALUES (?, 'member', 'disabled', ?, ?)
       ON CONFLICT(email) DO UPDATE SET status = 'disabled', disabled_at = excluded.disabled_at`
    )
      .bind(BOB, now, now)
      .run();
    const res = await rpc(token, ping);
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("account_disabled");
  });

  /** Authentication comes before any protocol work — an anonymous caller learns nothing. */
  it("authenticates before it parses anything", async () => {
    const res = await rpc(null, "{not json");
    expect(res.status).toBe(401);
    const listed = await rpc(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.status).toBe(401);
    expect((await json(listed)).result).toBeUndefined();
  });
});

// --- Origins and hosts -------------------------------------------------------

describe("origins and hosts", () => {
  const APP_ORIGIN = "http://localhost"; // what app.request() synthesizes
  const FOREIGN = "https://evil.example.com";
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

  it("answers a preflight before the gate, naming only a first-party origin", async () => {
    const res = await req(MCP_PATH, {
      method: "OPTIONS",
      headers: {
        Origin: APP_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Vary")).toContain("Origin");
    expect(await res.text()).toBe("");
  });

  it("never wildcards the allowed origin", async () => {
    for (const origin of [undefined, FOREIGN]) {
      const res = await req(MCP_PATH, {
        method: "OPTIONS",
        headers: { ...(origin ? { Origin: origin } : {}), "Access-Control-Request-Method": "POST" },
      });
      expect(res.status, String(origin)).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin"), String(origin)).not.toBe("*");
      expect(res.headers.get("Access-Control-Allow-Origin"), String(origin)).toBeNull();
    }
  });

  /**
   * DNS-rebinding protection, which the MCP specification asks every HTTP
   * transport to implement. A foreign `Origin` is refused outright rather than
   * merely denied CORS headers — a valid bearer token presented from a page we
   * do not control is still a request we have no reason to answer.
   */
  it("refuses a request from an origin it does not recognize, even with a valid token", async () => {
    const { token } = await tokenFor(BOB);
    const res = await rpc(token, ping, { headers: { Origin: FOREIGN } });
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("forbidden_origin");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();

    // The ordinary client — Claude Code, curl — sends no Origin at all.
    expect((await rpc(token, ping)).status).toBe(200);
    const sameOrigin = await rpc(token, ping, { headers: { Origin: APP_ORIGIN } });
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
  });

  /**
   * Host isolation. The content host serves uploaded HTML; it must never route
   * to an endpoint that authenticates a product credential, or a published page
   * could reach the API that manages it from its own origin.
   */
  /**
   * The other half of the same rule, and the one the onboarding command depends
   * on: `mcp.rtfx.pro` is an *app* host (wrangler.jsonc), so it answers `/mcp`
   * fully — and its own origin is a recognized one, which is what lets the OAuth
   * consent screen served there POST back to itself.
   */
  it("is served by the dedicated MCP host, whose origin it recognizes", async () => {
    const { token } = await tokenFor(BOB);
    const e = { ...env, CONTENT_HOSTNAMES: "a.rtfx.pro", PUBLIC_BASE_URL: "https://rtfx.pro" } as any;
    const send = (headers: Record<string, string> = {}) =>
      app.request(
        `https://mcp.rtfx.pro${MCP_PATH}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
          body: JSON.stringify(ping),
        },
        e
      );

    const res = await send();
    expect(res.status).toBe(200);
    expect((await res.json<any>()).result).toEqual({});

    const own = await send({ Origin: "https://mcp.rtfx.pro" });
    expect(own.status).toBe(200);
    expect(own.headers.get("Access-Control-Allow-Origin")).toBe("https://mcp.rtfx.pro");

    // The content host is still not an origin it will answer for, from here or
    // anywhere else.
    const fromContent = await send({ Origin: "https://a.rtfx.pro" });
    expect(fromContent.status).toBe(403);
  });

  it("is not served by the content host", async () => {
    const { token } = await tokenFor(BOB);
    const contentEnv = { ...env, CONTENT_HOSTNAMES: "a.test.local" } as any;
    const res = await app.request(
      `https://a.test.local${MCP_PATH}`,
      { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(ping) },
      contentEnv
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");

    // …and a content host is never an allowed CORS origin for it either.
    const preflight = await app.request(
      MCP_PATH,
      { method: "OPTIONS", headers: { Origin: "https://a.test.local", "Access-Control-Request-Method": "POST" } },
      contentEnv
    );
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
