import type { Context } from "hono";
import type { Env } from "./env";
import { contentType } from "./util";
import { notFoundPage } from "./pages";

/**
 * Serve a file for an artifact from R2. `path` is the portion after the slug
 * (may be empty). Empty or trailing-slash paths resolve to index.html.
 *
 * Generic over the app's per-request variables so it can be called from routes
 * with different Variables shapes (it only ever reads the bindings).
 */
export async function serveArtifact<E extends { Bindings: Env }>(
  c: Context<E>,
  slug: string,
  version: number,
  path: string
): Promise<Response> {
  let rel = path.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";

  const key = `${slug}/v${version}/${rel}`;
  const obj = await c.env.FILES.get(key);
  if (!obj) {
    return c.html(notFoundPage(slug), 404);
  }
  const headers = new Headers();
  headers.set("Content-Type", contentType(rel));
  headers.set("Cache-Control", "private, max-age=300");
  // Published artifacts are access-controlled, never public content. The header
  // is belt-and-braces next to robots.txt on the content origin: a crawler that
  // somehow holds a session must still not index or archive what it sees.
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("ETag", obj.httpEtag);
  return new Response(obj.body, { headers });
}
