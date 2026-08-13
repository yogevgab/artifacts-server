import type { ArtifactRow } from "./env";

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = `
:root{color-scheme:light dark;
  --bg:#06070a;--bg2:#111827;--elev:rgba(24,27,34,.72);--card:rgba(28,31,38,.72);
  --fg:#f5f7fb;--muted:#a6adbb;--faint:#737b8c;
  --accent:#0a84ff;--accent2:#64d2ff;--accent-weak:rgba(10,132,255,.16);
  --ok:#30d158;--ok-weak:rgba(48,209,88,.16);--danger:#ff453a;--danger-weak:rgba(255,69,58,.14);
  --border:rgba(255,255,255,.12);--border-strong:rgba(255,255,255,.22);
  --radius:24px;--radius-sm:14px;
  --shadow:0 1px 0 rgba(255,255,255,.05) inset,0 24px 70px -38px rgba(0,0,0,.95);
  --blur:saturate(180%) blur(24px);--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
@media(prefers-color-scheme:light){:root{
  --bg:#f5f5f7;--bg2:#eef3fb;--elev:rgba(255,255,255,.78);--card:rgba(255,255,255,.82);
  --fg:#1d1d1f;--muted:#626874;--faint:#8a9099;
  --accent:#0071e3;--accent2:#5ac8fa;--accent-weak:rgba(0,113,227,.11);
  --ok:#248a3d;--ok-weak:rgba(36,138,61,.10);--danger:#d70015;--danger-weak:rgba(215,0,21,.09);
  --border:rgba(0,0,0,.10);--border-strong:rgba(0,0,0,.18);
  --shadow:0 1px 0 rgba(255,255,255,.7) inset,0 22px 70px -42px rgba(15,23,42,.42)}}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:radial-gradient(circle at 18% -12%,rgba(100,210,255,.22),transparent 34rem),radial-gradient(circle at 86% 0,rgba(10,132,255,.18),transparent 30rem),linear-gradient(180deg,var(--bg),var(--bg2));color:var(--fg);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;min-height:100vh}
[hidden]{display:none !important}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:none;color:var(--accent2)}
:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.wrap{max-width:1120px;margin:0 auto;padding:2rem 1.25rem 4rem}
header.top{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:2rem}
h1{font-size:clamp(1.55rem,3.2vw,2.7rem);line-height:1.05;margin:0;letter-spacing:-.045em}.sub{color:var(--muted);font-size:.92rem;margin-top:.25rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:1rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.1rem 1.15rem;display:block;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);transition:border-color .18s,transform .18s,box-shadow .18s,background .18s}
.card:hover{border-color:var(--border-strong);transform:translateY(-2px);box-shadow:0 26px 80px -42px rgba(0,0,0,.72)}
.card h3{margin:0 0 .35rem;font-size:1.08rem;color:var(--fg);letter-spacing:-.02em}.card p{margin:0 0 .75rem;color:var(--muted);font-size:.9rem}
.meta{font-size:.78rem;color:var(--muted);display:flex;gap:.45rem;flex-wrap:wrap;align-items:center}
.tag,.badge{display:inline-flex;align-items:center;gap:.3rem;border:1px solid var(--border);border-radius:999px;padding:.16rem .62rem;font-size:.74rem;color:var(--muted);white-space:nowrap;line-height:1.55;background:rgba(255,255,255,.04)}
.badge.is-open{color:var(--accent);border-color:rgba(10,132,255,.42);background:var(--accent-weak)}
.badge.is-locked{color:var(--muted)}
.mono{font-family:var(--mono);font-size:.82em}
.empty{text-align:center;color:var(--muted);padding:3.5rem 1.5rem;border:1px dashed var(--border-strong);border-radius:var(--radius);background:var(--card);box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.empty h3{margin:0 0 .45rem;color:var(--fg);font-size:1.15rem;letter-spacing:-.02em}
.empty p{margin:0 auto;max-width:34rem;font-size:.92rem}
form.up{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem;margin-bottom:2rem;display:grid;gap:.75rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
label{font-size:.85rem;color:var(--muted);display:block;margin-bottom:.28rem}
input,textarea,select{width:100%;padding:.72rem .78rem;background:rgba(255,255,255,.06);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg);font:inherit;transition:border-color .15s,box-shadow .15s,background .15s}
input:focus,textarea:focus,select:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 4px var(--accent-weak);background:rgba(255,255,255,.10)}
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
#msg{padding:.72rem .85rem;border-radius:var(--radius-sm);font-size:.9rem;display:none}
@media(max-width:720px){.wrap{padding:1.2rem .85rem 3rem}header.top{align-items:flex-start}.row{align-items:flex-start;flex-direction:column}}

/* --- shared foundation: see docs/DESIGN.md -------------------------------- */
/* One status vocabulary for the whole product, so a pill means the same thing on
   the sign-in page, the people panel and the token list. Colour is never the only
   signal — every pill also carries its word. */
.badge.is-active{color:var(--ok);border-color:var(--ok);background:var(--ok-weak)}
.badge.is-invited{color:var(--accent);border-color:rgba(10,132,255,.42);background:var(--accent-weak)}
.badge.is-disabled{color:var(--danger);border-color:var(--danger);background:var(--danger-weak)}
.badge.is-warn{color:var(--danger);border-color:var(--border-strong)}
.badge.is-role{font-weight:650;letter-spacing:.005em}
/* A visual cue that needs a spoken one. */
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
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

// --- the mark ---------------------------------------------------------------
//
// One shape, drawn twice: once URL-encoded for the favicon, once as inline SVG
// for any page that shows the logo. Keeping the geometry in `MARK_PATH` and the
// colour in `MARK_BLUE` is what stops the tab and the page from drifting apart.

const MARK_PATH = "M9 22 16 9l7 13";
const MARK_BLUE = "#3b5bdb";

// Inline mark, so no page ever requests /favicon.ico — that path would fall
// through to the artifact catch-all (or the content-host redirect) and log noise.
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E" +
  `%3Crect width='32' height='32' rx='8' fill='%23${MARK_BLUE.slice(1)}'/%3E` +
  `%3Cpath d='${MARK_PATH}' fill='none' stroke='white' stroke-width='2.5' stroke-linejoin='round'/%3E%3C/svg%3E`;

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
    <path d="${MARK_PATH}" fill="none" stroke="white" stroke-width="2.5" stroke-linejoin="round"></path>
  </svg>`;
}

/**
 * Mark + wordmark, split exactly the way the dashboard header splits it
 * (`rtfx` in full weight, `.pro` quiet). Signing in and being signed in should
 * not look like two products.
 */
export function brandLockup(href = "/"): string {
  return `<a class="brand brand-lockup" data-brand-lockup href="${esc(href)}">${brandMark()}<span
    class="wordmark">rtfx<span>.pro</span></span></a>`;
}

/** Shared presentation for the lockup above, for pages that opt into it. */
export const BRAND_STYLE = `
.brand-lockup{display:inline-flex;align-items:center;gap:.55rem;color:var(--fg);font-weight:750;
  letter-spacing:-.03em;font-size:1.02rem;text-decoration:none}
.brand-lockup:hover{color:var(--accent);text-decoration:none}
.brand-lockup .mark{display:block;border-radius:8px;flex:none}
.brand-lockup .wordmark span{color:var(--muted);font-weight:600}
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
      `<meta property="og:image:type" content="image/svg+xml">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta property="og:image:alt" content="${esc(social)}">`,
      `<meta name="twitter:image" content="${esc(meta.image)}">`
    );
  }
  for (const block of meta.jsonLd ?? []) tags.push(ldJson(block));
  return tags.join("\n");
}

export function layout(title: string, body: string, extraStyle = "", meta?: HeadMeta): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#06070a">
<link rel="icon" href="${FAVICON}">
<title>${esc(title)}</title>
${headTags(title, meta)}
<style>${STYLE}${extraStyle}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

export function galleryPage(rows: ArtifactRow[]): string {
  const cards = rows
    .map(
      (r) => `<a class="card" href="/${esc(r.slug)}/" data-artifact="${esc(r.slug)}">
      <h3>${esc(r.title)}</h3>
      ${r.description ? `<p>${esc(r.description)}</p>` : `<p class="hint">/${esc(r.slug)}/</p>`}
      <div class="meta"><span class="tag">${esc(r.type)}</span>
        <span class="badge" data-badge="version">v${r.current_version}</span>
        ${r.visibility === "everyone" ? `<span class="badge is-open" data-badge="visibility">everyone</span>` : `<span class="badge is-locked" data-badge="visibility">restricted</span>`}
        <span>${fmtDate(r.created_at)}</span></div>
    </a>`
    )
    .join("");
  const body = `<header class="top"><div><h1>Artifacts</h1><div class="sub">${rows.length} published</div></div></header>
    ${
      rows.length
        ? `<div class="grid">${cards}</div>`
        : `<div class="empty" data-empty="gallery">
            <h3>No artifacts yet.</h3>
            <p>Nothing has been shared with you so far. When someone publishes an artifact and
              grants you access, it shows up here.</p>
          </div>`
    }`;
  return layout("Artifacts", body);
}

export function notFoundPage(slug?: string): string {
  const body = `<header class="top"><h1>Not found</h1></header>
    <div class="empty" data-empty="not-found">
      <h3>${slug ? `Nothing here at <span class="mono">/${esc(slug)}/</span>` : "This page does not exist."}</h3>
      <p>${
        slug
          ? "The artifact may have been deleted, renamed, or you may not have access to it. Check the link, or ask the person who shared it to grant you access."
          : "Check the address, or head back to the gallery."
      }</p>
      <p style="margin-top:1rem"><a href="/gallery">← Back to gallery</a></p>
    </div>`;
  return layout("Not found", body);
}
