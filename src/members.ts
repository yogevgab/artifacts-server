import { esc } from "./pages";
import { portalShell, stamp, plural, statTile, type PortalViewer } from "./portal";
import {
  ACCOUNT_ROLES,
  accountRoleLabel,
  effectivePlan,
  type AccountRole,
  type AccountRow,
  type MemberRow,
} from "./accounts";
import { limitsFor, PLANS } from "./quota";

/**
 * Workspace member management and seat counting — the Team plan's whole pitch.
 *
 * The People panel (src/people.ts) is the *platform* directory: who may sign
 * in at all. This is its workspace-scoped sibling: who belongs to one
 * account, what they may do inside it, and how many of the plan's seats that
 * costs. The two are deliberately different surfaces — see accounts.ts's
 * module note on why an account role must never be confused with platform
 * authority — and this page only ever touches the account side.
 *
 * Authorization is all in authz.ts (`canManageMembers`, `memberChangeDenial`);
 * this module renders what that policy already decided and wires up the JSON
 * routes in members-routes.ts. Nothing here re-derives a rule that already
 * has a tested home.
 */

// --- seats -------------------------------------------------------------------

/** Ascending seat ceiling, so "the plan that lifts it" can be found by walking forward. */
const PLAN_ORDER = ["free", "pro", "team"] as const;

export const DEFAULT_SEAT_LIMIT = PLANS.free.maxSeats;

/**
 * The seat ceiling for a plan name, falling back to `free`'s for anything
 * unrecognized.
 *
 * This used to read a module-local `SEAT_LIMITS` table carrying a TODO to fold
 * itself into `PLANS`. The production-SaaS plan called that out as a drift
 * risk, and it was a real one: two tables of plan limits are two tables that
 * can disagree, and the pricing pages read one while enforcement read the
 * other. There is now a single entitlement source (`PLANS`, src/quota.ts) and
 * this is a lookup into it. `limitsFor` supplies the unrecognized-plan
 * fallback, so that rule also lives in exactly one place.
 */
export function maxSeatsFor(plan: string): number {
  return limitsFor(plan).maxSeats;
}

/** The word for a plan, as the product says it. */
export function planLabel(plan: string): string {
  return plan.length ? plan[0].toUpperCase() + plan.slice(1) : plan;
}

/** The next plan (if any) whose seat ceiling is higher than `plan`'s. */
function planThatLifts(plan: string): string | null {
  const max = maxSeatsFor(plan);
  const idx = PLAN_ORDER.indexOf(plan as (typeof PLAN_ORDER)[number]);
  const rest = idx === -1 ? PLAN_ORDER : PLAN_ORDER.slice(idx + 1);
  return rest.find((p) => maxSeatsFor(p) > max) ?? null;
}

function seatWord(n: number): string {
  return `${n} seat${n === 1 ? "" : "s"}`;
}

/**
 * Why somebody may NOT be added, purely on seat count — or null when there is
 * room. `memberCount` is how many people already belong to the workspace;
 * adding a brand-new email always costs exactly one more seat, so the check
 * is `memberCount >= max`, not `>`.
 *
 * Names both the limit and, when one exists, the plan that raises it — an
 * operator refused here needs to know what to do next, not just that they
 * were refused.
 */
export function seatLimitDenial(plan: string, memberCount: number): string | null {
  const max = maxSeatsFor(plan);
  if (memberCount < max) return null;
  const lift = planThatLifts(plan);
  return lift
    ? `this workspace is on the ${planLabel(plan)} plan, which caps out at ${seatWord(max)} — upgrade to ${planLabel(lift)} (${seatWord(maxSeatsFor(lift))}) to add more people`
    : `this workspace is at its ${planLabel(plan)} plan's limit of ${seatWord(max)} — remove somebody before adding another`;
}

// --- presentation --------------------------------------------------------------

function statusLabel(status: string): string {
  return status.length ? status[0].toUpperCase() + status.slice(1) : status;
}

/** The timeline of one membership, in the order it reads: newest fact last. */
function memberMeta(m: MemberRow): string {
  const bits: string[] = [];
  if (m.invited_by) bits.push(`invited by ${m.invited_by}`);
  bits.push(`added ${stamp(m.created_at)}`);
  return bits.join(" · ");
}

function memberRow(m: MemberRow, canManage: boolean, viewerEmail: string | null, ownerCount: number): string {
  const isSelf = !!viewerEmail && viewerEmail === m.email;
  const isLastOwner = m.role === "owner" && ownerCount <= 1;

  const badges = [
    `<span class="badge is-role" data-badge="role">${esc(accountRoleLabel(m.role))}</span>`,
    `<span class="badge is-${m.status === "active" ? "active" : "warn"}" data-badge="status">${esc(statusLabel(m.status))}</span>`,
  ];

  let controls: string;
  if (!canManage) {
    controls = "";
  } else if (isLastOwner) {
    controls = `<span class="hint" data-locked>Last owner — promote somebody else first</span>`;
  } else {
    const roleOptions = ACCOUNT_ROLES.map(
      (r) => `<option value="${esc(r)}"${r === m.role ? " selected" : ""}>${esc(accountRoleLabel(r))}</option>`
    ).join("");
    controls = `<select class="small" data-member-role-select data-member-email="${esc(m.email)}"
        aria-label="Change role for ${esc(m.email)}">${roleOptions}</select>
      <button class="danger small" data-member-action="remove" data-member-email="${esc(m.email)}"
        aria-label="Remove ${esc(m.email)} from this workspace">Remove</button>`;
  }

  return `<div class="row member-row" data-member="${esc(m.email)}" data-member-role="${esc(m.role)}"
    data-member-status="${esc(m.status)}">
    <div class="info">
      <b>${esc(m.email)}</b>
      <div class="art-badges">${badges.join("")}</div>
      <div class="hint" data-member-meta>${esc(memberMeta(m))}</div>
    </div>
    <div class="row-actions">${isSelf ? `<span class="hint" data-you>That's you</span>` : ""}${controls}
      <span class="status" data-status hidden></span></div>
  </div>`;
}

function membersPanel(info: MembersPageInput): string {
  const ownerCount = info.members.filter((m) => m.role === "owner").length;
  const rows = info.members.map((m) => memberRow(m, info.canManage, info.viewerEmail, ownerCount)).join("");
  // The EFFECTIVE plan, so a workspace an operator comped onto Team shows —
  // and is refused against — the seats it actually has, not the ones its
  // (possibly still Free) subscription pays for.
  const plan = effectivePlan(info.account);
  const max = maxSeatsFor(plan);
  const used = info.members.length;
  const atCap = used >= max;

  // COPY RULE, and it is load-bearing: this form sends nothing. `POST
  // /api/workspace/:id/members` writes the membership row and makes no mail
  // call at all (see src/members-routes.ts, and the note in src/plan-copy.ts on
  // why Team is still a "talk to us" tier because of it). So nothing here may
  // say "invited", "invitation sent" or "we've emailed them" — the honest
  // description of what the button does is "adds them, and they're in as soon
  // as they sign in with that address". Change this copy only when a send
  // actually ships alongside it.
  const inviteForm = info.canManage
    ? `<form id="memberform" class="userform" data-invite-form data-account-id="${esc(info.account.id)}">
      <input id="newmember" type="email" placeholder="person@example.com" autocomplete="off"
        aria-label="Email address to add to this workspace" required>
      <select id="newmember-role" class="small" aria-label="Role to add them as">
        ${ACCOUNT_ROLES.map(
          (r) => `<option value="${esc(r)}"${r === "member" ? " selected" : ""}>${esc(accountRoleLabel(r))}</option>`
        ).join("")}
      </select>
      <button type="submit" class="small"${atCap ? " disabled" : ""}>Add member</button>
      <span id="members-status" class="status" data-status hidden></span>
    </form>
    <p class="hint" data-no-invite-mail>No email is sent. Adding somebody grants them this
      workspace the moment they sign in with that address — tell them yourself that they're in.</p>
    <p class="hint" data-seat-summary>${used} of ${max} ${max === 1 ? "seat" : "seats"} used on the ${esc(
        planLabel(plan)
      )} plan.${atCap ? " You're at the limit — remove somebody or upgrade to add more." : ""}</p>`
    : "";

  return `<section class="panel" data-panel="members" data-account-id="${esc(info.account.id)}"
    aria-labelledby="members-h">
    <div class="panel-head"><div>
      <h2 id="members-h">Members <span class="hint" data-member-summary>${used} of ${max} seats</span></h2>
      <p class="hint">Who belongs to this workspace and what they can do inside it. This is separate
        from who may sign in to the instance at all — see People for that.</p>
    </div></div>
    ${inviteForm}
    <div class="member-list">${
      rows ||
      `<div class="empty" data-empty="members"><h3>Nobody here yet</h3>
        <p>Add the first teammate above.</p></div>`
    }</div>
  </section>`;
}

const MEMBERS_SCRIPT = `
/* ---- workspace members ----
   Mirrors the People panel's script (src/people.ts): apiFetch/needsReauth/reauth
   exist for the same reason — Cloudflare Access guards this differently from
   /admin, so the first write of a session needs a full-page re-auth rather
   than a fetch that a cross-origin redirect would turn into a CORS error. */
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

var membersPanel = document.querySelector('[data-panel="members"]');
var MEMBERS_BASE = membersPanel
  ? '/api/workspace/' + encodeURIComponent(membersPanel.getAttribute('data-account-id')) + '/members'
  : null;

var memberForm = $('#memberform');
if(memberForm && MEMBERS_BASE){
  memberForm.addEventListener('submit', async function(e){
    e.preventDefault();
    var status = $('#members-status');
    var email = $('#newmember').value.trim();
    if(!email){ setStatus(status, 'Enter an email address.', 'error'); return; }
    var role = $('#newmember-role').value;
    var btn = $('button[type=submit]', memberForm);
    btn.disabled = true;
    setStatus(status, 'Adding…');
    try {
      var res = await apiFetch(MEMBERS_BASE, {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: email, role: role })
      });
      if(needsReauth(res)){ reauth(status); return; }
      if(!res.ok){ setStatus(status, (await detail(res)) || 'Could not add that person.', 'error'); return; }
      location.reload();
    } catch(err){ setStatus(status, 'Network error — try again.', 'error'); }
    finally { btn.disabled = false; }
  });
}

$$('select[data-member-role-select]').forEach(function(sel){
  var original = sel.value;
  sel.addEventListener('change', async function(){
    if(!MEMBERS_BASE) return;
    var email = sel.getAttribute('data-member-email');
    var row = $('[data-member="' + email + '"]');
    var status = row ? $('[data-status]', row) : null;
    sel.disabled = true;
    setStatus(status, 'Updating…');
    try {
      var res = await apiFetch(MEMBERS_BASE + '/' + encodeURIComponent(email), {
        method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ role: sel.value })
      });
      if(needsReauth(res)){ reauth(status); return; }
      if(!res.ok){
        sel.value = original;
        sel.disabled = false;
        setStatus(status, (await detail(res)) || 'Could not change that role.', 'error');
        return;
      }
      location.reload();
    } catch(err){
      sel.value = original;
      sel.disabled = false;
      setStatus(status, 'Network error — try again.', 'error');
    }
  });
});

$$('button[data-member-action="remove"]').forEach(function(b){
  b.addEventListener('click', async function(){
    if(!MEMBERS_BASE) return;
    var email = b.getAttribute('data-member-email');
    if(!confirm('Remove ' + email + ' from this workspace?\\n\\nThey lose reach into every artifact here. This does not affect their sign-in to the instance.')) return;
    var row = $('[data-member="' + email + '"]');
    var status = row ? $('[data-status]', row) : null;
    b.disabled = true;
    setStatus(status, 'Removing…');
    try {
      var res = await apiFetch(MEMBERS_BASE + '/' + encodeURIComponent(email), { method: 'DELETE' });
      if(needsReauth(res)){ reauth(status); return; }
      if(!res.ok){
        b.disabled = false;
        setStatus(status, (await detail(res)) || 'Could not remove that member.', 'error');
        return;
      }
      location.reload();
    } catch(err){
      b.disabled = false;
      setStatus(status, 'Network error — try again.', 'error');
    }
  });
});
`;

const MEMBERS_STYLE = `
.userform{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.75rem}
.userform input{flex:1;min-width:11rem}
.userform input#newmember{min-width:15rem;flex:1.4}
.member-row{align-items:flex-start}
.member-row .info{display:grid;gap:.3rem}
.member-row .info b{font-weight:650;letter-spacing:-.015em}
.member-row .art-badges{margin-top:.1rem}
.member-row .row-actions{align-items:center;flex-wrap:wrap;justify-content:flex-end}
.member-row select[data-member-role-select]{min-height:2.1rem}
.member-list .empty{padding:2.4rem 1.5rem}
`;

// --- page ----------------------------------------------------------------------

/** Everything the workspace Members panel needs to render. */
export interface MembersPageInput {
  viewer: PortalViewer;
  /** The workspace whose members this page shows. */
  account: AccountRow;
  members: MemberRow[];
  /**
   * Whether the requesting viewer may manage this workspace's membership —
   * i.e. `canManageMembers(identity, roles, account.id)`, already evaluated by
   * the caller. Rendering it here is courtesy, not security: hiding a control
   * never protects anything, and every route re-checks this and
   * `memberChangeDenial` for itself.
   */
  canManage: boolean;
  /** The viewer's own email, so their own row can say "that's you". */
  viewerEmail: string | null;
}

/**
 * The workspace-members panel: one row per member (email, role, status), a
 * role selector and remove control per row, and an invite form. The
 * *workspace* sibling of the platform People page (src/people.ts) — same
 * visual language, scoped to one account instead of the whole instance.
 */
export function membersPage(input: MembersPageInput): string {
  const plan = effectivePlan(input.account);
  const max = maxSeatsFor(plan);
  const used = input.members.length;
  const tiles = `<section class="stats" aria-label="Seats at a glance">
    ${statTile("seats-used", "Seats used", String(used), plural(used, "member"))}
    ${statTile("seats-max", "Seat limit", String(max), `${planLabel(plan)} plan`)}
    ${statTile(
      "seats-available",
      "Seats available",
      String(Math.max(max - used, 0)),
      used >= max ? "at the limit" : "ready to invite"
    )}
  </section>`;

  return portalShell({
    viewer: input.viewer,
    section: "members",
    title: `Members · ${input.account.name}`,
    heading: "Members",
    lede: `Who belongs to <b>${esc(
      input.account.name
    )}</b> — the workspace you are acting in — and what they can do inside it. Switch workspaces in
      the header to manage a different one. Seats are counted per workspace, not per platform sign-in.`,
    body: `${tiles}${membersPanel(input)}`,
    style: MEMBERS_STYLE,
    script: MEMBERS_SCRIPT,
  });
}
