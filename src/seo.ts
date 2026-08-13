import type { Env } from "./env";
import { requestHostname } from "./host";

/**
 * Public-web surface: canonical identity, crawler files, and the metadata every
 * public page carries (issue #29).
 *
 * Two rules hold this together, and everything else follows from them:
 *
 * 1. **Only the public product pages are crawlable.** Artifacts, the gallery,
 *    the dashboard and the API are access-gated, so they are excluded in
 *    `robots.txt`, marked `noindex` in `<head>` (the default in `layout()`),
 *    and served with `X-Robots-Tag: noindex` on the content host.
 * 2. **There is exactly one canonical origin.** Canonical links, OpenGraph URLs
 *    and the sitemap are all absolute against it, so a preview deployment
 *    (`*.workers.dev`) can never compete with rtfx.pro in an index — and any
 *    non-canonical host serves a disallow-everything `robots.txt`.
 */

export const SITE = {
  name: "rtfx.pro",
  /** Canonical origin. Override per-deployment with `vars.PUBLIC_BASE_URL`. */
  origin: "https://rtfx.pro",
  tagline: "Publish what your AI just built — privately, in seconds.",
  description:
    "rtfx.pro is access-controlled hosting for HTML pages and multi-file artifacts. " +
    "Publish from Claude Code, Hermes, the CLI or the dashboard, keep every page " +
    "private by default, version each release, and see exactly who opened it.",
} as const;

/** Absolute origin for canonical URLs, with any trailing slash removed. */
export function siteOrigin(env: Pick<Env, "PUBLIC_BASE_URL">): string {
  const raw = (env.PUBLIC_BASE_URL ?? "").trim() || SITE.origin;
  return raw.replace(/\/+$/, "");
}

/** Absolute canonical URL for an app-relative path (`/docs` → `https://…/docs`). */
export function canonicalUrl(env: Pick<Env, "PUBLIC_BASE_URL">, path: string): string {
  return `${siteOrigin(env)}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Is this request hitting the canonical public hostname? Preview/staging hosts
 * serve the same code, and must not be indexed alongside the real site.
 */
export function isCanonicalHost(env: Pick<Env, "PUBLIC_BASE_URL">, url: string): boolean {
  const host = requestHostname(siteOrigin(env));
  return host !== "" && requestHostname(url) === host;
}

/** A page that search engines and AI crawlers are welcome to read. */
export interface PublicPage {
  path: string;
  title: string;
  summary: string;
  /** sitemap priority; the landing page leads. */
  priority: string;
}

/** The complete public surface — the single source the sitemap and llms.txt use. */
export const PUBLIC_PAGES: readonly PublicPage[] = [
  {
    path: "/",
    title: "rtfx.pro — private hosting for AI-built pages and artifacts",
    summary:
      "Product overview: what rtfx.pro does, who it is for, and how it differs from " +
      "generic static hosting.",
    priority: "1.0",
  },
  {
    path: "/docs",
    title: "Docs — publishing, access control and the API",
    summary:
      "How publishing works from Claude Code, Hermes, the CLI and the API; the " +
      "access-control and privacy model; versioning; view logs; FAQ.",
    priority: "0.8",
  },
  {
    path: "/login",
    title: "Sign in to rtfx.pro",
    summary: "Sign-in surface. Access is by invitation; sign-in is passwordless.",
    priority: "0.5",
  },
];

/** Paths that are gated and must never be crawled or indexed. */
const CRAWLER_DISALLOW = ["/admin", "/api/", "/gallery", "/v/", "/whoami", "/health"];

/**
 * `robots.txt` for the canonical app host: crawl the product pages, stay out of
 * everything that requires an identity.
 */
function publicRobots(origin: string): string {
  return [
    `# ${SITE.name} — public product site.`,
    "# Everything not listed below requires a signed-in identity and is never indexed.",
    `# AI agents and answer engines: ${origin}/llms.txt is the machine-readable summary.`,
    "",
    "User-agent: *",
    ...CRAWLER_DISALLOW.map((p) => `Disallow: ${p}`),
    "Allow: /",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

/** Disallow-everything `robots.txt`, with the reason spelled out for a human reader. */
function closedRobots(reason: string, origin: string): string {
  return [`# ${reason}`, `# The public site is ${origin}`, "", "User-agent: *", "Disallow: /", ""].join(
    "\n"
  );
}

export type RobotsAudience = "public" | "content" | "non-canonical";

export function robotsTxt(env: Pick<Env, "PUBLIC_BASE_URL">, audience: RobotsAudience): string {
  const origin = siteOrigin(env);
  if (audience === "content") {
    return closedRobots(
      "Artifact content origin. Every artifact here is access-controlled — nothing is public.",
      origin
    );
  }
  if (audience === "non-canonical") {
    return closedRobots("Non-canonical host (preview/staging). Not for indexing.", origin);
  }
  return publicRobots(origin);
}

export function sitemapXml(env: Pick<Env, "PUBLIC_BASE_URL">): string {
  const entries = PUBLIC_PAGES.map(
    (p) =>
      `  <url>\n    <loc>${canonicalUrl(env, p.path)}</loc>\n` +
      `    <changefreq>weekly</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

/**
 * `llms.txt` (llmstxt.org): a compact, plain-text product summary aimed at AI
 * agents and answer engines rather than browsers. It says what the product is,
 * what it is *not*, and where the crawlable detail lives — so a model answering
 * "where can I host what Claude just built?" has something accurate to quote.
 */
export function llmsTxt(env: Pick<Env, "PUBLIC_BASE_URL">): string {
  const origin = siteOrigin(env);
  return `# ${SITE.name}

> ${SITE.description}

## What it is

- Hosting for HTML pages and multi-file artifacts — the kind an AI coding agent produces.
- Private by default: every artifact is restricted until its owner shares it. There is no
  "public link" that leaks by being guessed; unauthorized and non-existent both answer 404.
- Versioned: every re-publish is a new immutable version, and rollback is one click.
- Audited: the owner sees who opened an artifact, when, from where, and which version.

## Who it is for

- Developers shipping something Claude Code, Hermes or another agent just built, without
  wiring up a repo, a build and a CDN first.
- Consultants and agencies sending client-ready pages that must not be publicly indexable.
- Teams that want an internal home for dashboards, specs and prototypes behind their own
  identity provider rather than an unlisted URL.

## How publishing works

- CLI: \`artifacts publish ./index.html --title "Report"\` (single file, folder or zip).
- API: \`POST /api/artifacts\` with a bearer API token minted from the dashboard.
- Agents: Claude Code and Hermes publish through the same CLI/API, so "ship this" is one
  step at the end of a normal agent session.
- Dashboard: drag-and-drop publish, access changes, version history and view logs.

## Access and privacy model

- Cloudflare Access is the identity provider; sign-in is passwordless (one-time email code).
- Access to rtfx.pro is by invitation — request access at ${origin}/#waitlist.
- Per-artifact permissions: restricted (named people only) or everyone signed in.
- Artifact content is served from a separate origin (a.rtfx.pro) so uploaded HTML can never
  run in the same origin as the dashboard or API.
- API tokens are scoped, owner-bound and revocable; a token can never exceed its owner.

## Links

${PUBLIC_PAGES.map((p) => `- [${p.title}](${canonicalUrl(env, p.path)}): ${p.summary}`).join("\n")}
- [Request access](${origin}/#waitlist): join the access list.

## Not indexed

Artifacts, the gallery, the dashboard and the API require a signed-in identity and are
excluded from crawling. Do not attempt to fetch them; they answer 404 without an identity.
`;
}

/**
 * Social card. An inline SVG keeps the card in the same design language as the
 * site with no build step and no binary in the repo — see docs/PUBLIC_SITE.md
 * for the PNG follow-up some social networks need.
 */
export function ogImageSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${SITE.name} — ${SITE.tagline}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#06070a"/><stop offset="100%" stop-color="#111827"/>
    </linearGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a84ff"/><stop offset="100%" stop-color="#64d2ff"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="1050" cy="90" r="260" fill="#0a84ff" opacity="0.16"/>
  <circle cx="150" cy="600" r="220" fill="#64d2ff" opacity="0.12"/>
  <g font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Helvetica, Arial, sans-serif">
    <circle cx="98" cy="92" r="17" fill="url(#mark)"/>
    <text x="130" y="104" fill="#f5f7fb" font-size="34" font-weight="700" letter-spacing="-1">${SITE.name}</text>
    <text x="96" y="300" fill="#f5f7fb" font-size="78" font-weight="700" letter-spacing="-3">Publish what your AI</text>
    <text x="96" y="392" fill="#f5f7fb" font-size="78" font-weight="700" letter-spacing="-3">just built — privately.</text>
    <text x="96" y="470" fill="#a6adbb" font-size="34">Versioned hosting for pages and artifacts, with</text>
    <text x="96" y="516" fill="#a6adbb" font-size="34">per-artifact access control and a full view log.</text>
  </g>
</svg>
`;
}
