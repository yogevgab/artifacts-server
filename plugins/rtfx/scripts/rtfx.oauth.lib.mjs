// The pure half of "sign in to rtfx from Claude Code without pasting a token".
//
// Everything here is a plain function over plain data: no `node:` imports, no
// filesystem, no network, no clock. That is what lets the artifacts-server test
// suite exercise it inside the Workers pool — where `node:fs` does not exist —
// while the plugin itself ships standalone. The impure half (a file with mode
// 0600, a loopback HTTP listener, a browser) lives in `rtfx.oauth.mjs`.
//
// The flow this implements is the one src/oauth-routes.ts serves: RFC 8414
// discovery, RFC 7591 dynamic registration as a *public* client, authorization
// code + PKCE S256 to a loopback redirect (RFC 8252), and refresh-token rotation.
//
// The one fact that makes this small: the access token an OAuth grant returns is
// an ordinary `rtfx_<id>_<secret>` token row (see the header of src/oauth.ts), so
// once it is stored there is nothing new on the publish path — it goes into the
// same `Authorization: Bearer` header `RTFX_API_TOKEN` always did.

import { redactToken, tokenId } from "./rtfx.lib.mjs";

// --- What this client is ------------------------------------------------------

/** The `client_name` a person sees on the consent screen. */
export const CLIENT_NAME = "rtfx plugin for Claude Code";

/**
 * What login asks for. `rtfx:manage` is deliberately absent: publishing needs
 * read and publish, and a credential that can also change who may open an
 * artifact should be something a person opts into, not the default of a
 * one-command login.
 */
export const LOGIN_SCOPES = ["rtfx:read", "rtfx:publish"];

/** Mirrors PROTECTED_RESOURCE / MCP_PATH server-side: the RFC 8707 resource. */
export const RESOURCE_PATH = "/mcp";

/** RFC 8414 authorization-server metadata, relative to the issuer. */
export const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";

// --- Where the credential lives ----------------------------------------------

/** Directory under the config home. */
export const CONFIG_DIRNAME = "rtfx";

/** The file itself. */
export const CREDENTIALS_FILENAME = "credentials.json";

/** Owner read/write only. A credential store any other account can read is a leak. */
export const FILE_MODE = 0o600;

/** Owner-only directory, for the same reason. */
export const DIR_MODE = 0o700;

/** Bumped only if the on-disk shape changes incompatibly. */
export const STORE_VERSION = 1;

/**
 * Refresh this long before the access token actually expires.
 *
 * The server issues one-hour tokens. Two minutes of margin covers a slow upload
 * that started while the token was still valid — the alternative is a publish
 * that fails with a 401 halfway through for no reason a user could act on.
 */
export const REFRESH_SKEW_SECONDS = 120;

/**
 * The config directory, honouring `XDG_CONFIG_HOME`.
 *
 * `join` is injected (the caller passes `node:path`'s) so this stays free of
 * `node:` imports and still produces native separators on Windows.
 */
export function configDir(env = {}, home = "", join = defaultJoin) {
  const xdg = typeof env.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME.trim() : "";
  const base = xdg || join(home, ".config");
  return join(base, CONFIG_DIRNAME);
}

/** The credentials file path. */
export function credentialsPath(env = {}, home = "", join = defaultJoin) {
  return join(configDir(env, home, join), CREDENTIALS_FILENAME);
}

/** A POSIX-ish join, used only when no real one is injected (tests). */
function defaultJoin(...parts) {
  return parts.filter((p) => p !== "" && p !== undefined && p !== null).join("/").replace(/\/{2,}/g, "/");
}

// --- Issuers -----------------------------------------------------------------

/**
 * The issuer for an endpoint: its origin, and nothing else.
 *
 * Credentials are keyed by this rather than by the raw endpoint string so
 * `https://rtfx.pro` and `https://rtfx.pro/` cannot end up as two entries with
 * two different tokens — and so a credential minted for one host is never
 * offered to another.
 */
export function issuerFor(endpoint) {
  try {
    return new URL(String(endpoint)).origin;
  } catch {
    return null;
  }
}

/** The RFC 8707 resource identifier this client asks its token be bound to. */
export function resourceFor(issuer) {
  return `${String(issuer).replace(/\/+$/, "")}${RESOURCE_PATH}`;
}

// --- The store ---------------------------------------------------------------

export function emptyStore() {
  return { version: STORE_VERSION, credentials: {} };
}

/**
 * Parse the file. Deliberately total: a truncated or hand-edited file yields an
 * empty store rather than an exception, because the recovery for both is the
 * same — `rtfx.mjs login` overwrites it — and a crash on every command would
 * make that hard to reach.
 */
export function parseStore(text) {
  if (typeof text !== "string" || !text.trim()) return emptyStore();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyStore();
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyStore();
  const credentials = raw.credentials;
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) return emptyStore();
  const out = emptyStore();
  for (const [issuer, value] of Object.entries(credentials)) {
    if (value && typeof value === "object" && typeof value.access_token === "string") {
      out.credentials[issuer] = value;
    }
  }
  return out;
}

/** Serialize for writing. Trailing newline so the file behaves in an editor. */
export function serializeStore(store) {
  return `${JSON.stringify({ version: STORE_VERSION, credentials: store?.credentials ?? {} }, null, 2)}\n`;
}

export function getCredential(store, issuer) {
  if (!store || !issuer) return null;
  return store.credentials?.[issuer] ?? null;
}

/** A copy of `store` with one issuer's credential replaced. Never mutates. */
export function putCredential(store, issuer, credential) {
  const base = store?.credentials ?? {};
  return { version: STORE_VERSION, credentials: { ...base, [issuer]: credential } };
}

/** A copy of `store` with one issuer removed. Never mutates. */
export function removeCredential(store, issuer) {
  const { [issuer]: _dropped, ...rest } = store?.credentials ?? {};
  return { version: STORE_VERSION, credentials: rest };
}

/** True once a store holds nothing worth keeping a file for. */
export function isStoreEmpty(store) {
  return Object.keys(store?.credentials ?? {}).length === 0;
}

// --- Credential shape and freshness -------------------------------------------

/**
 * Turn a `/oauth/token` response into the record we persist.
 *
 * `previous` carries forward the things a refresh response does not repeat — the
 * discovered endpoints and the client id — so a refreshed credential is as
 * complete as the one login wrote.
 */
export function credentialFromTokenResponse(body, { issuer, clientId, endpoints, nowMs, previous = null }) {
  const expiresIn = Number(body?.expires_in);
  const lifetime = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
  const scope = typeof body?.scope === "string" && body.scope ? body.scope.split(/\s+/).filter(Boolean) : null;
  return {
    issuer,
    client_id: clientId ?? previous?.client_id ?? null,
    access_token: String(body?.access_token ?? ""),
    refresh_token:
      typeof body?.refresh_token === "string" && body.refresh_token
        ? body.refresh_token
        : (previous?.refresh_token ?? null),
    expires_at: new Date(nowMs + lifetime * 1000).toISOString(),
    obtained_at: new Date(nowMs).toISOString(),
    scopes: scope ?? previous?.scopes ?? [...LOGIN_SCOPES],
    token_endpoint: endpoints?.token_endpoint ?? previous?.token_endpoint ?? null,
    revocation_endpoint: endpoints?.revocation_endpoint ?? previous?.revocation_endpoint ?? null,
    resource: previous?.resource ?? resourceFor(issuer),
  };
}

/** True when the access token is gone, or close enough to expiry to be worth renewing. */
export function needsRefresh(credential, nowMs, skewSeconds = REFRESH_SKEW_SECONDS) {
  if (!credential?.access_token) return true;
  const at = Date.parse(credential.expires_at ?? "");
  if (!Number.isFinite(at)) return true;
  return at - skewSeconds * 1000 <= nowMs;
}

/** True when the token is past its expiry outright, margin aside. */
export function isExpired(credential, nowMs) {
  return needsRefresh(credential, nowMs, 0);
}

/**
 * A printable summary of a credential.
 *
 * This is the only function that is allowed anywhere near a stored token in
 * user-facing output, and it returns the token *id* — `rtfx_<id>_…` — never the
 * secret. The id is what `/admin/integrations` lists and what a revoke takes, so
 * it is all anyone needs; an agent transcript is exactly the place a secret
 * should not be.
 */
export function describeCredential(credential) {
  if (!credential) return null;
  return {
    issuer: credential.issuer ?? null,
    client_id: credential.client_id ?? null,
    token: redactToken(credential.access_token),
    token_id: tokenId(credential.access_token),
    scopes: Array.isArray(credential.scopes) ? credential.scopes : [],
    expires_at: credential.expires_at ?? null,
    has_refresh_token: Boolean(credential.refresh_token),
  };
}

/**
 * A refresh token is a bearer credential too, and it does not match the
 * `rtfx_<id>_<secret>` shape `redactToken` understands (it is `rtfxr_<random>`,
 * deliberately — see newRefreshToken in src/oauth.ts). It carries no id worth
 * showing, so it redacts to a constant.
 */
export function redactRefreshToken(token) {
  return typeof token === "string" && token.startsWith("rtfxr_") ? "rtfxr_…" : "[redacted]";
}

// --- Credential resolution ----------------------------------------------------

export const SOURCE_ENV = "env";
export const SOURCE_OAUTH = "oauth";
export const SOURCE_NONE = "none";

/**
 * Which credential a command should use.
 *
 * `RTFX_API_TOKEN` wins, always. That is not an accident of ordering: CI and
 * scripted use set it deliberately, often to a token with different scopes than
 * an interactive login would grant, and a stored browser credential silently
 * overriding it would be a surprise in exactly the setting where surprises are
 * most expensive. A stored OAuth credential is the fallback for the interactive
 * case, and only for the issuer it was minted against.
 */
export function resolveCredentialSource({ env = {}, store = null, endpoint, tokenVar = "RTFX_API_TOKEN" }) {
  const envToken = typeof env[tokenVar] === "string" ? env[tokenVar].trim() : "";
  if (envToken) return { source: SOURCE_ENV, token: envToken, credential: null, issuer: issuerFor(endpoint) };
  const issuer = issuerFor(endpoint);
  const credential = issuer ? getCredential(store, issuer) : null;
  if (credential?.access_token) {
    return { source: SOURCE_OAUTH, token: credential.access_token, credential, issuer };
  }
  return { source: SOURCE_NONE, token: "", credential: null, issuer };
}

// --- Failures -----------------------------------------------------------------

/**
 * An OAuth-specific refusal. `needsLogin` is the field callers act on: it means
 * the stored credential is beyond saving and the only cure is running login
 * again, so a caller should say that rather than retry.
 */
export class OAuthError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "OAuthError";
    this.detail = extra.detail ?? null;
    this.hint = extra.hint ?? null;
    this.needsLogin = extra.needsLogin ?? false;
    this.status = extra.status ?? null;
  }
}

// --- PKCE ---------------------------------------------------------------------

export function base64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A PKCE code verifier: 32 bytes of CSPRNG output, base64url'd to 43 characters
 * — the shortest length RFC 7636 §4.1 allows, and the full 256 bits of entropy.
 * `randomBytes` is injected so a test can make the flow deterministic.
 */
export function newCodeVerifier(randomBytes) {
  return base64url(randomBytes(32));
}

/** `state`, which ties a callback to the request that started it (RFC 6749 §10.12). */
export function newState(randomBytes) {
  return base64url(randomBytes(16));
}

/**
 * The S256 challenge for a verifier. `digest` is injected — `crypto.subtle` in
 * both real callers, so there is no hash implementation here to get wrong.
 */
export async function codeChallenge(verifier, digest) {
  const out = await digest(new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(out));
}

// --- Discovery ----------------------------------------------------------------

export function metadataUrl(issuer) {
  return `${String(issuer).replace(/\/+$/, "")}${AS_METADATA_PATH}`;
}

/**
 * Validate an RFC 8414 metadata document.
 *
 * Every endpoint has to sit on the issuer's own origin. Without that check a
 * compromised or spoofed discovery document could point the token exchange —
 * which carries the authorization code and the PKCE verifier — at somebody
 * else's server. Discovery is fetched over TLS from the host the user typed, so
 * this is the only place that trust needs re-checking.
 */
export function parseMetadata(body, issuer) {
  if (!body || typeof body !== "object") {
    throw new OAuthError("the discovery document was not a JSON object", {
      hint: `Check that ${issuer} is an rtfx instance.`,
    });
  }
  const origin = issuerFor(issuer);
  const sameOrigin = (value) => typeof value === "string" && issuerFor(value) === origin;

  for (const key of ["authorization_endpoint", "token_endpoint"]) {
    if (!sameOrigin(body[key])) {
      throw new OAuthError(`the discovery document's ${key} is missing or not on ${origin}`, {
        hint: "Refusing to send an authorization code to a host other than the one being signed into.",
      });
    }
  }
  for (const key of ["registration_endpoint", "revocation_endpoint"]) {
    if (body[key] !== undefined && body[key] !== null && !sameOrigin(body[key])) {
      throw new OAuthError(`the discovery document's ${key} is not on ${origin}`, {
        hint: "Refusing to use an endpoint on a host other than the one being signed into.",
      });
    }
  }
  const methods = body.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) {
    throw new OAuthError("that server does not support PKCE S256", {
      hint: "This client will not fall back to a weaker challenge method.",
    });
  }
  return {
    issuer: origin,
    authorization_endpoint: body.authorization_endpoint,
    token_endpoint: body.token_endpoint,
    registration_endpoint: sameOrigin(body.registration_endpoint) ? body.registration_endpoint : null,
    revocation_endpoint: sameOrigin(body.revocation_endpoint) ? body.revocation_endpoint : null,
    scopes_supported: Array.isArray(body.scopes_supported) ? body.scopes_supported : null,
  };
}

// --- Requests -----------------------------------------------------------------

/** The RFC 7591 registration body for this client. */
export function registrationRequest(redirectUris, scopes = LOGIN_SCOPES) {
  return {
    client_name: CLIENT_NAME,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: scopes.join(" "),
  };
}

/** The URL to open in a browser. */
export function authorizeUrl({ authorizationEndpoint, clientId, redirectUri, scopes, state, challenge, resource }) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", (scopes ?? LOGIN_SCOPES).join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (resource) url.searchParams.set("resource", resource);
  return url.toString();
}

/** `application/x-www-form-urlencoded`, which is the only body /oauth/token takes. */
export function formBody(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  return search.toString();
}

export function authorizationCodeForm({ clientId, code, codeVerifier, redirectUri }) {
  return formBody({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });
}

export function refreshForm({ clientId, refreshToken }) {
  return formBody({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
}

export function revokeForm(token) {
  return formBody({ token });
}

/**
 * Read the loopback callback.
 *
 * `state` is compared before anything else is believed: a mismatched or missing
 * state means this request did not come from the flow we started, and the code
 * in it — whoever put it there — must not be exchanged.
 */
export function parseCallback(requestUrl, expectedState) {
  let url;
  try {
    url = new URL(String(requestUrl), "http://127.0.0.1");
  } catch {
    return { ok: false, error: "invalid_request", detail: "the callback URL could not be parsed" };
  }
  const params = url.searchParams;
  const state = params.get("state");
  if (!expectedState || state !== expectedState) {
    return { ok: false, error: "state_mismatch", detail: "the callback did not carry the state this login sent" };
  }
  const error = params.get("error");
  if (error) {
    return { ok: false, error, detail: params.get("error_description") ?? "the authorization server refused" };
  }
  const code = params.get("code");
  if (!code) return { ok: false, error: "invalid_request", detail: "the callback carried no authorization code" };
  return { ok: true, code, issuer: params.get("iss") };
}

// --- Token exchange -----------------------------------------------------------

/** How a `/oauth/token` failure body reads back as a sentence. */
function tokenErrorMessage(status, body) {
  const error = typeof body?.error === "string" ? body.error : `HTTP ${status}`;
  const detail = typeof body?.error_description === "string" ? body.error_description : null;
  return { error, detail };
}

/**
 * POST to the token endpoint and validate the answer.
 *
 * An `invalid_grant` is the one outcome worth distinguishing: it means the code
 * or refresh token is spent, expired or revoked, so retrying is pointless and the
 * caller should send the user back through login.
 */
export async function postToken({ tokenEndpoint, body, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
  } catch (e) {
    throw new OAuthError(`could not reach ${tokenEndpoint}`, {
      detail: e?.message ?? String(e),
      hint: "Check that the instance is reachable from here.",
    });
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const { error, detail } = tokenErrorMessage(res.status, payload);
    const spent = error === "invalid_grant" || error === "invalid_client";
    throw new OAuthError(`the token endpoint refused: ${error}`, {
      detail,
      status: res.status,
      needsLogin: spent,
      hint: spent ? "That sign-in is no longer valid. Run login again." : "Retry; if it persists the server is refusing.",
    });
  }
  if (!payload || typeof payload.access_token !== "string" || !payload.access_token) {
    throw new OAuthError("the token endpoint returned no access token", {
      hint: "The server answered 200 without a credential — this is not an rtfx OAuth endpoint.",
    });
  }
  return payload;
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * The server rotates on every use (see `/oauth/token`'s refresh branch), so the
 * returned refresh token *replaces* the presented one and the caller must persist
 * the result before using it — a rotation that is not written down leaves the
 * stored credential pointing at a token that has already been spent.
 */
export async function refreshCredential({ credential, fetchImpl, nowMs }) {
  if (!credential?.refresh_token) {
    throw new OAuthError("that stored sign-in has no refresh token", {
      needsLogin: true,
      hint: "Run login again to get a fresh one.",
    });
  }
  const tokenEndpoint = credential.token_endpoint || `${credential.issuer}/oauth/token`;
  const payload = await postToken({
    tokenEndpoint,
    body: refreshForm({ clientId: credential.client_id, refreshToken: credential.refresh_token }),
    fetchImpl,
  });
  return credentialFromTokenResponse(payload, {
    issuer: credential.issuer,
    clientId: credential.client_id,
    endpoints: {
      token_endpoint: credential.token_endpoint,
      revocation_endpoint: credential.revocation_endpoint,
    },
    nowMs,
    previous: credential,
  });
}
