import type { ArtifactRow, VersionRow, ViewRow } from "./env";
import { layout, esc } from "./pages";

export interface ViewsInfo {
  counts: Map<string, { total: number; unique: number }>;
  recent: Map<string, ViewRow[]>;
}

function viewsPanel(slug: string, info: ViewsInfo): string {
  const c = info.counts.get(slug) ?? { total: 0, unique: 0 };
  const recent = info.recent.get(slug) ?? [];
  const rows = recent
    .map(
      (v) => `<div class="row"><div class="info">${esc(v.email ?? "—")}
        <span class="hint">${v.viewed_at.replace("T", " ").slice(0, 16)} · v${v.version}${v.country ? " · " + esc(v.country) : ""}${v.path ? " · /" + esc(v.path) : ""}</span></div></div>`
    )
    .join("");
  return `<div class="acc">
    <b>Views</b> <span class="hint">${c.total} total · ${c.unique} unique viewer(s)</span>
    ${recent.length ? rows : `<p class="note">No views yet.</p>`}
  </div>`;
}

const SCRIPT = `
const $ = (s)=>document.querySelector(s);
const msg = $('#msg');
function show(text, ok){ msg.textContent=text; msg.style.display='block';
  msg.style.background = ok ? 'rgba(60,160,90,.15)' : 'rgba(200,70,70,.15)';
  msg.style.color = ok ? '#3ca05a' : '#c84646'; }
$('#up').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const fd = new FormData(e.target);
  for (const key of ['file','bundle']) { const f = fd.get(key); if (f && f.size===0) fd.delete(key); }
  show('Uploading…', true);
  try {
    const res = await fetch('/api/artifacts', { method:'POST', body: fd });
    const data = await res.json();
    if (!res.ok) return show(data.detail || data.error || 'Upload failed', false);
    show('Published: ' + data.url, true);
    setTimeout(()=>location.reload(), 800);
  } catch (err) { show('Network error', false); }
});
async function del(slug){
  if (!confirm('Delete "'+slug+'"? This removes all its files.')) return;
  const res = await fetch('/api/artifacts/'+encodeURIComponent(slug), { method:'DELETE' });
  if (res.ok) location.reload(); else show('Delete failed', false);
}
async function addUser(e){
  e.preventDefault();
  const input = document.getElementById('newuser');
  const email = input.value.trim();
  if (!email) return;
  const st = document.getElementById('users-status'); st.textContent = 'adding…';
  const res = await fetch('/api/users', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email }) });
  const data = await res.json();
  if (res.ok) location.reload(); else { st.textContent = data.detail || 'failed'; st.style.color='#c84646'; }
}
async function removeUser(email){
  if (!confirm('Remove '+email+"? They lose login access and are revoked from all artifacts.")) return;
  const res = await fetch('/api/users/'+encodeURIComponent(email), { method:'DELETE' });
  if (res.ok) location.reload(); else { const d = await res.json(); alert(d.detail || 'failed'); }
}
async function saveAccess(slug){
  const card = document.getElementById('acc-'+slug);
  const visibility = card.querySelector('[name=visibility]').value;
  const emails = card.querySelector('[name=emails]').value.split(/[\\s,]+/).map(s=>s.trim()).filter(Boolean);
  const status = card.querySelector('.acc-status');
  status.textContent = 'saving…';
  const res = await fetch('/api/artifacts/'+encodeURIComponent(slug)+'/access', {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ visibility, emails })
  });
  const data = await res.json();
  status.textContent = res.ok ? ('saved · '+data.visibility+' · '+data.emails.length+' user(s)') : (data.detail||'error');
  status.style.color = res.ok ? '#3ca05a' : '#c84646';
}
function onVis(slug){
  const card = document.getElementById('acc-'+slug);
  const restricted = card.querySelector('[name=visibility]').value === 'restricted';
  card.querySelector('.emails-wrap').style.display = restricted ? 'block' : 'none';
}
async function makeCurrent(slug, version){
  if(!confirm('Make v'+version+' the live version of "'+slug+'"?')) return;
  const res = await fetch('/api/artifacts/'+encodeURIComponent(slug)+'/current', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ version: Number(version) })
  });
  if(res.ok) location.reload(); else { const d = await res.json(); alert(d.detail || 'failed'); }
}
async function uploadVersion(e){
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  for (const key of ['file','bundle']) { const f = fd.get(key); if (f && f.size===0) fd.delete(key); }
  if (!fd.get('file') && !fd.get('bundle')) { alert('choose a .html or .zip file'); return; }
  const st = form.querySelector('.ver-status'); st.textContent = 'uploading…';
  const res = await fetch('/api/artifacts', { method:'POST', body: fd });
  const d = await res.json();
  if(res.ok) location.reload(); else { st.textContent = d.detail || 'failed'; st.style.color = '#c84646'; }
}
document.querySelectorAll('button[data-del]').forEach(b=>b.addEventListener('click',()=>del(b.dataset.del)));
document.querySelectorAll('button[data-save]').forEach(b=>b.addEventListener('click',()=>saveAccess(b.dataset.save)));
document.querySelectorAll('select[data-vis]').forEach(s=>s.addEventListener('change',()=>onVis(s.dataset.vis)));
document.querySelectorAll('button[data-rmuser]').forEach(b=>b.addEventListener('click',()=>removeUser(b.dataset.rmuser)));
document.querySelectorAll('button[data-current]').forEach(b=>b.addEventListener('click',()=>makeCurrent(b.dataset.slug, b.dataset.current)));
document.querySelectorAll('form.newver').forEach(f=>f.addEventListener('submit', uploadVersion));
const uf = document.getElementById('userform'); if (uf) uf.addEventListener('submit', addUser);
`;

const ACCESS_STYLE = `
.acc{margin-top:.6rem;padding:.75rem;border:1px solid var(--border);border-radius:8px;background:var(--bg)}
.acc label{margin-bottom:.15rem}
.acc select,.acc textarea{margin-bottom:.5rem}
.acc-status{font-size:.8rem;color:var(--muted);margin-left:.6rem}
.vis-badge{font-size:.72rem;border:1px solid var(--border);border-radius:999px;padding:.05rem .5rem;margin-left:.4rem}
details.artifact{border:1px solid var(--border);border-radius:10px;padding:.6rem .9rem;margin-bottom:.6rem;background:var(--card)}
details.artifact summary{cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:1rem}
details.artifact summary b{display:inline}
`;

function accessPanel(r: ArtifactRow, emails: string[]): string {
  const restricted = r.visibility === "restricted";
  return `<div class="acc" id="acc-${esc(r.slug)}">
    <label>Visibility</label>
    <select name="visibility" data-vis="${esc(r.slug)}">
      <option value="restricted"${restricted ? " selected" : ""}>Restricted — only listed users + admin</option>
      <option value="everyone"${!restricted ? " selected" : ""}>Everyone — any logged-in user</option>
    </select>
    <div class="emails-wrap" style="display:${restricted ? "block" : "none"}">
      <label>Allowed emails (comma or newline separated)</label>
      <textarea name="emails" rows="2" placeholder="alice@example.com, bob@example.com">${esc(emails.join(", "))}</textarea>
    </div>
    <button data-save="${esc(r.slug)}">Save access</button>
    <span class="acc-status"></span>
  </div>`;
}

interface UsersInfo {
  users: string[] | null;
  admins: string[];
  usersError: string | null;
}

function usersPanel(info: UsersInfo): string {
  if (info.users === null) {
    const msg = info.usersError
      ? `User management error: ${esc(info.usersError)}`
      : `User management is not configured (set CF_API_TOKEN + Access ids to manage the login allow-list here).`;
    return `<div class="acc"><b>Users</b><p class="note">${msg}</p></div>`;
  }
  const adminSet = new Set(info.admins);
  const rows = info.users
    .map((u) => {
      const isAdm = adminSet.has(u);
      return `<div class="row"><div class="info">${esc(u)}${isAdm ? ' <span class="vis-badge">admin</span>' : ""}</div>
        <div>${isAdm ? '<span class="hint">always allowed</span>' : `<button class="ghost" data-rmuser="${esc(u)}">remove</button>`}</div></div>`;
    })
    .join("");
  return `<div class="acc">
    <b>Users — who can log in</b>
    <p class="hint">Backed by Cloudflare Access. Adding a user here lets them sign in; grant them artifacts below.</p>
    <form id="userform" style="display:flex;gap:.5rem;margin:.5rem 0">
      <input id="newuser" type="email" placeholder="person@example.com" style="flex:1">
      <button type="submit">Add user</button>
      <span id="users-status" class="acc-status"></span>
    </form>
    ${rows}
  </div>`;
}

function versionsPanel(r: ArtifactRow, versions: VersionRow[]): string {
  const list = versions
    .map((v) => {
      const isCur = v.version === r.current_version;
      const meta = [v.created_at.slice(0, 10), v.note ? esc(v.note) : "", v.created_by ? esc(v.created_by) : ""]
        .filter(Boolean)
        .join(" · ");
      return `<div class="row">
        <div class="info"><b>v${v.version}</b>${isCur ? ' <span class="vis-badge">current</span>' : ""}
          <span class="hint">${meta} · ${v.file_count} file(s)</span></div>
        <div><a href="/v/${esc(r.slug)}/${v.version}/" target="_blank">view</a>
          ${isCur ? "" : `<button class="ghost" data-slug="${esc(r.slug)}" data-current="${v.version}" style="margin-left:.5rem">make current</button>`}</div>
      </div>`;
    })
    .join("");
  return `<div class="acc">
    <b>Versions</b>
    ${list}
    <form class="newver" style="margin-top:.6rem;display:grid;gap:.4rem">
      <input type="hidden" name="slug" value="${esc(r.slug)}">
      <label class="hint">New version — single HTML (.html)</label><input type="file" name="file" accept=".html,.htm">
      <label class="hint">…or a bundle (.zip)</label><input type="file" name="bundle" accept=".zip">
      <input type="text" name="note" placeholder="what changed (optional note)">
      <div><button type="submit">Upload new version</button><span class="ver-status acc-status"></span></div>
    </form>
  </div>`;
}

export function adminPage(
  rows: ArtifactRow[],
  grants: Map<string, string[]>,
  versions: Map<string, VersionRow[]>,
  views: ViewsInfo,
  email: string,
  usersInfo: UsersInfo
): string {
  const list = rows
    .map((r) => {
      const emails = grants.get(r.slug) ?? [];
      const vers = versions.get(r.slug) ?? [];
      const badge =
        r.visibility === "everyone"
          ? `<span class="vis-badge">everyone</span>`
          : `<span class="vis-badge">restricted · ${emails.length}</span>`;
      const verBadge = `<span class="vis-badge">v${r.current_version}${vers.length > 1 ? ` of ${vers.length}` : ""}</span>`;
      return `<details class="artifact">
        <summary>
          <span><b>${esc(r.title)}</b> <span class="hint">/${esc(r.slug)}/ · ${esc(r.type)} · ${r.file_count} file(s)</span>${verBadge}${badge}</span>
          <span><a href="/${esc(r.slug)}/" target="_blank">open</a>
            <button class="ghost" data-del="${esc(r.slug)}" style="margin-left:.5rem">delete</button></span>
        </summary>
        ${versionsPanel(r, vers)}
        ${viewsPanel(r.slug, views)}
        ${accessPanel(r, emails)}
      </details>`;
    })
    .join("");

  const body = `<header class="top"><div><h1>Admin · Artifacts</h1>
      <div class="sub">signed in as ${esc(email)}</div></div>
      <div><a href="/gallery">view gallery →</a></div></header>

    <form class="up" id="up">
      <div><label>Title *</label><input name="title" required placeholder="Q3 Landing Page"></div>
      <div><label>Slug (optional — derived from title)</label><input name="slug" placeholder="q3-landing"></div>
      <div><label>Description (optional)</label><textarea name="description" rows="2"></textarea></div>
      <div><label>Single HTML file (.html)</label><input type="file" name="file" accept=".html,.htm"></div>
      <div><label>…or a bundle (.zip with index.html at root)</label><input type="file" name="bundle" accept=".zip"></div>
      <p class="hint">Publishing an existing slug adds a new version (goes live; previous versions kept).</p>
      <div><button type="submit">Publish</button></div>
      <div id="msg"></div>
    </form>

    <h2 style="font-size:1.1rem">Users</h2>
    ${usersPanel(usersInfo)}

    <h2 style="font-size:1.1rem">Published (${rows.length}) <span class="hint">— new artifacts start private (admin only)</span></h2>
    ${rows.length ? list : `<p class="note">Nothing published yet.</p>`}
    <script>${SCRIPT}</script>`;
  return layout("Admin · Artifacts", body, ACCESS_STYLE);
}
