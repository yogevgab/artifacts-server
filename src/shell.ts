/**
 * The viewer shell.
 *
 * Product UI — the share banner, the chat, the version indicator — cannot live
 * inside the artifact. Artifact HTML runs arbitrary JavaScript by design (see
 * the CSP in `src/serve.ts`), so a share control in that document would be
 * privileged UI sitting same-origin with attacker-controlled code.
 *
 * So the chrome lives here, on our origin, and the artifact renders in a frame
 * with `sandbox` and deliberately WITHOUT `allow-same-origin`. That omission is
 * the entire security property: the browser hands the framed document an opaque
 * origin, so it cannot read cookies, cannot make credentialed same-origin
 * requests, and cannot reach `window.parent`.
 *
 * See docs/superpowers/specs/2026-08-14-viewer-shell-design.md.
 */

import { esc } from "./pages";

export interface ShellInput {
  slug: string;
  title: string;
  version: number;
  /** Whether this caller may change access — decides if the banner exists at all. */
  canManage: boolean;
  /** Current visibility, for the banner's summary line. */
  visibility: "restricted" | "everyone";
  /** How many people are named on a restricted artifact. */
  grantCount: number;
  /** The path inside the artifact being viewed, "" for the root. */
  filePath: string;
  /**
   * The artifact's entry file. Usually index.html, but a PDF artifact's entry
   * is document.pdf — the frame must point at what actually exists, or the
   * shell renders around a 404.
   */
  entry?: string;
  /** True when this artifact is a single document rather than a site. */
  isDocument?: boolean;
}

const SHELL_STYLE = `
:root{color-scheme:light dark;--sh-bg:#F2F3F7;--sh-fg:#14182B;--sh-muted:#565D78;
  --sh-rule:#D3D7E4;--sh-accent:#2438C8;--sh-surface:#FFFFFF}
@media(prefers-color-scheme:dark){:root{--sh-bg:#0D1020;--sh-fg:#E7E9F3;--sh-muted:#9AA1BC;
  --sh-rule:#2B3252;--sh-accent:#8C9BFF;--sh-surface:#161A2E}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--sh-bg);color:var(--sh-fg);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  display:flex;flex-direction:column}
.bar{flex:none;display:flex;align-items:center;gap:12px;padding:8px 14px;
  background:var(--sh-surface);border-bottom:1px solid var(--sh-rule);flex-wrap:wrap;
  transition:margin-top .18s ease}
.bar[data-collapsed]{margin-top:calc(-1 * var(--bar-h,46px))}
@media(prefers-reduced-motion:reduce){.bar{transition:none}}
/* The peek tab is the only way back once the bar is hidden, so it is always
   reachable and never covers content it would obscure. */
.peek{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:5;
  border:1px solid var(--sh-rule);border-top:0;border-radius:0 0 8px 8px;
  background:var(--sh-surface);color:var(--sh-muted);font:inherit;font-size:11px;
  letter-spacing:.06em;text-transform:uppercase;padding:3px 12px;cursor:pointer}
.peek[hidden]{display:none}
.peek:focus-visible{outline:2px solid var(--sh-accent);outline-offset:2px}
.bar .mark{font-weight:600;letter-spacing:-.02em;font-size:14px;text-decoration:none;color:var(--sh-fg)}
.bar .mark span{color:var(--sh-accent)}
.bar .title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:34ch}
.bar .ver{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--sh-muted);
  border:1px solid var(--sh-rule);border-radius:999px;padding:1px 7px}
.bar .spacer{flex:1 1 auto}
.bar button{font:inherit;font-size:13px;padding:5px 11px;border-radius:6px;border:1px solid var(--sh-rule);
  background:transparent;color:var(--sh-fg);cursor:pointer}
.bar button.primary{background:var(--sh-accent);border-color:var(--sh-accent);color:#fff}
.bar button:focus-visible{outline:2px solid var(--sh-accent);outline-offset:2px}
.frame{flex:1 1 auto;width:100%;border:0;display:block;background:var(--sh-surface)}
.panel{position:fixed;inset:auto 0 0 auto;width:min(380px,100%);max-height:70vh;overflow:auto;
  background:var(--sh-surface);border:1px solid var(--sh-rule);border-radius:10px 10px 0 0;
  margin:0 14px;padding:14px;box-shadow:0 -6px 30px rgba(0,0,0,.18)}
.panel[hidden]{display:none}
.panel h2{margin:0 0 8px;font-size:14px}
.panel .hint{color:var(--sh-muted);font-size:12.5px;margin:0 0 10px}
.row{display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--sh-rule)}
.row:last-child{border-bottom:0}
.row .who{flex:1;overflow:hidden;text-overflow:ellipsis;font-size:13px}
.add{display:flex;gap:8px;margin-top:10px}
.add input{flex:1;padding:6px 9px;border:1px solid var(--sh-rule);border-radius:6px;
  background:transparent;color:var(--sh-fg);font:inherit;font-size:13px}
.sep{border:0;border-top:1px solid var(--sh-rule);margin:14px 0 10px}
.link-row{display:flex;gap:8px;align-items:center;padding:6px 0;font-size:12px}
.link-row code{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--sh-muted)}
`;

/**
 * The banner is rendered only for a caller who may manage the artifact. A
 * viewer gets no markup at all rather than a disabled control — advertising a
 * button somebody cannot press is worse than not having one.
 */
function banner(i: ShellInput): string {
  if (!i.canManage) return "";
  const summary =
    i.visibility === "everyone"
      ? "Anyone signed in can open this"
      : i.grantCount === 1
        ? "1 person can open this"
        : `${i.grantCount} people can open this`;

  return `<button class="primary" data-share-banner data-open-share>Share</button>
    <section class="panel" data-share-panel hidden aria-label="Sharing">
      <h2>Who can open this</h2>
      <p class="hint" data-share-summary>${esc(summary)}</p>
      <div data-share-list></div>
      <form class="add" data-share-add>
        <input type="email" name="email" placeholder="name@example.com" aria-label="Email address">
        <button type="submit">Add</button>
      </form>
      <hr class="sep">
      <h2>Or share a link</h2>
      <p class="hint">Anyone with the link can open this — no sign-in. Revoke it any time.</p>
      <div class="add">
        <button type="button" data-make-link>Create share link</button>
      </div>
      <div data-link-list></div>
    </section>`;
}

/**
 * The frame's sandbox, or null to omit the attribute entirely.
 *
 * `allow-scripts` with `allow-same-origin` is the pair that defeats a sandbox —
 * framed content can reach its own frame element and strip the attribute. So
 * HTML artifacts, which are attacker-controlled and need scripts, never get
 * same-origin. That is what stops an artifact reading cookies or touching the
 * shell, and it must not be relaxed.
 *
 * PDFs get no sandbox at all, and this was established by experiment rather
 * than assumption: Chrome refuses to instantiate its PDF viewer inside a
 * sandboxed frame under ANY combination of flags, rendering a broken-document
 * icon with no console error and no failed request. Only removing the attribute
 * works.
 *
 * That is acceptable here for one reason: no attacker-controlled document can
 * occupy that URL. `singlePdf` verifies the leading %PDF bytes at publish, and
 * the response is served `application/pdf` with `nosniff`, so the browser
 * cannot be talked into treating it as HTML. Both layers must hold. If either
 * is ever removed, PDFs must stop being framed this way.
 */
function sandboxFor(i: ShellInput): string | null {
  return i.isDocument
    ? null
    : "allow-scripts allow-forms allow-popups allow-downloads allow-modals";
}

export function shellPage(i: ShellInput): string {
  // An empty filePath means "the artifact itself", which is its entry — not
  // necessarily index.html.
  const target = i.filePath || (i.entry && i.entry !== "index.html" ? i.entry : "");
  const src = `/${encodeURIComponent(i.slug)}/${target}${target.includes("?") ? "&" : "?"}raw=1`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(i.title)} · rtfx.pro</title>
<style>${SHELL_STYLE}</style>
</head><body>
<button class="peek" data-show-bar hidden aria-label="Show toolbar">rtfx.pro</button>
<div class="bar" data-bar>
  <a class="mark" href="/">rtfx<span>.</span>pro</a>
  <span class="title">${esc(i.title)}</span>
  <span class="ver">v${i.version}</span>
  <span class="spacer"></span>
  <button data-copy-link>Copy link</button>
  ${banner(i)}
  <button data-hide-bar aria-label="Hide toolbar" title="Hide toolbar">&times;</button>
</div>
<iframe class="frame" title="${esc(i.title)}"
  ${sandboxFor(i) === null ? "" : `sandbox="${sandboxFor(i)}"`}
  src="${esc(src)}"></iframe>
<script>${SHELL_SCRIPT}</script>
</body></html>`;
}

const SHELL_SCRIPT = `(function(){
  /* --- chrome: hide by hand, or get out of the way while reading ---------- */
  var bar=document.querySelector('[data-bar]');
  var peek=document.querySelector('[data-show-bar]');
  var hide=document.querySelector('[data-hide-bar]');
  var pinnedHidden=false;

  try{ pinnedHidden = localStorage.getItem('rtfx.bar')==='hidden'; }catch(e){}

  function measure(){
    if(!bar.hasAttribute('data-collapsed'))
      document.documentElement.style.setProperty('--bar-h', bar.offsetHeight+'px');
  }
  function collapse(on){
    if(on){ bar.setAttribute('data-collapsed',''); peek.hidden=false; }
    else { bar.removeAttribute('data-collapsed'); peek.hidden=true; }
  }
  measure(); addEventListener('resize',measure);
  if(pinnedHidden) collapse(true);

  if(hide) hide.addEventListener('click',function(){
    pinnedHidden=true; collapse(true);
    try{ localStorage.setItem('rtfx.bar','hidden'); }catch(e){}
  });
  if(peek) peek.addEventListener('click',function(){
    pinnedHidden=false; collapse(false);
    try{ localStorage.removeItem('rtfx.bar'); }catch(e){}
  });

  /* The frame is cross-origin, so it tells us where it is rather than us
     reading it. Down hides, up reveals — the message is cosmetic only. */
  var lastY=0;
  addEventListener('message',function(ev){
    var d=ev.data;
    if(!d||d.type!=='rtfx:scroll'||typeof d.y!=='number') return;
    if(pinnedHidden) return;
    var dy=d.y-lastY; lastY=d.y;
    if(d.y<40){ collapse(false); return; }
    if(dy>6) collapse(true);
    else if(dy<-6) collapse(false);
  });

  var copy=document.querySelector('[data-copy-link]');
  if(copy){copy.addEventListener('click',function(){
    var url=location.origin+location.pathname;
    navigator.clipboard.writeText(url).then(function(){
      var t=copy.textContent; copy.textContent='Copied';
      setTimeout(function(){copy.textContent=t;},1400);
    });
  });}

  var open=document.querySelector('[data-open-share]');
  var panel=document.querySelector('[data-share-panel]');
  if(!open||!panel) return;

  var slug=location.pathname.split('/').filter(Boolean)[0];
  var list=panel.querySelector('[data-share-list]');

  function render(emails){
    list.innerHTML='';
    if(!emails.length){
      var p=document.createElement('p');
      p.className='hint'; p.textContent='Nobody is named yet.';
      list.appendChild(p); return;
    }
    emails.forEach(function(e){
      var row=document.createElement('div'); row.className='row';
      var who=document.createElement('span'); who.className='who'; who.textContent=e;
      var rm=document.createElement('button'); rm.type='button'; rm.textContent='Remove';
      rm.addEventListener('click',function(){ save(emails.filter(function(x){return x!==e;})); });
      row.appendChild(who); row.appendChild(rm); list.appendChild(row);
    });
  }

  function save(emails){
    fetch('/api/artifacts/'+encodeURIComponent(slug)+'/access',{
      method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({visibility:'restricted',emails:emails})
    }).then(function(r){return r.ok?r.json():null;}).then(function(j){
      if(j)render(j.emails||[]);
    });
  }

  open.addEventListener('click',function(){
    panel.hidden=!panel.hidden;
    if(!panel.hidden){
      fetch('/api/artifacts/'+encodeURIComponent(slug)+'/access')
        .then(function(r){return r.ok?r.json():null;})
        .then(function(j){ if(j)render(j.emails||[]); });
    }
  });

  var mk=panel.querySelector('[data-make-link]');
  var linkList=panel.querySelector('[data-link-list]');

  /* The key comes back exactly once — it is hashed on the server and cannot be
     shown again — so it goes straight to the clipboard and is never re-fetched. */
  if(mk) mk.addEventListener('click',function(){
    mk.disabled=true; mk.textContent='Creating\u2026';
    fetch('/api/artifacts/'+encodeURIComponent(slug)+'/links',{
      method:'POST',headers:{'Content-Type':'application/json'},body:'{}'
    }).then(function(r){return r.ok?r.json():null;}).then(function(j){
      mk.disabled=false; mk.textContent='Create share link';
      if(!j) return;
      navigator.clipboard.writeText(j.url).catch(function(){});
      var row=document.createElement('div'); row.className='link-row';
      var c=document.createElement('code'); c.textContent=j.url;
      var copied=document.createElement('span'); copied.textContent='Copied';
      var rev=document.createElement('button'); rev.type='button'; rev.textContent='Revoke';
      rev.addEventListener('click',function(){
        fetch('/api/artifacts/'+encodeURIComponent(slug)+'/links/'+encodeURIComponent(j.id),
          {method:'DELETE'}).then(function(){ row.remove(); });
      });
      row.appendChild(c); row.appendChild(copied); row.appendChild(rev);
      linkList.appendChild(row);
    }).catch(function(){ mk.disabled=false; mk.textContent='Create share link'; });
  });

  panel.querySelector('[data-share-add]').addEventListener('submit',function(e){
    e.preventDefault();
    var input=e.target.elements.email, v=input.value.trim().toLowerCase();
    if(!v||v.indexOf('@')===-1) return;
    var current=[].map.call(list.querySelectorAll('.who'),function(n){return n.textContent;});
    if(current.indexOf(v)===-1) current.push(v);
    input.value=''; save(current);
  });
})();`;
