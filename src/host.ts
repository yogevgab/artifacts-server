import type { Env } from "./env";

const MANAGEMENT_PATHS = new Set([
  "/",
  "/health",
  "/whoami",
  "/waitlist",
  "/gallery",
  "/login",
  "/logout",
  "/signup",
  "/docs",
  "/privacy",
  "/terms",
  // The per-tier product pages and the "Talk to us" surface. App host only,
  // like every other public product page: a content host must never serve them,
  // or the same page is reachable at two origins and competes with itself.
  "/pro",
  "/team",
  "/enterprise",
  "/contact",
  "/sitemap.xml",
  "/llms.txt",
  // security.txt (RFC 9116). Its canonical path lives under the `/.well-known`
  // prefix below; this is the legacy top-level one, and it has to be named
  // explicitly or the app host 302s it to the content host as an unknown path
  // — which is how it came to be findable at neither origin. See SECURITY_TXT_PATHS
  // in src/seo.ts.
  "/security.txt",
  "/og.svg",
  "/og.png",
  "/logo.png",
]);
// `/mcp` is the remote MCP endpoint (src/mcp.ts). It belongs here for exactly
// the reason `/api` does: it authenticates a bearer credential and answers for
// the product, so the origin that serves untrusted uploaded HTML must never
// route to it.
//
// `/oauth` and `/.well-known` join it for the same reason and one more. The
// OAuth authorization server (src/oauth-routes.ts) mints credentials from a
// browser session, and its discovery documents name this instance's issuer and
// resource identifiers. A content host answering either would advertise an
// authorization server at an origin that serves untrusted uploaded HTML — and
// the app host must not redirect them to the content host the way it does an
// unknown path, which is the *other* thing listing them here prevents.
const MANAGEMENT_PREFIXES = [
  "/admin",
  "/api",
  "/v",
  "/auth",
  "/shared",
  "/mcp",
  "/oauth",
  "/.well-known",
];

/**
 * Paths the CONTENT host serves in addition to artifact files. The chat socket
 * has to live here: the viewer shell runs on the content origin, and the app
 * origin's session cookie is host-only, so a cross-origin socket would carry no
 * credential at all. `_chat` can never be a slug — SLUG_RE requires the first
 * character to be [a-z0-9] — so this prefix is collision-free by construction.
 *
 * `/_access-request` joins it for the same structural reason: the "ask for
 * access" form lives on `notFoundPage` (src/pages.ts), which is rendered on
 * the content host too — that is the host somebody actually lands on when a
 * shared link 404s. Its POST target must resolve there, not just on the app
 * host where `/api/*` already lives (and is management-only, so it 404s on
 * a content host). See src/access-request-routes.ts.
 */
const CONTENT_PREFIXES = ["/_chat", "/_access-request"];

export function isContentPrefix(path: string): boolean {
  return CONTENT_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}

/**
 * Paths every host answers for itself, whatever else it serves. `robots.txt` is
 * per-origin by definition: a crawler asks the *content* host what it may crawl
 * there, so answering 404 (as management paths do) would leave that question
 * unanswered instead of "nothing". The body differs per host — see `robotsTxt`.
 */
const PER_ORIGIN_PATHS = new Set(["/robots.txt"]);

export function isPerOriginPath(path: string): boolean {
  return PER_ORIGIN_PATHS.has(path);
}

/** Parse a comma-separated hostname list (env var) into a lowercase set. */
export function parseHostnames(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** Lowercase hostname from a full request URL (authoritative in Workers). */
export function requestHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** True if this request's hostname is a configured content-only origin. */
export function isContentHost(env: Env, url: string): boolean {
  const hosts = parseHostnames(env.CONTENT_HOSTNAMES);
  if (hosts.size === 0) return false;
  return hosts.has(requestHostname(url));
}

/** First configured content hostname (redirect target from the app host), if any. */
export function firstContentHostname(env: Env): string | undefined {
  const hosts = parseHostnames(env.CONTENT_HOSTNAMES);
  return hosts.size === 0 ? undefined : hosts.values().next().value;
}

/**
 * True for app-only routes (public product pages, legal pages, gallery, admin,
 * API, whoami, health, version preview, waitlist, sitemap/llms.txt) that must
 * never be reachable from a content host.
 */
export function isManagementPath(path: string): boolean {
  // Served by the content host, so never treated as management.
  if (isContentPrefix(path)) return false;
  if (MANAGEMENT_PATHS.has(path)) return true;
  return MANAGEMENT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Every first path segment the app host already answers for itself, lowercase.
 *
 * Derived from the tables above rather than restated, because it feeds the
 * reserved list for branded workspace addresses (src/account-slugs.ts): a route
 * added to `MANAGEMENT_PATHS` or `MANAGEMENT_PREFIXES` becomes unclaimable in
 * the same commit, with nobody having to remember the second list exists.
 * Without that, somebody could hold `/docs` as a workspace address and own a
 * namespace no request could ever reach, because the real page wins the route.
 *
 * Dotted entries (`robots.txt`, `sitemap.xml`) survive into the set even though
 * a slug can never contain a dot. Harmless, and cheaper than filtering.
 */
export function reservedTopLevelSegments(): string[] {
  const segments = new Set<string>();
  const add = (path: string) => {
    const first = path.replace(/^\/+/, "").split("/")[0];
    if (first) segments.add(first.toLowerCase());
  };
  for (const p of MANAGEMENT_PATHS) add(p);
  for (const p of MANAGEMENT_PREFIXES) add(p);
  for (const p of CONTENT_PREFIXES) add(p);
  for (const p of PER_ORIGIN_PATHS) add(p);
  return [...segments];
}
