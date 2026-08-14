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
/**
 * Posted by the frame to the shell so it can hide chrome while you read.
 *
 * The frame is cross-origin by design, so the shell cannot observe scrolling
 * inside it. This reporter is the narrowest possible bridge: it sends a number
 * out and accepts nothing in. Nothing the shell does with it is a security
 * decision — an artifact that forges the message can hide or show a toolbar,
 * and that is the whole blast radius.
 */
const SCROLL_REPORTER = `<script>(function(){
  if(window.parent===window) return;
  var last=-1, queued=false;
  function post(){
    queued=false;
    var y=window.scrollY||document.documentElement.scrollTop||0;
    if(y===last) return;
    last=y;
    try{window.parent.postMessage({type:'rtfx:scroll',y:y},'*');}catch(e){}
  }
  addEventListener('scroll',function(){
    if(queued) return; queued=true; requestAnimationFrame(post);
  },{passive:true});
})();</script>`;

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
  headers.set("X-Content-Type-Options", "nosniff");
  // Set explicitly so the app-wide middleware does not stamp DENY here. The
  // viewer shell frames this content from the same origin; DENY blocked it
  // outright and the shell rendered neatly around an empty box. Kept alongside
  // `frame-ancestors 'self'` because the two disagree about precedence across
  // browsers, and both must say the same thing.
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("Referrer-Policy", "no-referrer");
  // frame-ancestors is 'self', not 'none' and never '*': the viewer shell must be able
  // to frame this content, and nothing else on the internet may. See src/shell.ts.
  // Keep artifact pages working: AI-built pages often load CDNs, fonts, images or iframes.
  // This CSP hardens the browser boundary that matters for the shared content origin
  // (no framing, no hostile <base>) without blocking those artifact subresources.
  // The permissive policy below exists for HTML artifacts, which routinely load
  // CDNs, fonts and inline scripts. Anything else — a PDF, an image, a font —
  // executes nothing, so the script/style directives buy no safety and can
  // interfere with the browser's own viewers. Framing control still applies.
  if (!headers.get("Content-Type")?.startsWith("text/html")) {
    headers.set("Content-Security-Policy", "frame-ancestors 'self'");
    headers.set("ETag", obj.httpEtag);
    return new Response(obj.body, { headers });
  }

  headers.set(
    "Content-Security-Policy",
    "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
      "script-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
      "style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; " +
      "connect-src *; media-src * data: blob:; frame-src *; worker-src * blob:; " +
      "frame-ancestors 'self'; base-uri 'none'"
  );
  headers.set("ETag", obj.httpEtag);
  const res = new Response(obj.body, { headers });

  // Only a framed HTML page gets the reporter. An unframed request — the CLI, a
  // download, a machine fetch — receives the artifact exactly as published,
  // because "immutable version" has to mean the bytes too.
  const framed = new URL(c.req.url).searchParams.has("raw");
  if (framed && headers.get("Content-Type")?.startsWith("text/html")) {
    return new HTMLRewriter()
      .on("body", {
        element(el) {
          el.append(SCROLL_REPORTER, { html: true });
        },
      })
      .transform(res);
  }
  return res;
}
