/**
 * The page behind `GET /u/<token>` — where a non-technical person drops the
 * site Claude asked them to upload.
 *
 * Plain language throughout, one decision on the screen (put the files here),
 * and every failure explained in terms of what to do next. The token is in the
 * URL, so the page ships with `Referrer-Policy: no-referrer` and `no-store`
 * (set by the route) and the unknown/expired/used pages reveal nothing about the
 * destination.
 *
 * The inline script is allowed: the app has no page CSP, and this is the same
 * pattern the "ask for access" form on `notFoundPage` uses.
 */

import { layout, esc, BRAND_STYLE, brandLockup, skipLink } from "./pages";
import { MAX_UPLOAD_BYTES } from "./upload";

const STYLE = `${BRAND_STYLE}
.up-wrap{max-width:40rem;margin:0 auto}
.up-wrap header.top{margin-bottom:1.4rem}
.up-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
  box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);padding:2rem 1.7rem}
.up-card h1{font-size:clamp(1.55rem,4vw,2.1rem);margin:0 0 .55rem}
.up-card .lede{color:var(--muted);margin:0 0 1.2rem}
.up-meta{display:grid;grid-template-columns:auto 1fr;gap:.3rem .9rem;margin:0 0 1.4rem;font-size:.92rem}
.up-meta dt{color:var(--muted)}.up-meta dd{margin:0;word-break:break-all}
.drop{border:2px dashed var(--border-strong);border-radius:var(--radius);padding:2.4rem 1.2rem;text-align:center;
  background:rgba(255,255,255,.03);transition:border-color .15s,background .15s}
.drop.is-over{border-color:var(--accent);background:var(--accent-weak)}
.drop .big{font-size:1.25rem;font-weight:650;letter-spacing:-.02em;margin:0 0 .3rem}
.drop .small{color:var(--muted);margin:0 0 1.2rem;font-size:.95rem}
.drop .pick{display:flex;gap:.6rem;justify-content:center;flex-wrap:wrap}
.up-selected{margin:1rem 0 0;padding:.8rem 1rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:.95rem}
.up-selected b{font-weight:650}
.up-actions{margin-top:1.2rem;display:flex;gap:.7rem;align-items:center;flex-wrap:wrap}
.up-actions button.go{padding:.9rem 1.6rem;font-size:1.05rem}
.up-bar{height:.75rem;border-radius:999px;background:var(--border);overflow:hidden;margin-top:1.2rem}
.up-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width .2s}
#up-msg{margin-top:1rem;padding:.75rem .9rem;border-radius:var(--radius-sm);font-size:.95rem;border:1px solid transparent}
#up-msg.is-error{color:var(--danger);border-color:var(--danger);background:var(--danger-weak)}
#up-msg.is-info{color:var(--muted);border-color:var(--border)}
.up-done{text-align:center}
.up-done h1{margin-bottom:.6rem}
.up-done a.open{display:inline-flex;align-items:center;justify-content:center;margin:1.2rem 0 .6rem;
  padding:1rem 2.2rem;font-size:1.15rem;font-weight:700;border-radius:999px;color:#fff;text-decoration:none;
  background:linear-gradient(180deg,var(--accent),#006edb);box-shadow:0 14px 34px -22px rgba(10,132,255,.95)}
.up-done a.open:hover{color:#fff;opacity:.96}
.up-gone{text-align:center}
.up-gone h1{font-size:1.5rem}
@media(max-width:560px){.up-card{padding:1.4rem 1.1rem}.drop{padding:1.6rem .8rem}}
`;

function head(): string {
  return `${skipLink()}<header class="top">${brandLockup("/")}</header>`;
}

/** Expired, already used, or never existed: one gentle page, no detail about which destination it was. */
export function uploadGonePage(kind: "expired" | "used" | "unknown"): string {
  const text =
    kind === "used"
      ? "This upload link has already been used. If you need to send more files, ask Claude for a new link."
      : kind === "expired"
        ? "This link has expired. Go back to Claude and ask for a new one — it only takes a moment."
        : "We couldn't find this upload link. Check that you copied the whole address, or ask Claude for a new one.";
  const title = kind === "unknown" ? "Link not found" : kind === "used" ? "Link already used" : "Link expired";
  return layout(
    `${title} · rtfx.pro`,
    `<div class="up-wrap">${head()}<main class="up-card up-gone" id="main" data-upload-state="${kind}">
      <h1>${title}</h1><p class="lede">${esc(text)}</p></main></div>`,
    STYLE
  );
}

export interface UploadPageInput {
  token: string;
  title: string;
  /** The address the site will be published at, e.g. https://a.rtfx.pro/my-site/. */
  destination: string;
  /** True when this adds a version to something that already exists. */
  isUpdate: boolean;
  expiresAt: string;
}

/** Safe to embed in a <script>: JSON with "<" escaped so "</script>" can not appear. */
function js(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const SCRIPT = `
(function(){
  var CFG = window.__UPLOAD__;
  var $ = function(id){ return document.getElementById(id); };
  var drop = $('drop'), msg = $('up-msg'), sel = $('up-selected'), go = $('up-go'), bar = $('up-bar'), fill = $('up-fill');
  var items = []; // [{file, path}]
  var busy = false;
  var JUNK = /(^|\\/)(\\.DS_Store|Thumbs\\.db|desktop\\.ini)$|(^|\\/)__MACOSX(\\/|$)/;

  function fmt(n){ return n < 1048576 ? Math.max(1, Math.round(n/1024)) + ' KB' : (n/1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB'; }
  function say(text, kind){ msg.textContent = text; msg.hidden = !text; msg.className = kind ? 'is-' + kind : ''; }

  // Expiry: show it in the person's own clock and stop the page when it passes.
  var exp = new Date(CFG.expiresAt), expEl = $('up-exp');
  function tick(){
    var left = exp - Date.now();
    if (left <= 0) { expired(); return; }
    expEl.textContent = 'about ' + Math.max(1, Math.ceil(left/60000)) + ' minute' + (left > 90000 ? 's' : '');
  }
  function expired(){
    expEl.textContent = 'expired';
    go.disabled = true;
    say('This link has expired — ask Claude for a new one.', 'error');
  }
  tick(); setInterval(tick, 20000);

  function addItems(list){
    var out = [];
    for (var i = 0; i < list.length; i++) if (!JUNK.test(list[i].path)) out.push(list[i]);
    items = out;
    render();
  }
  function render(){
    say('');
    if (!items.length) { sel.hidden = true; go.disabled = true; return; }
    var total = 0; for (var i = 0; i < items.length; i++) total += items[i].file.size;
    var one = items.length === 1 ? items[0] : null;
    sel.hidden = false;
    sel.innerHTML = '';
    var b = document.createElement('b');
    b.textContent = one ? one.file.name : items.length + ' files';
    sel.appendChild(b);
    sel.appendChild(document.createTextNode(' · ' + fmt(total) + ' ready to upload'));
    go.disabled = false;
  }
  function asZip(){ return items.length === 1 && /\\.zip$/i.test(items[0].file.name) ? items[0].file : null; }

  // Without index.html at the top the site has no front page — tell them before
  // spending a minute uploading 15 MB.
  function hasIndex(){
    if (asZip()) return true;
    var tops = {}, n = 0, hasRoot = false, nested = false;
    for (var i = 0; i < items.length; i++) {
      var p = items[i].path.replace(/^\\/+/, '');
      if (p === 'index.html') hasRoot = true;
      var slash = p.indexOf('/');
      var top = slash === -1 ? '' : p.slice(0, slash);
      if (!(top in tops)) { tops[top] = 1; n++; }
      if (slash !== -1 && p.slice(slash + 1) === 'index.html') nested = true;
    }
    if (items.length === 1 && /\\.html?$/i.test(items[0].file.name)) return true;
    return hasRoot || (n === 1 && !('' in tops) && nested);
  }

  // --- gathering files ---
  function fromInput(files){
    var out = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      out.push({ file: f, path: f.webkitRelativePath || f.name });
    }
    addItems(out);
  }
  function readAll(reader){
    return new Promise(function(resolve, reject){
      var all = [];
      (function next(){
        reader.readEntries(function(batch){
          if (!batch.length) return resolve(all);
          all = all.concat(Array.prototype.slice.call(batch));
          next();
        }, reject);
      })();
    });
  }
  function walk(entry, prefix){
    if (entry.isFile) {
      return new Promise(function(resolve, reject){
        entry.file(function(file){ resolve([{ file: file, path: prefix + entry.name }]); }, reject);
      });
    }
    if (entry.isDirectory) {
      return readAll(entry.createReader()).then(function(children){
        return Promise.all(children.map(function(ch){ return walk(ch, prefix + entry.name + '/'); }));
      }).then(function(parts){ return [].concat.apply([], parts); });
    }
    return Promise.resolve([]);
  }
  function fromDrop(dt){
    // Entries must be taken synchronously: the list is cleared once we await.
    var entries = [], loose = [];
    if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
      for (var i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        if (it.kind !== 'file') continue;
        var en = it.webkitGetAsEntry();
        if (en) entries.push(en); else { var f = it.getAsFile(); if (f) loose.push({ file: f, path: f.name }); }
      }
      say('Reading your files…', 'info');
      Promise.all(entries.map(function(e){ return walk(e, ''); })).then(function(parts){
        addItems([].concat.apply(loose, parts));
      }).catch(function(){ say("We couldn't read those files. Try the Choose buttons instead.", 'error'); });
    } else {
      fromInput(dt.files);
    }
  }

  ['dragenter','dragover'].forEach(function(t){ drop.addEventListener(t, function(e){ e.preventDefault(); drop.classList.add('is-over'); }); });
  ['dragleave','drop'].forEach(function(t){ drop.addEventListener(t, function(e){ e.preventDefault(); drop.classList.remove('is-over'); }); });
  drop.addEventListener('drop', function(e){ if (!busy) fromDrop(e.dataTransfer); });
  // A file dropped slightly outside the box must not make the browser navigate away.
  window.addEventListener('dragover', function(e){ e.preventDefault(); });
  window.addEventListener('drop', function(e){ e.preventDefault(); });
  $('pick-files').addEventListener('click', function(){ $('in-files').click(); });
  $('pick-folder').addEventListener('click', function(){ $('in-folder').click(); });
  $('in-files').addEventListener('change', function(e){ fromInput(e.target.files); e.target.value = ''; });
  $('in-folder').addEventListener('change', function(e){ fromInput(e.target.files); e.target.value = ''; });

  // --- sending ---
  function explain(status, body){
    var code = body && body.error, detail = body && body.detail;
    if (status === 410 || status === 404) return 'This link has expired or was already used — ask Claude for a new one.';
    if (code === 'no_index') return "We couldn't find index.html — drop the whole site folder (the one that contains index.html), or a .zip of it.";
    if (code === 'slug_taken') return 'That address is already used by someone else. Ask Claude to pick a different name.';
    if (status === 413) return detail || 'That is too big to upload here.';
    if (status === 429) return 'Too many tries from your connection. Please wait a little and try again.';
    if (status === 403) return detail || "You don't have permission to publish this.";
    return detail || 'Something went wrong on our side. Please try again.';
  }
  function done(data){
    var card = $('up-card');
    card.className = 'up-card up-done';
    card.innerHTML = '';
    var h = document.createElement('h1'); h.textContent = 'Your site is published'; card.appendChild(h);
    var p = document.createElement('p'); p.className = 'lede';
    p.textContent = data.file_count + ' file' + (data.file_count === 1 ? '' : 's') + ' uploaded. ' + (CFG.isUpdate ? 'It is now the live version, shared exactly as before.' : 'It is private to you until you share it.');
    card.appendChild(p);
    var a = document.createElement('a'); a.className = 'open'; a.href = data.url; a.textContent = 'Open your site';
    card.appendChild(a);
    var q = document.createElement('p'); q.className = 'hint'; q.textContent = 'You can close this tab and go back to Claude.';
    card.appendChild(q);
    a.focus();
  }
  function send(){
    if (busy || !items.length) return;
    if (!hasIndex()) { say("We couldn't find index.html — drop the whole site folder (the one that contains index.html), or a .zip of it.", 'error'); return; }
    var total = 0; for (var i = 0; i < items.length; i++) total += items[i].file.size;
    if (total > CFG.maxBytes) { say('That is ' + fmt(total) + ', and the limit is ' + fmt(CFG.maxBytes) + '. Try a smaller site or compress the images and video.', 'error'); return; }
    var fd = new FormData(), zip = asZip();
    if (zip) fd.append('bundle', zip, zip.name);
    else for (var j = 0; j < items.length; j++) { fd.append('path', items[j].path); fd.append('file', items[j].file, items[j].file.name); }
    busy = true; go.disabled = true; say('');
    bar.hidden = false; fill.style.width = '0%';
    var xhr = new XMLHttpRequest();
    xhr.open('POST', CFG.endpoint);
    xhr.upload.onprogress = function(e){
      if (!e.lengthComputable) return;
      var pct = Math.round(e.loaded / e.total * 100);
      fill.style.width = pct + '%';
      say(pct < 100 ? 'Uploading… ' + pct + '%' : 'Publishing your site…', 'info');
    };
    xhr.onerror = function(){ busy = false; go.disabled = false; bar.hidden = true; say('The upload was interrupted. Check your connection and press the button to try again.', 'error'); };
    xhr.onload = function(){
      var body = null; try { body = JSON.parse(xhr.responseText); } catch (e) {}
      busy = false;
      if (xhr.status >= 200 && xhr.status < 300 && body && body.url) { done(body); return; }
      go.disabled = xhr.status === 410 || xhr.status === 404;
      bar.hidden = true;
      say(explain(xhr.status, body), 'error');
    };
    xhr.send(fd);
  }
  go.addEventListener('click', send);
})();
`;

export function uploadPage(input: UploadPageInput): string {
  const cfg = {
    isUpdate: input.isUpdate,
    endpoint: `/api/uploads/${input.token}`,
    expiresAt: input.expiresAt,
    maxBytes: MAX_UPLOAD_BYTES,
  };
  const body = `<div class="up-wrap">${head()}
  <main class="up-card" id="up-card" data-upload-state="ready">
    <h1>Publish ${esc(input.title)} to rtfx</h1>
    <p class="lede">Drop your site here and we'll put it online. Nothing is published until you do.</p>
    <dl class="up-meta">
      <dt>Address</dt><dd class="mono">${esc(input.destination)}</dd>
      <dt>${input.isUpdate ? "Updates" : "New"}</dt><dd>${input.isUpdate ? "This adds a new version to a site you already have." : "This creates a new site, private to you until you share it."}</dd>
      <dt>Link works for</dt><dd id="up-exp">about 30 minutes</dd>
    </dl>
    <div class="drop" id="drop">
      <p class="big">Drag your site here</p>
      <p class="small">A .zip, a whole folder, or several files — images and videos are fine.</p>
      <div class="pick">
        <button type="button" id="pick-files">Choose zip or files</button>
        <button type="button" id="pick-folder" class="ghost">Choose folder</button>
      </div>
      <input type="file" id="in-files" multiple hidden>
      <input type="file" id="in-folder" webkitdirectory hidden>
    </div>
    <div class="up-selected" id="up-selected" hidden></div>
    <div class="up-bar" id="up-bar" hidden><i id="up-fill"></i></div>
    <div id="up-msg" role="status" aria-live="polite" hidden></div>
    <div class="up-actions"><button type="button" class="go" id="up-go" disabled>Publish my site</button></div>
  </main></div>
  <script>window.__UPLOAD__=${js(cfg)};</script>
  <script>${SCRIPT}</script>`;
  return layout(`Publish ${input.title} · rtfx.pro`, body, STYLE);
}
