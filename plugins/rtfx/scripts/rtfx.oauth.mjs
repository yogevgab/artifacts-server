// The impure half of rtfx login: a credential file with mode 0600, a loopback
// listener for the OAuth callback, and a browser.
//
// The protocol itself — PKCE, discovery validation, the store's shape, refresh
// rotation — is in `rtfx.oauth.lib.mjs`, which has no `node:` imports and is unit
// tested. This file is the part that cannot be: it touches the filesystem, binds
// a socket and spawns `open`. Keeping the split means the rules that matter are
// exercised by the suite even though the suite runs in a Workers pool.
//
// Standalone by design, like the rest of the plugin: Node 18+, no dependencies.

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import {
  DIR_MODE,
  FILE_MODE,
  LOGIN_SCOPES,
  OAuthError,
  authorizationCodeForm,
  authorizeUrl,
  codeChallenge,
  credentialFromTokenResponse,
  credentialsPath as credentialsPathFor,
  emptyStore,
  getCredential,
  isStoreEmpty,
  issuerFor,
  metadataUrl,
  needsRefresh,
  newCodeVerifier,
  newState,
  parseCallback,
  parseMetadata,
  parseStore,
  postToken,
  putCredential,
  refreshCredential,
  registrationRequest,
  removeCredential,
  resourceFor,
  revokeForm,
  serializeStore,
} from "./rtfx.oauth.lib.mjs";

export { OAuthError };

/** Where the credential file lives on this machine. */
export function credentialsPath(env = process.env) {
  return credentialsPathFor(env, homedir(), join);
}

// --- Reading and writing the store -------------------------------------------

/**
 * Read the store. Never throws: an unreadable or corrupt file reads as empty,
 * because every command's recovery from both is the same (`login` rewrites it)
 * and a hard failure would make that advice impossible to follow.
 */
export function loadStore(env = process.env) {
  const path = credentialsPath(env);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return emptyStore();
  }
  return parseStore(text);
}

/**
 * Write the store with owner-only permissions.
 *
 * The mode is set twice on purpose. `writeFileSync`'s `mode` applies only when
 * the file is *created* — it is masked by the process umask and ignored entirely
 * when the file already exists — so an explicit `chmodSync` afterwards is what
 * actually guarantees 0600 on a rewrite. The directory gets the same treatment.
 */
export function saveStore(store, env = process.env) {
  const path = credentialsPath(env);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // A config dir the user shares with other tools may not be ours to chmod;
    // the file's own mode is the control that matters.
  }
  writeFileSync(path, serializeStore(store), { mode: FILE_MODE });
  chmodSync(path, FILE_MODE);
  return path;
}

/** Delete the file once nothing is left in it, so logout leaves no trace. */
function saveOrRemove(store, env) {
  const path = credentialsPath(env);
  if (isStoreEmpty(store)) {
    if (existsSync(path)) unlinkSync(path);
    return path;
  }
  return saveStore(store, env);
}

/** The stored credential for an endpoint, or null. Synchronous, no network. */
export function readCredential(endpoint, env = process.env) {
  const issuer = issuerFor(endpoint);
  return issuer ? getCredential(loadStore(env), issuer) : null;
}

/**
 * A usable access token for an endpoint, refreshing and persisting first if the
 * stored one is expired or nearly so.
 *
 * The rotation is written to disk *before* the token is handed back: the server
 * spends the presented refresh token whether or not this process survives to use
 * the new one, so a rotation that is not persisted strands the credential.
 */
export async function ensureAccessToken(endpoint, { env = process.env, fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const issuer = issuerFor(endpoint);
  if (!issuer) return null;
  const store = loadStore(env);
  const credential = getCredential(store, issuer);
  if (!credential) return null;
  if (!needsRefresh(credential, nowMs)) return credential;

  const refreshed = await refreshAndPersist({ credential, issuer, store, env, fetchImpl, nowMs });
  return refreshed;
}

/** Refresh one credential and write the rotation down. Shared by the CLI and MCP paths. */
export async function refreshAndPersist({ credential, issuer, store = null, env = process.env, fetchImpl = fetch, nowMs = Date.now() }) {
  const next = await refreshCredential({ credential, fetchImpl, nowMs });
  saveStore(putCredential(store ?? loadStore(env), issuer, next), env);
  return next;
}

// --- Discovery ----------------------------------------------------------------

async function discover(issuer, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(metadataUrl(issuer), { headers: { Accept: "application/json" } });
  } catch (e) {
    throw new OAuthError(`could not reach ${issuer}`, {
      detail: e?.message ?? String(e),
      hint: "Check ARTIFACTS_URL and that the host is reachable from here.",
    });
  }
  if (!res.ok) {
    throw new OAuthError(`${issuer} has no OAuth discovery document (HTTP ${res.status})`, {
      status: res.status,
      hint: "That instance may predate browser login. Mint a token at /admin/integrations and export RTFX_API_TOKEN instead.",
    });
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new OAuthError(`${issuer} answered discovery with something that is not JSON`, {
      hint: "Check that ARTIFACTS_URL points straight at an rtfx instance and not at a proxy.",
    });
  }
  return parseMetadata(body, issuer);
}

// --- Registration -------------------------------------------------------------

async function register(metadata, redirectUris, fetchImpl) {
  if (!metadata.registration_endpoint) {
    throw new OAuthError("that instance does not offer dynamic client registration", {
      hint: "Mint a token at /admin/integrations and export RTFX_API_TOKEN instead.",
    });
  }
  const res = await fetchImpl(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(registrationRequest(redirectUris)),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || typeof body?.client_id !== "string") {
    if (res.status === 429) {
      throw new OAuthError("that instance is rate-limiting client registration", {
        status: 429,
        hint: "Too many login attempts from this address in the last hour. Wait, or export RTFX_API_TOKEN instead.",
      });
    }
    throw new OAuthError(`registration was refused: ${body?.error ?? `HTTP ${res.status}`}`, {
      detail: body?.error_description ?? null,
      status: res.status,
    });
  }
  return body.client_id;
}

// --- The loopback callback ----------------------------------------------------

/**
 * The page the browser lands on. Deliberately self-contained and inert: no
 * network references, no script. It renders after the code has already been
 * captured, so nothing here is load-bearing.
 */
function callbackPage(title, detail) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;
background:#0b0b0f;color:#e8e8ef}main{max-width:32rem;padding:2rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#a0a0b0}</style></head>
<body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;
}

/**
 * Start the loopback listener.
 *
 * Binds an ephemeral port rather than a fixed one: a pinned port is a collision
 * waiting to happen on a developer machine, and the redirect URI is registered
 * fresh for each login anyway, so there is nothing to gain by fixing it.
 *
 * Returns as soon as the socket is bound — the caller needs the port to build a
 * redirect URI it can register — and hands back a promise that settles when the
 * callback arrives, plus the `state` setter and a way to shut down early.
 */
function startCallbackServer({ timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolveReady, rejectReady) => {
    let expectedState = null;
    let settle = null;
    let settled = false;

    const result = new Promise((r) => {
      settle = r;
    });

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      settle(value);
    };

    const server = createServer((req, res) => {
      const parsed = parseCallback(req.url ?? "/", expectedState);
      // A request that is not our callback is background noise on a loopback
      // port, not a failed login. Answer it and keep waiting.
      if (!parsed.ok && parsed.error === "state_mismatch") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found\n");
        return;
      }
      const title = parsed.ok ? "Signed in to rtfx" : "Sign-in failed";
      const detail = parsed.ok
        ? "You can close this tab and return to your terminal."
        : `${parsed.error}: ${parsed.detail}`;
      res.writeHead(parsed.ok ? 200 : 400, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(callbackPage(title, detail));
      finish(parsed);
    });

    const timer = setTimeout(
      () => finish({ ok: false, error: "timeout", detail: "no callback arrived within five minutes" }),
      timeoutMs
    );
    if (typeof timer.unref === "function") timer.unref();

    server.on("error", (e) => {
      if (settled) {
        return;
      }
      rejectReady(new OAuthError(`could not listen for the sign-in callback: ${e.message}`));
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveReady({
        redirectUri: `http://127.0.0.1:${port}/callback`,
        setState: (s) => {
          expectedState = s;
        },
        result,
        cancel: () => finish({ ok: false, error: "cancelled", detail: "the login was cancelled" }),
      });
    });
  });
}

// --- Browser ------------------------------------------------------------------

/**
 * Open a URL in the default browser, best effort.
 *
 * Returns false rather than throwing when there is no browser to open — a
 * headless box, a container, an SSH session — because the URL is printed either
 * way and the flow still completes if the person opens it themselves.
 */
export function openBrowser(url) {
  const commands =
    process.platform === "darwin"
      ? [["open", [url]]]
      : process.platform === "win32"
        ? [["cmd", ["/c", "start", "", url]]]
        : [
            ["xdg-open", [url]],
            ["sensible-browser", [url]],
          ];
  for (const [command, args] of commands) {
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
      return true;
    } catch {
      // try the next one
    }
  }
  return false;
}

// --- Login --------------------------------------------------------------------

/**
 * The whole browser sign-in, start to finish.
 *
 * Order matters: the socket is bound before registration, because the redirect
 * URI has to name the port that is actually listening and this server registers
 * redirect URIs by exact match (see normalizeRedirectUri in src/oauth.ts).
 *
 * `notify` receives progress lines. Nothing it is given ever contains a
 * credential — the authorization URL carries a code *challenge*, which is a hash,
 * and the access token never leaves this function except into the store.
 */
export async function login(
  endpoint,
  {
    env = process.env,
    fetchImpl = fetch,
    nowMs = () => Date.now(),
    randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n)),
    digest = (bytes) => crypto.subtle.digest("SHA-256", bytes),
    notify = () => {},
    openUrl = openBrowser,
    manual = null,
    scopes = LOGIN_SCOPES,
    timeoutMs = 5 * 60 * 1000,
  } = {}
) {
  const issuer = issuerFor(endpoint);
  if (!issuer) throw new OAuthError(`${endpoint} is not a URL that can be signed into`);

  const metadata = await discover(issuer, fetchImpl);

  const verifier = newCodeVerifier(randomBytes);
  const challenge = await codeChallenge(verifier, digest);
  const state = newState(randomBytes);

  // Manual mode: no listener, no browser. The redirect still has to be a
  // registered loopback URI, so a fixed one is used and the person pastes the
  // address bar back. This is the path for an SSH session or a container, where
  // the browser is on a different machine and cannot reach this one's loopback.
  const server = manual ? null : await startCallbackServer({ timeoutMs });
  const redirectUri = manual ? MANUAL_REDIRECT_URI : server.redirectUri;
  server?.setState(state);

  let clientId;
  try {
    clientId = await register(metadata, [redirectUri], fetchImpl);
  } catch (e) {
    server?.cancel();
    throw e;
  }

  const url = authorizeUrl({
    authorizationEndpoint: metadata.authorization_endpoint,
    clientId,
    redirectUri,
    scopes,
    state,
    challenge,
    resource: resourceFor(issuer),
  });

  let callback;
  if (manual) {
    notify(`Open this in a browser, approve, then paste the address you land on:\n\n  ${url}\n`);
    const pasted = await manual();
    callback = parseCallback(pasted, state);
  } else {
    const opened = openUrl(url);
    notify(
      opened
        ? `Opening your browser to approve this sign-in.\nIf it did not open, use:\n\n  ${url}\n`
        : `Open this in a browser to approve the sign-in:\n\n  ${url}\n`
    );
    callback = await server.result;
  }

  if (!callback.ok) {
    throw new OAuthError(`sign-in did not complete: ${callback.error}`, {
      detail: callback.detail,
      hint:
        callback.error === "timeout"
          ? "Nothing arrived on the callback. Try again, or use --manual if the browser is on another machine."
          : "Approve the request in the browser, or run login again.",
    });
  }

  const at = nowMs();
  const payload = await postToken({
    tokenEndpoint: metadata.token_endpoint,
    body: authorizationCodeForm({ clientId, code: callback.code, codeVerifier: verifier, redirectUri }),
    fetchImpl,
  });
  const credential = credentialFromTokenResponse(payload, {
    issuer,
    clientId,
    endpoints: metadata,
    nowMs: at,
  });

  const path = saveStore(putCredential(loadStore(env), issuer, credential), env);
  return { credential, path, issuer };
}

/**
 * The redirect URI used by `--manual`. Fixed, because there is no listener whose
 * port could be reported — the person copies the address bar rather than the
 * browser reaching this machine.
 */
export const MANUAL_REDIRECT_URI = "http://127.0.0.1:53682/callback";

// --- Logout -------------------------------------------------------------------

/**
 * Forget the stored credential, telling the server first.
 *
 * The revocation is best effort and its outcome does not change what happens
 * locally: a person running logout wants the credential gone from this machine,
 * and a network failure must not leave it sitting in the file. Both tokens are
 * revoked — the access token so it stops working before its hour is up, and the
 * refresh token so it cannot mint more.
 */
export async function logout(endpoint, { env = process.env, fetchImpl = fetch } = {}) {
  const issuer = issuerFor(endpoint);
  if (!issuer) throw new OAuthError(`${endpoint} is not a URL that can be signed out of`);
  const store = loadStore(env);
  const credential = getCredential(store, issuer);
  if (!credential) return { revoked: false, hadCredential: false, path: credentialsPath(env) };

  const revocationEndpoint = credential.revocation_endpoint || `${issuer}/oauth/revoke`;
  let revoked = false;
  for (const token of [credential.refresh_token, credential.access_token]) {
    if (!token) continue;
    try {
      const res = await fetchImpl(revocationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: revokeForm(token),
      });
      revoked = revoked || res.ok;
    } catch {
      // Best effort — the local delete below is the part that must happen.
    }
  }
  const path = saveOrRemove(removeCredential(store, issuer), env);
  return { revoked, hadCredential: true, path };
}
