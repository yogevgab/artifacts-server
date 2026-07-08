import type { ArtifactRow } from "./env";

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = `
:root{color-scheme:light dark;--bg:#0b0c10;--card:#16181d;--fg:#e8eaed;--muted:#9aa0a6;--accent:#7aa2f7;--border:#2a2d34}
@media(prefers-color-scheme:light){:root{--bg:#f6f7f9;--card:#fff;--fg:#1a1c20;--muted:#5f6368;--accent:#3b5bdb;--border:#e3e6ea}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:2rem 1.25rem}
header.top{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin-bottom:2rem}
h1{font-size:1.5rem;margin:0}.sub{color:var(--muted);font-size:.9rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1rem 1.1rem;display:block;transition:border-color .15s}
.card:hover{border-color:var(--accent);text-decoration:none}
.card h3{margin:0 0 .35rem;font-size:1.05rem;color:var(--fg)}
.card p{margin:0 0 .6rem;color:var(--muted);font-size:.9rem}
.meta{font-size:.78rem;color:var(--muted);display:flex;gap:.5rem;flex-wrap:wrap}
.tag{border:1px solid var(--border);border-radius:999px;padding:.05rem .5rem}
.empty{text-align:center;color:var(--muted);padding:4rem 1rem;border:1px dashed var(--border);border-radius:12px}
form.up{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.25rem;margin-bottom:2rem;display:grid;gap:.75rem}
label{font-size:.85rem;color:var(--muted);display:block;margin-bottom:.25rem}
input,textarea{width:100%;padding:.55rem .6rem;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--fg);font:inherit}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:.6rem 1rem;font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}
.row{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.75rem 0;border-bottom:1px solid var(--border)}
.row:last-child{border-bottom:0}.row .info{min-width:0}.row .info b{display:block}
.note{font-size:.85rem;color:var(--muted)}
.hint{font-size:.8rem;color:var(--muted)}
#msg{padding:.6rem .8rem;border-radius:8px;font-size:.9rem;display:none}
`;

export function layout(title: string, body: string, extraStyle = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}${extraStyle}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

export function galleryPage(rows: ArtifactRow[]): string {
  const cards = rows
    .map(
      (r) => `<a class="card" href="/${esc(r.slug)}/">
      <h3>${esc(r.title)}</h3>
      ${r.description ? `<p>${esc(r.description)}</p>` : ""}
      <div class="meta"><span class="tag">${esc(r.type)}</span><span>${fmtDate(r.created_at)}</span></div>
    </a>`
    )
    .join("");
  const body = `<header class="top"><div><h1>Artifacts</h1><div class="sub">${rows.length} published</div></div></header>
    ${rows.length ? `<div class="grid">${cards}</div>` : `<div class="empty">No artifacts yet.</div>`}`;
  return layout("Artifacts", body);
}

export function notFoundPage(slug?: string): string {
  const body = `<header class="top"><h1>Not found</h1></header>
    <p class="note">${slug ? `No artifact matched <code>${esc(slug)}</code>.` : "This page does not exist."}</p>
    <p><a href="/">← Back to gallery</a></p>`;
  return layout("Not found", body);
}
