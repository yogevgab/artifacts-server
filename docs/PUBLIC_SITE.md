# The public site: SEO, AI crawlers, and what stays private

Issue #29. rtfx.pro is a public product website with controlled access — not a hidden
preview. This document is the contract for everything a crawler, a search engine or an AI
agent can see, and the rule for the copy that faces them.

## The public surface

Exactly six paths are public, plus the crawler files. Everything else requires an identity.

| Path | What it is | Indexable |
|---|---|---|
| `/` | Product landing page: positioning, use cases, differentiators, Claude Code/Hermes story, request access | ✅ |
| `/docs` | Public documentation: publishing, agents, access & privacy model, `#why-rtfx` (table stakes vs differentiators vs not-yet), API overview, FAQ | ✅ |
| `/login` | Sign-in surface (signed-out state) | ✅ |
| `/privacy` | Privacy policy — what is stored, cookies, processors, retention, rights (issue #36) | ✅ |
| `/terms` | Terms of use — access, ownership, acceptable use, tokens, liability (issue #36) | ✅ |
| `/waitlist` | `POST` access request from the landing page; `GET` redirects to `/#waitlist` | — |
| `/robots.txt` | Crawl policy — **per-origin**, three different answers (below) | — |
| `/sitemap.xml` | The indexable pages, absolute against `PUBLIC_BASE_URL` | — |
| `/llms.txt` | [llmstxt.org](https://llmstxt.org) product summary for AI agents/answer engines | — |
| `/og.svg` | 1200×630 SVG source social card | — |
| `/og.png` | 1200×630 PNG social card used by OpenGraph/Twitter previews | — |
| `/logo.png` | 512×512 PNG of the rtfx mark — `Organization.logo` in the landing page's JSON-LD | — |

Gated, and excluded from every index: `/admin/*` (the gallery included), `/api/*`, `/gallery`
(a redirect into `/admin/gallery`), `/v/*`, `/whoami`, `/health`, and every artifact URL.

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

## Copy rules

### Maturity language

Access to rtfx.pro is by invitation, and the copy says so plainly — "invite-only",
"request access", "we onboard a few teams at a time". That describes **who may sign in**.

What must never appear on a public page is language about how *finished the product is*:
"beta", "MVP", "early access", "coming soon", "preview". `test/integration.test.ts`
enforces this ("public pages avoid preview-stage framing"); if a word belongs in that
family, add it to the assertion rather than arguing with it.

Inside the app, a non-admin is a **member**, not a "beta user".

### Claims (issue #38)

[POSITIONING.md](POSITIONING.md) is the source of truth for *what* the public pages claim:
the competitive field, what is table stakes, what is genuinely ours, and — the part that
constrains copy hardest — what we have not built and must not imply.

Two rules bind every public surface:

- **Say "access-protected", never "password-protected".** There is no password anywhere in
  this product: sign-in is an app-owned one-time email code or magic link, and share links
  carry no secret of their own. Competing products lead with password protection, so the
  vocabulary is easy to borrow by accident.
- **A planned feature is labelled planned, on the page.** `/docs#why-rtfx` carries a "Not
  here yet" list, and `llms.txt` carries a "Not shipped yet" section, precisely so an answer
  engine that has read a competitor's page cannot attribute their features to us.
- **The content origin isolates artifacts from the app, not from each other.** Copy may say
  uploaded HTML cannot reach the dashboard or the API — that is true and enforced in
  `src/host.ts`. Copy must never imply a per-artifact browser sandbox or a per-artifact origin:
  every artifact shares `a.rtfx.pro`, so two artifacts are same-origin with each other and the
  access list is what keeps them apart. `/docs` states this in the access section, in the
  `#why-rtfx` differentiator and in the "where does the uploaded HTML run" FAQ; `llms.txt`
  states it under the access and privacy model; [SECURITY.md](../SECURITY.md) carries the full
  threat-model version.

- **Install paths must be ones a reader can run today.** There is no npm package, so no public
  surface may show `npx artifacts …` or a bare `artifacts …` binary. The honest paths are the
  Claude Code plugin (`/plugin marketplace add yogevgab/artifacts-server`, which brings its own
  dependency-free publisher), `node cli/artifacts.mjs …` from a checkout with `npm install` run,
  the MCP server file inside the installed plugin or a checkout, and `curl` against
  `POST /api/artifacts`. When a package does ship, `src/docs.ts`, `src/integrations.ts` and
  `llmsTxt()` in `src/seo.ts` change together.

- **The `curl` example must run against this instance as deployed.** Two ways it silently stops
  being runnable: sending a zip as `-F file=@…`, when `file` is one HTML document and `bundle` is
  the zip field (`src/api.ts`); or showing legacy Cloudflare Access service-token headers as if
  `rtfx.pro` still needed them. It does not: `/api/machine/*` authenticates the bearer `rtfx_…`
  token and nothing else. The examples on `/docs` (`data-docs="http-publish"`) and in the
  Integrations panel (`data-snippet="setup-http"`) must change together.

`test/positioning.test.ts` enforces these, plus the `#why-rtfx` anchor and its markers;
`test/portal.test.ts` covers the Integrations copy of the same snippets.

## Cookies and consent (issue #36)

There is **no non-essential storage on the public site**, and the cookie notice says exactly that
rather than asking permission for tracking that does not exist:

| Stored | Kind | Why |
|---|---|---|
| `rtfx_session` | Cookie, set by us | The app-owned sign-in session, created by verifying an email code or magic link. Set by signing in, never by reading a public page. |
| `__cf_bm` and similar | Cookie, set by the Cloudflare network | Bot management / abuse prevention. |
| `rtfx.cookie-notice` | `localStorage`, set by us | Remembers the notice was dismissed. Never sent to the server. |

**The dashboard is a different surface, on purpose.** `/admin` can load PostHog for session
recording and error tracking, but only on a deployment that sets `POSTHOG_KEY` at all, and only
after an explicit accept/decline choice (`analyticsConsentNotice` in `src/consent.ts`,
`src/posthog.ts`). None of that reaches a public page: `window.rtfxConsent.analytics` is hard-coded
`false` on every page the public notice renders on, and the notice links to
`/privacy#dashboard-analytics` so the difference is stated rather than hidden.

`src/consent.ts` renders the notice as a **labelled region, not a dialog** — no overlay, no
focus trap, no scroll lock, last in the tab order — because it must never block core use. It
is emitted `hidden` and unhidden by its own script, so a returning visitor sees no flash and
a visitor without JavaScript never gets a banner whose dismiss button could not work.

If a non-essential script is ever introduced, it must not run until
`window.rtfxConsent.analytics` is true. That flag is `false` today and nothing reads it; the
notice grows a real choice — with a real "no" — in the same change that introduces the first
thing worth consenting to, and `/privacy#cookies` is updated before it ships, not after.
`test/legal.test.ts` fails the build if any public page starts setting a cookie, loading an
external script/stylesheet/font, or preconnecting to a third party.

## Deployment

The public paths are public because the Worker routes them that way, not because a Cloudflare
Access Bypass app sits in front of them. Earlier revisions of this project used Access as the
primary identity layer; fresh rtfx.pro-style deployments do not. The app owns sign-in now: it emails
a one-time code or magic link, verifies it, and sets its own host-only `rtfx_session` cookie.

After deploying, verify the public/crawler surface from a shell with no browser session:

```bash
for p in / /docs /login /privacy /terms /robots.txt /sitemap.xml /llms.txt /og.svg /og.png /logo.png; do
  printf '%-14s ' "$p"; curl -s -o /dev/null -w '%{http_code} %{content_type}
' "https://rtfx.pro$p"
done
```

Expected: every path returns `200`, the HTML pages are `text/html`, `robots.txt` and `llms.txt` are
`text/plain`, the sitemap is XML, and the image paths are PNG/SVG. No public HTML page may set a
cookie of its own; `rtfx_session` is set by signing in, not by reading marketing/legal/docs pages.

The content host remains the hard boundary: `a.rtfx.pro` serves artifact content and should answer
`404` for app/legal/API pages such as `/login`, `/privacy`, `/terms`, `/docs`, `/admin` and `/api/*`.

See [DEPLOY_RTFX.md](DEPLOY_RTFX.md) §6b for the command checklist.

## Social previews and trust headers

`HeadMeta.image` points at `/og.png`, a 1200×630 PNG social card for platforms that do not
render SVG previews reliably. `/og.svg` remains the readable/vector source for the same card.
`Organization.logo` in the landing page's JSON-LD points at `/logo.png` instead — a 512×512
render of the mark alone. That property is consumed as a *logo* (cropped towards square in a
knowledge panel), so pointing it at the landscape card, which is mostly headline copy, gave
every consumer of the graph the wrong image. All three are public app-host files and blocked
on the artifact content host.

### Regenerating the rasters

A Worker has no image encoder, so `/og.png` and `/logo.png` are base64 constants in
`src/seo.ts`, rendered from `ogImageSvg()` and `logoSvg()` in the same file. That once drifted
badly — the card was redesigned and the constant went on serving the previous design to every
unfurl — so the two are now bound together in both directions:

```bash
npm run generate:rasters   # rasterizes with headless Chrome, rewrites src/seo.ts in place
npm test                   # test/brand-raster.test.ts proves the two now agree
```

Run it after **any** change to `ogImageSvg()`, `logoSvg()`, `MARK_PATH`, `MARK_BLUE`,
`SITE.name` or `SITE.tagline`. `test/brand-raster.test.ts` fails otherwise: it compares
SHA-256 of the current SVG against the digest the rasters were rendered from, *and* decodes
both PNGs to check the mark's tile is where today's SVG puts it — so neither a forgotten
re-render nor a hand-pasted digest gets through.

The Worker adds baseline app headers (`X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`). Artifact files get
content-origin headers in `src/serve.ts`: `X-Robots-Tag`, `nosniff`, `no-referrer`, and a
compatibility-first CSP that prevents framing and hostile `<base>` URLs without blocking normal
artifact subresources such as CDNs, images, fonts or iframes. Because every artifact on
`a.rtfx.pro` shares one origin, do not treat the content host as a browser sandbox between two
artifacts owned by mutually distrusting parties; use access control and future per-artifact
origins/sandboxing if that threat model matters.

## Changing the public copy

Start at [POSITIONING.md](POSITIONING.md) if the change touches *what is claimed*. Positioning
lives in six files at once and drifts if edited one at a time.

- Landing page → `src/landing.ts` (structured data lives beside the copy it describes).
- Docs page → `src/docs.ts`; add a question to `FAQS` and both the page and the JSON-LD
  gain it. The table-stakes/differentiator/not-yet split is `#why-rtfx` in the same file.
- Product summary shared with AI agents → `llmsTxt()` in `src/seo.ts`, including the
  **Not shipped yet** section that keeps an answer engine from inventing features.
- Privacy policy / terms of use → `src/legal.ts`. Both pages open with the **operator-template /
  not-legal-advice** banner on *every* deployment, rtfx.pro included, because the legal entity,
  address, contact and governing law are still placeholders. Do not remove it until real values
  exist and a lawyer has looked at them; a self-hoster has the same job
  ([SELF_HOSTING.md](SELF_HOSTING.md)). The inventory in the privacy policy is written against the D1
  schema and the R2 bucket, so a change to what is stored is a change to that page — treat the
  two as one commit.
- Add a public page → add it to `PUBLIC_PAGES` (`src/seo.ts`, which feeds the sitemap and
  llms.txt), to `MANAGEMENT_PATHS` (`src/host.ts`), and to `RESERVED_SLUGS` (`src/util.ts`). Then
  update the public-route smoke list in [DEPLOY_RTFX.md](DEPLOY_RTFX.md).
