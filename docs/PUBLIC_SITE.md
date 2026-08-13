# The public site: SEO, AI crawlers, and what stays private

Issue #29. rtfx.pro is a public product website with controlled access — not a hidden
preview. This document is the contract for everything a crawler, a search engine or an AI
agent can see, and the rule for the copy that faces them.

## The public surface

Exactly four paths are public, plus the crawler files. Everything else requires an identity.

| Path | What it is | Indexable |
|---|---|---|
| `/` | Product landing page: positioning, use cases, differentiators, Claude Code/Hermes story, request access | ✅ |
| `/docs` | Public documentation: publishing, agents, access & privacy model, API overview, FAQ | ✅ |
| `/login` | Sign-in surface (signed-out state) | ✅ |
| `/waitlist` | `POST` access request from the landing page; `GET` redirects to `/#waitlist` | — |
| `/robots.txt` | Crawl policy — **per-origin**, three different answers (below) | — |
| `/sitemap.xml` | The three indexable pages, absolute against `PUBLIC_BASE_URL` | — |
| `/llms.txt` | [llmstxt.org](https://llmstxt.org) product summary for AI agents/answer engines | — |
| `/og.svg` | 1200×630 social card | — |

Gated, and excluded from every index: `/admin`, `/api/*`, `/gallery`, `/v/*`, `/whoami`,
`/health`, and every artifact URL.

Three layers keep it that way, and none of them depends on the others:

1. **`robots.txt`** disallows each gated prefix on the app host, and disallows *everything*
   on an artifact content host.
2. **`<meta name="robots">`** — `layout()` in `src/pages.ts` emits `noindex,nofollow`
   unless a page passes `HeadMeta`. Private by default: a new signed-in page cannot be
   indexed by someone forgetting to mark it.
3. **`X-Robots-Tag: noindex, nofollow, noarchive`** on every artifact file served from R2
   (`src/serve.ts`), so a crawler holding a session still must not index or archive it.

## Canonical origin

`PUBLIC_BASE_URL` (`wrangler.jsonc` → `vars`, default `https://rtfx.pro`) is the one origin
canonical links, OpenGraph URLs, `sitemap.xml` and `llms.txt` are absolute against.

`robots.txt` is answered by whichever origin was asked, with three answers:

- **canonical app host** → crawl the product pages, `Sitemap:` line included;
- **content host** (`CONTENT_HOSTNAMES`, e.g. `a.rtfx.pro`) → `Disallow: /`, because every
  artifact there is access-controlled;
- **any other host** (a `*.workers.dev` preview, staging) → `Disallow: /`, so a preview
  deployment can never compete with production in a search index.

Set `PUBLIC_BASE_URL` when deploying under a different domain, or the whole site will point
its canonicals at rtfx.pro.

## Structured data

- `/` — one `@graph`: `Organization`, `WebSite`, `SoftwareApplication` (with `featureList`).
- `/docs` — `TechArticle`, `FAQPage`, `BreadcrumbList`.

The FAQ prose and the `FAQPage` JSON-LD are generated from the same `FAQS` array in
`src/docs.ts`, so a rich result can never quote an answer the page doesn't show. JSON-LD is
serialized with `<` escaped to `<`, so no content can close the `<script>` early.

## Copy rule

Access to rtfx.pro is by invitation, and the copy says so plainly — "invite-only",
"request access", "we onboard a few teams at a time". That describes **who may sign in**.

What must never appear on a public page is language about how *finished the product is*:
"beta", "MVP", "early access", "coming soon", "preview". `test/integration.test.ts`
enforces this ("public pages avoid preview-stage framing"); if a word belongs in that
family, add it to the assertion rather than arguing with it.

Inside the app, a non-admin is a **member**, not a "beta user".

## Deployment

The public paths must sit **outside** the Cloudflare Access application, or a visitor (or
Googlebot) meets Cloudflare's login screen instead of the site. The `Artifacts (public)`
Access app needs Bypass destinations for all of:

```
rtfx.pro/            rtfx.pro/docs         rtfx.pro/login        rtfx.pro/waitlist
rtfx.pro/robots.txt  rtfx.pro/sitemap.xml  rtfx.pro/llms.txt     rtfx.pro/og.svg
```

See [DEPLOY_RTFX.md](DEPLOY_RTFX.md) step 5.3 for the full runbook step and the post-deploy
verification (`curl -I` each path expecting `200` and no `CF_Authorization` challenge).

## Known follow-up

`og:image` is an SVG (`/og.svg`). It renders in most modern link previews, but some social
networks only rasterize PNG/JPEG. If cards come back blank on a given network, export the
same artwork to `/og.png` at 1200×630 and point `HeadMeta.image` at it — the SVG source in
`ogImageSvg()` (`src/seo.ts`) is the master.

## Changing the public copy

- Landing page → `src/landing.ts` (structured data lives beside the copy it describes).
- Docs page → `src/docs.ts`; add a question to `FAQS` and both the page and the JSON-LD
  gain it.
- Product summary shared with AI agents → `llmsTxt()` in `src/seo.ts`.
- Add a public page → add it to `PUBLIC_PAGES` (`src/seo.ts`, which feeds the sitemap and
  llms.txt), to `MANAGEMENT_PATHS` (`src/host.ts`), to `RESERVED_SLUGS` (`src/util.ts`),
  and to the Access bypass list above.
