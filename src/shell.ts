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

/**
 * Layering, once, so nothing has to guess:
 *
 *   frame 0 · scrim 35 · chat 40 · bar 45 (and the share popover inside it) · peek 50
 *
 * The bar outranks the chat deliberately. The share popover is a *child* of the
 * bar so it can be anchored to the Share button, which means the bar's z-index
 * is also the popover's — put the bar below the chat and the popover disappears
 * behind the drawer.
 */
const SHELL_STYLE = `
:root{color-scheme:light dark;
  --sh-bg:#F2F3F7;--sh-fg:#14182B;--sh-muted:#565D78;--sh-rule:#D7DAE6;
  --sh-accent:#2438C8;--sh-accent-fg:#FFFFFF;--sh-surface:#FFFFFF;--sh-danger:#B3261E;
  --sh-glass:rgba(255,255,255,.86);--sh-hover:rgba(20,24,43,.055);--sh-press:rgba(20,24,43,.1);
  --sh-scrim:rgba(14,17,32,.36);
  --sh-shadow:0 20px 48px rgba(16,20,40,.16),0 2px 6px rgba(16,20,40,.06);
  --sh-r:16px;--sh-r-sm:10px}
@media(prefers-color-scheme:dark){:root{
  --sh-bg:#0D1020;--sh-fg:#E7E9F3;--sh-muted:#9AA1BC;--sh-rule:#2E3556;
  --sh-accent:#8C9BFF;--sh-accent-fg:#101427;--sh-surface:#161A2E;--sh-danger:#FF6B6B;
  --sh-glass:rgba(22,26,46,.86);--sh-hover:rgba(255,255,255,.07);--sh-press:rgba(255,255,255,.13);
  --sh-scrim:rgba(4,6,14,.5);
  --sh-shadow:0 20px 52px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.35)}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--sh-bg);color:var(--sh-fg);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  display:flex;flex-direction:column;-webkit-font-smoothing:antialiased}

/* --- controls, shared by the bar and both panels ------------------------- */
.btn{font:inherit;font-size:13px;line-height:1.2;padding:7px 12px;border-radius:999px;
  border:1px solid var(--sh-rule);background:transparent;color:var(--sh-fg);cursor:pointer;
  white-space:nowrap;transition:background .15s ease,border-color .15s ease,opacity .15s ease}
.btn:hover{background:var(--sh-hover)}
.btn:active{background:var(--sh-press)}
.btn[disabled]{opacity:.55;cursor:default}
.btn.quiet{border-color:transparent}
.btn.quiet[aria-expanded=true]{background:var(--sh-press)}
.btn.sm{font-size:12px;padding:4px 10px}
.btn.primary{border-color:var(--sh-accent);background:var(--sh-accent);color:var(--sh-accent-fg);
  font-weight:590}
.btn.primary:hover{background:var(--sh-accent);filter:brightness(1.07)}
.btn.icon{width:28px;height:28px;padding:0;border-color:transparent;color:var(--sh-muted);
  display:inline-flex;align-items:center;justify-content:center;font-size:17px;line-height:1}
.btn.icon:hover{color:var(--sh-fg);background:var(--sh-hover)}
.field{font:inherit;font-size:13px;padding:7px 11px;min-width:0;color:var(--sh-fg);
  border:1px solid var(--sh-rule);border-radius:var(--sh-r-sm);background:var(--sh-surface)}
.field::placeholder{color:var(--sh-muted)}
.field:hover{border-color:var(--sh-muted)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,
[tabindex]:focus-visible{outline:2px solid var(--sh-accent);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.bar,.btn,.peek,.field{transition:none}}

/* --- the toolbar ---------------------------------------------------------
   One row, always. It shrinks the title rather than wrapping, because a bar
   that reflows to two rows changes --bar-h under the collapse animation. */
.bar{position:relative;z-index:45;flex:none;display:flex;align-items:center;gap:10px;
  flex-wrap:nowrap;min-height:48px;padding:0 10px 0 14px;
  background:var(--sh-surface);border-bottom:1px solid var(--sh-rule);
  box-shadow:0 1px 2px rgba(16,20,40,.04);transition:margin-top .18s ease}
.bar[data-collapsed]{margin-top:calc(-1 * var(--bar-h,48px))}
.bar .mark{flex:none;font-weight:600;letter-spacing:-.02em;font-size:14px;
  text-decoration:none;color:var(--sh-fg);opacity:.82;transition:opacity .15s ease}
.bar .mark:hover{opacity:1}
.bar .mark .dot{color:var(--sh-accent)}
.bar .rule{flex:none;width:1px;height:18px;background:var(--sh-rule)}
.bar .title{flex:0 1 auto;min-width:0;font-weight:590;letter-spacing:-.01em;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar .ver{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;
  color:var(--sh-muted);border:1px solid var(--sh-rule);border-radius:999px;padding:1px 7px}
.bar .spacer{flex:1 1 auto;min-width:8px}
.actions{flex:none;display:flex;align-items:center;gap:6px}
/* The peek tab is the only way back once the bar is hidden, so it is always
   reachable and never covers content it would obscure. */
.peek{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:50;
  display:inline-flex;align-items:center;gap:6px;
  border:1px solid var(--sh-rule);border-top:0;border-radius:0 0 12px 12px;
  background:var(--sh-glass);-webkit-backdrop-filter:saturate(180%) blur(20px);
  backdrop-filter:saturate(180%) blur(20px);color:var(--sh-muted);font:inherit;font-size:11px;
  letter-spacing:.06em;text-transform:uppercase;padding:4px 12px 5px;cursor:pointer;
  box-shadow:0 6px 18px rgba(16,20,40,.1);transition:color .15s ease}
.peek:hover{color:var(--sh-fg)}
.peek[hidden]{display:none}
.frame{flex:1 1 auto;width:100%;border:0;display:block;background:var(--sh-surface)}

/* --- the scrim, mobile only ----------------------------------------------
   On a wide screen the popover and the drawer sit in their own corners and
   dimming the artifact behind them would be theatre. On a phone they cover it,
   so the scrim is what makes "tap outside to dismiss" discoverable. */
.scrim{position:fixed;inset:0;z-index:35;display:none;background:var(--sh-scrim);
  -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}

/* --- the share popover ---------------------------------------------------
   Anchored under the Share button rather than pinned to a screen corner, so
   the panel reads as belonging to the control that opened it. */
.share{position:relative;align-self:stretch;display:flex;align-items:center}
.panel{position:absolute;top:calc(100% + 6px);right:0;
  width:min(384px,calc(100vw - 24px));max-height:min(70vh,560px);
  overflow:auto;overscroll-behavior:contain;
  background:var(--sh-glass);-webkit-backdrop-filter:saturate(180%) blur(24px);
  backdrop-filter:saturate(180%) blur(24px);
  border:1px solid var(--sh-rule);border-radius:var(--sh-r);box-shadow:var(--sh-shadow);
  padding:14px 16px 16px}
.panel[hidden]{display:none}
.panel-head{display:flex;align-items:center;gap:8px;margin:0 0 10px}
.panel-head h2{flex:1;margin:0;font-size:14px;font-weight:640;letter-spacing:-.01em}
.panel h3{margin:0 0 5px;font-size:11px;font-weight:640;letter-spacing:.05em;
  text-transform:uppercase;color:var(--sh-muted)}
.panel .hint{color:var(--sh-muted);font-size:12.5px;line-height:1.45;margin:0 0 10px}
.row{display:flex;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid var(--sh-rule)}
.row:last-child{border-bottom:0}
.row .who{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.add{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.add .field{flex:1 1 150px}
.add input[type=number]{flex:0 0 82px}
.sep{border:0;border-top:1px solid var(--sh-rule);margin:16px 0 12px}
.link-row{display:flex;gap:8px;align-items:center;padding:7px 0;font-size:12px;
  border-bottom:1px solid var(--sh-rule)}
.link-row:last-child{border-bottom:0}
.link-row code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--sh-muted)}
.link-row .exp{flex:none;color:var(--sh-muted);white-space:nowrap}
.link-row .exp.expired{color:var(--sh-danger);font-weight:600}

/* --- the chat drawer -----------------------------------------------------
   A floating card in the bottom-right corner, clear of the toolbar and clear
   of the share popover, with head / log / composer as three fixed bands. */
.chat{position:fixed;right:16px;bottom:16px;z-index:40;
  width:min(376px,calc(100vw - 32px));
  height:min(540px,calc(100vh - var(--bar-h,48px) - 44px));
  display:flex;flex-direction:column;overflow:hidden;
  background:var(--sh-glass);-webkit-backdrop-filter:saturate(180%) blur(24px);
  backdrop-filter:saturate(180%) blur(24px);
  border:1px solid var(--sh-rule);border-radius:var(--sh-r);box-shadow:var(--sh-shadow)}
.chat[hidden]{display:none}
.chat-head{flex:none;display:flex;align-items:flex-start;gap:8px;
  padding:10px 10px 10px 14px;border-bottom:1px solid var(--sh-rule)}
.chat-title{flex:1;min-width:0;display:flex;flex-direction:column}
.chat-title b{font-size:13px;font-weight:640;letter-spacing:-.01em}
.chat-title .sub{font-size:11.5px;line-height:1.35;color:var(--sh-muted)}
.chat-log{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;
  padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.msg{display:flex;flex-direction:column;gap:3px;align-items:flex-start}
.msg .who{font-size:11px;color:var(--sh-muted);padding:0 2px}
.msg .who b{color:var(--sh-fg);font-weight:600}
.msg .body{font-size:13.5px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;
  max-width:100%;background:var(--sh-hover);border-radius:12px;padding:7px 10px}
.chat-form{flex:none;display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--sh-rule)}
.chat-form .field{flex:1;border-radius:999px}
.chat-empty{color:var(--sh-muted);font-size:12.5px;margin:0;padding:2px}

/* --- phones: both panels become bottom sheets ---------------------------
   A 384px popover anchored to a button has nowhere to go at 360px wide, and
   two floating cards in the same corner would sit on top of each other. */
.grip{display:none}
@media(max-width:640px){
  .bar{gap:8px;padding:0 8px 0 12px}
  .bar .ver,.bar .rule,.wide{display:none}
  .scrim:not([hidden]){display:block}
  .grip{display:block;flex:none;width:36px;height:4px;border-radius:999px;
    background:var(--sh-rule);margin:0 auto 10px}
  .panel{position:fixed;top:auto;inset:auto 0 0 0;width:auto;
    max-height:min(78vh,calc(100vh - 56px));
    border-radius:20px 20px 0 0;border-bottom:0;
    padding:12px 16px calc(16px + env(safe-area-inset-bottom,0px))}
  .chat{inset:auto 0 0 0;width:auto;height:min(72vh,calc(100vh - 56px));
    border-radius:20px 20px 0 0;border-bottom:0}
  .chat .grip{margin:8px auto 0}
  .chat-form{padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))}
}
`;

/**
 * The two chevrons that pair the hide control with the peek tab: the bar folds
 * up and comes back down. Both are decorative — the accessible name is on the
 * button, so the glyph is `aria-hidden` and carries no text of its own.
 */
const chevron = (d: string) =>
  `<svg class="chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">` +
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" ` +
  `stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHEVRON_UP = chevron("M2.5 7.5 6 4l3.5 3.5");
const CHEVRON_DOWN = chevron("M2.5 4.5 6 8l3.5-3.5");

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

  return `<div class="share" data-share>
      <button type="button" class="btn primary" data-share-banner data-open-share
        aria-haspopup="dialog" aria-expanded="false" aria-controls="rtfx-share">Share</button>
      <section class="panel" id="rtfx-share" data-share-panel hidden tabindex="-1"
        role="dialog" aria-label="Sharing">
        <span class="grip" aria-hidden="true"></span>
        <div class="panel-head">
          <h2>Share</h2>
          <button type="button" class="btn icon" data-close-share aria-label="Close sharing">&times;</button>
        </div>
        <h3>Who can open this</h3>
        <p class="hint" data-share-summary>${esc(summary)}</p>
        <div class="list" data-share-list></div>
        <form class="add" data-share-add>
          <input class="field" type="email" name="email" placeholder="name@example.com" aria-label="Email address">
          <button type="submit" class="btn">Add</button>
        </form>
        <hr class="sep">
        <h3>Or share a link</h3>
        <p class="hint">Anyone with the link can open this — no sign-in. Revoke it any time.</p>
        <div class="add">
          <select class="field" data-link-expiry aria-label="Link expiry">
            <option value="">Never expires</option>
            <option value="7">Expires in 7 days</option>
            <option value="30">Expires in 30 days</option>
            <option value="custom">Custom…</option>
          </select>
          <input class="field" type="number" min="1" max="365" data-link-days hidden aria-label="Days until the link expires" placeholder="Days">
          <button type="button" class="btn" data-make-link>Create share link</button>
        </div>
        <div class="list" data-link-list></div>
      </section>
    </div>`;
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
<button class="peek" data-show-bar hidden aria-label="Show toolbar">${CHEVRON_DOWN}rtfx.pro</button>
<header class="bar" data-bar>
  <a class="mark" href="/" aria-label="rtfx.pro home">rtfx<span class="dot">.</span>pro</a>
  <span class="rule" aria-hidden="true"></span>
  <span class="title" title="${esc(i.title)}">${esc(i.title)}</span>
  <span class="ver">v${i.version}</span>
  <span class="spacer"></span>
  <div class="actions" data-actions>
    <button type="button" class="btn quiet" data-open-chat
      aria-expanded="false" aria-controls="rtfx-chat">Chat</button>
    <button type="button" class="btn quiet" data-copy-link>Copy<span class="wide"> link</span></button>
    ${banner(i)}
    <button type="button" class="btn icon" data-hide-bar
      aria-label="Hide toolbar" title="Hide toolbar">${CHEVRON_UP}</button>
  </div>
</header>
<div class="scrim" data-scrim hidden></div>
<section class="chat" id="rtfx-chat" data-chat hidden role="dialog" aria-label="Conversation">
  <span class="grip" aria-hidden="true"></span>
  <header class="chat-head">
    <span class="chat-title">
      <b>Conversation</b>
      <span class="sub">Everyone who can open this artifact</span>
    </span>
    <button type="button" class="btn icon" data-close-chat aria-label="Close conversation">&times;</button>
  </header>
  <div class="chat-log" data-chat-log role="log" aria-live="polite" tabindex="0"></div>
  <form class="chat-form" data-chat-form>
    <input class="field" name="body" placeholder="Say something…" autocomplete="off" aria-label="Message">
    <button type="submit" class="btn primary">Send</button>
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
  var scrim=document.querySelector('[data-scrim]');
  var chat=document.querySelector('[data-chat]');
  var chatBtn=document.querySelector('[data-open-chat]');
  var panel=document.querySelector('[data-share-panel]');
  var shareBtn=document.querySelector('[data-open-share]');
  var pinnedHidden=false;

  /* --- one panel at a time -------------------------------------------------
     On a wide screen the popover and the drawer have their own corners, but on
     a phone both are the same bottom sheet. Rather than have them fight, only
     one is ever open — which also keeps the scrim's meaning unambiguous. */
  function syncScrim(){
    if(scrim) scrim.hidden = !((chat&&!chat.hidden)||(panel&&!panel.hidden));
  }
  function closeShare(){
    if(!panel||panel.hidden) return;
    panel.hidden=true;
    if(shareBtn) shareBtn.setAttribute('aria-expanded','false');
    syncScrim();
  }
  function closeChat(){
    if(!chat||chat.hidden) return;
    chat.hidden=true;
    if(chatBtn) chatBtn.setAttribute('aria-expanded','false');
    syncScrim();
  }

  addEventListener('keydown',function(ev){
    if(ev.key!=='Escape') return;
    if(panel&&!panel.hidden){ closeShare(); if(shareBtn) shareBtn.focus(); return; }
    if(chat&&!chat.hidden){ closeChat(); if(chatBtn) chatBtn.focus(); }
  });
  if(scrim) scrim.addEventListener('click',function(){ closeShare(); closeChat(); });

  try{ pinnedHidden = localStorage.getItem('rtfx.bar')==='hidden'; }catch(e){}

  function measure(){
    if(!bar.hasAttribute('data-collapsed'))
      document.documentElement.style.setProperty('--bar-h', bar.offsetHeight+'px');
  }
  function collapse(on){
    /* The popover hangs off the bar, so it has to go when the bar does. The
       chat is anchored to the viewport and deliberately survives — reading is
       the reason the bar hides, and closing a conversation mid-scroll would
       throw away what somebody was typing. */
    if(on){ bar.setAttribute('data-collapsed',''); peek.hidden=false; closeShare(); }
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
    if(!chat.hidden){ closeChat(); return; }
    closeShare();
    chat.hidden=false;
    chatBtn.setAttribute('aria-expanded','true');
    syncScrim();
    /* Reopening a drawer whose socket is still live must not wipe the log back
       to "Connecting\u2026" \u2014 the socket would never re-send its history. */
    if(!sock){ empty('Connecting\u2026'); connect(); }
    var field=chat.querySelector('[data-chat-form] input');
    if(field) field.focus();
  });
  var closeChatBtn=document.querySelector('[data-close-chat]');
  if(closeChatBtn) closeChatBtn.addEventListener('click',function(){
    closeChat(); if(chatBtn) chatBtn.focus();
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
  if(copy){
    /* The label carries a span the narrow layout hides, so it is restored as
       markup — writing textContent back would flatten it after one copy. */
    var copyLabel=copy.innerHTML;
    copy.addEventListener('click',function(){
      var url=location.origin+location.pathname;
      navigator.clipboard.writeText(url).then(function(){
        copy.textContent='Copied';
        setTimeout(function(){copy.innerHTML=copyLabel;},1400);
      });
    });
  }

  if(!shareBtn||!panel) return;

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
      var rm=document.createElement('button');
      rm.type='button'; rm.className='btn sm'; rm.textContent='Remove';
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
    var rev=document.createElement('button');
    rev.type='button'; rev.className='btn sm'; rev.textContent='Revoke';
    rev.addEventListener('click',function(){
      fetch('/api/artifacts/'+encodeURIComponent(slug)+'/links/'+encodeURIComponent(id),
        {method:'DELETE'}).then(function(){ row.remove(); });
    });
    row.appendChild(c); row.appendChild(expEl); row.appendChild(rev);
    return row;
  }

  var closeShareBtn=panel.querySelector('[data-close-share]');
  if(closeShareBtn) closeShareBtn.addEventListener('click',function(){
    closeShare(); shareBtn.focus();
  });

  shareBtn.addEventListener('click',function(){
    if(!panel.hidden){ closeShare(); return; }
    closeChat();
    panel.hidden=false;
    shareBtn.setAttribute('aria-expanded','true');
    syncScrim();
    panel.focus();
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
