import { esc } from "./pages";
import { MAX_DISPLAY_NAME_LENGTH, MAX_NOTES_LENGTH, type PublicUser } from "./users";
import { portalShell, stamp, type PortalViewer } from "./portal";

/** Everything the People section needs. Mirrors the GET /api/users payload. */
export interface UsersInfo {
  users: PublicUser[];
  /** Emails that can never lose access — rendered as protected. */
  admins: string[];
  /** The signed-in admin, so the panel can refuse to let them disable themselves. */
  viewer: string | null;
  /** True only for a super admin, who alone may act on another admin. */
  canManageAdmins: boolean;
}

const ROLE_LABEL: Record<PublicUser["role"], string> = {
  super_admin: "Owner",
  admin: "Admin",
  member: "Member",
};

const STATUS_LABEL: Record<PublicUser["status"], string> = {
  active: "Active",
  invited: "Invited",
  disabled: "Paused",
};

/** The timeline of one person, in the order it actually reads: newest fact last. */
function userMeta(u: PublicUser): string {
  const bits: string[] = [];
  if (u.invited_at) bits.push(`invited ${stamp(u.invited_at)}${u.invited_by ? ` by ${u.invited_by}` : ""}`);
  else if (u.created_at) bits.push(`added ${stamp(u.created_at)}`);
  if (u.status === "disabled" && u.disabled_at) bits.push(`paused ${stamp(u.disabled_at)}`);
  else if (u.last_seen_at) bits.push(`last seen ${stamp(u.last_seen_at)}`);
  else bits.push("never signed in");
  if (!u.in_directory) bits.push("from configuration");
  return bits.join(" · ");
}

function userRow(u: PublicUser, info: UsersInfo): string {
  const isSelf = !!info.viewer && info.viewer === u.email;
  // Who may act on this row — the same rules userActionDenial enforces server
  // side. Rendering them here is courtesy, not security: hiding a button never
  // protects anything, so the API re-checks every one of these.
  const locked = u.is_protected || (u.role !== "member" && !info.canManageAdmins);
  const badges = [
    `<span class="badge is-role" data-badge="role">${esc(ROLE_LABEL[u.role])}</span>`,
    `<span class="badge is-${u.status === "disabled" ? "disabled" : u.status}" data-badge="status">${esc(STATUS_LABEL[u.status])}</span>`,
  ];

  let actions: string;
  if (locked) {
    actions = `<span class="hint" data-locked>${
      u.is_protected ? "Protected owner" : "Owner-only"
    }</span>`;
  } else if (isSelf) {
    actions = `<span class="hint" data-locked>That's you</span>`;
  } else if (u.status === "disabled") {
    actions = `<button class="ghost small" data-user-action="enable" data-user-email="${esc(u.email)}">Re-enable</button>
      <button class="danger small" data-user-action="remove" data-user-email="${esc(u.email)}">Remove</button>`;
  } else {
    actions = `<button class="ghost small" data-user-action="disable" data-user-email="${esc(u.email)}">Pause</button>
      <button class="danger small" data-user-action="remove" data-user-email="${esc(u.email)}">Remove</button>`;
  }

  return `<div class="row user-row" data-user="${esc(u.email)}" data-user-status="${esc(u.status)}" data-user-role="${esc(u.role)}">
    <div class="info">
      <b>${u.display_name ? esc(u.display_name) : esc(u.email)}</b>
      ${u.display_name ? `<span class="hint mono">${esc(u.email)}</span>` : ""}
      <div class="art-badges">${badges.join("")}</div>
      <div class="hint" data-user-meta>${esc(userMeta(u))}</div>
      ${u.notes ? `<div class="hint user-note" data-user-notes>${esc(u.notes)}</div>` : ""}
    </div>
    <div class="row-actions">${actions}<span class="status" data-status hidden></span></div>
  </div>`;
}

/** One tile per lifecycle state, so "who is waiting on me?" is answered first. */
function peopleStats(info: UsersInfo): {
  active: number;
  invited: number;
  paused: number;
  summary: string;
} {
  const active = info.users.filter((u) => u.status === "active").length;
  const invited = info.users.filter((u) => u.status === "invited").length;
  const paused = info.users.filter((u) => u.status === "disabled").length;
  const summary = [
    `${active} active`,
    invited ? `${invited} invited` : "",
    paused ? `${paused} paused` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { active, invited, paused, summary };
}

/**
 * The People panel. The directory this app owns *is* the list — there is no
 * external policy system to reconcile it against — so each row reads as a person
 * with a lifecycle ("has Dana signed in yet?") rather than as a policy row.
 */
function usersPanel(info: UsersInfo): string {
  const { summary } = peopleStats(info);
  const rows = info.users.map((u) => userRow(u, info)).join("");

  return `<section class="panel" data-panel="users" aria-labelledby="users-h">
    <div class="panel-head"><div>
      <h2 id="users-h">Directory <span class="hint" data-user-summary>${esc(summary)}</span></h2>
      <p class="hint">Anyone who verifies an email address can sign in; this is who the product knows
        about. Inviting somebody adds them here and emails them a sign-in link — grant them
        individual artifacts from the artifact's own page.</p>
    </div></div>
    <form id="userform" class="userform" data-invite-form>
      <input id="newuser" type="email" placeholder="person@example.com" autocomplete="off"
        aria-label="Email to invite" required>
      <input id="newuser-name" type="text" placeholder="Name (optional)" autocomplete="off"
        aria-label="Display name" maxlength="${MAX_DISPLAY_NAME_LENGTH}">
      <input id="newuser-notes" type="text" placeholder="Note (optional)" autocomplete="off"
        aria-label="Internal note" maxlength="${MAX_NOTES_LENGTH}">
      <button type="submit" class="small">Send invite</button>
      <span id="users-status" class="status" data-status hidden></span>
    </form>
    <div class="user-list">${
      rows ||
      `<div class="empty" data-empty="users"><h3>No one here yet</h3>
        <p>Invite your first teammate above. They'll get a one-time code by email the first
          time they open the dashboard — there's no password to share.</p></div>`
    }</div>
  </section>`;
}

const PEOPLE_SCRIPT = `
/* ---- people ----
   Every mutation reloads on success. The server re-derives the whole directory
   from D1 after each write, so re-rendering from source is both simpler and more
   honest than patching rows client-side. */

/* Sign-in is app-owned: these writes carry the host-only rtfx_session cookie,
   and an expired session comes back as a plain 403 the handlers below already
   report.

   The redirect handling is for a legacy/self-host deployment that still gates
   paths at the edge. There, a write can be answered before the Worker sees it
   with a cross-origin 302 to the edge sign-in page, and a request carrying
   'Content-Type: application/json' may not follow a cross-origin redirect
   without a preflight, which is not allowed after a redirect. Left alone the
   browser reports the whole thing as a CORS error and "Send invite" appears
   broken (issue #37).

   redirect:'manual' stops the browser from escalating it: we get an opaque
   response instead of an exception, and that is our cue to re-authenticate with
   the one thing that can follow such a redirect — a full-page navigation. */
function apiFetch(url, init){
  init = init || {};
  init.redirect = 'manual';
  init.credentials = 'same-origin';
  return fetch(url, init);
}
function needsReauth(res){
  return res.type === 'opaqueredirect' || res.status === 0 ||
    (res.status >= 300 && res.status < 400);
}
function reauth(status){
  setStatus(status, 'Renewing your sign-in…');
  location.href = '/api/users/reauth?next=' +
    encodeURIComponent(location.pathname + location.search);
}

var userForm = $('#userform');
if(userForm){
  userForm.addEventListener('submit', async function(e){
    e.preventDefault();
    var status = $('#users-status');
    var email = $('#newuser').value.trim();
    if(!email){ setStatus(status, 'Enter an email address.', 'error'); return; }
    var payload = { email: email };
    var name = $('#newuser-name').value.trim(); if(name) payload.display_name = name;
    var note = $('#newuser-notes').value.trim(); if(note) payload.notes = note;
    var btn = $('button[type=submit]', userForm);
    btn.disabled = true;
    setStatus(status, 'Inviting…');
    try {
      var res = await apiFetch('/api/users', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
      });
      if(needsReauth(res)){ reauth(status); return; }
      if(!res.ok){ setStatus(status, (await detail(res)) || 'Could not invite that person.', 'error'); return; }
      var data = await res.json();
      /* A warning means the write landed but something alongside it did not —
         say so rather than letting the reload imply everything is fine. */
      if(data.warning){ alert(data.warning); }
      location.reload();
    } catch(err){ setStatus(status, 'Network error — try again.', 'error'); }
    finally { btn.disabled = false; }
  });
}

var USER_ACTIONS = {
  disable: {
    confirm: function(e){ return 'Pause ' + e + '?\\n\\nThey are signed out everywhere and their API tokens are revoked. Their artifacts are kept, and you can re-enable them at any time.'; },
    url: function(e){ return '/api/users/' + encodeURIComponent(e) + '/disable'; },
    method: 'POST', busy: 'Pausing…', fail: 'Could not pause that account.'
  },
  enable: {
    confirm: function(e){ return 'Re-enable ' + e + '?\\n\\nThey can sign in again. Previously revoked API tokens stay revoked.'; },
    url: function(e){ return '/api/users/' + encodeURIComponent(e) + '/enable'; },
    method: 'POST', busy: 'Re-enabling…', fail: 'Could not re-enable that account.'
  },
  remove: {
    confirm: function(e){ return 'Remove ' + e + ' from rtfx.pro?\\n\\nThey lose sign-in, every artifact grant, and every API token. Artifacts they published are NOT deleted. This cannot be undone.'; },
    url: function(e){ return '/api/users/' + encodeURIComponent(e); },
    method: 'DELETE', busy: 'Removing…', fail: 'Could not remove that person.'
  }
};

$$('button[data-user-action]').forEach(function(b){
  b.addEventListener('click', async function(){
    var action = USER_ACTIONS[b.getAttribute('data-user-action')];
    var email = b.getAttribute('data-user-email');
    if(!action || !confirm(action.confirm(email))) return;
    var row = $('[data-user="' + email + '"]');
    var status = row ? $('[data-status]', row) : null;
    b.disabled = true;
    setStatus(status, action.busy);
    try {
      var res = await apiFetch(action.url(email), { method: action.method });
      if(needsReauth(res)){ reauth(status); return; }
      if(!res.ok){
        b.disabled = false;
        setStatus(status, (await detail(res)) || action.fail, 'error');
        return;
      }
      var data = await res.json();
      if(data.warning){ alert(data.warning); }
      location.reload();
    } catch(err){
      b.disabled = false;
      setStatus(status, 'Network error — try again.', 'error');
    }
  });
});
`;

const PEOPLE_STYLE = `
.userform{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.75rem}
.userform input{flex:1;min-width:11rem}
.userform input#newuser{min-width:15rem;flex:1.4}
.art-badges{display:flex;gap:.35rem;flex-wrap:wrap}
.user-row{align-items:flex-start}
.user-row .info{display:grid;gap:.3rem}
.user-row .info b{font-weight:650;letter-spacing:-.015em}
.user-row .art-badges{margin-top:.1rem}
.user-note{border-left:2px solid var(--border-strong);padding-left:.6rem;color:var(--faint)}
.user-row .row-actions{align-items:center;flex-wrap:wrap;justify-content:flex-end}
.user-list .empty{padding:2.4rem 1.5rem}
`;

export function peoplePage(viewer: PortalViewer, info: UsersInfo): string {
  const { active, invited, paused } = peopleStats(info);
  const tiles = `<section class="stats" aria-label="Team at a glance">
    <div class="stat" data-stat="people-active">
      <div class="stat-label">Active</div>
      <div class="stat-value" data-stat-value>${active}</div>
      <div class="stat-hint">signed in at least once</div>
    </div>
    <div class="stat" data-stat="people-invited">
      <div class="stat-label">Invited</div>
      <div class="stat-value" data-stat-value>${invited}</div>
      <div class="stat-hint">${invited ? "waiting for a first sign-in" : "nobody pending"}</div>
    </div>
    <div class="stat" data-stat="people-paused">
      <div class="stat-label">Paused</div>
      <div class="stat-value" data-stat-value>${paused}</div>
      <div class="stat-hint">${paused ? "reversible — nothing deleted" : "no paused accounts"}</div>
    </div>
  </section>`;

  return portalShell({
    viewer,
    section: "people",
    title: "People",
    heading: "People",
    lede: `Who can sign in, what state they're in, and who is still waiting on an invite.
      Roles come from configuration, never from this page.`,
    body: `${tiles}${usersPanel(info)}`,
    style: PEOPLE_STYLE,
    script: PEOPLE_SCRIPT,
  });
}
