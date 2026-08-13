const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// Slugs that would collide with the Worker's own routes. Dotted public files
// (robots.txt, sitemap.xml, llms.txt, og.svg) can't be slugs at all — SLUG_RE
// rejects the dot — but their stems are reserved so a slug can never read as
// one of the site's own crawler files.
const RESERVED_SLUGS = new Set([
  "api",
  "admin",
  "health",
  "whoami",
  "v",
  "waitlist",
  "gallery",
  "login",
  "docs",
  "robots",
  "sitemap",
  "llms",
  "og",
]);

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s) && s.length <= 100 && !RESERVED_SLUGS.has(s);
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  pdf: "application/pdf",
  wasm: "application/wasm",
  map: "application/json; charset=utf-8",
};

export function contentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}
