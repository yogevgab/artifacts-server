/**
 * `/media/<name>`: the few site-owned media files (the guide video and its
 * poster) that are too large to embed in the Worker the way the guide
 * screenshots are (src/guide-images.ts).
 *
 * They live in the artifacts R2 bucket under `_site/`, a prefix no artifact can
 * ever use (artifact keys are `<slug>/v<N>/…` and SLUG_RE needs a leading
 * [a-z0-9]). Only names in MEDIA are served, so this is not a window into the
 * bucket. Uploaded by hand, once per re-render:
 *
 *   npx wrangler r2 object put artifacts-files/_site/rtfx-guide.mp4 --file rtfx-guide.mp4 --remote
 *
 * Byte ranges are honoured because Safari will not play a <video> whose server
 * answers a Range request with a plain 200 (same reasoning as src/serve.ts).
 * URLs in the HTML carry `?v=`, so bump MEDIA_VERSION after a re-upload.
 */

import type { Env } from "./env";

export const MEDIA: Record<string, string> = {
  "rtfx-guide.mp4": "video/mp4",
  "rtfx-guide-poster.jpg": "image/jpeg",
};

/** Cache-buster for the URLs written into pages. Bump after re-uploading. */
export const MEDIA_VERSION = "1";

export const mediaUrl = (name: string) => `/media/${name}?v=${MEDIA_VERSION}`;

export async function mediaResponse(env: Env, name: string, rangeHeader: string | undefined, reqHeaders: Headers): Promise<Response> {
  const type = Object.hasOwn(MEDIA, name) ? MEDIA[name] : undefined;
  if (!type) return new Response("Not found", { status: 404 });
  const key = `_site/${name}`;

  // One well-formed range only; anything else gets the whole file (RFC 9110).
  let wantsRange = /^bytes=(\d+-\d*|-\d+)$/.test(rangeHeader ?? "");
  let obj: R2ObjectBody | null = null;
  if (wantsRange) {
    try {
      obj = await env.FILES.get(key, { range: reqHeaders });
    } catch {
      wantsRange = false;
    }
  }
  if (!wantsRange) obj = await env.FILES.get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": "public, max-age=86400",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    ETag: obj.httpEtag,
  });
  const range = wantsRange ? (obj as R2ObjectBody & { range?: R2Range }).range : undefined;
  if (range && "offset" in range && typeof range.offset === "number") {
    const length = Math.min(range.length ?? obj.size, obj.size - range.offset);
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + length - 1}/${obj.size}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  if (range && "suffix" in range && typeof range.suffix === "number") {
    const length = Math.min(range.suffix, obj.size);
    headers.set("Content-Range", `bytes ${obj.size - length}-${obj.size - 1}/${obj.size}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
}
