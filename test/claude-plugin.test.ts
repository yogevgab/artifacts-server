import { describe, it, expect, beforeEach } from "vitest";
import { unzipSync, deflateSync, strToU8, strFromU8 } from "fflate";
import app from "../src/index";
import { initDb, clearR2, req, as, withToken, htmlForm } from "./fixtures";
import {
  DEFAULT_ENDPOINT,
  MACHINE_API_PREFIX,
  TOKEN_VAR,
  describeNonJsonResponse,
  machineApiPath,
  shouldRetryOnLegacyApi,
  INCLUDE,
  SKIP_DIR,
  SKIP_FILE,
  SKIP_SECRET,
  classifyEntry,
  isSensitivePath,
  resolveEndpoint,
  resolveConfig,
  authHeaders,
  apiUrl,
  parseArgs,
  createZip,
  crc32,
  describeApiError,
  publishSummary,
  redactToken,
  tokenId,
  SOURCE_ENV,
  SOURCE_OAUTH,
  SOURCE_NONE,
} from "../plugins/rtfx/scripts/rtfx.lib.mjs";
import {
  LOGIN_SCOPES,
  authorizationCodeForm,
  authorizeUrl,
  credentialFromTokenResponse,
  credentialsPath,
  describeCredential,
  emptyStore,
  getCredential,
  isStoreEmpty,
  issuerFor,
  metadataUrl,
  needsRefresh,
  parseCallback,
  parseMetadata,
  parseStore,
  putCredential,
  refreshCredential,
  registrationRequest,
  removeCredential,
  resourceFor,
  revokeForm,
  serializeStore,
} from "../plugins/rtfx/scripts/rtfx.oauth.lib.mjs";
import {
  parseFrontmatter,
  findSecrets,
  checkPluginManifest,
  checkMarketplace,
  checkMarketplaceEntryMatchesManifest,
  checkMarketplaceUrls,
  checkCommand,
  checkSkill,
  checkSkillNameMatchesDir,
  checkPluginRootRefs,
  checkChangelog,
  checkCommunityMarketplaceClaims,
  checkSubmissionPacket,
} from "../scripts/validate-plugin.lib.mjs";

/**
 * Issue #25: the Claude Code plugin. Three things are worth pinning here.
 *
 *  1. The plugin ships standalone, so it writes its own zip container instead of
 *     depending on fflate. That container is fed through the *real* upload path
 *     below — the server is the only judge of whether it is a valid bundle.
 *  2. Its configuration surface is exactly RTFX_API_TOKEN plus an endpoint. A
 *     regression that started requiring a Cloudflare credential would be a
 *     product change disguised as a refactor.
 *  3. The artifact URL is never assembled client-side. The API now returns it on
 *     every route that reports on an artifact, and these tests hold that.
 *
 * Structural validation of the plugin *files* lives in `npm run validate:plugin`
 * (the Workers pool has no filesystem); the rules it applies are unit-tested here.
 */

describe("plugin config resolution", () => {
  it("defaults to rtfx.pro and prefers ARTIFACTS_URL over RTFX_URL", () => {
    expect(resolveEndpoint({})).toBe(DEFAULT_ENDPOINT);
    expect(resolveEndpoint({ RTFX_URL: "https://rtfx.example" })).toBe("https://rtfx.example");
    expect(
      resolveEndpoint({ ARTIFACTS_URL: "https://a.example", RTFX_URL: "https://b.example" })
    ).toBe("https://a.example");
  });

  it("trims trailing slashes so URL joining can't double them", () => {
    expect(resolveEndpoint({ ARTIFACTS_URL: "https://x.example///" })).toBe("https://x.example");
    expect(apiUrl("https://x.example", "/api/artifacts")).toBe("https://x.example/api/artifacts");
    expect(apiUrl("https://x.example/", "api/artifacts")).toBe("https://x.example/api/artifacts");
  });

  it("rejects a non-URL or non-http endpoint instead of failing at fetch time", () => {
    expect(() => resolveEndpoint({ ARTIFACTS_URL: "not a url" })).toThrow(/not a valid URL/);
    expect(() => resolveEndpoint({ ARTIFACTS_URL: "ftp://x.example" })).toThrow(/http/);
  });

  it("needs only a bearer token; Access headers are optional pass-through", () => {
    const bare = resolveConfig({ [TOKEN_VAR]: "rtfx_abc123_secretvalue" });
    expect(bare.hasToken).toBe(true);
    expect(bare.access).toBeNull();
    expect(authHeaders(bare)).toEqual({ Authorization: "Bearer rtfx_abc123_secretvalue" });

    const gated = resolveConfig({
      [TOKEN_VAR]: "rtfx_abc123_secretvalue",
      CF_ACCESS_CLIENT_ID: "id.access",
      CF_ACCESS_CLIENT_SECRET: "shh",
    });
    expect(authHeaders(gated)).toEqual({
      Authorization: "Bearer rtfx_abc123_secretvalue",
      "CF-Access-Client-Id": "id.access",
      "CF-Access-Client-Secret": "shh",
    });
  });

  it("half-configured Access headers are ignored rather than sent broken", () => {
    const cfg = resolveConfig({ [TOKEN_VAR]: "rtfx_a_b", CF_ACCESS_CLIENT_ID: "id.access" });
    expect(cfg.access).toBeNull();
    expect(authHeaders(cfg)).not.toHaveProperty("CF-Access-Client-Id");
  });

  it("takes no Cloudflare account credential from the environment", () => {
    const cfg = resolveConfig({ [TOKEN_VAR]: "rtfx_a_b", CF_API_TOKEN: "should-be-ignored" });
    expect(JSON.stringify(cfg)).not.toContain("should-be-ignored");
    expect(JSON.stringify(authHeaders(cfg))).not.toContain("should-be-ignored");
  });

  it("only ever exposes a token's id, never its secret", () => {
    const token = "rtfx_9f2c1ab30d4e_Xj7superSecretTail";
    expect(tokenId(token)).toBe("9f2c1ab30d4e");
    expect(redactToken(token)).toBe("rtfx_9f2c1ab30d4e_…");
    expect(redactToken(token)).not.toContain("Xj7superSecretTail");
    expect(redactToken("garbage")).toBe("(unrecognised token format)");
  });

  it("uses a stored OAuth access token only when no env token is set", () => {
    const credential = {
      issuer: "https://rtfx.pro",
      access_token: "rtfx_oauthid_storedSecret",
      refresh_token: "rtfxr_refreshSecret",
      expires_at: "2099-01-01T00:00:00.000Z",
      scopes: ["rtfx:read", "rtfx:publish"],
    };
    const stored = resolveConfig({}, { credential });
    expect(stored.source).toBe(SOURCE_OAUTH);
    expect(authHeaders(stored)).toEqual({ Authorization: "Bearer rtfx_oauthid_storedSecret" });

    const envWins = resolveConfig({ [TOKEN_VAR]: "rtfx_envid_envSecret" }, { credential });
    expect(envWins.source).toBe(SOURCE_ENV);
    expect(envWins.credential).toBeNull();
    expect(authHeaders(envWins)).toEqual({ Authorization: "Bearer rtfx_envid_envSecret" });

    expect(resolveConfig({}).source).toBe(SOURCE_NONE);
  });
});

describe("plugin OAuth credential helpers", () => {
  it("keys credentials by issuer and stores only the matching entry", () => {
    expect(issuerFor("https://rtfx.pro/mcp")).toBe("https://rtfx.pro");
    expect(resourceFor("https://rtfx.pro")).toBe("https://rtfx.pro/mcp");
    expect(credentialsPath({ XDG_CONFIG_HOME: "/tmp/cfg" }, "/home/me")).toBe("/tmp/cfg/rtfx/credentials.json");

    const credential = { issuer: "https://rtfx.pro", access_token: "rtfx_a_secret" };
    const store = putCredential(emptyStore(), "https://rtfx.pro", credential);
    expect(getCredential(store, "https://rtfx.pro")).toBe(credential);
    expect(getCredential(store, "https://other.example")).toBeNull();
    expect(isStoreEmpty(removeCredential(store, "https://rtfx.pro"))).toBe(true);
  });

  it("round-trips the store and ignores corrupt/non-credential entries", () => {
    const store = putCredential(emptyStore(), "https://rtfx.pro", {
      issuer: "https://rtfx.pro",
      access_token: "rtfx_abc_secret",
    });
    const parsed = parseStore(serializeStore(store));
    expect(parsed.version).toBe(1);
    expect(getCredential(parsed, "https://rtfx.pro")?.access_token).toBe("rtfx_abc_secret");
    expect(parseStore("not json")).toEqual(emptyStore());
    expect(parseStore(JSON.stringify({ credentials: { bad: { refresh_token: "rtfxr_x" } } }))).toEqual(emptyStore());
  });

  it("builds safe OAuth requests and validates callback state", () => {
    const registration = registrationRequest(["http://127.0.0.1:1234/callback"]);
    expect(registration.token_endpoint_auth_method).toBe("none");
    expect(registration.scope).toBe(LOGIN_SCOPES.join(" "));

    const url = authorizeUrl({
      authorizationEndpoint: "https://rtfx.pro/oauth/authorize",
      clientId: "client_1",
      redirectUri: "http://127.0.0.1:1234/callback",
      scopes: LOGIN_SCOPES,
      state: "state123",
      challenge: "challenge123",
      resource: "https://rtfx.pro/mcp",
    });
    const params = new URL(url).searchParams;
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("resource")).toBe("https://rtfx.pro/mcp");

    expect(parseCallback("/callback?state=state123&code=code123", "state123")).toEqual({
      ok: true,
      code: "code123",
      issuer: null,
    });
    const mismatched = parseCallback("/callback?state=wrong&code=code123", "state123");
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.error).toBe("state_mismatch");

    expect(authorizationCodeForm({ clientId: "client_1", code: "code", codeVerifier: "verifier", redirectUri: "http://127.0.0.1/cb" })).toContain("grant_type=authorization_code");
    expect(revokeForm("rtfx_abc_secret")).toBe("token=rtfx_abc_secret");
  });

  it("rejects discovery endpoints that move token exchange off-origin", () => {
    expect(metadataUrl("https://rtfx.pro")).toBe("https://rtfx.pro/.well-known/oauth-authorization-server");
    expect(() =>
      parseMetadata(
        {
          authorization_endpoint: "https://rtfx.pro/oauth/authorize",
          token_endpoint: "https://evil.example/token",
        },
        "https://rtfx.pro"
      )
    ).toThrow(/token_endpoint/);

    const parsed = parseMetadata(
      {
        authorization_endpoint: "https://rtfx.pro/oauth/authorize",
        token_endpoint: "https://rtfx.pro/oauth/token",
        registration_endpoint: "https://rtfx.pro/oauth/register",
        revocation_endpoint: "https://rtfx.pro/oauth/revoke",
        code_challenge_methods_supported: ["S256"],
      },
      "https://rtfx.pro"
    );
    expect(parsed.token_endpoint).toBe("https://rtfx.pro/oauth/token");
  });

  it("summarizes and refreshes credentials without exposing secrets", async () => {
    const now = Date.parse("2026-08-15T12:00:00.000Z");
    const credential = credentialFromTokenResponse(
      {
        access_token: "rtfx_1234_accessSecret",
        refresh_token: "rtfxr_refreshSecret",
        expires_in: 3600,
        scope: "rtfx:read rtfx:publish",
      },
      { issuer: "https://rtfx.pro", clientId: "client_1", endpoints: { token_endpoint: "https://rtfx.pro/oauth/token" }, nowMs: now }
    );
    expect(needsRefresh(credential, now + 30 * 60 * 1000)).toBe(false);
    expect(needsRefresh(credential, now + 59 * 60 * 1000)).toBe(true);
    const described = describeCredential(credential)!;
    expect(described.token).toBe("rtfx_1234_…");
    expect(JSON.stringify(describeCredential(credential))).not.toContain("accessSecret");
    expect(JSON.stringify(describeCredential(credential))).not.toContain("refreshSecret");

    const calls: Array<{ url: string; body: string }> = [];
    const refreshed = await refreshCredential({
      credential,
      nowMs: now + 3600 * 1000,
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return new Response(
          JSON.stringify({ access_token: "rtfx_5678_nextSecret", refresh_token: "rtfxr_nextRefresh", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as typeof fetch,
    });
    expect(calls[0].url).toBe("https://rtfx.pro/oauth/token");
    expect(calls[0].body).toContain("grant_type=refresh_token");
    expect(refreshed.access_token).toBe("rtfx_5678_nextSecret");
  });

  it("marks spent refresh tokens as needing a new login", async () => {
    await expect(
      refreshCredential({
        credential: {
          issuer: "https://rtfx.pro",
          client_id: "client_1",
          access_token: "rtfx_old_oldSecret",
          refresh_token: "rtfxr_spent",
          token_endpoint: "https://rtfx.pro/oauth/token",
        },
        nowMs: Date.now(),
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "invalid_grant", error_description: "spent" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
      })
    ).rejects.toMatchObject({ name: "OAuthError", needsLogin: true });
  });
});

describe("plugin argument parsing", () => {
  it("reads --flag value pairs and valueless flags the same way the repo CLI does", () => {
    const { flags, positional, errors } = parseArgs([
      "./dist",
      "--slug",
      "q3-report",
      "--note",
      "revised charts",
      "--json",
    ]);
    expect(positional).toEqual(["./dist"]);
    expect(flags).toEqual({ slug: "q3-report", note: "revised charts", json: true });
    expect(errors).toEqual([]);
  });

  it("reports a value-taking flag left dangling instead of silently dropping it", () => {
    expect(parseArgs(["./dist", "--slug"]).errors).toEqual(["--slug needs a value"]);
  });
});

describe("what the directory walk uploads", () => {
  it("includes ordinary files and directories", () => {
    expect(classifyEntry("index.html", false)).toBe(INCLUDE);
    expect(classifyEntry("assets", true)).toBe(INCLUDE);
    expect(classifyEntry("dist", true)).toBe(INCLUDE);
  });

  it("skips build and VCS directories, so a project root can't become a 413", () => {
    expect(classifyEntry("node_modules", true)).toBe(SKIP_DIR);
    expect(classifyEntry(".git", true)).toBe(SKIP_DIR);
    expect(classifyEntry(".wrangler", true)).toBe(SKIP_DIR);
  });

  it("refuses anything shaped like a credential", () => {
    for (const name of [".env", ".env.production", ".dev.vars", "server.pem", "deploy.key", "id_rsa"]) {
      expect(classifyEntry(name, false), name).toBe(SKIP_SECRET);
    }
  });

  it("drops editor and OS droppings", () => {
    expect(classifyEntry(".DS_Store", false)).toBe(SKIP_FILE);
    expect(classifyEntry("Thumbs.db", false)).toBe(SKIP_FILE);
  });

  it("a directory named like a secret file is still walked, not skipped as one", () => {
    // `.env` as a *directory* is unusual but real; the secret rule is file-only.
    expect(classifyEntry(".env", true)).toBe(INCLUDE);
  });
  it("classifies full archive paths that must not be sent as-is", () => {
    for (const path of [".env", "site/.env", "assets/.git/config", "node_modules/pkg/index.js", "deploy.key", "__MACOSX/._index.html"]) {
      expect(isSensitivePath(path), path).toBe(true);
    }
    expect(isSensitivePath("index.html")).toBe(false);
    expect(isSensitivePath("assets/app.js")).toBe(false);
  });
});

describe("the plugin's zip writer", () => {
  const files = {
    "index.html": strToU8("<h1>hello</h1>"),
    "assets/app.js": strToU8("console.log('x');".repeat(50)),
    "assets/style.css": strToU8("body{margin:0}"),
  };

  it("produces a stored archive fflate can read back exactly", () => {
    const unzipped = unzipSync(createZip(files));
    expect(Object.keys(unzipped).sort()).toEqual(["assets/app.js", "assets/style.css", "index.html"]);
    expect(strFromU8(unzipped["index.html"])).toBe("<h1>hello</h1>");
    expect(strFromU8(unzipped["assets/style.css"])).toBe("body{margin:0}");
  });

  it("produces a deflated archive fflate can read back exactly", () => {
    const zip = createZip(files, { deflate: (bytes) => deflateSync(bytes) });
    const unzipped = unzipSync(zip);
    expect(strFromU8(unzipped["assets/app.js"])).toBe("console.log('x');".repeat(50));
    // The repetitive file must actually have compressed, or the deflate path is dead code.
    expect(zip.length).toBeLessThan(createZip(files).length);
  });

  it("falls back to stored when compression would not shrink an entry", () => {
    // A deflate that always grows its input: every entry must still round-trip.
    const grow = (bytes: Uint8Array) => new Uint8Array(bytes.length + 10);
    const unzipped = unzipSync(createZip(files, { deflate: grow }));
    expect(strFromU8(unzipped["index.html"])).toBe("<h1>hello</h1>");
  });

  it("is deterministic and order-independent", () => {
    const a = createZip(files);
    const b = createZip({
      "assets/style.css": files["assets/style.css"],
      "index.html": files["index.html"],
      "assets/app.js": files["assets/app.js"],
    });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("handles an empty file and refuses an empty archive", () => {
    const unzipped = unzipSync(createZip({ "index.html": strToU8(""), "a.txt": strToU8("x") }));
    expect(unzipped["index.html"].length).toBe(0);
    expect(() => createZip({})).toThrow(/empty zip/);
  });

  it("computes CRC-32 the way the format requires", () => {
    // Standard check value: CRC-32("123456789") === 0xCBF43926.
    expect(crc32(strToU8("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("API error guidance", () => {
  it("marks credential and ownership failures as not retryable", () => {
    for (const status of [400, 401, 403, 404, 409, 413]) {
      expect(describeApiError(status, {}).retryable, String(status)).toBe(false);
      expect(describeApiError(status, {}).hint.length).toBeGreaterThan(10);
    }
  });

  it("distinguishes a scope problem from a paused account", () => {
    expect(describeApiError(403, { error: "insufficient_scope" }).hint).toMatch(/scope/i);
    expect(describeApiError(403, { error: "account_disabled" }).hint).toMatch(/paused/i);
  });

  it("only a server fault is worth retrying", () => {
    expect(describeApiError(503, {}).retryable).toBe(true);
  });

  it("summarises a publish as the fact plus the link", () => {
    expect(
      publishSummary({ slug: "q3", version: 2, type: "bundle", file_count: 3, url: "https://a.rtfx.pro/q3/" })
    ).toBe("published q3 v2 (bundle, 3 files)\nhttps://a.rtfx.pro/q3/");
  });

  it("tells a missing token apart from a rejected one", () => {
    expect(describeApiError(401, { error: "unauthorized" }).hint).toMatch(/No bearer token/);
    expect(describeApiError(401, { error: "invalid_token" }).hint).toMatch(/revoked or expired/);
  });
});

/**
 * The machine surface. `/api` is the dashboard's API and is gated by Cloudflare
 * Access on a real deployment, so a client holding only a bearer token cannot
 * reach it. Everything the plugin does goes to `/api/machine` instead, which
 * takes the bearer token and nothing else.
 */
describe("machine API routing", () => {
  it("rewrites an /api path onto the machine surface and leaves others alone", () => {
    expect(MACHINE_API_PREFIX).toBe("/api/machine");
    expect(machineApiPath("/api/artifacts")).toBe("/api/machine/artifacts");
    expect(machineApiPath("api/artifacts/q3/versions")).toBe("/api/machine/artifacts/q3/versions");
    expect(machineApiPath("/api/artifacts/q3/current")).toBe("/api/machine/artifacts/q3/current");
    // Not an /api path, and — importantly — never doubled up.
    expect(machineApiPath("/health")).toBe("/health");
    expect(machineApiPath("/api/machine/artifacts")).toBe("/api/machine/machine/artifacts");
  });

  it("retries on /api only for the bare 404 of an instance without the surface", () => {
    // A server that has never heard of /api/machine: the framework's own 404.
    expect(shouldRetryOnLegacyApi(404, {})).toBe(true);
    // Every 404 the machine surface produces names itself, and is final: an
    // artifact that isn't yours must not be re-asked for on the gated path.
    expect(shouldRetryOnLegacyApi(404, { error: "not_found" })).toBe(false);
    // Nothing else is ever retried.
    for (const status of [200, 401, 403, 409, 413, 500]) {
      expect(shouldRetryOnLegacyApi(status, {}), String(status)).toBe(false);
    }
  });

  it("names Cloudflare Access as the culprit when a sign-in page comes back", () => {
    const challenged = describeNonJsonResponse(
      "https://rtfx.pro/api/machine/artifacts",
      "https://team.cloudflareaccess.com/cdn-cgi/access/login/rtfx.pro"
    );
    expect(challenged.message).toMatch(/Cloudflare Access/);
    expect(challenged.hint).toMatch(/Bypass/);

    const elsewhere = describeNonJsonResponse(
      "https://rtfx.pro/api/machine/artifacts",
      "https://proxy.example.com/login"
    );
    expect(elsewhere.message).toContain("proxy.example.com");

    // Same origin, just not JSON: no redirect to blame.
    const plain = describeNonJsonResponse(
      "https://rtfx.pro/api/machine/artifacts",
      "https://rtfx.pro/api/machine/artifacts"
    );
    expect(plain.message).toBe("the server did not return JSON");
    expect(plain.hint).toMatch(/ARTIFACTS_URL/);

    // A hostname that merely ends in something similar is not Access.
    expect(
      describeNonJsonResponse("https://rtfx.pro/x", "https://notcloudflareaccess.com.evil.test/x").message
    ).not.toMatch(/Cloudflare Access/);
  });
});

describe("the plugin's bundles against the real upload path", () => {
  beforeEach(async () => {
    await initDb();
    await clearR2();
  });

  /** Post a zip built by the plugin exactly as the plugin posts it. */
  async function publishZip(zip: Uint8Array, fields: Record<string, string>) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set("bundle", new File([zip], "bundle.zip", { type: "application/zip" }));
    return req("/api/artifacts", as("admin@test.com", { method: "POST", body: fd }));
  }

  it("a stored zip is accepted and served", async () => {
    const zip = createZip({
      "index.html": strToU8("<h1>plugin bundle</h1>"),
      "assets/app.js": strToU8("console.log(1)"),
    });
    const res = await publishZip(zip, { slug: "plugin-stored", title: "Plugin Stored" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { url: string; type: string; file_count: number; version: number };
    expect(data.type).toBe("bundle");
    expect(data.file_count).toBe(2);
    expect(data.version).toBe(1);

    const page = await req("/plugin-stored/", as("admin@test.com"));
    expect(await page.text()).toContain("plugin bundle");
    const asset = await req("/plugin-stored/assets/app.js", as("admin@test.com"));
    expect(asset.status).toBe(200);
  });

  it("a deflated zip is accepted and served", async () => {
    const zip = createZip(
      {
        "index.html": strToU8(`<h1>deflated</h1>${"<p>padding</p>".repeat(200)}`),
        "assets/style.css": strToU8("body{margin:0}".repeat(100)),
      },
      { deflate: (bytes) => deflateSync(bytes) }
    );
    const res = await publishZip(zip, { slug: "plugin-deflated", title: "Plugin Deflated" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { file_count: number }).toMatchObject({ file_count: 2 });

    const page = await req("/plugin-deflated/", as("admin@test.com"));
    expect(await page.text()).toContain("deflated");
  });

  it("a bundle with no root index.html is refused, as the skill warns", async () => {
    const zip = createZip({ "readme.txt": strToU8("nope") });
    const res = await publishZip(zip, { slug: "plugin-noindex", title: "No Index" });
    expect(res.status).toBe(400);
  });
});

describe("artifact URLs come from the API, never from the client", () => {
  beforeEach(async () => {
    await initDb();
    await clearR2();
  });

  async function seed(slug: string, body: string) {
    return req(
      "/api/artifacts",
      as("admin@test.com", {
        method: "POST",
        body: htmlForm({ slug, title: slug }, "page.html", strToU8(body)),
      })
    );
  }

  it("publish, versions and rollback all report the same URL", async () => {
    const first = (await (await seed("linked", "<p>v1</p>")).json()) as { url: string };
    await seed("linked", "<p>v2</p>");

    const versions = (await (
      await req("/api/artifacts/linked/versions", as("admin@test.com"))
    ).json()) as { url: string; current: number };
    expect(versions.current).toBe(2);
    expect(versions.url).toBe(first.url);

    const rolled = (await (
      await req(
        "/api/artifacts/linked/current",
        as("admin@test.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: 1 }),
        })
      )
    ).json()) as { url: string; current: number };
    expect(rolled.current).toBe(1);
    expect(rolled.url).toBe(first.url);
  });

  it("the list carries the content origin, so any slug's URL is derivable", async () => {
    await seed("listed", "<p>hi</p>");
    const data = (await (await req("/api/artifacts", as("admin@test.com"))).json()) as {
      artifacts: { slug: string }[];
      content_base: string;
    };
    expect(data.artifacts).toHaveLength(1);
    expect(data.content_base).toMatch(/^https?:\/\//);
    expect(`${data.content_base}/listed/`).toBe(
      ((await (await req("/api/artifacts/listed/versions", as("admin@test.com"))).json()) as { url: string }).url
    );
  });

  it("a publish-scoped API token — what the plugin uses — gets the URL too", async () => {
    const created = (await (
      await req(
        "/api/tokens",
        as("admin@test.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "claude-code", owner_email: "admin@test.com", scopes: ["read", "publish"] }),
        })
      )
    ).json()) as { token: string };

    const res = await req(
      "/api/artifacts",
      withToken(created.token, {
        method: "POST",
        body: htmlForm({ slug: "via-token", title: "Via Token" }, "page.html", strToU8("<p>x</p>")),
      })
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toContain("/via-token/");
  });
});

// --- Rules behind `npm run validate:plugin` ---------------------------------

describe("plugin frontmatter parsing", () => {
  it("splits frontmatter from body and joins wrapped values", () => {
    const parsed = parseFrontmatter("---\nname: x\ndescription: one\n  two\n---\n\nbody here\n");
    expect(parsed?.frontmatter).toEqual({ name: "x", description: "one two" });
    expect(parsed?.body.trim()).toBe("body here");
  });

  it("returns null when there is no frontmatter at all", () => {
    expect(parseFrontmatter("# just markdown")).toBeNull();
    expect(parseFrontmatter("---\nname: unterminated\n")).toBeNull();
  });
});

describe("manifest and marketplace rules", () => {
  const manifest = { name: "rtfx", version: "1.0.0", description: "Publish artifacts to rtfx.pro from a session" };

  it("accepts a well-formed manifest", () => {
    expect(checkPluginManifest(manifest).errors).toEqual([]);
  });

  it("rejects a non-kebab name, a bad version and a stub description", () => {
    expect(checkPluginManifest({ ...manifest, name: "Rtfx Plugin" }).errors[0]).toMatch(/kebab-case/);
    expect(checkPluginManifest({ ...manifest, version: "1.0" }).errors[0]).toMatch(/semver/);
    expect(checkPluginManifest({ ...manifest, description: "short" }).errors[0]).toMatch(/description/);
  });

  it("rejects a marketplace entry pointing at a directory with no plugin", () => {
    const market = {
      name: "rtfx",
      owner: { name: "rtfx.pro" },
      plugins: [{ name: "rtfx", source: "./plugins/moved", description: "d" }],
    };
    expect(checkMarketplace(market, ["./plugins/rtfx"]).errors[0]).toMatch(/has no .claude-plugin/);
    expect(
      checkMarketplace({ ...market, plugins: [{ ...market.plugins[0], source: "./plugins/rtfx" }] }, ["./plugins/rtfx"])
        .errors
    ).toEqual([]);
  });

  it("rejects a marketplace with no owner or no plugins", () => {
    expect(checkMarketplace({ name: "rtfx", plugins: [] }).errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/owner/), expect.stringMatching(/non-empty/)])
    );
  });

  it("catches the same plugin listed twice", () => {
    const dup = {
      name: "rtfx",
      owner: { name: "rtfx.pro" },
      plugins: [
        { name: "rtfx", source: "./plugins/rtfx", description: "d" },
        { name: "rtfx", source: "./plugins/rtfx", description: "d" },
      ],
    };
    expect(checkMarketplace(dup, ["./plugins/rtfx"]).errors[0]).toMatch(/more than once/);
  });

  // The marketplace entry restates the plugin's own metadata so the install
  // screen can show it without fetching the plugin. Two copies of a version
  // string is the pair that can hurt: `version` in the entry *pins* the
  // plugin, so an entry left behind after plugin.json is bumped quietly stops
  // shipping updates — and nothing on the author's machine looks wrong.
  it("catches a marketplace entry whose version has drifted from plugin.json", () => {
    const entry = { name: "rtfx", version: "1.1.0", description: "d", license: "MIT" };
    expect(checkMarketplaceEntryMatchesManifest(entry, { name: "rtfx", version: "1.1.0", description: "d" }).errors)
      .toEqual([]);
    expect(
      checkMarketplaceEntryMatchesManifest(entry, { name: "rtfx", version: "1.2.0", description: "d" }).errors[0]
    ).toMatch(/sets version "1\.1\.0" but .*says "1\.2\.0"/);
    expect(
      checkMarketplaceEntryMatchesManifest(entry, { name: "rtfx", version: "1.1.0", description: "other" }).errors[0]
    ).toMatch(/description/);
  });

  it("leaves a field alone when only one side declares it", () => {
    const { errors } = checkMarketplaceEntryMatchesManifest(
      { name: "rtfx", description: "d" },
      { name: "rtfx", description: "d", version: "1.1.0", license: "MIT" }
    );
    expect(errors).toEqual([]);
  });

  it("requires every advertised marketplace URL to be https", () => {
    const good = {
      owner: { url: "https://rtfx.pro" },
      plugins: [{ name: "rtfx", homepage: "https://rtfx.pro/docs", repository: "https://github.com/x/y" }],
    };
    expect(checkMarketplaceUrls(good).errors).toEqual([]);
    expect(checkMarketplaceUrls({ ...good, owner: { url: "http://rtfx.pro" } }).errors[0]).toMatch(/owner\.url/);
    expect(
      checkMarketplaceUrls({ ...good, plugins: [{ name: "rtfx", homepage: "rtfx.pro/docs" }] }).errors[0]
    ).toMatch(/homepage must be an https URL/);
  });
});

describe("command and skill rules", () => {
  it("a command needs a description and a body", () => {
    expect(checkCommand("c.md", "---\ndescription: Publish to rtfx.pro\n---\n\nDo the thing.").errors).toEqual([]);
    expect(checkCommand("c.md", "no frontmatter").errors[0]).toMatch(/frontmatter/);
    expect(checkCommand("c.md", "---\ndescription: d\n---\n").errors[0]).toMatch(/no body/);
  });

  it("a skill description must say when to use it, because that is all selection sees", () => {
    const good = "---\nname: publishing-to-rtfx\ndescription: Use when the user asks to publish a page\n---\n\nHow.";
    expect(checkSkill("s.md", good).errors).toEqual([]);
    const passive = "---\nname: publishing-to-rtfx\ndescription: Publishing helper for rtfx.pro\n---\n\nHow.";
    expect(checkSkill("s.md", passive).errors[0]).toMatch(/when to use/);
  });

  it("a skill's directory and declared name must agree", () => {
    const text = "---\nname: publishing-to-rtfx\ndescription: Use when publishing\n---\n\nHow.";
    expect(checkSkillNameMatchesDir("publishing-to-rtfx", text).errors).toEqual([]);
    expect(checkSkillNameMatchesDir("publish-to-rtfx", text).errors[0]).toMatch(/must match the directory/);
  });

  it("catches a plugin-root reference to a file that is not there", () => {
    const exists = (ref: string) => ref === "scripts/rtfx.mjs";
    expect(checkPluginRootRefs("c.md", 'node "${CLAUDE_PLUGIN_ROOT}/scripts/rtfx.mjs" list', exists).errors).toEqual([]);
    expect(checkPluginRootRefs("c.md", 'node "${CLAUDE_PLUGIN_ROOT}/scripts/gone.mjs"', exists).errors[0]).toMatch(
      /does not exist/
    );
  });

  it("catches a bare script path that would resolve against the user's cwd", () => {
    const exists = () => true;
    expect(checkPluginRootRefs("c.md", "run node scripts/rtfx.mjs publish", exists).errors[0]).toMatch(
      /CLAUDE_PLUGIN_ROOT/
    );
  });
});

describe("committed-secret detection", () => {
  it("passes the placeholders the docs are full of", () => {
    expect(findSecrets("export RTFX_API_TOKEN=rtfx_…")).toEqual([]);
    expect(findSecrets("Authorization: Bearer ***")).toEqual([]);
    expect(findSecrets("rtfx_9f2c1ab30d4e_Xj7…")).toEqual([]);
  });

  it("catches a real-looking token, service token, or private key", () => {
    expect(findSecrets("rtfx_9f2c1ab30d4e_Xj7aBcDeFgHiJkLmNoP")).toContain("rtfx API token");
    expect(findSecrets("id is 0123456789abcdef0123456789abcdef.access")).toContain(
      "Cloudflare Access service token"
    );
    expect(findSecrets("-----BEGIN PRIVATE KEY-----")).toContain("private key block");
    expect(findSecrets('CF_API_TOKEN="abcdefghijklmnopqrstuvwxyz012345"')).toContain("Cloudflare API token");
  });
});

/**
 * Rules that exist for the marketplace submission (docs/ANTHROPIC_PLUGIN_SUBMISSION.md).
 * All three guard the same failure: a claim in a markdown file that was true when
 * it was written and is not true now, in a place no test would otherwise reach.
 */
describe("submission-readiness rules", () => {
  describe("changelog against the declared version", () => {
    const log = "# Changelog\n\n## 1.1.0\n\n- MCP server\n\n## 1.0.0\n\n- First release\n";

    it("accepts a changelog whose newest entry is the manifest version", () => {
      expect(checkChangelog("CHANGELOG.md", log, "1.1.0").errors).toEqual([]);
    });

    it("catches a version bump that shipped without release notes", () => {
      expect(checkChangelog("CHANGELOG.md", log, "1.2.0").errors[0]).toMatch(/newest entry is 1\.1\.0.*not at all/);
    });

    // Newest-first is the whole reason the topmost heading is checkable, so an
    // entry appended to the bottom is a failure, not a style preference.
    it("catches an entry added in the wrong place", () => {
      const appended = `${log}\n## 1.2.0\n\n- Added late\n`;
      expect(checkChangelog("CHANGELOG.md", appended, "1.2.0").errors[0]).toMatch(/but not as the newest entry/);
    });

    it("accepts the `## [1.1.0]` link-reference form too", () => {
      expect(checkChangelog("CHANGELOG.md", "## [1.1.0] - 2026-08-15\n\n- x\n", "1.1.0").errors).toEqual([]);
    });

    it("says so when there are no version headings at all", () => {
      expect(checkChangelog("CHANGELOG.md", "# Changelog\n\nNothing yet.\n", "1.1.0").errors[0]).toMatch(
        /no version headings/
      );
    });
  });

  describe("community-marketplace claims", () => {
    it("passes a mention that carries its qualifier", () => {
      const text = "Only after approval do users install `rtfx@claude-community`.\n";
      expect(checkCommunityMarketplaceClaims("d.md", text).errors).toEqual([]);
    });

    it("passes a page that never mentions it, without inventing an ok line", () => {
      const result = checkCommunityMarketplaceClaims("d.md", "Install with `/plugin install rtfx@rtfx`.\n");
      expect(result.errors).toEqual([]);
      expect(result.ok).toEqual([]);
    });

    it("catches the install string presented as if it worked today", () => {
      const text = "Install it:\n\n```\n/plugin install rtfx@claude-community\n```\n";
      const [error] = checkCommunityMarketplaceClaims("d.md", text).errors;
      expect(error).toMatch(/no approval qualifier/);
      // The quoted context must be the offending line, not the ``` fence above it.
      expect(error).toContain("/plugin install rtfx@claude-community");
    });

    // The point of checking per passage rather than per file: a caveat in the
    // intro must not license an unqualified command further down the page.
    it("will not let a code block borrow a caveat from a distant paragraph", () => {
      const text =
        "The plugin is not yet approved for the community marketplace.\n\n" +
        "```\n/plugin marketplace add anthropics/claude-plugins-community\n```\n";
      expect(checkCommunityMarketplaceClaims("d.md", text).errors).toHaveLength(1);
    });

    it("checks table rows one at a time, so a stray row cannot inherit one either", () => {
      const table =
        "| What | How |\n|---|---|\n" +
        "| Community | Real only after approval |\n" +
        "| Install | `/plugin install rtfx@claude-community` |\n";
      expect(checkCommunityMarketplaceClaims("d.md", table).errors).toHaveLength(1);
    });
  });

  describe("the submission packet against the manifest", () => {
    const packet =
      "Version `1.1.0`, path `./plugins/rtfx`, repo https://github.com/yogevgab/artifacts-server\n";
    const expected = {
      version: "1.1.0",
      repository: "https://github.com/yogevgab/artifacts-server",
      pluginPath: "./plugins/rtfx",
    };

    it("accepts a packet that names all three", () => {
      expect(checkSubmissionPacket("s.md", packet, expected).errors).toEqual([]);
    });

    it("catches a packet left behind by a version bump or a repository rename", () => {
      expect(checkSubmissionPacket("s.md", packet, { ...expected, version: "1.2.0" }).errors[0]).toMatch(
        /the declared version 1\.2\.0/
      );
      expect(
        checkSubmissionPacket("s.md", packet, { ...expected, repository: "https://github.com/yogevgab/rtfx" }).errors[0]
      ).toMatch(/the repository URL/);
      expect(checkSubmissionPacket("s.md", packet, { ...expected, pluginPath: "./plugins/rtfx-cli" }).errors[0]).toMatch(
        /the plugin path/
      );
    });

    it("checks only the fields it was given", () => {
      expect(checkSubmissionPacket("s.md", packet, {}).errors).toEqual([]);
      expect(checkSubmissionPacket("s.md", packet, {}).ok).toEqual([]);
    });
  });
});

describe("the product surfaces point at the plugin", () => {
  beforeEach(async () => {
    await initDb();
  });

  it("the public docs page carries the install commands", async () => {
    const html = await (await req("/docs")).text();
    expect(html).toContain('data-docs="claude-code-plugin"');
    expect(html).toContain("/plugin marketplace add yogevgab/artifacts-server");
    expect(html).toContain("/plugin install rtfx@rtfx");
  });

  it("the integrations panel offers the plugin next to the token that feeds it", async () => {
    const html = await (await req("/admin/integrations", as("admin@test.com"))).text();
    expect(html).toContain('data-snippet="setup-plugin"');
    expect(html).toContain("/plugin install rtfx@rtfx");
  });

  it("both surfaces also carry the MCP server the plugin registers (issue #39)", async () => {
    const docs = await (await req("/docs")).text();
    expect(docs).toContain('data-docs="mcp-server"');
    expect(docs).toContain("rtfx-mcp.mjs");
    const panel = await (await req("/admin/integrations", as("admin@test.com"))).text();
    expect(panel).toContain('data-snippet="setup-mcp"');
    expect(panel).toContain("rtfx-mcp.mjs");
    // The example config must show a placeholder, never anything token-shaped.
    for (const html of [docs, panel]) expect(html).not.toMatch(/rtfx_[A-Za-z0-9]{4,}_[A-Za-z0-9_-]{8,}/);
  });
});
