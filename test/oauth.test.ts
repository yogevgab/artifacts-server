import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { initDb, clearR2, req, as, dropOAuthTables } from "./fixtures";
import { MCP_PATH } from "../src/mcp";
import {
  AS_METADATA_PATH,
  PROTECTED_RESOURCE_PATH,
  OAUTH_SCOPES_SUPPORTED,
  s256,
} from "../src/oauth";

/**
 * The OAuth 2.1 authorization server — src/oauth-routes.ts and src/oauth.ts.
 *
 * This is the surface that turns `claude mcp login rtfx` into something real,
 * and it is also the only place in the product where an *unauthenticated*
 * request can begin a chain that ends in a credential. So these tests are shaped
 * around the four things that have to hold for that to be safe:
 *
 *  1. **The discovery documents are true.** Everything they name is served, on
 *     the origin the request arrived on, and only on the app host. A metadata
 *     document that named a host it was not answering on would hand every client
 *     a resource identifier that fails audience validation later.
 *  2. **`redirect_uri` is an exact-match allow-list of two shapes.** https, or
 *     http to loopback. Registration is unauthenticated, so this function is the
 *     whole safety story: a wildcard, a `javascript:` URI, an http URL to a
 *     public host, a fragment or embedded credentials must all be refused at
 *     registration, and an unregistered URI must never be redirected to.
 *  3. **A code is worth nothing without the verifier that started the flow, and
 *     is worth nothing twice.** PKCE S256 is mandatory, a wrong verifier fails,
 *     and a code is single-use.
 *  4. **An un-migrated instance degrades, it does not 500.**
 */

const BOB = "bob@beta.com";
const CB = "http://127.0.0.1:1455/callback";

/** A PKCE pair. The verifier is fixed so a failing test is reproducible. */
const VERIFIER = "a".repeat(64);
let CHALLENGE = "";

beforeEach(async () => {
  vi.restoreAllMocks();
  await initDb();
  await clearR2();
  // Rate-limit buckets outlive initDb (the table is created on demand and is not
  // part of schema.sql), so they have to be cleared here or one test's
  // registrations count against the next one's.
  await env.DB.prepare("DROP TABLE IF EXISTS waitlist_rate_limits").run();
  CHALLENGE = await s256(VERIFIER);
});

// --- Helpers -----------------------------------------------------------------

const json = async (res: Response) => await res.json<any>();

/**
 * Registration is capped at 10 per IP per hour, so every call gets its own
 * address unless a test is deliberately exercising the cap. Sharing one address
 * would make a test's tenth registration fail for a reason it is not about.
 */
let ipCounter = 0;
async function register(body: unknown, init: RequestInit = {}): Promise<Response> {
  return req("/oauth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": `198.51.100.${++ipCounter % 250}`,
    },
    body: JSON.stringify(body),
    ...init,
  });
}

/** Register a client and return its id, failing loudly if registration didn't. */
async function registerClient(redirectUris: string[] = [CB], scope?: string): Promise<string> {
  const res = await register({
    client_name: "Claude Code",
    redirect_uris: redirectUris,
    ...(scope ? { scope } : {}),
  });
  expect(res.status).toBe(201);
  return (await json(res)).client_id as string;
}

function cimdClient(
  url = "https://claude.ai/.well-known/oauth-client-metadata.json",
  redirectUris: string[] = [CB]
): string {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input) !== url) return new Response("not found", { status: 404 });
    return Response.json({
      client_id: url,
      client_name: "Claude",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "rtfx:read rtfx:publish",
    });
  });
  return url;
}

function authorizeQuery(clientId: string, over: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CB,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "rtfx:read rtfx:publish",
    state: "opaque-state",
    ...over,
  });
  for (const [k, v] of Object.entries(over)) if (v === "") params.delete(k);
  return `/oauth/authorize?${params}`;
}

/** The csrf value the consent GET set as a cookie. */
function csrfFrom(res: Response): string {
  const cookie = res.headers.get("Set-Cookie") ?? "";
  const match = /rtfx_oauth_csrf=([^;]+)/.exec(cookie);
  expect(match, cookie).not.toBeNull();
  return match![1];
}

/**
 * Drive the whole browser half of the flow as a signed-in person: fetch the
 * consent screen, take its CSRF cookie, and submit the form.
 *
 * `query` and `form` are separate on purpose. The GET is what a real client
 * sends; the POST is what the browser sends back, and a test that only overrides
 * `form` is testing exactly the case this design cares about — a person who
 * edited the hidden fields before submitting.
 */
async function consent(
  clientId: string,
  opts: {
    query?: Record<string, string>;
    form?: Record<string, string>;
    decision?: string;
    email?: string;
  } = {}
): Promise<Response> {
  const email = opts.email ?? BOB;
  const query = opts.query ?? {};
  const page = await req(authorizeQuery(clientId, query), as(email));
  expect(page.status, await page.clone().text()).toBe(200);
  const csrf = csrfFrom(page);

  const over = opts.form ?? query;
  const form = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CB,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "rtfx:read rtfx:publish",
    state: "opaque-state",
    ...over,
    csrf,
    decision: opts.decision ?? "allow",
  });
  for (const [k, v] of Object.entries(over)) if (v === "") form.delete(k);

  return req(
    "/oauth/authorize",
    as(email, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `rtfx_oauth_csrf=${csrf}`,
      },
      body: form.toString(),
    })
  );
}

/** An authorization code, obtained the way a real client obtains one. */
async function authorizationCode(clientId: string): Promise<string> {
  const res = await consent(clientId);
  expect(res.status).toBe(302);
  const code = new URL(res.headers.get("Location")!).searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
}

function formPost(path: string, body: Record<string, string>): Promise<Response> {
  return req(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

const tokenRequest = (body: Record<string, string>) => formPost("/oauth/token", body);
const revokeRequest = (body: Record<string, string>) => formPost("/oauth/revoke", body);

// --- Discovery ---------------------------------------------------------------

describe("protected-resource metadata (RFC 9728)", () => {
  it("describes /mcp on the origin the request arrived on", async () => {
    const res = await req(PROTECTED_RESOURCE_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = await json(res);
    expect(body.resource).toBe(`http://localhost${MCP_PATH}`);
    expect(body.authorization_servers).toEqual(["http://localhost"]);
    expect(body.scopes_supported).toEqual(OAUTH_SCOPES_SUPPORTED);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  /**
   * The identifier a client validates its audience against is a *string*. If the
   * document named a configured base URL while answering on a preview host, the
   * two would never match, and every token this server issued would be rejected
   * by the client that asked for it.
   */
  it("names the request's own origin, not a configured one", async () => {
    const res = await app.request(
      `https://preview.example.com${PROTECTED_RESOURCE_PATH}`,
      {},
      { ...(env as any), PUBLIC_BASE_URL: "https://rtfx.pro" }
    );
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.resource).toBe("https://preview.example.com/mcp");
    expect(body.authorization_servers).toEqual(["https://preview.example.com"]);
  });

  /**
   * The dedicated host, stated as a fact rather than left to the general rule.
   * `mcp.rtfx.pro` is routed to this same Worker (wrangler.jsonc) as an *app*
   * host, and a client that discovers rtfx there must be told the resource is
   * `https://mcp.rtfx.pro/mcp` — not the canonical `rtfx.pro`, which would fail
   * the client's audience check on every token it was subsequently issued.
   */
  it("names the dedicated MCP host when the request arrives there", async () => {
    const e = { ...(env as any), PUBLIC_BASE_URL: "https://rtfx.pro", CONTENT_HOSTNAMES: "a.rtfx.pro" };
    const resource = await app.request(`https://mcp.rtfx.pro${PROTECTED_RESOURCE_PATH}`, {}, e);
    expect(resource.status).toBe(200);
    expect(await resource.json<any>()).toMatchObject({
      resource: "https://mcp.rtfx.pro/mcp",
      authorization_servers: ["https://mcp.rtfx.pro"],
    });

    const as_ = await app.request(`https://mcp.rtfx.pro${AS_METADATA_PATH}`, {}, e);
    expect(as_.status).toBe(200);
    expect(await as_.json<any>()).toMatchObject({
      issuer: "https://mcp.rtfx.pro",
      authorization_endpoint: "https://mcp.rtfx.pro/oauth/authorize",
      token_endpoint: "https://mcp.rtfx.pro/oauth/token",
    });
  });

  /**
   * Host isolation. The content host serves untrusted uploaded HTML; a document
   * served there would advertise an authorization server at that origin.
   */
  it("is not served by the content host", async () => {
    const contentEnv = { ...(env as any), CONTENT_HOSTNAMES: "a.test.local" };
    for (const path of [PROTECTED_RESOURCE_PATH, AS_METADATA_PATH, "/oauth/authorize"]) {
      const res = await app.request(`https://a.test.local${path}`, {}, contentEnv);
      expect(res.status, path).toBe(404);
      // A 302 to the content host would be worse than a 404: it would make the
      // document reachable at the content origin by one more hop.
      expect(res.headers.get("Location"), path).toBeNull();
    }
  });
});

describe("authorization-server metadata (RFC 8414)", () => {
  it("advertises the endpoints it serves, and S256 only", async () => {
    const res = await req(AS_METADATA_PATH);
    expect(res.status).toBe(200);
    const body = await json(res);

    expect(body.issuer).toBe("http://localhost");
    expect(body.authorization_endpoint).toBe("http://localhost/oauth/authorize");
    expect(body.token_endpoint).toBe("http://localhost/oauth/token");
    expect(body.registration_endpoint).toBe("http://localhost/oauth/register");
    expect(body.revocation_endpoint).toBe("http://localhost/oauth/revoke");
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(body.scopes_supported).toEqual(OAUTH_SCOPES_SUPPORTED);
  });

  /**
   * PKCE is what stands in for a client secret here, so `plain` — which proves
   * nothing, because the "verifier" is the challenge — must never be offered.
   * There is no implicit or password grant either, and no client authentication.
   */
  it("offers S256 only, and no client authentication", async () => {
    const body = await json(await req(AS_METADATA_PATH));
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.code_challenge_methods_supported).not.toContain("plain");
    expect(body.grant_types_supported).not.toContain("implicit");
    expect(body.grant_types_supported).not.toContain("password");
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(body.client_id_metadata_document_supported).toBe(true);
  });

  /** Every endpoint the document names has to be one this app actually routes. */
  it("names only endpoints that exist", async () => {
    const body = await json(await req(AS_METADATA_PATH));
    for (const key of [
      "authorization_endpoint",
      "token_endpoint",
      "registration_endpoint",
      "revocation_endpoint",
    ]) {
      const path = new URL(body[key]).pathname;
      const res = await req(path, { method: "POST" });
      expect(res.status, `${key} ${path}`).not.toBe(404);
    }
  });
});

// --- Dynamic client registration ---------------------------------------------

describe("dynamic client registration", () => {
  it("registers a public client with a loopback redirect", async () => {
    const res = await register({
      client_name: "Claude Code",
      redirect_uris: [CB],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toContain("no-store");

    const body = await json(res);
    expect(body.client_id).toMatch(/^oc_[0-9a-f]{32}$/);
    expect(body.client_name).toBe("Claude Code");
    expect(body.redirect_uris).toEqual([CB]);
    expect(body.token_endpoint_auth_method).toBe("none");
    // Public clients only: a secret would be a credential nobody can keep.
    expect(body.client_secret).toBeUndefined();
    expect(body.client_secret_expires_at).toBeUndefined();
  });

  it("accepts https and every loopback spelling", async () => {
    for (const uri of [
      "https://app.example.com/oauth/callback",
      "http://127.0.0.1:1455/callback",
      "http://localhost:8976/cb",
      "http://[::1]:3000/cb",
    ]) {
      const res = await register({ client_name: "c", redirect_uris: [uri] });
      expect(res.status, uri).toBe(201);
    }
  });

  /**
   * The core of the feature's safety. Each of these, registered, would be a way
   * to have an authorization code delivered somewhere its owner never chose.
   */
  it("refuses every redirect URI that is not one of the two allowed shapes", async () => {
    const refused: Array<[string, unknown]> = [
      ["wildcard host", "https://*.example.com/cb"],
      ["wildcard path", "https://example.com/*"],
      ["javascript:", "javascript:alert(document.domain)"],
      ["data:", "data:text/html,<script>1</script>"],
      ["file:", "file:///etc/passwd"],
      ["http to a public host", "http://example.com/cb"],
      ["http to a lookalike host", "http://127.0.0.1.evil.com/cb"],
      ["fragment", "https://example.com/cb#frag"],
      ["embedded credentials", "https://user:pass@example.com/cb"],
      ["relative", "/cb"],
      ["not a URL", "not a url at all"],
      ["empty", ""],
      ["not a string", 42],
    ];
    for (const [label, uri] of refused) {
      const res = await register({ client_name: "c", redirect_uris: [uri] });
      expect(res.status, label).toBe(400);
      expect((await json(res)).error, label).toBe("invalid_redirect_uri");
    }
  });

  it("refuses a missing, empty or over-long redirect_uris list", async () => {
    for (const redirect_uris of [
      undefined,
      [],
      "https://example.com/cb",
      Array.from({ length: 6 }, (_, i) => `https://example.com/cb${i}`),
    ]) {
      const res = await register({ client_name: "c", redirect_uris });
      expect((await json(res)).error, JSON.stringify(redirect_uris)).toBe("invalid_redirect_uri");
    }
    // Five is the documented maximum, and five is accepted.
    const ok = await register({
      client_name: "c",
      redirect_uris: Array.from({ length: 5 }, (_, i) => `https://example.com/cb${i}`),
    });
    expect(ok.status).toBe(201);
  });

  it("refuses metadata this server cannot honour", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["a client secret", { token_endpoint_auth_method: "client_secret_basic" }],
      ["an implicit response type", { response_types: ["token"] }],
      ["an unsupported grant", { grant_types: ["client_credentials"] }],
      ["an unknown scope", { scope: "rtfx:read admin:everything" }],
      ["an over-long name", { client_name: "x".repeat(121) }],
    ];
    for (const [label, extra] of cases) {
      const res = await register({ client_name: "c", redirect_uris: [CB], ...extra });
      expect(res.status, label).toBe(400);
      expect((await json(res)).error, label).toBe("invalid_client_metadata");
    }
  });

  it("refuses a body that is not a JSON object", async () => {
    for (const body of ["[]", '"hi"', "not json"]) {
      const res = await req("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status, body).toBe(400);
    }
  });

  it("rate-limits registration per IP", async () => {
    const ip = { "CF-Connecting-IP": "203.0.113.9" };
    for (let i = 0; i < 10; i++) {
      const res = await register({ client_name: "c", redirect_uris: [CB] }, { headers: { "Content-Type": "application/json", ...ip } });
      expect(res.status, `attempt ${i}`).toBe(201);
    }
    const blocked = await register(
      { client_name: "c", redirect_uris: [CB] },
      { headers: { "Content-Type": "application/json", ...ip } }
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("3600");
  });
});

// --- The authorization endpoint ----------------------------------------------

describe("the authorization endpoint", () => {
  it("shows a consent screen naming the client, the scopes and the endpoint", async () => {
    const clientId = await registerClient();
    const res = await req(authorizeQuery(clientId), as(BOB));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Set-Cookie")).toContain("rtfx_oauth_csrf=");

    const html = await res.text();
    expect(html).toContain("Claude Code");
    expect(html).toContain("See your artifacts");
    expect(html).toContain("Publish and update artifacts");
    // Not requested, so not shown — and never granted by default.
    expect(html).not.toContain("Manage access and delete artifacts");
    expect(html).toContain(BOB);
    expect(html).toContain("http://localhost/mcp");
  });

  it("accepts a CIMD client_id URL without dynamic registration", async () => {
    const clientId = cimdClient();
    const res = await req(authorizeQuery(clientId), as(BOB));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("claude.ai");
    expect(html).toContain("Claude");
    expect(html).toContain("Publish and update artifacts");

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_clients").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("lets CIMD native clients vary only the loopback callback port", async () => {
    const clientId = cimdClient("https://claude.ai/.well-known/oauth-client-metadata.json", [
      "http://127.0.0.1/callback",
    ]);
    const res = await req(
      authorizeQuery(clientId, { redirect_uri: "http://127.0.0.1:49152/callback" }),
      as(BOB)
    );
    expect(res.status).toBe(200);
  });

  it("refuses a CIMD document that is not self-referential", async () => {
    const url = "https://claude.ai/.well-known/oauth-client-metadata.json";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        client_id: "https://evil.example.com/client.json",
        client_name: "Claude",
        redirect_uris: [CB],
        token_endpoint_auth_method: "none",
      })
    );
    const res = await req(authorizeQuery(url), as(BOB));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid_client");
  });

  /**
   * `client_name` is attacker-controlled: registration is unauthenticated, so
   * anybody can put any string on this page. It has to arrive escaped.
   */
  it("escapes the self-reported client name", async () => {
    const res = await register({
      client_name: '<img src=x onerror="alert(1)">',
      redirect_uris: [CB],
    });
    const clientId = (await json(res)).client_id;
    const html = await (await req(authorizeQuery(clientId), as(BOB))).text();
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img");
  });

  /**
   * The two failures that must be rendered here rather than redirected. An
   * unknown client and an unregistered redirect URI both mean "no redirect
   * target is trusted", and bouncing to one anyway is how an open redirect —
   * and eventually a leaked code — happens.
   */
  it("renders an unknown client locally instead of redirecting", async () => {
    const res = await req(authorizeQuery("oc_deadbeef"), as(BOB));
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("invalid_client");
  });

  it("never redirects to a redirect_uri the client did not register", async () => {
    const clientId = await registerClient([CB]);
    for (const attacker of [
      "https://evil.example.com/cb",
      "http://127.0.0.1:1455/callback/../../evil",
      "http://127.0.0.1:9999/callback",
      "",
    ]) {
      const res = await req(authorizeQuery(clientId, { redirect_uri: attacker }), as(BOB));
      expect(res.status, attacker).toBe(400);
      expect(res.headers.get("Location"), attacker).toBeNull();
      const html = await res.text();
      expect(html, attacker).toContain("invalid_redirect_uri");
      expect(html, attacker).not.toContain("evil.example.com");
    }
  });

  /**
   * Once the redirect URI is known to be the client's own, OAuth requires the
   * error to be reported there — with the `state` echoed, so the client can tie
   * it to the request it made.
   */
  it("reports a bad parameter at the client's own redirect URI", async () => {
    const clientId = await registerClient();
    const cases: Array<[Record<string, string>, string]> = [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge_method: "" }, "invalid_request"],
      [{ code_challenge: "too-short" }, "invalid_request"],
      [{ scope: "rtfx:read admin:everything" }, "invalid_scope"],
      [{ resource: "https://elsewhere.example.com/mcp" }, "invalid_target"],
    ];
    for (const [over, error] of cases) {
      const res = await req(authorizeQuery(clientId, over), as(BOB));
      expect(res.status, error).toBe(302);
      const location = new URL(res.headers.get("Location")!);
      expect(location.origin + location.pathname, error).toBe(CB);
      expect(location.searchParams.get("error"), error).toBe(error);
      expect(location.searchParams.get("state"), error).toBe("opaque-state");
      expect(location.searchParams.get("code"), error).toBeNull();
    }
  });

  /** PKCE is not optional: a request without a challenge cannot be completed. */
  it("requires a PKCE challenge", async () => {
    const clientId = await registerClient();
    const res = await req(
      authorizeQuery(clientId, { code_challenge: "", code_challenge_method: "" }),
      as(BOB)
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("accepts the matching RFC 8707 resource, and refuses another", async () => {
    const clientId = await registerClient();
    const ok = await req(
      authorizeQuery(clientId, { resource: "http://localhost/mcp" }),
      as(BOB)
    );
    expect(ok.status).toBe(200);
  });

  /**
   * The bounce a signed-out `claude mcp login` takes. `next` must be a path on
   * this origin and never an absolute URL: what waits on the other side of the
   * sign-in is a minted session, so an open redirect here would be the one bug
   * that matters. `/login` consumes it — see "?next= round trip" in
   * test/auth-routes.test.ts for the other half.
   */
  it("bounces a signed-out visitor to /login, carrying the request as a local path", async () => {
    const clientId = await registerClient();
    const query = authorizeQuery(clientId);
    // DEV_LOGIN resolves an identity for any request that doesn't say otherwise,
    // so "signed out" has to be stated explicitly here.
    const res = await req(query, { headers: { "X-Dev-Anonymous": "true" } });
    expect(res.status).toBe(302);

    const location = res.headers.get("Location")!;
    expect(location.startsWith("/login?next=")).toBe(true);
    const next = new URLSearchParams(location.split("?")[1]).get("next")!;
    expect(next).toBe(query);
    expect(next.startsWith("/oauth/authorize?")).toBe(true);
    expect(next.startsWith("//")).toBe(false);
  });

  /**
   * The round trip completes: `/login` hands a signed-in visitor back to the
   * authorization request rather than dropping them on the dashboard while the
   * MCP client waits for a callback that is never coming.
   */
  it("lands a signed-in visitor back on the consent screen", async () => {
    const clientId = await registerClient();
    const query = authorizeQuery(clientId);
    const bounce = await req(query, { headers: { "X-Dev-Anonymous": "true" } });
    const login = bounce.headers.get("Location")!;

    const back = await req(login, as(BOB));
    expect(back.status).toBe(302);
    expect(back.headers.get("Location")).toBe(query);

    const consent = await req(back.headers.get("Location")!, as(BOB));
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain("Claude Code");
  });

  /**
   * A machine credential must never be able to mint another one. This is a
   * browser flow by construction: the thing being granted is a person's
   * authority, and a token is not a person.
   */
  it("refuses to let an API token authorize an application", async () => {
    const clientId = await registerClient();
    const minted = await req(
      "/api/tokens",
      as(BOB, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "t" }),
      })
    );
    expect(minted.status).toBe(201);
    const { token } = await json(minted);

    const res = await req(authorizeQuery(clientId), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("404s an unrouted path under /oauth rather than looking for an artifact", async () => {
    const res = await req("/oauth/not-a-thing");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });
});

// --- Consent -----------------------------------------------------------------

describe("the consent submission", () => {
  it("issues a code to the registered redirect URI, echoing state and iss", async () => {
    const clientId = await registerClient();
    const res = await consent(clientId);
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(CB);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("opaque-state");
    expect(location.searchParams.get("iss")).toBe("http://localhost");
    // The consent is spent, so the CSRF cookie is cleared with it.
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("reports a refusal to the client as access_denied, with no code", async () => {
    const clientId = await registerClient();
    const res = await consent(clientId, { decision: "deny" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("refuses a submission with no CSRF cookie, or the wrong one", async () => {
    const clientId = await registerClient();
    const page = await req(authorizeQuery(clientId), as(BOB));
    const csrf = csrfFrom(page);
    const form = (over: Record<string, string>) =>
      new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: CB,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        decision: "allow",
        ...over,
      }).toString();

    for (const [label, init] of [
      ["no cookie at all", { body: form({ csrf }) }],
      ["cookie but no field", { body: form({}), cookie: `rtfx_oauth_csrf=${csrf}` }],
      ["mismatched", { body: form({ csrf: "0".repeat(32) }), cookie: `rtfx_oauth_csrf=${csrf}` }],
    ] as Array<[string, { body: string; cookie?: string }]>) {
      const res = await req(
        "/oauth/authorize",
        as(BOB, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            ...(init.cookie ? { Cookie: init.cookie } : {}),
          },
          body: init.body,
        })
      );
      expect(res.status, label).toBe(403);
      expect(res.headers.get("Location"), label).toBeNull();
      const html = await res.text();
      expect(html, label).toContain("Start authorization again");
      expect(html, label).toContain("already says the rtfx connection is active");
      expect(html, label).toContain("/oauth/authorize?");
    }
  });

  it("refuses a submission from an origin this instance does not recognize", async () => {
    const clientId = await registerClient();
    const page = await req(authorizeQuery(clientId), as(BOB));
    const csrf = csrfFrom(page);
    const res = await req(
      "/oauth/authorize",
      as(BOB, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://evil.example.com",
          Cookie: `rtfx_oauth_csrf=${csrf}`,
        },
        body: new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: CB,
          code_challenge: CHALLENGE,
          code_challenge_method: "S256",
          csrf,
          decision: "allow",
        }).toString(),
      })
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("Location")).toBeNull();
  });

  /**
   * The hidden fields are a convenience for the browser, never a record of what
   * GET already checked. A tampered form re-runs every check from scratch, so
   * the worst it can produce is a refusal.
   */
  it("re-validates the tampered form rather than trusting it", async () => {
    const clientId = await registerClient([CB]);
    // A redirect_uri swapped in the form is refused exactly as in the query, and
    // is not redirected to.
    const swapped = await consent(clientId, {
      form: { redirect_uri: "https://evil.example.com/cb" },
    });
    expect(swapped.status).toBe(400);
    expect(swapped.headers.get("Location")).toBeNull();
    expect(await swapped.text()).not.toContain("evil.example.com");

    // A scope widened in the form fails validation instead of being granted.
    const widened = await consent(clientId, { form: { scope: "rtfx:read admin:everything" } });
    expect(widened.status).toBe(302);
    expect(new URL(widened.headers.get("Location")!).searchParams.get("error")).toBe(
      "invalid_scope"
    );
  });
});

// --- The token endpoint ------------------------------------------------------

describe("the token endpoint", () => {
  it("exchanges a code plus the right verifier for a usable access token", async () => {
    const clientId = await registerClient();
    const code = await authorizationCode(clientId);

    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      redirect_uri: CB,
      client_id: clientId,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");

    const body = await json(res);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe("rtfx:read rtfx:publish");
    expect(body.access_token).toMatch(/^rtfx_/);
    expect(body.refresh_token).toMatch(/^rtfxr_/);

    // The whole point: the result is an ordinary bearer credential that the MCP
    // endpoint already knows how to accept.
    const mcp = await req(MCP_PATH, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${body.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(mcp.status).toBe(200);
  });

  it("exchanges a CIMD authorization code without storing an OAuth client row", async () => {
    const clientId = cimdClient();
    const code = await authorizationCode(clientId);

    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      redirect_uri: CB,
      client_id: clientId,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.access_token).toMatch(/^rtfx_/);
    expect(body.refresh_token).toMatch(/^rtfxr_/);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_clients").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("rejects a CIMD token exchange when the metadata URL no longer validates", async () => {
    const clientId = cimdClient();
    const code = await authorizationCode(clientId);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));

    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      redirect_uri: CB,
      client_id: clientId,
    });
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("invalid_client");
  });

  /**
   * The consented scopes, and only those, reach the token — mapped onto the
   * internal vocabulary that `requireScope` already enforces. A platform admin
   * authorizing a client must not hand it platform authority either.
   */
  it("mints a scoped, non-admin, expiring token owned by the person who consented", async () => {
    const clientId = await registerClient();
    const code = await authorizationCode(clientId);
    const body = await json(
      await tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        redirect_uri: CB,
        client_id: clientId,
      })
    );

    const id = body.access_token.split("_")[1];
    const row = await env.DB.prepare(
      "SELECT owner_email, is_admin, scopes, expires_at, issued_via, oauth_client_id FROM api_tokens WHERE id = ?"
    )
      .bind(id)
      .first<any>();
    expect(row.owner_email).toBe(BOB);
    expect(row.is_admin).toBe(0);
    expect(row.scopes).toBe("read,publish");
    expect(row.issued_via).toBe("oauth");
    expect(row.oauth_client_id).toBe(clientId);
    expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now());
    expect(Date.parse(row.expires_at)).toBeLessThanOrEqual(Date.now() + 3600_000 + 5_000);
  });

  it("refuses the wrong code_verifier", async () => {
    const clientId = await registerClient();
    const code = await authorizationCode(clientId);
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: "b".repeat(64),
      redirect_uri: CB,
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid_grant");
  });

  it("refuses a missing or malformed code_verifier rather than skipping PKCE", async () => {
    const clientId = await registerClient();
    for (const code_verifier of [undefined, "", "short"]) {
      const code = await authorizationCode(clientId);
      const res = await tokenRequest({
        grant_type: "authorization_code",
        code,
        ...(code_verifier === undefined ? {} : { code_verifier }),
        redirect_uri: CB,
        client_id: clientId,
      });
      expect(res.status, String(code_verifier)).toBe(400);
      expect((await json(res)).error, String(code_verifier)).toBe("invalid_request");
    }
  });

  /** A code is spent by the exchange, whether or not the exchange succeeded. */
  it("spends a code on first use", async () => {
    const clientId = await registerClient();
    const code = await authorizationCode(clientId);
    const exchange = () =>
      tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        redirect_uri: CB,
        client_id: clientId,
      });

    expect((await exchange()).status).toBe(200);
    const replay = await exchange();
    expect(replay.status).toBe(400);
    expect((await json(replay)).error).toBe("invalid_grant");
  });

  it("refuses a code presented by a different client", async () => {
    const first = await registerClient();
    const second = await registerClient();
    const code = await authorizationCode(first);
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      redirect_uri: CB,
      client_id: second,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid_grant");
  });

  it("refuses an unknown code, an unknown client and a client secret", async () => {
    const clientId = await registerClient();
    const unknownCode = await tokenRequest({
      grant_type: "authorization_code",
      code: "not-a-code",
      code_verifier: VERIFIER,
      redirect_uri: CB,
      client_id: clientId,
    });
    expect((await json(unknownCode)).error).toBe("invalid_grant");

    const unknownClient = await tokenRequest({
      grant_type: "authorization_code",
      code: "x",
      code_verifier: VERIFIER,
      redirect_uri: CB,
      client_id: "oc_nope",
    });
    expect(unknownClient.status).toBe(401);
    expect((await json(unknownClient)).error).toBe("invalid_client");

    const withSecret = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: "hunter2",
    });
    expect(withSecret.status).toBe(401);
    expect((await json(withSecret)).error).toBe("invalid_client");
  });

  it("refuses a grant type it does not implement", async () => {
    const clientId = await registerClient();
    const res = await tokenRequest({ grant_type: "client_credentials", client_id: clientId });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("unsupported_grant_type");
  });

  it("rotates a refresh token, and refuses the one it replaced", async () => {
    const clientId = await registerClient();
    const code = await authorizationCode(clientId);
    const first = await json(
      await tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        redirect_uri: CB,
        client_id: clientId,
      })
    );

    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const second = await json(refreshed);
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);

    const replay = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(replay.status).toBe(400);
    expect((await json(replay)).error).toBe("invalid_grant");
  });

  /** RFC 6749 §6: a refresh may narrow the granted scope, never widen it. */
  it("lets a refresh narrow the scope but not widen it", async () => {
    const clientId = await registerClient();
    const code = await authorizationCode(clientId);
    const first = await json(
      await tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        redirect_uri: CB,
        client_id: clientId,
      })
    );

    const widened = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
      scope: "rtfx:read rtfx:publish rtfx:manage",
    });
    expect(widened.status).toBe(400);
    expect((await json(widened)).error).toBe("invalid_scope");

    // …and the failed attempt did not spend the token.
    const narrowed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
      scope: "rtfx:read",
    });
    expect(narrowed.status).toBe(200);
    expect((await json(narrowed)).scope).toBe("rtfx:read");
  });

  it("refuses a refresh token presented by another client", async () => {
    const first = await registerClient();
    const second = await registerClient();
    const code = await authorizationCode(first);
    const granted = await json(
      await tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        redirect_uri: CB,
        client_id: first,
      })
    );
    const res = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: granted.refresh_token,
      client_id: second,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid_grant");
  });
});

// --- Revocation --------------------------------------------------------------

describe("revocation", () => {
  async function grant(clientId: string) {
    const code = await authorizationCode(clientId);
    return json(
      await tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        redirect_uri: CB,
        client_id: clientId,
      })
    );
  }

  it("revokes an OAuth access token, and the MCP endpoint stops accepting it", async () => {
    const clientId = await registerClient();
    const granted = await grant(clientId);
    const ping = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${granted.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    };
    expect((await req(MCP_PATH, ping)).status).toBe(200);

    const revoked = await revokeRequest({ token: granted.access_token });
    expect(revoked.status).toBe(200);
    expect((await req(MCP_PATH, ping)).status).toBe(401);
  });

  it("revokes a refresh token", async () => {
    const clientId = await registerClient();
    const granted = await grant(clientId);
    expect((await revokeRequest({ token: granted.refresh_token })).status).toBe(200);

    const res = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: granted.refresh_token,
      client_id: clientId,
    });
    expect(res.status).toBe(400);
  });

  /**
   * A dashboard-minted token is revoked in the dashboard, by a signed-in human.
   * The OAuth endpoint is unauthenticated by design, so if it could reach one,
   * anybody who saw a token in a log could destroy it.
   */
  it("will not revoke a token it did not issue", async () => {
    const minted = await req(
      "/api/tokens",
      as(BOB, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "dashboard" }),
      })
    );
    const { token } = await json(minted);

    // RFC 7009 §2.2: 200 regardless, so this is not an oracle for what exists.
    expect((await revokeRequest({ token })).status).toBe(200);

    const still = await req(MCP_PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(still.status).toBe(200);
  });

  it("answers 200 for an unknown or absent token", async () => {
    expect((await revokeRequest({ token: "rtfxr_nonsense" })).status).toBe(200);
    expect((await revokeRequest({ token: "rtfx_nope_nope" })).status).toBe(200);
    expect((await revokeRequest({})).status).toBe(200);
  });
});

// --- The un-migrated instance ------------------------------------------------

/**
 * A Worker deployed ahead of migration 0019. Every OAuth route has to degrade to
 * a stated `temporarily_unavailable` rather than a 500 — and, more importantly,
 * the bearer-token path that has always served `/mcp` has to be untouched.
 */
describe("an instance that has not run migration 0019", () => {
  beforeEach(async () => {
    await dropOAuthTables();
  });

  it("says so at registration rather than failing", async () => {
    const res = await register({ client_name: "c", redirect_uris: [CB] });
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe("temporarily_unavailable");
  });

  it("says so at the authorization and token endpoints", async () => {
    const page = await req(authorizeQuery("oc_whatever"), as(BOB));
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("temporarily_unavailable");

    const token = await tokenRequest({
      grant_type: "authorization_code",
      code: "x",
      code_verifier: VERIFIER,
      redirect_uri: CB,
      client_id: "oc_whatever",
    });
    expect(token.status).toBe(400);
    expect((await json(token)).error).toBe("temporarily_unavailable");
  });

  it("still serves the discovery documents, and still revokes nothing quietly", async () => {
    expect((await req(PROTECTED_RESOURCE_PATH)).status).toBe(200);
    expect((await req(AS_METADATA_PATH)).status).toBe(200);
    expect((await revokeRequest({ token: "rtfxr_nonsense" })).status).toBe(200);
  });

  it("leaves the bearer-token path into /mcp working", async () => {
    const minted = await req(
      "/api/tokens",
      as(BOB, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "t" }),
      })
    );
    const { token } = await json(minted);
    const res = await req(MCP_PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(200);
  });
});
