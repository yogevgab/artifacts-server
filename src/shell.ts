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
  --sh-rule:#D3D7E4;--sh-accent:#2438C8;--sh-surface:#FFFFFF;--sh-danger:#B3261E}
@media(prefers-color-scheme:dark){:root{--sh-bg:#0D1020;--sh-fg:#E7E9F3;--sh-muted:#9AA1BC;
  --sh-rule:#2B3252;--sh-accent:#8C9BFF;--sh-surface:#161A2E;--sh-danger:#FF6B6B}}
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
.add select{padding:6px 9px;border:1px solid var(--sh-rule);border-radius:6px;
  background:transparent;color:var(--sh-fg);font:inherit;font-size:13px}
.add input[type=number]{flex:0 0 64px}
.sep{border:0;border-top:1px solid var(--sh-rule);margin:14px 0 10px}
.link-row{display:flex;gap:8px;align-items:center;padding:6px 0;font-size:12px}
.link-row code{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--sh-muted)}
.link-row .exp{flex:none;color:var(--sh-muted);white-space:nowrap}
.link-row .exp.expired{color:var(--sh-danger);font-weight:600}
.chat{position:fixed;right:14px;bottom:0;width:min(340px,calc(100% - 28px));display:flex;
  flex-direction:column;max-height:60vh;background:var(--sh-surface);border:1px solid var(--sh-rule);
  border-bottom:0;border-radius:10px 10px 0 0;box-shadow:0 -6px 30px rgba(0,0,0,.18);z-index:4}
.chat[hidden]{display:none}
.chat-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--sh-rule)}
.chat-head b{font-size:13px;flex:1}
.chat-log{flex:1 1 auto;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:9px}
.msg{display:flex;flex-direction:column;gap:2px}
.msg .who{font-size:11px;color:var(--sh-muted)}
.msg .who b{color:var(--sh-fg);font-weight:600}
.msg .body{font-size:13.5px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
.chat-form{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--sh-rule)}
.chat-form input{flex:1;padding:7px 9px;border:1px solid var(--sh-rule);border-radius:6px;
  background:transparent;color:var(--sh-fg);font:inherit;font-size:13px}
.chat-empty{color:var(--sh-muted);font-size:12.5px}
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
        <select data-link-expiry aria-label="Link expiry">
          <option value="">Never expires</option>
          <option value="7">Expires in 7 days</option>
          <option value="30">Expires in 30 days</option>
          <option value="custom">Custom…</option>
        </select>
        <input type="number" min="1" max="365" data-link-days hidden aria-label="Days until the link expires" placeholder="Days">
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
  <button data-open-chat aria-expanded="false">Chat</button>
  <button data-copy-link>Copy link</button>
  ${banner(i)}
  <button data-hide-bar aria-label="Hide toolbar" title="Hide toolbar">&times;</button>
</div>
<section class="chat" data-chat hidden aria-label="Conversation">
  <div class="chat-head">
    <b>Conversation</b>
    <button type="button" data-close-chat aria-label="Close conversation">&times;</button>
  </div>
  <div class="chat-log" data-chat-log role="log" aria-live="polite"></div>
  <form class="chat-form" data-chat-form>
    <input name="body" placeholder="Say something…" autocomplete="off" aria-label="Message">
    <button type="submit">Send</button>
  </form>
</section>
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

  /* --- chat ---------------------------------------------------------------
     The socket lives on this origin (/_chat/<slug>) because the app origin's
     session cookie is host-only: a cross-origin socket would arrive with no
     credential at all. Authorization happens in the Worker before the socket
     is handed to the room. */
  var chat=document.querySelector('[data-chat]');
  var chatBtn=document.querySelector('[data-open-chat]');
  var log=document.querySelector('[data-chat-log]');
  var slugForChat=location.pathname.split('/').filter(Boolean)[0];
  var sock=null;

  function stamp(m){
    var el=document.createElement('div'); el.className='msg';
    var who=document.createElement('span'); who.className='who';
    var name=document.createElement('b');
    name.textContent=m.author_email||(m.author_kind==='link'?'Someone with the link':'Signed out');
    who.appendChild(name);
    who.appendChild(document.createTextNode(' \u00b7 v'+m.version));
    var body=document.createElement('div'); body.className='body'; body.textContent=m.body;
    el.appendChild(who); el.appendChild(body); log.appendChild(el);
    log.scrollTop=log.scrollHeight;
  }
  function empty(text){
    log.innerHTML=''; var p=document.createElement('p');
    p.className='chat-empty'; p.textContent=text; log.appendChild(p);
  }

  function connect(){
    if(sock) return;
    var proto=location.protocol==='https:'?'wss://':'ws://';
    try{ sock=new WebSocket(proto+location.host+'/_chat/'+encodeURIComponent(slugForChat)); }
    catch(e){ empty('Chat is unavailable here.'); return; }
    sock.addEventListener('message',function(ev){
      var d; try{ d=JSON.parse(ev.data); }catch(e){ return; }
      if(d.type==='history'){
        if(!d.messages.length){ empty('No messages yet. Say the first thing.'); return; }
        log.innerHTML=''; d.messages.forEach(stamp);
      } else if(d.type==='message'){
        if(log.querySelector('.chat-empty')) log.innerHTML='';
        stamp(d.message);
      }
    });
    sock.addEventListener('close',function(){ sock=null; });
    sock.addEventListener('error',function(){ empty('Lost the connection. Reopen to retry.'); });
  }

  if(chatBtn) chatBtn.addEventListener('click',function(){
    var open=chat.hidden;
    chat.hidden=!open;
    chatBtn.setAttribute('aria-expanded',String(open));
    if(open){ empty('Connecting\u2026'); connect(); }
  });
  var closeChat=document.querySelector('[data-close-chat]');
  if(closeChat) closeChat.addEventListener('click',function(){
    chat.hidden=true; chatBtn.setAttribute('aria-expanded','false');
  });

  var chatForm=document.querySelector('[data-chat-form]');
  if(chatForm) chatForm.addEventListener('submit',function(ev){
    ev.preventDefault();
    var input=chatForm.elements.body, text=input.value.trim();
    if(!text||!sock||sock.readyState!==1) return;
    sock.send(JSON.stringify({type:'post',body:text}));
    input.value='';
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

  var mk=panel.querySelector('[data-make-link]');
  var linkList=panel.querySelector('[data-link-list]');
  var expirySelect=panel.querySelector('[data-link-expiry]');
  var daysInput=panel.querySelector('[data-link-days]');

  if(expirySelect&&daysInput) expirySelect.addEventListener('change',function(){
    daysInput.hidden = expirySelect.value!=='custom';
    if(!daysInput.hidden) daysInput.focus();
  });

  function selectedExpiryDays(){
    if(!expirySelect) return null;
    var v=expirySelect.value;
    if(!v) return null;
    if(v==='custom'){
      var n=parseInt(daysInput.value,10);
      return (n>=1&&n<=365) ? n : NaN;
    }
    return parseInt(v,10);
  }

  function describeExpiry(expiresAt){
    if(!expiresAt) return {text:'Never expires',expired:false};
    var t=Date.parse(expiresAt);
    if(isNaN(t)) return {text:'Never expires',expired:false};
    var ds=new Date(t).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
    return t<=Date.now() ? {text:'Expired '+ds,expired:true} : {text:'Expires '+ds,expired:false};
  }

  function linkRow(id,url,expiresAt){
    var row=document.createElement('div'); row.className='link-row';
    var c=document.createElement('code'); c.textContent=url||'Share link';
    var exp=describeExpiry(expiresAt);
    var expEl=document.createElement('span'); expEl.className='exp'+(exp.expired?' expired':'');
    expEl.textContent=exp.text;
    var rev=document.createElement('button'); rev.type='button'; rev.textContent='Revoke';
    rev.addEventListener('click',function(){
      fetch('/api/artifacts/'+encodeURIComponent(slug)+'/links/'+encodeURIComponent(id),
        {method:'DELETE'}).then(function(){ row.remove(); });
    });
    row.appendChild(c); row.appendChild(expEl); row.appendChild(rev);
    return row;
  }

  open.addEventListener('click',function(){
    panel.hidden=!panel.hidden;
    if(!panel.hidden){
      fetch('/api/artifacts/'+encodeURIComponent(slug)+'/access')
        .then(function(r){return r.ok?r.json():null;})
        .then(function(j){ if(j)render(j.emails||[]); });
      fetch('/api/artifacts/'+encodeURIComponent(slug)+'/links')
        .then(function(r){return r.ok?r.json():null;})
        .then(function(j){
          linkList.innerHTML='';
          if(!j||!j.links) return;
          j.links.filter(function(l){return !l.revokedAt;}).forEach(function(l){
            linkList.appendChild(linkRow(l.id,null,l.expiresAt));
          });
        });
    }
  });

  /* The key comes back exactly once — it is hashed on the server and cannot be
     shown again — so it goes straight to the clipboard and is never re-fetched. */
  if(mk) mk.addEventListener('click',function(){
    var days=selectedExpiryDays();
    if(days!==null&&isNaN(days)){ daysInput.focus(); return; }
    mk.disabled=true; mk.textContent='Creating\u2026';
    fetch('/api/artifacts/'+encodeURIComponent(slug)+'/links',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(days?{expires_in_days:days}:{})
    }).then(function(r){return r.ok?r.json():null;}).then(function(j){
      if(!j){ mk.disabled=false; mk.textContent='Create share link'; return; }
      navigator.clipboard.writeText(j.url).catch(function(){});
      linkList.appendChild(linkRow(j.id,j.url,j.expires_at));
      mk.disabled=false; mk.textContent='Copied!';
      setTimeout(function(){ mk.textContent='Create share link'; },1400);
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
