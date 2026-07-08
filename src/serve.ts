import type { Context } from "hono";
import type { AppBindings } from "./env";
import { contentType } from "./util";
import { notFoundPage } from "./pages";

/**
 * Serve a file for an artifact from R2. `path` is the portion after the slug
 * (may be empty). Empty or trailing-slash paths resolve to index.html.
 */
export async function serveArtifact(
  c: Context<AppBindings>,
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
  headers.set("ETag", obj.httpEtag);
  return new Response(obj.body, { headers });
}
