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
  --bg:#0b0c10;--elev:#101217;--card:#16181d;--fg:#e8eaed;--muted:#9aa0a6;--faint:#6b7078;
  --accent:#7aa2f7;--accent-weak:rgba(122,162,247,.14);
  --ok:#4ec07a;--ok-weak:rgba(78,192,122,.14);--danger:#f07171;--danger-weak:rgba(240,113,113,.14);
  --border:#2a2d34;--border-strong:#3a3f48;
  --radius:14px;--shadow:0 1px 2px rgba(0,0,0,.35),0 10px 30px -18px rgba(0,0,0,.8);
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
@media(prefers-color-scheme:light){:root{
  --bg:#f6f7f9;--elev:#fff;--card:#fff;--fg:#1a1c20;--muted:#5f6368;--faint:#80868b;
  --accent:#3b5bdb;--accent-weak:rgba(59,91,219,.10);
  --ok:#1e8e4a;--ok-weak:rgba(30,142,74,.12);--danger:#c5382f;--danger-weak:rgba(197,56,47,.10);
  --border:#e3e6ea;--border-strong:#d3d8df;
  --shadow:0 1px 2px rgba(16,24,40,.06),0 10px 30px -18px rgba(16,24,40,.35)}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased}
[hidden]{display:none !important}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.wrap{max-width:960px;margin:0 auto;padding:2rem 1.25rem}
header.top{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin-bottom:2rem}
h1{font-size:1.5rem;margin:0;letter-spacing:-.01em}.sub{color:var(--muted);font-size:.9rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.1rem;display:block;transition:border-color .15s,transform .15s,box-shadow .15s}
.card:hover{border-color:var(--accent);text-decoration:none;transform:translateY(-1px);box-shadow:var(--shadow)}
.card h3{margin:0 0 .35rem;font-size:1.05rem;color:var(--fg)}
.card p{margin:0 0 .6rem;color:var(--muted);font-size:.9rem}
.meta{font-size:.78rem;color:var(--muted);display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.tag,.badge{display:inline-flex;align-items:center;gap:.3rem;border:1px solid var(--border);border-radius:999px;padding:.1rem .55rem;font-size:.74rem;color:var(--muted);white-space:nowrap;line-height:1.6}
.badge.is-open{color:var(--accent);border-color:var(--accent);background:var(--accent-weak)}
.badge.is-locked{color:var(--muted)}
.mono{font-family:var(--mono);font-size:.82em}
.empty{text-align:center;color:var(--muted);padding:3.5rem 1.5rem;border:1px dashed var(--border-strong);border-radius:var(--radius);background:var(--card)}
.empty h3{margin:0 0 .4rem;color:var(--fg);font-size:1.05rem}
.empty p{margin:0 auto;max-width:32rem;font-size:.9rem}
form.up{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem;margin-bottom:2rem;display:grid;gap:.75rem}
label{font-size:.85rem;color:var(--muted);display:block;margin-bottom:.25rem}
input,textarea,select{width:100%;padding:.55rem .6rem;background:var(--bg);border:1px solid var(--border);border-radius:10px;color:var(--fg);font:inherit}
input:focus,textarea:focus,select:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 3px var(--accent-weak)}
::placeholder{color:var(--faint);opacity:1}
button{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:.6rem 1rem;font:inherit;font-weight:600;cursor:pointer;transition:opacity .15s,border-color .15s,color .15s}
button:hover{opacity:.9}button:disabled{opacity:.55;cursor:default}
button.ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}
button.ghost:hover{color:var(--fg);border-color:var(--border-strong)}
button.small{padding:.35rem .7rem;font-size:.82rem}
button.danger{background:transparent;color:var(--danger);border:1px solid var(--border)}
button.danger:hover{border-color:var(--danger);background:var(--danger-weak)}
.row{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.75rem 0;border-bottom:1px solid var(--border)}
.row:last-child{border-bottom:0}.row .info{min-width:0}.row .info b{display:block}
.note{font-size:.85rem;color:var(--muted)}
.hint{font-size:.8rem;color:var(--muted)}
.status{font-size:.85rem;color:var(--muted)}
.status.is-ok{color:var(--ok)}.status.is-error{color:var(--danger)}
#msg{padding:.6rem .8rem;border-radius:10px;font-size:.9rem;display:none}
`;

// Inline mark, so no page ever requests /favicon.ico — that path would fall
// through to the artifact catch-all (or the content-host redirect) and log noise.
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E" +
  "%3Crect width='32' height='32' rx='8' fill='%233b5bdb'/%3E" +
  "%3Cpath d='M9 22 16 9l7 13' fill='none' stroke='white' stroke-width='2.5' stroke-linejoin='round'/%3E%3C/svg%3E";

export function layout(title: string, body: string, extraStyle = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="${FAVICON}">
<title>${esc(title)}</title><style>${STYLE}${extraStyle}</style></head>
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
