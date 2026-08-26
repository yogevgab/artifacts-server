/**
 * The OAuth 2.1 authorization server: discovery, dynamic client registration,
 * the authorization/consent flow, token issuance and revocation.
 *
 * This is what makes `claude mcp login rtfx` a real thing rather than a plan.
 * The design and its reasoning live in docs/REMOTE_MCP_OAUTH.md; what follows
 * are the decisions that are only visible in the code.
 *
 * **The origin is the request's own origin.** Every URL in the two metadata
 * documents — issuer, endpoints, and the `resource` identifier — is built from
 * the host the client actually contacted. RFC 8707 audience validation compares
 * strings, so a document that named `PUBLIC_BASE_URL` while answering on a
 * preview host would hand every client a resource identifier that does not match
 * where it is talking. These routes are app-host-only (`MANAGEMENT_PREFIXES`,
 * src/host.ts), so the origin can never be a content host.
 *
 * **A registration grants nothing.** `POST /oauth/register` has to be
 * unauthenticated — Claude Code cannot be pre-registered — which makes it the
 * obvious abuse target. It is rate-limited per IP, stores only public metadata,
 * issues no `client_secret`, and produces a `client_id` that is inert until a
 * signed-in human clicks Allow.
 *
 * **Errors go to the client, except when they can't.** OAuth requires an invalid
 * request to be reported at the client's redirect URI. That is only safe once
 * the redirect URI is known to be the client's own: an unknown `client_id` or an
 * unregistered `redirect_uri` is rendered as a page here instead, because
 * redirecting would mean sending our own error — and, with one future bug, a
 * code — to a URL nobody vouched for.
 *
 * **The consent POST is the only browser request that mints a credential.** It
 * is protected three ways: a double-submit CSRF cookie, an `Origin` check
 * against this instance's own origins, and the `SameSite=Lax` session cookie
 * which a cross-site POST does not carry in the first place.
 */

import { Hono, type Context } from "hono";
import type { AppBindings, Env } from "./env";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AS_METADATA_PATH,
  MAX_CLIENT_NAME_LENGTH,
  OAUTH_SCOPES_SUPPORTED,
  PROTECTED_RESOURCE_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
  claimAuthorizationCode,
  createAuthorizationCode,
  createOAuthClient,
  createRefreshToken,
  findRefreshToken,
  getOAuthClient,
  isLoopbackHostname,
  isMissingOAuthTable,
  isRefreshTokenShape,
  isRefreshUsable,
  isValidCodeChallenge,
  isValidCodeVerifier,
  markTokenIssuedViaOAuth,
  normalizeRedirectUri,
  normalizeRedirectUris,
  parseOAuthScopes,
  revokeRefreshToken,
  rowOAuthScopes,
  s256,
  timingSafeEqual,
  toInternalScopes,
  touchOAuthClient,
  type OAuthClient,
  type OAuthScope,
} from "./oauth";
import { consentPage, oauthErrorPage } from "./oauth-consent";
import { MCP_PATH } from "./mcp";
import { resolveAuth, readCookie, type Identity } from "./auth";
import { accountPausedPage } from "./login";
import { resolveAccountContext } from "./accounts";
import { createApiToken, findApiToken, revokeApiToken, MAX_TOKEN_NAME_LENGTH } from "./tokens";
import { incrementRateLimitBucket, clientAddress } from "./rate-limit";
import { isAllowedOrigin } from "./cors";
import { notFoundPage } from "./pages";

export const oauthRoutes = new Hono<AppBindings>();

/** Never cache anything on this surface: it is all identity- and secret-bearing. */
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

/** Discovery documents are public and identical for everyone, so they may cache. */
const METADATA_CACHE = { "Cache-Control": "public, max-age=300" } as const;

/** The double-submit CSRF cookie for the consent form. Host-only, `/oauth` only. */
const CSRF_COOKIE = "rtfx_oauth_csrf";
const CSRF_TTL_SECONDS = 600;

// Per hour, per IP. Registration is the unauthenticated write; the token
// endpoint is generous because a legitimate client refreshes on a schedule.
const REGISTER_PER_IP = 10;
const TOKEN_PER_IP = 300;
const AUTHORIZE_PER_IP = 120;

/**
 * The context every helper in this file takes. Written out as `Context<AppBindings>`
 * rather than inferred from `oauthRoutes.get`: Hono's `get` is an overload set, so
 * `Parameters<…>` picks the `get(path)` arity-1 signature and resolves the handler
 * to `never` — which typechecks locally and then rejects every real context passed
 * to it. The path parameter is left at its `any` default because none of these
 * routes have path params.
 */
type Ctx = Context<AppBindings>;

// --- Origins and identifiers -------------------------------------------------

/** The origin this request arrived on — the only one its metadata may name. */
function requestOrigin(c: Ctx): string {
  return new URL(c.req.url).origin;
}

/** The RFC 8707 resource identifier for the MCP endpoint on this origin. */
function mcpResource(c: Ctx): string {
  return `${requestOrigin(c)}${MCP_PATH}`;
}

// --- Discovery ---------------------------------------------------------------

/**
 * RFC 9728 §3. What `/mcp`'s 401 points a client at, and the only document that
 * makes naming `resource_metadata` in that challenge honest.
 */
oauthRoutes.get(PROTECTED_RESOURCE_PATH, (c) => {
  const origin = requestOrigin(c);
  return c.json(
    {
      resource: mcpResource(c),
      authorization_servers: [origin],
      scopes_supported: OAUTH_SCOPES_SUPPORTED,
      bearer_methods_supported: ["header"],
      resource_name: "rtfx remote MCP",
      resource_documentation: `${origin}/docs`,
    },
    200,
    METADATA_CACHE
  );
});

/**
 * RFC 8414 §3. Only `S256` is advertised, and only the two grants that exist:
 * there is no implicit grant, no password grant and no client authentication —
 * every client here is public, and PKCE is what stands in for a secret.
 */
oauthRoutes.get(AS_METADATA_PATH, (c) => {
  const origin = requestOrigin(c);
  return c.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: OAUTH_SCOPES_SUPPORTED,
      service_documentation: `${origin}/docs`,
      /** RFC 8707: we validate `resource` at the authorization endpoint. */
      authorization_response_iss_parameter_supported: true,
    },
    200,
    METADATA_CACHE
  );
});

// --- Dynamic client registration (RFC 7591) ----------------------------------

function registrationError(c: Ctx, error: string, detail: string, status = 400) {
  return c.json({ error, error_description: detail }, status as 400, NO_STORE);
}

oauthRoutes.post("/oauth/register", async (c) => {
  if (!(await incrementRateLimitBucket(c, `oauth:register:${clientAddress(c)}`, REGISTER_PER_IP))) {
    return c.json({ error: "rate_limited" }, 429, { "Retry-After": "3600", ...NO_STORE });
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return registrationError(c, "invalid_client_metadata", "send a JSON object");
  }
  const input = body as Record<string, unknown>;

  const redirects = normalizeRedirectUris(input.redirect_uris);
  if ("error" in redirects) return registrationError(c, redirects.error, redirects.detail);

  const rawName = typeof input.client_name === "string" ? input.client_name.trim() : "";
  if (rawName.length > MAX_CLIENT_NAME_LENGTH) {
    return registrationError(
      c,
      "invalid_client_metadata",
      `client_name may not exceed ${MAX_CLIENT_NAME_LENGTH} characters`
    );
  }
  // A name is what the consent screen shows, so an absent one becomes an honest
  // placeholder rather than an empty heading.
  const clientName = rawName || "An unnamed application";

  // Public clients only. There is no `client_secret` to issue and no client
  // authentication to perform, so a client asking for one is refused rather than
  // quietly downgraded into believing it is confidential.
  const authMethod = input.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") {
    return registrationError(
      c,
      "invalid_client_metadata",
      "this server registers public clients only: token_endpoint_auth_method must be \"none\""
    );
  }

  if (input.response_types !== undefined) {
    const types = input.response_types;
    if (!Array.isArray(types) || types.some((t) => t !== "code")) {
      return registrationError(c, "invalid_client_metadata", "response_types must be [\"code\"]");
    }
  }
  if (input.grant_types !== undefined) {
    const grants = input.grant_types;
    const allowed = ["authorization_code", "refresh_token"];
    if (!Array.isArray(grants) || grants.some((g) => typeof g !== "string" || !allowed.includes(g))) {
      return registrationError(
        c,
        "invalid_client_metadata",
        "grant_types must be a subset of [\"authorization_code\", \"refresh_token\"]"
      );
    }
  }

  const scopes = parseOAuthScopes(input.scope);
  if (!scopes) {
    return registrationError(
      c,
      "invalid_client_metadata",
      `scope must be a space-delimited subset of: ${OAUTH_SCOPES_SUPPORTED.join(" ")}`
    );
  }

  let client: OAuthClient;
  try {
    client = await createOAuthClient(c.env, {
      clientName,
      redirectUris: redirects.uris,
      scope: scopes.join(" "),
      now: new Date().toISOString(),
    });
  } catch (e) {
    if (isMissingOAuthTable(e)) {
      return registrationError(
        c,
        "temporarily_unavailable",
        "this instance has not run the OAuth migration yet",
        503
      );
    }
    throw e;
  }

  return c.json(
    {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
      client_name: client.client_name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: client.scope,
    },
    201,
    NO_STORE
  );
});

// --- The authorization endpoint ----------------------------------------------

/** An authorization request, once every parameter has been checked. */
interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  scopes: OAuthScope[];
  state: string | null;
  codeChallenge: string;
  resource: string;
}

/** A failure the client is entitled to be told about at its own redirect URI. */
interface RedirectableFailure {
  redirectUri: string;
  state: string | null;
  error: string;
  detail: string;
}

/** A failure that must be rendered here, because no redirect target is trusted. */
interface PageFailure {
  error: string;
  detail: string;
  status: 400 | 403;
  retryHref?: string | null;
}

type AuthorizeOutcome =
  | { ok: true; request: AuthorizeRequest }
  | { ok: false; redirect: RedirectableFailure }
  | { ok: false; page: PageFailure };

type ClientResolution = { client: OAuthClient; cimd: boolean } | { page: PageFailure };

function normalizeClientMetadataUrl(raw: string): string | null {
  if (!raw || raw.length > 2048 || /[\s]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname) return null;
  return url.toString();
}

function redirectMatchesCimd(registered: string, presented: string): boolean {
  const a = new URL(registered);
  const b = new URL(presented);
  if (a.protocol === "http:" && b.protocol === "http:" && isLoopbackHostname(a.hostname) && isLoopbackHostname(b.hostname)) {
    return a.hostname.toLowerCase() === b.hostname.toLowerCase() && a.pathname === b.pathname && a.search === b.search && !b.hash;
  }
  return registered === presented;
}

async function fetchCimdClient(clientId: string, now: string): Promise<OAuthClient | null> {
  const metadataUrl = normalizeClientMetadataUrl(clientId);
  if (!metadataUrl) return null;
  const res = await fetch(metadataUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (normalizeClientMetadataUrl(String(input.client_id ?? "")) !== metadataUrl) return null;

  const redirects = normalizeRedirectUris(input.redirect_uris);
  if ("error" in redirects) return null;
  const authMethod = input.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") return null;
  if (input.response_types !== undefined) {
    const types = input.response_types;
    if (!Array.isArray(types) || types.some((t) => t !== "code")) return null;
  }
  if (input.grant_types !== undefined) {
    const grants = input.grant_types;
    const allowed = ["authorization_code", "refresh_token"];
    if (!Array.isArray(grants) || grants.some((g) => typeof g !== "string" || !allowed.includes(g))) return null;
  }
  const rawName = typeof input.client_name === "string" ? input.client_name.trim() : "";
  let clientName = new URL(metadataUrl).hostname;
  if (rawName && rawName.length <= MAX_CLIENT_NAME_LENGTH) clientName = `${clientName} (${rawName})`;
  return {
    client_id: metadataUrl,
    client_name: clientName.slice(0, MAX_CLIENT_NAME_LENGTH),
    redirectUris: redirects.uris,
    scope: typeof input.scope === "string" ? input.scope : null,
    created_at: now,
    last_used_at: null,
  };
}

async function resolveOAuthClient(c: Ctx, clientId: string, now: string): Promise<ClientResolution> {
  if (normalizeClientMetadataUrl(clientId)) {
    const client = await fetchCimdClient(clientId, now);
    if (client) return { client, cimd: true };
    return {
      page: {
        error: "invalid_client",
        detail: "That client metadata document could not be fetched or validated.",
        status: 400,
      },
    };
  }
  try {
    const client = await getOAuthClient(c.env, clientId);
    if (client) return { client, cimd: false };
  } catch (e) {
    if (isMissingOAuthTable(e)) {
      return {
        page: {
          error: "temporarily_unavailable",
          detail: "This instance has not run the OAuth migration yet.",
          status: 400,
        },
      };
    }
    throw e;
  }
  return {
    page: {
      error: "invalid_client",
      detail: "That application is not registered with this server.",
      status: 400,
    },
  };
}

/**
 * Validate an authorization request. Identical for GET and POST — the consent
 * form re-runs every check from scratch rather than trusting the hidden fields
 * it echoed back, so a tampered form can only ever produce a refusal.
 */
async function validateAuthorize(
  c: Ctx,
  params: URLSearchParams
): Promise<AuthorizeOutcome> {
  const clientId = params.get("client_id") ?? "";
  const now = new Date().toISOString();
  const resolved = await resolveOAuthClient(c, clientId, now);
  if ("page" in resolved) return { ok: false, page: resolved.page };
  const { client } = resolved;

  // Exact match against what was registered. Normalized on both sides with the
  // same function, so `https://x.example` and `https://x.example/` cannot be
  // made to disagree — and nothing here is a prefix or substring test.
  const presented = normalizeRedirectUri(params.get("redirect_uri"));
  const redirectAllowed = presented
    ? resolved.cimd
      ? client.redirectUris.some((registered) => redirectMatchesCimd(registered, presented))
      : client.redirectUris.includes(presented)
    : false;
  if (!presented || !redirectAllowed) {
    return {
      ok: false,
      page: {
        error: "invalid_redirect_uri",
        detail:
          "The redirect address in that request is not one this application registered, so it " +
          "cannot be sent an answer.",
        status: 400,
      },
    };
  }
  const redirectUri = presented;
  const state = params.get("state");

  const fail = (error: string, detail: string): AuthorizeOutcome => ({
    ok: false,
    redirect: { redirectUri, state, error, detail },
  });

  if (params.get("response_type") !== "code") {
    return fail("unsupported_response_type", "this server issues authorization codes only");
  }
  if (params.get("code_challenge_method") !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256");
  }
  const codeChallenge = params.get("code_challenge");
  if (!isValidCodeChallenge(codeChallenge)) {
    return fail("invalid_request", "a valid PKCE code_challenge is required");
  }

  const scopes = parseOAuthScopes(params.get("scope") ?? undefined);
  if (!scopes) {
    return fail("invalid_scope", `scope must be a subset of: ${OAUTH_SCOPES_SUPPORTED.join(" ")}`);
  }

  // RFC 8707. Absent means "the one resource this server protects", which is the
  // only thing it could mean here; a *different* one is refused rather than
  // silently reinterpreted.
  const resource = mcpResource(c);
  const requested = params.get("resource");
  if (requested !== null && requested !== "" && requested.replace(/\/+$/, "") !== resource) {
    return fail("invalid_target", `the only resource this server issues tokens for is ${resource}`);
  }

  return { ok: true, request: { client, redirectUri, scopes, state, codeChallenge, resource } };
}

function redirectWithError(c: Ctx, failure: RedirectableFailure) {
  const url = new URL(failure.redirectUri);
  url.searchParams.set("error", failure.error);
  url.searchParams.set("error_description", failure.detail);
  url.searchParams.set("iss", requestOrigin(c));
  if (failure.state) url.searchParams.set("state", failure.state);
  return c.redirect(url.toString(), 302);
}

function renderFailure(c: Ctx, failure: PageFailure) {
  return c.html(
    oauthErrorPage(c.env, {
      error: failure.error,
      detail: failure.detail,
      retryHref: failure.retryHref,
    }),
    failure.status
  );
}

function restartAuthorizeHref(params: URLSearchParams): string | null {
  const echoed = echoedParams(params);
  const next = new URLSearchParams(echoed);
  return next.toString() ? `/oauth/authorize?${next}` : null;
}

/**
 * Who is granting, or the response that has to happen before anybody can.
 *
 * Three identities are refused outright rather than being shown a consent
 * screen: a bearer-token caller (this is a browser flow, and a machine
 * credential must never be able to mint another one), a guest session (a
 * deliberately narrower credential, issued by clicking a link in a shared
 * artifact), and a paused account.
 */
async function consentingUser(
  c: Ctx
): Promise<{ identity: Identity } | { response: Response }> {
  const { identity, disabled, disabledEmail } = await resolveAuth(c);
  if (disabled) {
    return { response: c.html(accountPausedPage(c.env, disabledEmail), 403) };
  }
  if (identity?.token) {
    return {
      response: renderFailure(c, {
        error: "invalid_request",
        detail:
          "This is a browser sign-in. An API token cannot authorize an application on somebody's behalf.",
        status: 403,
      }),
    };
  }
  if (identity?.kind === "guest") {
    return {
      response: renderFailure(c, {
        error: "access_denied",
        detail:
          "You are signed in as a guest for one shared artifact. Guest access cannot authorize an application.",
        status: 403,
      }),
    };
  }
  if (!identity?.email) {
    const url = new URL(c.req.url);
    return {
      response: c.redirect(
        `/login?next=${encodeURIComponent(url.pathname + url.search)}`,
        302
      ),
    };
  }
  return { identity };
}

/** The authorize parameters, echoed into the consent form so POST can re-check them. */
function echoedParams(params: URLSearchParams): Record<string, string> {
  const keep = [
    "response_type",
    "client_id",
    "redirect_uri",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
    "resource",
  ];
  const out: Record<string, string> = {};
  for (const key of keep) {
    const value = params.get(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

function csrfCookie(value: string, maxAge: number): string {
  return [
    `${CSRF_COOKIE}=${value}`,
    "Path=/oauth",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

function newCsrfToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

oauthRoutes.get("/oauth/authorize", async (c) => {
  if (!(await incrementRateLimitBucket(c, `oauth:authz:${clientAddress(c)}`, AUTHORIZE_PER_IP))) {
    return c.text("Too many authorization attempts. Try again in an hour.", 429, {
      "Retry-After": "3600",
      ...NO_STORE,
    });
  }

  const params = new URL(c.req.url).searchParams;
  const outcome = await validateAuthorize(c, params);
  if (!outcome.ok) {
    return "page" in outcome ? renderFailure(c, outcome.page) : redirectWithError(c, outcome.redirect);
  }

  const who = await consentingUser(c);
  if ("response" in who) return who.response;

  const accounts = await resolveAccountContext(c.env, { email: who.identity.email }, { ensure: true });
  const csrf = newCsrfToken();

  return c.html(
    consentPage(c.env, {
      clientName: outcome.request.client.client_name,
      scopes: outcome.request.scopes,
      resource: outcome.request.resource,
      email: who.identity.email!,
      workspace: accounts.active?.name ?? null,
      expiresIn: "one hour, then it renews itself until you revoke it",
      csrf,
      params: echoedParams(params),
    }),
    200,
    { "Set-Cookie": csrfCookie(csrf, CSRF_TTL_SECONDS), ...NO_STORE }
  );
});

/**
 * The consent submission — the only browser POST in the product that mints a
 * credential.
 *
 * Everything GET checked is checked again here from the submitted fields. The
 * hidden inputs are a convenience for the browser, not a trusted record: a
 * tampered `scope` or `redirect_uri` fails the same validation the query string
 * did, so the worst a modified form can do is produce an error.
 */
oauthRoutes.post("/oauth/authorize", async (c) => {
  if (!(await incrementRateLimitBucket(c, `oauth:authz:${clientAddress(c)}`, AUTHORIZE_PER_IP))) {
    return c.text("Too many authorization attempts. Try again in an hour.", 429, {
      "Retry-After": "3600",
      ...NO_STORE,
    });
  }

  // A cross-origin POST is refused before anything else is read. `isAllowedOrigin`
  // is the same function `/api` and `/mcp` use, so a content host can never be an
  // allowed origin here either.
  const origin = c.req.header("Origin");
  if (origin && !isAllowedOrigin(c.env, c.req.url, origin)) {
    return renderFailure(c, {
      error: "invalid_request",
      detail: "That form was submitted from an origin this instance does not recognize.",
      status: 403,
    });
  }

  const form = await c.req.parseBody().catch(() => null);
  if (!form) {
    return renderFailure(c, {
      error: "invalid_request",
      detail: "That consent form could not be read.",
      status: 400,
    });
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (typeof value === "string") params.set(key, value);
  }

  // Double-submit CSRF. The cookie is host-only and `SameSite=Lax`, so a
  // cross-site POST carries neither it nor the session — this is the belt to
  // that browser-enforced brace.
  const cookieCsrf = readCookie(c.req.header("Cookie") ?? c.req.header("cookie"), CSRF_COOKIE);
  const formCsrf = params.get("csrf") ?? "";
  if (!cookieCsrf || !formCsrf || !timingSafeEqual(cookieCsrf, formCsrf)) {
    return renderFailure(c, {
      error: "invalid_request",
      detail:
        "That consent form has expired or did not come from this browser. Start the sign-in again.",
      status: 403,
      retryHref: restartAuthorizeHref(params),
    });
  }

  const outcome = await validateAuthorize(c, params);
  if (!outcome.ok) {
    return "page" in outcome ? renderFailure(c, outcome.page) : redirectWithError(c, outcome.redirect);
  }

  const who = await consentingUser(c);
  if ("response" in who) return who.response;

  const request = outcome.request;
  if (params.get("decision") !== "allow") {
    return redirectWithError(c, {
      redirectUri: request.redirectUri,
      state: request.state,
      error: "access_denied",
      detail: "the person declined this authorization",
    });
  }

  const now = new Date().toISOString();
  const accounts = await resolveAccountContext(c.env, { email: who.identity.email }, { ensure: true, now });

  const code = await createAuthorizationCode(c.env, {
    clientId: request.client.client_id,
    email: who.identity.email!,
    accountId: accounts.active?.id ?? null,
    scopes: request.scopes,
    resource: request.resource,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    now,
  });
  await touchOAuthClient(c.env, request.client.client_id, now);

  const target = new URL(request.redirectUri);
  target.searchParams.set("code", code);
  target.searchParams.set("iss", requestOrigin(c));
  if (request.state) target.searchParams.set("state", request.state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      // The consent is spent; the cookie should not outlive it.
      "Set-Cookie": csrfCookie("", 0),
      ...NO_STORE,
    },
  });
});

// --- The token endpoint ------------------------------------------------------

function tokenError(c: Ctx, error: string, detail: string, status: 400 | 401 = 400) {
  return c.json({ error, error_description: detail }, status, NO_STORE);
}

/** Form-encoded per RFC 6749; JSON is accepted too, because some clients send it. */
async function tokenParams(c: Ctx): Promise<URLSearchParams | null> {
  const type = (c.req.header("Content-Type") ?? "").toLowerCase();
  try {
    if (type.includes("application/json")) {
      const body = await c.req.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) return null;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (typeof v === "string") params.set(k, v);
      }
      return params;
    }
    return new URLSearchParams(await c.req.text());
  } catch {
    return null;
  }
}

/**
 * Mint the access token for a completed grant.
 *
 * This is the load-bearing decision of the whole design: the access token is an
 * ordinary `api_tokens` row with a one-hour expiry and the consented scopes, so
 * `requireApiToken`, `requireScope`, the paused-account check and
 * revoke-on-user-removal all apply to it with no second authorization path.
 *
 * `isAdmin` is hard-coded false. A platform admin authorizing an MCP client must
 * not hand that client platform authority — the OAuth surface issues workspace
 * credentials and nothing more, whoever is signing in.
 */
async function issueAccessToken(
  env: Env,
  input: {
    client: { client_id: string; client_name: string };
    email: string;
    accountId: string | null;
    scopes: OAuthScope[];
    now: string;
  }
): Promise<{ token: string; expiresAt: string }> {
  const expiresAt = new Date(
    Date.parse(input.now) + ACCESS_TOKEN_TTL_SECONDS * 1000
  ).toISOString();
  const { token, row } = await createApiToken(env, {
    name: `${input.client.client_name} (OAuth)`.slice(0, MAX_TOKEN_NAME_LENGTH),
    ownerEmail: input.email,
    accountId: input.accountId,
    isAdmin: false,
    scopes: toInternalScopes(input.scopes),
    createdBy: `oauth:${input.client.client_id}`,
    expiresAt,
    now: input.now,
  });
  await markTokenIssuedViaOAuth(env, row.id, input.client.client_id);
  return { token, expiresAt };
}

oauthRoutes.post("/oauth/token", async (c) => {
  if (!(await incrementRateLimitBucket(c, `oauth:token:${clientAddress(c)}`, TOKEN_PER_IP))) {
    return c.json({ error: "rate_limited" }, 429, { "Retry-After": "3600", ...NO_STORE });
  }

  const params = await tokenParams(c);
  if (!params) return tokenError(c, "invalid_request", "send an application/x-www-form-urlencoded body");

  const grantType = params.get("grant_type");
  const clientId = params.get("client_id") ?? "";

  // No client authentication exists here: every client is public and PKCE is
  // what proves the token request came from the same software that started the
  // flow. `client_id` still has to name a registered client, and still has to
  // match the one the code was issued to.
  if (params.get("client_secret")) {
    return tokenError(
      c,
      "invalid_client",
      "this server registers public clients only; do not send a client_secret",
      401
    );
  }

  const now = new Date().toISOString();
  const resolved = await resolveOAuthClient(c, clientId, now);
  if ("page" in resolved) {
    const status = resolved.page.error === "invalid_client" ? 401 : 400;
    return tokenError(c, resolved.page.error, resolved.page.detail, status as 400 | 401);
  }
  const { client } = resolved;

  if (grantType === "authorization_code") {
    const code = params.get("code") ?? "";
    const verifier = params.get("code_verifier");
    const redirectUri = normalizeRedirectUri(params.get("redirect_uri"));
    if (!code) return tokenError(c, "invalid_request", "code is required");
    if (!isValidCodeVerifier(verifier)) {
      return tokenError(c, "invalid_request", "a valid PKCE code_verifier is required");
    }
    if (!redirectUri) return tokenError(c, "invalid_request", "redirect_uri is required");

    const claimed = await claimAuthorizationCode(c.env, code, now);
    if (typeof claimed === "string") {
      // "replayed" is reported as an ordinary invalid_grant: telling a caller
      // that a code existed and was already spent is a signal it has no use for.
      return tokenError(c, "invalid_grant", "that authorization code is not usable");
    }
    if (claimed.client_id !== client.client_id) {
      return tokenError(c, "invalid_grant", "that authorization code was issued to another client");
    }
    if (claimed.redirect_uri !== redirectUri) {
      return tokenError(c, "invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (!timingSafeEqual(await s256(verifier), claimed.code_challenge)) {
      return tokenError(c, "invalid_grant", "the code_verifier does not match the code_challenge");
    }

    const scopes = rowOAuthScopes(claimed.scopes);
    if (!scopes.length) return tokenError(c, "invalid_grant", "that grant carries no usable scope");

    const { token } = await issueAccessToken(c.env, {
      client,
      email: claimed.email,
      accountId: claimed.account_id,
      scopes,
      now,
    });
    const refresh = await createRefreshToken(c.env, {
      clientId: client.client_id,
      email: claimed.email,
      accountId: claimed.account_id,
      scopes,
      resource: claimed.resource,
      now,
    });
    await touchOAuthClient(c.env, client.client_id, now);

    return c.json(
      {
        access_token: token,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: refresh,
        refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS,
        scope: scopes.join(" "),
      },
      200,
      NO_STORE
    );
  }

  if (grantType === "refresh_token") {
    const presented = params.get("refresh_token") ?? "";
    if (!isRefreshTokenShape(presented)) {
      return tokenError(c, "invalid_grant", "that refresh token is not usable");
    }
    const row = await findRefreshToken(c.env, presented);
    if (!row || !isRefreshUsable(row, now) || row.client_id !== client.client_id) {
      return tokenError(c, "invalid_grant", "that refresh token is not usable");
    }

    let scopes = rowOAuthScopes(row.scopes);
    // RFC 6749 §6: a refresh may narrow the scope, never widen it.
    const requested = params.get("scope");
    if (requested) {
      const asked = parseOAuthScopes(requested);
      if (!asked || asked.some((s) => !scopes.includes(s))) {
        return tokenError(c, "invalid_scope", "a refresh may only narrow the scopes it was granted");
      }
      scopes = asked;
    }
    if (!scopes.length) return tokenError(c, "invalid_grant", "that grant carries no usable scope");

    // Rotate: the presented token is spent whether or not the client ever sees
    // the new one, so a stolen refresh token is usable at most once.
    if (!(await revokeRefreshToken(c.env, row.id, now))) {
      return tokenError(c, "invalid_grant", "that refresh token is not usable");
    }

    const { token } = await issueAccessToken(c.env, {
      client,
      email: row.email,
      accountId: row.account_id,
      scopes,
      now,
    });
    const refresh = await createRefreshToken(c.env, {
      clientId: client.client_id,
      email: row.email,
      accountId: row.account_id,
      scopes,
      resource: row.resource,
      now,
    });
    await touchOAuthClient(c.env, client.client_id, now);

    return c.json(
      {
        access_token: token,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: refresh,
        refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS,
        scope: scopes.join(" "),
      },
      200,
      NO_STORE
    );
  }

  return tokenError(
    c,
    "unsupported_grant_type",
    "this server supports authorization_code and refresh_token"
  );
});

// --- Revocation (RFC 7009) ---------------------------------------------------

/**
 * `claude mcp logout`, and the thing that makes a leaked OAuth credential
 * something a client can clean up after itself.
 *
 * RFC 7009 §2.2: the response is 200 whether or not anything was revoked, so
 * this endpoint is not an oracle for which tokens exist. Possession of the token
 * is the authorization — somebody holding it can already use it, so letting them
 * destroy it grants nothing.
 *
 * An access token is only revoked when it was issued *by this surface*
 * (`issued_via = 'oauth'`). A dashboard-minted token is revoked in the dashboard,
 * by a signed-in human; the OAuth endpoint has no business reaching it.
 */
oauthRoutes.post("/oauth/revoke", async (c) => {
  const params = await tokenParams(c);
  const presented = params?.get("token") ?? "";
  if (!presented) return c.body(null, 200, NO_STORE);
  const now = new Date().toISOString();

  try {
    if (isRefreshTokenShape(presented)) {
      const row = await findRefreshToken(c.env, presented);
      if (row) await revokeRefreshToken(c.env, row.id, now);
      return c.body(null, 200, NO_STORE);
    }
    const row = await findApiToken(c.env, presented);
    if (row) {
      const issued = await c.env.DB.prepare("SELECT issued_via FROM api_tokens WHERE id = ?")
        .bind(row.id)
        .first<{ issued_via: string | null }>()
        .catch(() => null);
      if (issued?.issued_via === "oauth") await revokeApiToken(c.env, row.id, now);
    }
  } catch {
    // RFC 7009: an unrecognized token is not an error, and neither is a
    // not-yet-migrated instance with nothing to revoke.
  }
  return c.body(null, 200, NO_STORE);
});

// --- Everything else under /oauth --------------------------------------------

/**
 * `/oauth/<anything else>` is not a route. Answered as the product's own 404
 * rather than falling through to the artifact catch-all, which would otherwise
 * try to serve a slug named `oauth`.
 */
oauthRoutes.all("/oauth/*", (c) => c.html(notFoundPage(), 404));
