import { esc } from "./pages";
import { MAX_DISPLAY_NAME_LENGTH, MAX_NOTES_LENGTH, type PublicUser } from "./users";
import type { AllowlistView } from "./access-api";
import { portalShell, stamp, type PortalViewer } from "./portal";

/** Everything the People section needs. Mirrors the GET /api/users payload. */
export interface UsersInfo {
  users: PublicUser[];
  /** Emails that can never lose access — rendered as protected. */
  admins: string[];
  /** What we can see of the Cloudflare Access allow-list right now. */
  allowlist: AllowlistView;
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

/**
 * How the Cloudflare Access side of things is doing, as a calm sentence rather
 * than a red box. Only a genuine API failure is an error — "not configured yet"
 * is a setup step, and dressing it up as a fault trains people to ignore red.
 */
function allowlistNote(view: AllowlistView): string {
  if (!view.configured) {
    return `<p class="note" data-users-unconfigured>Cloudflare Access isn't connected yet, so
      invites are recorded here but nobody new can sign in. Set <span class="mono">CF_API_TOKEN</span>,
      <span class="mono">CF_ACCOUNT_ID</span>, <span class="mono">ACCESS_VIEWER_APP_ID</span> and
      <span class="mono">ACCESS_VIEWER_POLICY_ID</span> to manage sign-in from here. Pausing
      somebody still works — this app refuses a paused account either way.</p>`;
  }
  if (view.error) {
    return `<p class="status is-error" data-users-error>Couldn't reach Cloudflare Access: ${esc(view.error)}</p>
      <p class="note">Check that <span class="mono">CF_API_TOKEN</span> is valid and has the
        <b>Access: Apps and Policies — Edit</b> permission, then reload. Everything below is the
        local directory, which still applies.</p>`;
  }
  return "";
}

/** The timeline of one person, in the order it actually reads: newest fact last. */
function userMeta(u: PublicUser): string {
  const bits: string[] = [];
  if (u.invited_at) bits.push(`invited ${stamp(u.invited_at)}${u.invited_by ? ` by ${u.invited_by}` : ""}`);
  else if (u.created_at) bits.push(`added ${stamp(u.created_at)}`);
  if (u.status === "disabled" && u.disabled_at) bits.push(`paused ${stamp(u.disabled_at)}`);
  else if (u.last_seen_at) bits.push(`last seen ${stamp(u.last_seen_at)}`);
  else bits.push("never signed in");
  if (!u.in_directory) bits.push("allow-list only");
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
  // Drift: the directory says they're a member, but Access won't let them in.
  if (u.allowlisted === false && u.status !== "disabled" && !u.is_protected) {
    badges.push(`<span class="badge is-warn" data-badge="allowlist">No sign-in</span>`);
  }

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
 * The People panel: the local directory first, Cloudflare Access as a fact about
 * each person rather than the list itself. That inversion is the point of issue
 * #24 — an operator thinks in people ("has Dana signed in yet?"), not in policy
 * rows.
 */
function usersPanel(info: UsersInfo): string {
  const { summary } = peopleStats(info);
  const rows = info.users.map((u) => userRow(u, info)).join("");

  return `<section class="panel" data-panel="users" aria-labelledby="users-h">
    <div class="panel-head"><div>
      <h2 id="users-h">Directory <span class="hint" data-user-summary>${esc(summary)}</span></h2>
      <p class="hint">Cloudflare Access verifies every sign-in; this is who the product knows
        about. Inviting somebody adds them to the Access allow-list — grant them individual
        artifacts from the artifact's own page.</p>
    </div></div>
    ${allowlistNote(info.allowlist)}
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
   (D1 + the Access allow-list) after each write, so re-rendering from source is
   both simpler and more honest than patching rows client-side. */
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
      var res = await fetch('/api/users', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
      });
      if(!res.ok){ setStatus(status, (await detail(res)) || 'Could not invite that person.', 'error'); return; }
      var data = await res.json();
      /* A warning means the write landed but Access didn't — say so rather than
         letting the reload imply everything is fine. */
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
      var res = await fetch(action.url(email), { method: action.method });
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
