export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// `--faint` is the quietest ink in the palette, and it is used for real text
// (eyebrows, stat labels, nav blurbs) rather than decoration — so it is tuned to
// clear 4.5:1 against its own background in both schemes, not to be as light as
// it can get away with. Anything quieter than this belongs in a border, not a word.
const STYLE = `
:root{color-scheme:light dark;
  --bg:#06070a;--bg2:#111827;--elev:rgba(24,27,34,.72);--card:rgba(28,31,38,.72);
  --fg:#f5f7fb;--muted:#a6adbb;--faint:#7d8598;
  --accent:#0a84ff;--accent2:#64d2ff;--accent-weak:rgba(10,132,255,.16);--link-hover:#64d2ff;
  --ok:#30d158;--ok-weak:rgba(48,209,88,.16);--danger:#ff453a;--danger-weak:rgba(255,69,58,.14);
  --border:rgba(255,255,255,.12);--border-strong:rgba(255,255,255,.22);
  --radius:24px;--radius-sm:14px;
  --shadow:0 1px 0 rgba(255,255,255,.05) inset,0 24px 70px -38px rgba(0,0,0,.95);
  --blur:saturate(180%) blur(24px);--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
@media(prefers-color-scheme:light){:root{
  --bg:#f5f5f7;--bg2:#eef3fb;--elev:rgba(255,255,255,.78);--card:rgba(255,255,255,.82);
  --fg:#1d1d1f;--muted:#626874;--faint:#656c78;
  --accent:#0064cc;--accent2:#5ac8fa;--accent-weak:rgba(0,100,204,.11);--link-hover:#004a9e;
  --ok:#1e7a35;--ok-weak:rgba(30,122,53,.10);--danger:#d70015;--danger-weak:rgba(215,0,21,.09);
  --border:rgba(0,0,0,.10);--border-strong:rgba(0,0,0,.18);
  --shadow:0 1px 0 rgba(255,255,255,.7) inset,0 22px 70px -42px rgba(15,23,42,.42)}}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:radial-gradient(circle at 18% -12%,rgba(100,210,255,.22),transparent 34rem),radial-gradient(circle at 86% 0,rgba(10,132,255,.18),transparent 30rem),linear-gradient(180deg,var(--bg),var(--bg2));color:var(--fg);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;min-height:100vh}
[hidden]{display:none !important}
/* Hover used to lighten a link to --accent2, which on a light background made it
   *less* readable than it was at rest — a pale cyan on near-white. --link-hover
   moves each scheme further from its own background instead of towards it. */
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:none;color:var(--link-hover)}
:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.wrap{max-width:1120px;margin:0 auto;padding:2rem 1.25rem 4rem}
header.top{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:2rem}
h1{font-size:clamp(1.55rem,3.2vw,2.7rem);line-height:1.05;margin:0;letter-spacing:-.045em}.sub{color:var(--muted);font-size:.92rem;margin-top:.25rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:1rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.1rem 1.15rem;display:block;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);transition:border-color .18s,transform .18s,box-shadow .18s,background .18s}
.card:hover{border-color:var(--border-strong);transform:translateY(-2px);box-shadow:0 26px 80px -42px rgba(0,0,0,.72)}
.card h3{margin:0 0 .35rem;font-size:1.08rem;color:var(--fg);letter-spacing:-.02em}.card p{margin:0 0 .75rem;color:var(--muted);font-size:.9rem}
.meta{font-size:.78rem;color:var(--muted);display:flex;gap:.45rem;flex-wrap:wrap;align-items:center}
.hint{font-weight:400}
.tag,.badge{display:inline-flex;align-items:center;gap:.3rem;border:1px solid var(--border);border-radius:999px;padding:.16rem .62rem;font-size:.74rem;font-weight:500;color:var(--muted);white-space:nowrap;line-height:1.55;background:rgba(255,255,255,.04)}
.badge.is-open{color:var(--accent);border-color:rgba(10,132,255,.42);background:var(--accent-weak)}
.badge.is-locked{color:var(--muted)}
.mono{font-family:var(--mono);font-size:.82em}
.empty{text-align:center;color:var(--muted);padding:3.5rem 1.5rem;border:1px dashed var(--border-strong);border-radius:var(--radius);background:var(--card);box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.empty h1,.empty h3{margin:0 0 .45rem;color:var(--fg);font-size:1.15rem;letter-spacing:-.02em;line-height:1.3}
.empty p{margin:0 auto;max-width:34rem;font-size:.92rem}
form.up{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem;margin-bottom:2rem;display:grid;gap:.75rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
label{font-size:.85rem;color:var(--muted);display:block;margin-bottom:.28rem}
input,textarea,select{width:100%;padding:.72rem .78rem;background:rgba(255,255,255,.06);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font:inherit;transition:border-color .15s,box-shadow .15s,background .15s}
input:focus,textarea:focus,select:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 4px var(--accent-weak);background:rgba(255,255,255,.10)}
/* …but a keyboard user still gets the outline. The 4px ring above is a 16%-alpha
   tint — pretty, and nowhere near the 3:1 a focus indicator has to reach — so it
   decorates the pointer case only, and :focus-visible puts the real ring back. */
input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
::placeholder{color:var(--faint);opacity:1}
button{background:linear-gradient(180deg,var(--accent),#006edb);color:#fff;border:0;border-radius:999px;padding:.72rem 1.08rem;font:inherit;font-weight:650;cursor:pointer;box-shadow:0 14px 34px -22px rgba(10,132,255,.95);transition:transform .15s,opacity .15s,box-shadow .15s,border-color .15s,color .15s,background .15s}
button:hover{opacity:.96;transform:translateY(-1px)}button:disabled{opacity:.55;cursor:default;transform:none}
button.ghost,a.ghost.link-button{background:rgba(255,255,255,.04);color:var(--fg);border:1px solid var(--border);box-shadow:none}
a.ghost.link-button{display:inline-flex;align-items:center;justify-content:center;border-radius:999px;padding:.72rem 1.08rem;font-weight:650;text-decoration:none}
button.ghost:hover,a.ghost.link-button:hover{color:var(--fg);border-color:var(--border-strong);background:rgba(255,255,255,.08)}
button.small{padding:.42rem .78rem;font-size:.82rem}
button.danger{background:transparent;color:var(--danger);border:1px solid var(--border);box-shadow:none}
button.danger:hover{border-color:var(--danger);background:var(--danger-weak)}
.row{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.82rem 0;border-bottom:1px solid var(--border)}
.row:last-child{border-bottom:0}.row .info{min-width:0}.row .info b{display:block}
.note{font-size:.87rem;color:var(--muted)}
.hint{font-size:.82rem;color:var(--muted)}
.status{font-size:.86rem;color:var(--muted)}
.status.is-ok{color:var(--ok)}.status.is-error{color:var(--danger)}
/* The waitlist form's live region. Hidden with [hidden] rather than an inline
   display, and coloured from the same status tokens the rest of the product
   uses — the hard-coded greens and reds it used before were the one pair on the
   site that failed contrast in light mode. */
#msg{padding:.72rem .85rem;border-radius:var(--radius-sm);font-size:.9rem;border:1px solid transparent}
#msg.is-ok{color:var(--ok);border-color:var(--ok);background:var(--ok-weak)}
#msg.is-error{color:var(--danger);border-color:var(--danger);background:var(--danger-weak)}
@media(max-width:720px){.wrap{padding:1.2rem .85rem 3rem}header.top{align-items:flex-start}.row{align-items:flex-start;flex-direction:column}}

/* --- shared foundation: see docs/DESIGN.md -------------------------------- */
/* One status vocabulary for the whole product, so a pill means the same thing on
   the sign-in page, the people panel and the token list. Colour is never the only
   signal — every pill also carries its word. */
.badge.is-active{color:var(--ok);border-color:var(--ok);background:var(--ok-weak)}
.badge.is-invited{color:var(--accent);border-color:rgba(10,132,255,.42);background:var(--accent-weak)}
.badge.is-disabled{color:var(--danger);border-color:var(--danger);background:var(--danger-weak)}
.badge.is-warn{color:var(--danger);border-color:var(--border-strong)}
.badge.is-role{letter-spacing:.005em}
/* A visual cue that needs a spoken one. */
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
/* Every page's first tab stop. Off-screen rather than display:none, so it is
   still in the focus order; it becomes visible the moment it is focused. */
.skip{position:absolute;left:-9999px;top:0}
.skip:focus{position:static;display:inline-block;margin-bottom:.7rem}
/* Quiet, spacious surface for the sign-in / access states. */
.sheet{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
  box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);
  padding:2.4rem 2.1rem;max-width:34rem;margin:0 auto}
.sheet .eyebrow{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);margin:0 0 .6rem}
.sheet h1{font-size:clamp(1.7rem,4vw,2.4rem);letter-spacing:-.045em;margin:0 0 .65rem}
.sheet .lede{color:var(--muted);font-size:1.02rem;line-height:1.55;margin:0}
.sheet .actions{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1.6rem;align-items:center}
.sheet .divider{border:0;border-top:1px solid var(--border);margin:1.7rem 0}
.sheet dl{display:grid;gap:.35rem .9rem;grid-template-columns:auto 1fr;margin:0;font-size:.9rem}
.sheet dt{color:var(--muted)}.sheet dd{margin:0}
a.link-button{display:inline-flex;align-items:center;justify-content:center;border-radius:999px;
  padding:.72rem 1.08rem;font-weight:650;text-decoration:none;
  background:linear-gradient(180deg,var(--accent),#006edb);color:#fff;
  box-shadow:0 14px 34px -22px rgba(10,132,255,.95);transition:transform .15s,opacity .15s}
a.link-button:hover{opacity:.96;transform:translateY(-1px);text-decoration:none;color:#fff}
/* Restrained motion is a design rule, not a preference: nothing in this app moves
   more than a couple of pixels, and none of it moves at all for people who ask. */
@media(prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  *,*::before,*::after{transition-duration:.01ms !important;animation-duration:.01ms !important;
    animation-iteration-count:1 !important}
  button:hover,.card:hover,a.link-button:hover{transform:none}
}
`;

/**
 * The public repository. Defined here rather than in `src/seo.ts` because
 * `seo.ts` already imports the mark from this file, and pointing it back the
 * other way would make the two modules circular.
 *
 * It is a constant rather than a literal in the footer because three surfaces
 * cite it — the footer, the docs page and the `sameAs` entity signal in the
 * landing page's structured data — and a repository URL that disagrees with
 * itself across them is worse than not publishing one.
 */
export const SOURCE_URL = "https://github.com/yogevgab/artifacts-server";

// --- the mark ---------------------------------------------------------------
//
// One shape, drawn twice: once URL-encoded for the favicon, once as inline SVG
// for any page that shows the logo. Keeping the geometry in `MARK_PATH` and the
// colour in `MARK_BLUE` is what stops the tab and the page from drifting apart.

/**
 * The mark's geometry and colour, exported so anything that has to redraw it in
 * a different medium — the social card in `src/seo.ts`, for instance — redraws
 * *this* shape rather than inventing a second one.
 *
 * The mark is a **solid** caret, not a stroked one. It used to be the open
 * three-point path `M9 22 16 9l7 13` at 2.5px — which is the single most reused
 * glyph in interface design (`expand_less`, "sort ascending", "back to top"),
 * and which, on a 32-unit grid rendered into a 16px favicon, thins to about
 * 1.25px and blurs into a tick. Filling the same gesture keeps the brand
 * continuous — it is still the caret people already associate with rtfx — while
 * giving it the weight to survive a browser tab, and reading as a deliberate
 * mark rather than an icon-font default.
 *
 * `MARK_BLUE` is the same `#0a84ff` as `--accent`. It was `#3b5bdb`, an indigo
 * roughly 20° of hue away from every other blue in the product, so the favicon,
 * the social card's glow and the buttons were three different blues; the card
 * in `src/seo.ts` drew all three on one canvas. One accent, everywhere.
 */
export const MARK_PATH = "M16 9 L24 23 L19.5 23 L16 16.5 L12.5 23 L8 23 Z";
export const MARK_BLUE = "#0a84ff";

// Inline mark, so no page ever requests /favicon.ico — that path would fall
// through to the artifact catch-all (or the content-host redirect) and log noise.
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E" +
  `%3Crect width='32' height='32' rx='8' fill='%23${MARK_BLUE.slice(1)}'/%3E` +
  `%3Cpath d='${MARK_PATH}' fill='white'/%3E%3C/svg%3E`;

/**
 * The rtfx mark as inline SVG. Inline rather than an `<img>` because the one
 * page that most needs it — `/login` — is the page a person meets before they
 * are authenticated, on a connection that is about to hand them to a different
 * origin: it must render complete on first paint, with no second request.
 *
 * `aria-hidden` on purpose. It is always rendered beside the wordmark, and a
 * screen reader announcing "rtfx.pro logo, rtfx.pro" is noise, not information.
 */
export function brandMark(size = 28): string {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect width="32" height="32" rx="8" fill="${MARK_BLUE}"></rect>
    <path d="${MARK_PATH}" fill="white"></path>
  </svg>`;
}

/**
 * Wordmark-only lockup. The mark still exists for the favicon and social card,
 * but the product chrome leads with the domain itself: rtfx.pro.
 */
export function brandLockup(href = "/"): string {
  return `<a class="brand brand-lockup" data-brand-lockup href="${esc(href)}"><span
    class="wordmark">rtfx<span>.pro</span></span></a>`;
}

/** Shared presentation for the lockup above, for pages that opt into it. */
export const BRAND_STYLE = `
.brand-lockup{display:inline-flex;align-items:center;gap:.55rem;color:var(--fg);font-weight:750;
  letter-spacing:-.03em;font-size:1.02rem;text-decoration:none}
.brand-lockup:hover{color:var(--accent);text-decoration:none}
.brand-lockup .wordmark{display:inline-block}
.brand-lockup .wordmark span{color:var(--muted);font-weight:600}
`;

// --- public chrome ----------------------------------------------------------
//
// One header and one footer for every page a signed-out visitor can reach
// (issue #35). Landing, docs and sign-in used to carry three near-identical
// copies of this markup and CSS, which is exactly how three pages drift into
// looking like three products.

/** Which public page is being rendered, so its own link can be dropped. */
export type PublicPage = "home" | "docs" | "login" | "privacy" | "terms";

/**
 * The link every public page opens with, and the reason each of them wraps its
 * content in `<main id="main">`. It is the first thing in the tab order, so
 * somebody navigating by keyboard reaches the page's content without walking
 * the whole nav on every single page.
 */
export function skipLink(): string {
  return `<a class="skip" href="#main">Skip to content</a>`;
}

/**
 * The sticky nav bar: the rtfx lockup, then the same four destinations in the
 * same order everywhere. The current page's own link is omitted rather than
 * disabled — a nav that points at the page you are on is noise.
 *
 * The skip link is emitted here rather than by each page, so a new public page
 * cannot be added without one.
 */
export function siteHeader(current: PublicPage = "home"): string {
  const links = [
    current === "home" ? "" : `<a href="/" data-nav="home">Home</a>`,
    current === "docs" ? "" : `<a href="/docs" data-cta="docs">Docs</a>`,
    `<a href="/docs#use-cases" data-nav="use-cases">Use cases</a>`,
    `<a href="/#waitlist" class="primary" data-cta="request-access">Request access</a>`,
    current === "login" ? "" : `<a href="/login" data-cta="sign-in">Sign in →</a>`,
  ].filter(Boolean);
  return `${skipLink()}
    <header class="top">${brandLockup("/")}
    <nav class="nav" aria-label="Primary">${links.join("\n      ")}</nav></header>`;
}

/**
 * The same footer on every public page: where to go next, and what this is.
 *
 * The legal row is separated from the navigation row because it answers a
 * different question — "what am I agreeing to?" rather than "where do I go?" —
 * and because a person looking for a privacy policy looks at the bottom of the
 * page, in a place that does not move between pages (issue #36).
 */
export function siteFooter(): string {
  return `<footer class="site">
      <nav aria-label="Footer">
        <a href="/">Home</a>
        <a href="/docs" data-cta="docs">Docs</a>
        <a href="/docs#use-cases">Use cases</a>
        <a href="/login" data-cta="sign-in">Sign in</a>
        <!-- The strongest thing a security product can offer somebody it has not
             invited yet: read the code and the threat model before asking for an
             account. The repository is public and the product is MIT-licensed, so
             this costs nothing and answers the question an invite-only page
             otherwise leaves open — "what am I being asked to trust?" -->
        <a href="${SOURCE_URL}" data-nav="source" rel="noopener">Source</a>
        <a href="${SOURCE_URL}/blob/main/SECURITY.md" data-nav="security" rel="noopener">Security</a>
        <a href="/llms.txt">llms.txt</a>
      </nav>
      <nav class="legal" aria-label="Legal">
        <a href="/privacy" data-legal="privacy">Privacy</a>
        <a href="/terms" data-legal="terms">Terms</a>
        <a href="/privacy#cookies" data-legal="cookies">Cookies</a>
      </nav>
      <div>rtfx.pro — secure, access-protected hosting for pages and artifacts.</div>
    </footer>`;
}

/**
 * Presentation for `siteHeader`/`siteFooter`. Includes `BRAND_STYLE`, so a page
 * that opts into the chrome cannot end up with an unstyled lockup.
 */
export const PUBLIC_CHROME_STYLE = `${BRAND_STYLE}
header.top{position:sticky;top:0;z-index:5;margin:-.75rem 0 2.2rem;padding:.72rem .9rem;
  border:1px solid var(--border);border-radius:999px;background:var(--elev);
  backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);box-shadow:var(--shadow)}
.nav{display:flex;gap:.9rem;align-items:center;flex-wrap:wrap}
.nav a{color:var(--muted);font-size:.9rem}
.nav a:hover{color:var(--fg)}
.nav a.primary{color:var(--fg);border:1px solid var(--border);border-radius:999px;
  padding:.42rem .78rem;background:rgba(255,255,255,.05)}
footer.site{text-align:center;color:var(--muted);font-size:.88rem;padding:2.4rem 0 1rem;
  border-top:1px solid var(--border);margin-top:3rem}
footer.site nav{display:flex;gap:1.1rem;justify-content:center;flex-wrap:wrap;margin-bottom:.9rem}
footer.site nav.legal{gap:.9rem;font-size:.84rem;margin-bottom:1.1rem}
footer.site nav.legal a{color:var(--muted)}
footer.site nav.legal a:hover{color:var(--fg)}
@media(max-width:760px){
  header.top{position:static;border-radius:22px}
  .nav{gap:.55rem}
  /* The two orientation links go first on a narrow screen; the two that move a
     person forward (request access, sign in) always stay. */
  .nav a[data-nav="use-cases"],.nav a[data-nav="home"]{display:none}
}
/* Touch targets in the nav: a 0.9rem text link is not 44px on its own. The
   .toc pills on /docs, /privacy and /terms are the same problem — a row of
   small chips is exactly where a thumb misses. */
@media(pointer:coarse){
  .nav a,footer.site nav a,.toc a{min-height:44px;display:inline-flex;align-items:center}
}
`;

/**
 * Head metadata for a page. Omitting it is the safe default: a page with no
 * `HeadMeta` is treated as private and rendered `noindex,nofollow`, so a new
 * signed-in surface can never be indexed by forgetting to say so (issue #29).
 */
export interface HeadMeta {
  /** Meta description + OpenGraph/Twitter description. */
  description: string;
  /** Absolute canonical URL — also the OpenGraph URL. */
  canonical: string;
  /** Absolute social card URL. */
  image?: string;
  /** Social-card title; defaults to the page title. */
  socialTitle?: string;
  /** JSON-LD objects rendered as `application/ld+json`. */
  jsonLd?: unknown[];
}

/** Serialize JSON-LD safely: `<` can never start a tag inside the script. */
function ldJson(data: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

function headTags(title: string, meta?: HeadMeta): string {
  if (!meta) return `<meta name="robots" content="noindex,nofollow">`;
  const social = meta.socialTitle ?? title;
  const tags = [
    `<meta name="description" content="${esc(meta.description)}">`,
    `<link rel="canonical" href="${esc(meta.canonical)}">`,
    `<meta name="robots" content="index,follow,max-image-preview:large">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="rtfx.pro">`,
    `<meta property="og:locale" content="en_US">`,
    `<meta property="og:title" content="${esc(social)}">`,
    `<meta property="og:description" content="${esc(meta.description)}">`,
    `<meta property="og:url" content="${esc(meta.canonical)}">`,
    `<meta name="twitter:card" content="${meta.image ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${esc(social)}">`,
    `<meta name="twitter:description" content="${esc(meta.description)}">`,
  ];
  if (meta.image) {
    tags.push(
      `<meta property="og:image" content="${esc(meta.image)}">`,
      `<meta property="og:image:type" content="image/png">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta property="og:image:alt" content="${esc(social)}">`,
      `<meta name="twitter:image" content="${esc(meta.image)}">`
    );
  }
  for (const block of meta.jsonLd ?? []) tags.push(ldJson(block));
  return tags.join("\n");
}

/**
 * `csp`, when given, is rendered as a `<meta http-equiv="Content-Security-Policy">`
 * tag — the only way to add a page-scoped CSP directive without a response-header
 * middleware for that route. Today only the `/admin` portal shell passes one (see
 * `posthogCsp` in `src/posthog.ts`, called from `src/portal.ts`), to allow the
 * PostHog host once a deployment opts into it. A meta tag cannot carry
 * `frame-ancestors`, `report-uri` or `sandbox` — irrelevant here, since this is
 * always an additive `script-src`/`connect-src`/`worker-src` allowance, never a
 * restriction, and never touches the artifact content host's own CSP header
 * (`src/serve.ts`).
 */
export function layout(title: string, body: string, extraStyle = "", meta?: HeadMeta, csp?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#06070a">
${csp ? `<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">\n` : ""}<link rel="icon" href="${FAVICON}">
<title>${esc(title)}</title>
${headTags(title, meta)}
<style>${STYLE}${extraStyle}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

const NOT_FOUND_STYLE = `
.ask-access{margin-top:1.9rem;padding-top:1.6rem;border-top:1px solid var(--border);text-align:left}
.ask-access p.hint{margin:0 0 .75rem;text-align:center;color:var(--muted);font-size:.9rem}
.ask-access form{display:flex;gap:.6rem;flex-wrap:wrap;justify-content:center}
.ask-access input{flex:1;min-width:14rem}
.ask-access #ra-msg{max-width:28rem;margin:.85rem auto 0}
`;

/**
 * The "ask for access" form's behaviour. Kept minimal on purpose: it posts an
 * address, disables the button while in flight, and shows one of a small,
 * fixed set of sentences — none of which is allowed to depend on whether the
 * artifact exists, only on whether the *request itself* succeeded (see
 * src/access-request-routes.ts for why).
 */
const REQUEST_ACCESS_SCRIPT = `<script>(function(){
  var form = document.querySelector('[data-request-access]');
  if(!form) return;
  var msg = document.getElementById('ra-msg');
  var btn = form.querySelector('button[type=submit]');
  var email = document.getElementById('ra-email');
  function show(text, kind){
    msg.textContent = text; msg.hidden = false;
    msg.className = kind === 'ok' ? 'is-ok' : kind === 'error' ? 'is-error' : '';
  }
  form.addEventListener('submit', function(e){
    e.preventDefault();
    btn.disabled = true;
    show('Sending…', '');
    fetch(form.getAttribute('data-request-access'), {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ email: email.value.trim() })
    }).then(function(res){
      if (res.status === 429) { show('Too many requests — please try again in an hour.', 'error'); return; }
      if (!res.ok) { show('Enter a valid email address.', 'error'); return; }
      show("Sent. If you're missing access, the owner will hear from you.", 'ok');
      form.reset();
    }).catch(function(){
      show('Network error — please try again.', 'error');
    }).finally(function(){
      btn.disabled = false;
    });
  });
})();</script>`;

/**
 * The 404 every missing *or* unauthorized artifact gets. This is the one page
 * rendered on the content origin as well as the app origin, which is why it
 * depends on nothing outside this module.
 *
 * It carries the lockup like every other surface (issue #35): somebody who
 * followed a link that no longer resolves should still be able to tell whose
 * product just answered them.
 *
 * The "ask for access" form below is a pure function of `slug` alone — it
 * never queries anything, never learns whether the slug is real, and is
 * shown whenever a slug is present, full stop. That is what keeps this page
 * from becoming an existence oracle: a real, access-restricted slug and a
 * completely invented one render the exact same markup, because the only
 * input either path has ever had is the string itself. See
 * src/access-request-routes.ts for the other half of that guarantee — the
 * form's POST target, which is equally indifferent to what it answers.
 */
export function notFoundPage(slug?: string): string {
  const askAccess = slug
    ? `<div class="ask-access" data-ask-access>
        <p class="hint">Think you should have access? Ask the owner.</p>
        <form data-request-access="/_access-request/${esc(encodeURIComponent(slug))}">
          <label class="sr-only" for="ra-email">Your email address</label>
          <input id="ra-email" name="email" type="email" required placeholder="you@example.com" autocomplete="email">
          <button type="submit">Ask for access</button>
        </form>
        <div id="ra-msg" role="status" aria-live="polite" hidden></div>
      </div>${REQUEST_ACCESS_SCRIPT}`
    : "";
  const body = `${skipLink()}
    <header class="top">${brandLockup("/")}</header>
    <main class="empty" id="main" data-empty="not-found">
      <h1>${slug ? `Nothing here at <span class="mono">/${esc(slug)}/</span>` : "This page does not exist."}</h1>
      <p>${
        slug
          ? "The artifact may have been deleted, renamed, or you may not have access to it. Check the link, or ask the person who shared it to grant you access."
          : "Check the address, or head back to your dashboard."
      }</p>
      <p style="margin-top:1rem"><a href="/admin">← Back to your dashboard</a></p>
      ${askAccess}
    </main>`;
  return layout("Not found", body, `${BRAND_STYLE}${NOT_FOUND_STYLE}`);
}
