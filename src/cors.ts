import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";
import { parseHostnames, requestHostname } from "./host";

/**
 * Cross-origin policy for the management API (issue #37).
 *
 * The dashboard and the API are the same origin, so in the ordinary case no CORS
 * is involved at all — and none of this changes who may do anything. What this
 * module fixes is a browser-level failure mode that made "Send invite" look
 * broken:
 *
 *   • `/admin` and `/api/users` sit behind two different Cloudflare Access
 *     applications (docs/DEPLOY_RTFX.md §5d). A browser holding a session for
 *     the first has none for the second, so Access answers the invite `fetch`
 *     with a 302 to `…cloudflareaccess.com`. That is a *cross-origin* redirect,
 *     and a request carrying `Content-Type: application/json` may not follow one
 *     without a preflight — which is not allowed after a redirect. The browser
 *     reports the whole thing as a CORS error. (See `PEOPLE_SCRIPT` in
 *     src/people.ts for the client half of the fix, and `/api/users/reauth` in
 *     src/api.ts for the way back.)
 *
 *   • A genuine preflight is sent with *no* credentials, by definition. Running
 *     `requireUser`/`requireAdmin` on one therefore refuses it — and a refused
 *     preflight blocks a request that would have been perfectly authorized.
 *
 * The policy is deliberately narrow:
 *
 *   - Only this app's own origins are ever named. Never `*` — which would in any
 *     case be rejected by every browser alongside `Allow-Credentials: true`.
 *   - A content host is never an allowed origin, at any cost. It serves
 *     untrusted uploaded HTML; letting an artifact call the management API with
 *     the viewer's cookies is precisely the isolation `src/host.ts` exists to
 *     prevent.
 *   - `Vary: Origin` on everything, so a shared cache can never replay one
 *     origin's answer to another.
 */

/** Methods the API actually implements. */
export const ALLOWED_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";

/**
 * Request headers a browser may send. `Content-Type` is what the dashboard's
 * JSON writes need; `Authorization` is for a first-party tool calling the API
 * with a bearer token from an app origin. Nothing else is permitted, so a novel
 * header can't be smuggled past the preflight.
 */
export const ALLOWED_HEADERS = "Authorization, Content-Type";

/** Ten minutes: long enough that an invite is one request, short enough to fix. */
export const PREFLIGHT_MAX_AGE = "600";

/** The origin of an absolute URL ("https://rtfx.pro"), or null if it isn't one. */
function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * The origins that count as "this app" for a given request: the host it actually
 * arrived on, the configured canonical origin, and anything named in
 * `APP_ORIGINS` — minus every content host, whichever way it got in.
 *
 * Derived per request rather than from configuration alone so a self-hosted
 * instance, a `*.workers.dev` preview and rtfx.pro all work with no extra
 * settings: the common case is same-origin, and same-origin is always allowed.
 */
export function appOrigins(env: Env, requestUrl: string): Set<string> {
  const contentHosts = parseHostnames(env.CONTENT_HOSTNAMES);
  const out = new Set<string>();
  const add = (candidate: string | null | undefined) => {
    if (!candidate) return;
    const origin = originOf(candidate);
    if (!origin) return;
    // The one rule with no exception: untrusted content is never an app origin.
    if (contentHosts.has(requestHostname(origin))) return;
    out.add(origin);
  };

  add(requestUrl);
  add(env.PUBLIC_BASE_URL);
  for (const extra of (env.APP_ORIGINS ?? "").split(",")) add(extra.trim());
  return out;
}

/**
 * Is this `Origin` header one of ours? Exact whole-origin comparison — scheme,
 * host and port all count, so `https://rtfx.pro.evil.com` is not `rtfx.pro` and
 * the opaque `"null"` origin a sandboxed frame sends matches nothing.
 */
export function isAllowedOrigin(
  env: Env,
  requestUrl: string,
  origin: string | undefined | null
): boolean {
  if (!origin || origin === "null") return false;
  return appOrigins(env, requestUrl).has(origin);
}

/** The allow headers for one trusted origin. Credentials only ever with a name. */
function allowHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
  };
}

/**
 * Middleware for the management API. Answers preflights itself and annotates
 * every other response.
 *
 * Mounted *before* the auth middleware on purpose (see src/api.ts). A preflight
 * asks "may a browser attempt this?", never "may this caller have it?" — it
 * carries no credentials and returns no body, so answering it identically for
 * everybody reveals nothing, and the request that follows is authenticated
 * exactly as it always was. The test
 * "answering a preflight grants nothing on its own" pins that down.
 */
export const apiCors: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const origin = c.req.header("Origin");
  const allowed = isAllowedOrigin(c.env, c.req.url, origin);

  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...(allowed ? allowHeaders(origin!) : {}),
        "Access-Control-Allow-Methods": ALLOWED_METHODS,
        "Access-Control-Allow-Headers": ALLOWED_HEADERS,
        "Access-Control-Max-Age": PREFLIGHT_MAX_AGE,
        Vary: "Origin",
      },
    });
  }

  await next();

  // A request with no Origin (the CLI, curl, an agent) gets no CORS headers at
  // all — there is no browser to satisfy, and silence is the smaller surface.
  if (allowed) for (const [k, v] of Object.entries(allowHeaders(origin!))) c.res.headers.set(k, v);
  if (origin) c.res.headers.append("Vary", "Origin");
};
