import type { Env } from "./env";

const MANAGEMENT_PATHS = new Set([
  "/",
  "/health",
  "/whoami",
  "/waitlist",
  "/gallery",
  "/login",
  "/docs",
  "/privacy",
  "/terms",
  "/sitemap.xml",
  "/llms.txt",
  "/og.svg",
]);
const MANAGEMENT_PREFIXES = ["/admin", "/api", "/v"];

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
  if (MANAGEMENT_PATHS.has(path)) return true;
  return MANAGEMENT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}
