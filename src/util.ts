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
  "privacy",
  "terms",
  "robots",
  "sitemap",
  "llms",
  "og",
  // The OAuth authorization server (src/oauth-routes.ts). `/oauth/*` is a
  // management prefix, so a slug of this name would be unreachable on the
  // content host — reserve it rather than let somebody publish into a hole.
  "oauth",
]);

/**
 * A `?next=` value that is safe to redirect to: a path on this origin, and
 * nothing else.
 *
 * Returns null for an absolute URL, a protocol-relative one (`//evil.example`),
 * a backslash-smuggled one (`/\evil.example`, which some browsers normalize to
 * a host) or anything over-long. An open redirect on a sign-in route hands a
 * freshly minted session to whatever host an attacker names, so this is a strict
 * allow-list of one shape rather than a list of things to strip.
 */
export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 512) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  // Control characters (a smuggled newline above all) never belong in a Location.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return value;
}

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
