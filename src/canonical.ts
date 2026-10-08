/**
 * Canonical artifact addresses: `https://rtfx.pro/<workspace>/<artifact>`.
 *
 * This is the ONLY address the product shows or returns. The content origin
 * (`a.rtfx.pro`) still exists, but it is an invisible, sandboxed byte server
 * that the viewer on the app origin frames; nobody is ever sent to it.
 *
 * Kept free of D1 and of Hono so every rule here is table-testable. The
 * lookups that need the database live in src/viewer-routes.ts and src/api.ts.
 */

import type { Env } from "./env";
import { parseHostnames, firstContentHostname } from "./host";
import { siteOrigin } from "./seo";

/**
 * The canonical app origin: where the viewer lives and where every shown URL
 * points. `PUBLIC_BASE_URL`, or the product default.
 */
export function canonicalOrigin(env: Pick<Env, "PUBLIC_BASE_URL">): string {
  return siteOrigin(env);
}

/**
 * The origin canonical links are built on for THIS deployment: the configured
 * app origin on a two-host deployment, the request's own origin on a single-host
 * one (a local `wrangler dev`, or a self-host with no content host) — so a link
 * shown by a dev server opens on that dev server.
 */
export function appOriginFor(env: Env, requestUrl: string): string {
  if (firstContentHostname(env)) return canonicalOrigin(env);
  try {
    return new URL(requestUrl).origin;
  } catch {
    return canonicalOrigin(env);
  }
}

/**
 * Path of an artifact's canonical address. `workspace` is null only for an
 * artifact that belongs to no workspace (legacy, owner-less rows): those are
 * viewed at `/<slug>`, the one-segment form, which nothing else can claim
 * because a workspace address is never also an artifact route.
 *
 * `rest` is a path inside the artifact (no leading slash); each segment is
 * encoded.
 */
export function canonicalPath(workspace: string | null, slug: string, rest = ""): string {
  const head = workspace
    ? `/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`
    : `/${encodeURIComponent(slug)}`;
  const tail = rest
    .split("/")
    .filter((s) => s !== "")
    .map(encodeURIComponent)
    .join("/");
  return tail ? `${head}/${tail}` : head;
}

/** Absolute canonical URL. */
export function canonicalArtifactLink(
  origin: string,
  workspace: string | null,
  slug: string,
  rest = ""
): string {
  return `${origin.replace(/\/+$/, "")}${canonicalPath(workspace, slug, rest)}`;
}

/**
 * The origin the content host answers on, or null on a single-host deployment
 * (where the app origin serves content too and the frame is same-origin).
 * The scheme follows the request that is asking, like every other URL this
 * Worker builds from its own hostnames.
 */
export function contentOrigin(env: Env, requestUrl: string): string | null {
  const host = firstContentHostname(env);
  if (!host) return null;
  let protocol = "https:";
  let port = "";
  try {
    const u = new URL(requestUrl);
    protocol = u.protocol;
    // A non-default port is carried over, so a local dev server (app.localhost:8787
    // and a.localhost:8787) works; production has none.
    port = u.port ? `:${u.port}` : "";
  } catch {
    // keep https
  }
  return `${protocol}//${host}${port}`;
}

/**
 * The exact set of origins allowed to FRAME artifact content: the canonical app
 * origin plus anything in `APP_ORIGINS`, never a content host and never `*`.
 * `'self'` is added by {@link frameAncestorsDirective}.
 *
 * `mcp.rtfx.pro` is deliberately not here: it is an app host for the API/OAuth,
 * and the viewer redirects there to the canonical origin rather than rendering
 * (see viewer-routes.ts), so it never frames anything.
 */
export function frameAncestorOrigins(env: Env): string[] {
  const contentHosts = parseHostnames(env.CONTENT_HOSTNAMES);
  const out = new Set<string>();
  const add = (candidate: string) => {
    let u: URL;
    try {
      u = new URL(candidate);
    } catch {
      return;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return;
    if (contentHosts.has(u.hostname.toLowerCase())) return;
    out.add(u.origin);
  };
  add(canonicalOrigin(env));
  for (const extra of (env.APP_ORIGINS ?? "").split(",")) {
    if (extra.trim()) add(extra.trim());
  }
  return [...out];
}

/**
 * The `frame-ancestors` directive for artifact content.
 *
 * Content is framed by the viewer on the APP origin, a different origin from
 * the one serving it, so `'self'` alone no longer suffices. `X-Frame-Options`
 * cannot name another origin (SAMEORIGIN means same as the content, DENY means
 * nobody; ALLOW-FROM is dead in every current browser), so content responses
 * send no X-Frame-Options at all and `frame-ancestors` is the only, and
 * authoritative, framing policy.
 */
export function frameAncestorsDirective(env: Env): string {
  return `frame-ancestors 'self' ${frameAncestorOrigins(env).join(" ")}`.trim();
}
