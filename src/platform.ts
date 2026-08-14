import { esc } from "./pages";
import { portalShell, statTile, num, bytes, plural, stamp, type PortalViewer } from "./portal";
import { effectivePlan, overrideActive, type AccountRow } from "./accounts";
import { AUDIT_ACTION_LABEL, auditDetail, type AuditAction, type AuditRow } from "./audit";
import { OVERRIDABLE_PLANS, MAX_ACCOUNT_NOTES_LENGTH } from "./operator";
import type { AccountSummary, BillingEventRow, ContactRequestRow, MailLogRow } from "./operator";

/**
 * The operator control plane's pages: the `/admin/platform` readouts and the
 * per-account detail page that carries the controls (Production SaaS plan,
 * Phase 1).
 *
 * Split out of src/admin.ts rather than added to it, because this surface is a
 * different thing from the rest of the portal: every other section renders the
 * viewer's own workspace, and this one renders *everybody else's*. Keeping it in
 * its own module means the blast radius of an operator-only change is an
 * operator-only file, and it makes the one rule that governs the whole surface
 * greppable in one place.
 *
 * That rule: **nothing here decides who may look.** src/platform-routes.ts gates
 * the entire surface on the platform super admin before any of these functions
 * are called. A renderer that hid a control from the wrong person would be
 * pretending to be a security boundary; hiding a form has never protected
 * anything, and the routes re-check on every POST regardless.
 *
 * The second rule, which is why `plannedRow` exists: **no fake controls.** Where
 * the plan lists something that is not implemented (per-limit and per-seat
 * overrides), this renders a row that says "planned" rather than a form that
 * looks like it works. An operator who clicks a control and gets silence learns
 * to distrust the whole page.
 */

// --- small shared pieces ----------------------------------------------------

/** A timestamp, or an em dash. Never the word "null" on an operator's screen. */
function when(iso: string | null | undefined): string {
  return iso ? esc(stamp(iso)) : `<span class="faint">—</span>`;
}

/** Free text that may be absent, in the same shape. */
function text(value: string | null | undefined): string {
  return value ? esc(value) : `<span class="faint">—</span>`;
}

/** The human name for an audited action, falling back to the raw dotted key. */
export function auditLabel(action: string): string {
  return AUDIT_ACTION_LABEL[action as AuditAction] ?? action;
}

/**
 * A capability the plan names and this build does not have.
 *
 * Deliberately a badge and a sentence rather than a disabled input: a greyed-out
 * form still reads as "this exists, you just can't use it right now", which is a
 * different and wronger claim than "this was not built yet".
 */
export function plannedRow(key: string, label: string, detail: string): string {
  return `<div class="row" data-planned="${esc(key)}">
    <div class="info"><b>${esc(label)}</b><span class="hint">${detail}</span></div>
    <div class="row-actions"><span class="badge is-locked">Planned</span></div>
  </div>`;
}

/**
 * The result of the operator's last POST, carried across the redirect that
 * follows it (Post/Redirect/Get — a reload must never re-apply a suspension).
 */
export interface Flash {
  kind: "ok" | "error";
  message: string;
}

function flashBanner(flash: Flash | null): string {
  if (!flash) return "";
  return `<p class="op-flash" data-flash="${flash.kind}" role="status">${esc(flash.message)}</p>`;
}

/** The plan an account is actually entitled to, and what billing says, when they differ. */
function planCells(account: AccountRow, now: string): string {
  const effective = effectivePlan(account, now);
  const overridden = overrideActive(account, now);
  return `<td data-cell="plan"><span class="badge${overridden ? " is-open" : ""}" data-effective-plan="${esc(
    effective
  )}">${esc(effective)}</span></td>
    <td data-cell="billed-plan">${
      overridden
        ? `<span class="hint" data-billed-plan="${esc(account.plan)}">billed ${esc(account.plan)}</span>`
        : `<span class="faint">—</span>`
    }</td>`;
}

function statusBadge(account: AccountRow): string {
  return account.status === "suspended"
    ? `<span class="badge is-warn" data-account-status="suspended">Suspended</span>`
    : `<span class="badge is-active" data-account-status="active">Active</span>`;
}

// --- /admin/platform: the operator readouts ---------------------------------

/** Everything the platform page shows beyond the instance configuration. */
export interface OperatorData {
  accounts: AccountSummary[];
  audit: AuditRow[];
  auditTotal: number;
  contacts: ContactRequestRow[];
  billing: BillingEventRow[];
  mail: MailLogRow[];
  /** The search this list was filtered by, echoed back into the input. */
  q: string;
  /** Evaluated once per render, so every row on the page agrees about "now". */
  now: string;
}

function accountsPanel(data: OperatorData): string {
  const rows = data.accounts
    .map((s) => {
      const a = s.account;
      const href = `/admin/platform/accounts/${encodeURIComponent(a.id)}`;
      return `<tr data-account="${esc(a.id)}">
        <td data-cell="name"><a href="${esc(href)}">${esc(a.name)}</a>
          <span class="hint mono">${esc(a.id)}</span></td>
        <td data-cell="owner">${text(s.ownerEmail ?? a.personal_email)}</td>
        <td data-cell="kind">${esc(a.kind)}</td>
        ${planCells(a, data.now)}
        <td data-cell="status">${statusBadge(a)}</td>
        <td data-cell="members" class="numeric">${num(s.memberCount)}</td>
        <td data-cell="artifacts" class="numeric">${num(s.artifactCount)}</td>
        <td data-cell="storage" class="numeric">${esc(bytes(s.storageBytes))}</td>
        <td data-cell="last-publish">${when(s.lastPublishAt)}</td>
      </tr>`;
    })
    .join("");

  // A GET form: the filtered list is a URL an operator can bookmark and send.
  const search = `<form class="op-search" method="get" action="/admin/platform" data-account-search>
    <label class="sr-only" for="op-q">Filter accounts</label>
    <input id="op-q" type="search" name="q" value="${esc(data.q)}"
      placeholder="Filter by workspace, id or email…" autocomplete="off">
    <button type="submit" class="ghost small">Filter</button>
    ${data.q ? `<a class="ghost link-button small-link" href="/admin/platform">Clear</a>` : ""}
  </form>`;

  return `<section class="panel" data-panel="platform-accounts" aria-labelledby="accounts-h">
    <div class="panel-head"><div>
      <h2 id="accounts-h">Accounts <span class="hint">${plural(data.accounts.length, "workspace")}</span></h2>
      <p class="hint">Every workspace on this instance, most recently changed first. <b>Plan</b> is what
        the account is actually entitled to — an operator override when one is live, otherwise what
        billing says.</p>
    </div>${search}</div>
    ${
      data.accounts.length
        ? `<div class="op-scroll"><table class="optable" data-table="accounts">
      <thead><tr>
        <th scope="col">Workspace</th><th scope="col">Owner</th><th scope="col">Kind</th>
        <th scope="col">Plan</th><th scope="col">Billed</th><th scope="col">Status</th>
        <th scope="col" class="numeric">Members</th><th scope="col" class="numeric">Artifacts</th>
        <th scope="col" class="numeric">Storage</th><th scope="col">Last publish</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`
        : `<p class="note" data-empty="accounts">${
            data.q
              ? "No workspace matches that filter."
              : "No workspaces yet — one is created the first time somebody publishes."
          }</p>`
    }
  </section>`;
}

/** One audit row, in the compact form both this page and the detail page use. */
function auditRowHtml(row: AuditRow): string {
  const detail = auditDetail(row);
  const target =
    row.target_type === "account" && row.target_id
      ? `<a href="/admin/platform/accounts/${encodeURIComponent(row.target_id)}">${esc(row.target_id)}</a>`
      : text(row.target_id);
  return `<div class="row" data-audit="${row.id}" data-audit-action="${esc(row.action)}">
    <div class="info"><b>${esc(auditLabel(row.action))}</b>
      <span class="hint">${esc(row.summary ?? "")}</span>
      <span class="hint mono">${when(row.created_at)} · ${esc(
        row.actor_email ?? (row.actor_role === "system" ? "system" : "unknown")
      )} · ${target}</span>
      ${
        detail
          ? `<details class="op-detail"><summary>Detail</summary><pre class="mono">${esc(
              JSON.stringify(detail, null, 2)
            )}</pre></details>`
          : ""
      }
    </div>
  </div>`;
}

function auditPanel(rows: AuditRow[], total: number, scope: "instance" | "account"): string {
  return `<section class="panel" data-panel="platform-audit" aria-labelledby="audit-h">
    <div class="panel-head"><div>
      <h2 id="audit-h">Audit trail <span class="hint">${
        scope === "instance" ? `${plural(total, "entry")} in total` : plural(rows.length, "entry")
      }</span></h2>
      <p class="hint">Append-only. Every operator control writes its row in the same database
        transaction as the change it records, so there is no action here that could have happened
        without leaving one.</p>
    </div></div>
    ${
      rows.length
        ? rows.map(auditRowHtml).join("")
        : `<p class="note" data-empty="audit">Nothing recorded yet${
            scope === "account" ? " for this workspace" : ""
          }.</p>`
    }
  </section>`;
}

function contactsPanel(rows: ContactRequestRow[]): string {
  const list = rows
    .map(
      (r) => `<div class="row" data-contact="${r.id}">
      <div class="info"><b>${esc(r.email)}</b>
        <span class="hint">${when(r.created_at)}${r.plan ? ` · asked about ${esc(r.plan)}` : ""}</span>
        ${r.message ? `<span class="hint op-message">${esc(r.message)}</span>` : ""}
      </div>
      <div class="row-actions"><a href="mailto:${esc(r.email)}">Reply ↗</a></div>
    </div>`
    )
    .join("");
  return `<section class="panel" data-panel="platform-contacts" aria-labelledby="contacts-h">
    <div class="panel-head"><div>
      <h2 id="contacts-h">Enquiries <span class="hint">${plural(rows.length, "request")}</span></h2>
      <p class="hint">Everything submitted through <span class="mono">/contact</span> — the "Talk to
        us" button on the Team and Enterprise pages. Nothing else notifies anybody, so this list is
        the only place these arrive.</p>
    </div></div>
    ${list || `<p class="note" data-empty="contacts">No enquiries yet.</p>`}
  </section>`;
}

function billingPanel(rows: BillingEventRow[], scope: "instance" | "account"): string {
  const list = rows
    .map(
      (r) => `<div class="row" data-billing-event="${esc(r.id)}">
      <div class="info"><b>${esc(r.event_name)}</b>
        <span class="hint mono">${when(r.processed_at)}${
          scope === "instance" && r.account_id
            ? ` · <a href="/admin/platform/accounts/${encodeURIComponent(r.account_id)}">${esc(r.account_id)}</a>`
            : ""
        }</span></div>
    </div>`
    )
    .join("");
  return `<section class="panel" data-panel="platform-billing" aria-labelledby="billing-h">
    <div class="panel-head"><div>
      <h2 id="billing-h">Billing events <span class="hint">${plural(rows.length, "delivery")}</span></h2>
      <p class="hint">Lemon Squeezy webhook deliveries this instance has accepted. Each id is recorded
        once, so a redelivery is visible here exactly as often as it was processed.</p>
    </div></div>
    ${list || `<p class="note" data-empty="billing">No webhook deliveries recorded.</p>`}
  </section>`;
}

function mailPanel(rows: MailLogRow[]): string {
  const failed = rows.filter((r) => r.status === "failed").length;
  const list = rows
    .map(
      (r) => `<div class="row" data-mail="${r.id}" data-mail-status="${esc(r.status)}">
      <div class="info"><b>${esc(r.email)}</b>
        <span class="hint">${esc(r.kind)} · ${when(r.created_at)}${
          r.error_code ? ` · ${esc(r.error_code)}` : ""
        }</span></div>
      <div class="row-actions">${
        r.status === "failed"
          ? `<span class="badge is-warn">Failed</span>`
          : `<span class="badge is-active">${esc(r.status)}</span>`
      }</div>
    </div>`
    )
    .join("");
  return `<section class="panel" data-panel="platform-mail" aria-labelledby="mail-h">
    <div class="panel-head"><div>
      <h2 id="mail-h">Transactional mail <span class="hint">${
        failed ? `${plural(failed, "failure")} in the last ${num(rows.length)}` : "all delivered"
      }</span></h2>
      <p class="hint">Sign-in codes, share invitations and read receipts. This is what answers
        "they say they never got the email".</p>
    </div></div>
    ${list || `<p class="note" data-empty="mail">No mail sent yet.</p>`}
  </section>`;
}

/** The operator half of `/admin/platform`, appended after the configuration readout. */
export function operatorSections(data: OperatorData): string {
  return `${accountsPanel(data)}
    ${auditPanel(data.audit, data.auditTotal, "instance")}
    ${contactsPanel(data.contacts)}
    <div class="pcols">
      ${billingPanel(data.billing, "instance")}
      ${mailPanel(data.mail)}
    </div>`;
}

// --- /admin/platform/accounts/:id -------------------------------------------

export interface AccountDetail {
  summary: AccountSummary;
  audit: AuditRow[];
  billing: BillingEventRow[];
  now: string;
  flash: Flash | null;
}

/** The numbers, up top, before any control that could change them. */
function detailStats(s: AccountSummary): string {
  return `<section class="stats" aria-label="Workspace totals">
    ${statTile("account-members", "Members", num(s.memberCount), "in this workspace")}
    ${statTile("account-artifacts", "Artifacts", num(s.artifactCount), "published")}
    ${statTile("account-storage", "Storage", bytes(s.storageBytes), "across every version")}
    ${statTile(
      "account-last-publish",
      "Last publish",
      s.lastPublishAt ? stamp(s.lastPublishAt).slice(0, 10) : "never",
      s.lastPublishAt ? stamp(s.lastPublishAt) : "nothing published yet"
    )}
  </section>`;
}

function identityPanel(s: AccountSummary): string {
  const a = s.account;
  return `<section class="panel" data-panel="account-identity" aria-labelledby="identity-h">
    <div class="panel-head"><div>
      <h2 id="identity-h">Workspace</h2>
      <p class="hint">Who this account is. Nothing on this page is shown to the customer.</p>
    </div></div>
    <div class="row" data-field="id">
      <div class="info"><b>Account id</b><span class="hint">Opaque and never derived from an email.</span></div>
      <div class="row-actions"><span class="mono">${esc(a.id)}</span></div>
    </div>
    <div class="row" data-field="kind">
      <div class="info"><b>Kind</b><span class="hint">${
        a.kind === "personal"
          ? "Created automatically for one identity the first time they published."
          : "A shared workspace with its own membership."
      }</span></div>
      <div class="row-actions"><span class="badge">${esc(a.kind)}</span></div>
    </div>
    <div class="row" data-field="owner">
      <div class="info"><b>Owner</b><span class="hint">The first owner in the workspace.</span></div>
      <div class="row-actions"><span class="mono">${text(s.ownerEmail ?? a.personal_email)}</span></div>
    </div>
    <div class="row" data-field="created">
      <div class="info"><b>Created</b><span class="hint">by ${text(a.created_by)}</span></div>
      <div class="row-actions">${when(a.created_at)}</div>
    </div>
    <div class="row" data-field="updated">
      <div class="info"><b>Last changed</b><span class="hint">Any write to the account row.</span></div>
      <div class="row-actions">${when(a.updated_at)}</div>
    </div>
  </section>`;
}

/**
 * The entitlement panel: what the account gets, what it pays for, and the two
 * controls that move the first without touching the second.
 */
function planPanel(s: AccountSummary, now: string): string {
  const a = s.account;
  const id = encodeURIComponent(a.id);
  const effective = effectivePlan(a, now);
  const live = overrideActive(a, now);
  const expired = !!a.plan_override && !live;
  const options = OVERRIDABLE_PLANS.map(
    (p) => `<option value="${esc(p)}"${p === effective ? " selected" : ""}>${esc(p)}</option>`
  ).join("");

  const state = `<div class="row" data-field="effective-plan">
      <div class="info"><b>Effective plan</b><span class="hint">What quota, seats and the monthly
        view limit are actually computed from.</span></div>
      <div class="row-actions"><span class="badge${live ? " is-open" : ""}"
        data-effective-plan="${esc(effective)}">${esc(effective)}</span></div>
    </div>
    <div class="row" data-field="billed-plan">
      <div class="info"><b>Billed plan</b><span class="hint">What the Lemon Squeezy subscription says.
        An override never writes this, which is why clearing one hands the account back to billing
        rather than to whatever it held when the override was applied.</span></div>
      <div class="row-actions"><span class="badge" data-billed-plan="${esc(a.plan)}">${esc(a.plan)}</span></div>
    </div>
    <div class="row" data-field="override-state" data-override="${live ? "active" : expired ? "expired" : "none"}">
      <div class="info"><b>Operator override</b><span class="hint">${
        live
          ? `On ${esc(a.plan_override!)} ${
              a.plan_override_expires_at ? `until ${esc(stamp(a.plan_override_expires_at))}` : "with no expiry"
            }, set by ${esc(a.plan_override_by ?? "unknown")} ${
              a.plan_override_at ? `on ${esc(stamp(a.plan_override_at))}` : ""
            }.${a.plan_override_note ? ` Note: ${esc(a.plan_override_note)}` : ""}`
          : expired
            ? `Expired — the ${esc(a.plan_override!)} override ran out${
                a.plan_override_expires_at ? ` on ${esc(stamp(a.plan_override_expires_at))}` : ""
              } and is now inert. Clear it to tidy the record.`
            : "None. The account gets what it pays for."
      }</span></div>
      <div class="row-actions">${
        live
          ? `<span class="badge is-open">Active</span>`
          : expired
            ? `<span class="badge is-warn">Expired</span>`
            : `<span class="badge is-locked">None</span>`
      }</div>
    </div>`;

  const setForm = `<form class="op-form" method="post"
      action="/admin/platform/accounts/${id}/plan-override" data-form="plan-override">
    <div class="field-grid">
      <div>
        <label for="ov-plan">Put this workspace on</label>
        <select id="ov-plan" name="plan" required>${options}</select>
      </div>
      <div>
        <label for="ov-expires">Until <span class="faint">(optional — blank means indefinitely)</span></label>
        <input id="ov-expires" name="expires_at" type="date" autocomplete="off">
      </div>
    </div>
    <label for="ov-note">Why <span class="faint">(optional, recorded on the account)</span></label>
    <input id="ov-note" name="note" placeholder="Comped for the pilot — invoice by bank transfer"
      autocomplete="off" maxlength="500">
    <div class="row-actions"><button type="submit" class="small">Apply override</button></div>
  </form>`;

  const clearForm = a.plan_override
    ? `<form class="op-form" method="post"
        action="/admin/platform/accounts/${id}/clear-plan-override" data-form="clear-plan-override">
      <div class="row-actions">
        <button type="submit" class="ghost small">Clear override — return to ${esc(a.plan)}</button>
      </div>
    </form>`
    : "";

  return `<section class="panel" data-panel="account-plan" aria-labelledby="plan-h">
    <div class="panel-head"><div>
      <h2 id="plan-h">Entitlement</h2>
      <p class="hint">An override is the manual escape hatch: it moves what the account <i>gets</i>
        without touching what it <i>pays</i>. A billing webhook that lands while one is live updates
        the billed plan and writes an audit row, and the override still wins.</p>
    </div></div>
    ${state}
    ${setForm}
    ${clearForm}
    ${plannedRow(
      "limit-overrides",
      "Per-limit overrides",
      `Raising just the artifact, storage or view cap for one account is not built. Move the
       workspace between plans instead — that is what the control above does.`
    )}
    ${plannedRow(
      "seat-overrides",
      "Extra seats",
      `Seats come from the effective plan (<span class="mono">maxSeats</span> in src/quota.ts). There
       is no per-account seat grant.`
    )}
  </section>`;
}

/**
 * Suspension. Rendered as a danger zone rather than a row of buttons because it
 * is the one control here that a customer feels immediately: publishing stops
 * and every artifact stops serving.
 */
function statusPanel(a: AccountRow): string {
  const id = encodeURIComponent(a.id);
  const suspended = a.status === "suspended";
  const history = `<div class="row" data-field="status">
      <div class="info"><b>Status</b><span class="hint">${
        suspended
          ? `Suspended${a.suspended_at ? ` on ${esc(stamp(a.suspended_at))}` : ""}${
              a.suspended_by ? ` by ${esc(a.suspended_by)}` : ""
            }.${a.suspended_reason ? ` Reason: ${esc(a.suspended_reason)}` : ""} Nothing was deleted.`
          : `Active.${
              a.suspended_reason
                ? ` Previously suspended — the last recorded reason was: ${esc(a.suspended_reason)}.`
                : ""
            }`
      }</span></div>
      <div class="row-actions">${statusBadge(a)}</div>
    </div>`;

  const control = suspended
    ? `<form class="op-form" method="post" action="/admin/platform/accounts/${id}/unsuspend"
        data-form="unsuspend">
      <div class="row-actions"><button type="submit" class="small">Lift the suspension</button>
        <span class="hint">Publishing and serving resume immediately.</span></div>
    </form>`
    : `<form class="op-form" method="post" action="/admin/platform/accounts/${id}/suspend"
        data-form="suspend">
      <label for="sus-reason">Reason <span class="faint">(optional, kept even after unsuspending)</span></label>
      <input id="sus-reason" name="reason" placeholder="Chargeback opened 2026-08-14" autocomplete="off"
        maxlength="500">
      <div class="row-actions"><button type="submit" class="danger small">Suspend this workspace</button></div>
    </form>`;

  return `<section class="panel" data-panel="account-status" aria-labelledby="status-h">
    <div class="panel-head"><div>
      <h2 id="status-h">Status</h2>
      <p class="hint">A suspended workspace cannot publish, and its artifacts stop serving to
        everyone except a platform admin. Nothing is deleted, and unsuspending restores exactly what
        was there — which is what makes this usable for a payment dispute, not only for an ending.</p>
    </div></div>
    ${history}
    ${control}
  </section>`;
}

function notesPanel(a: AccountRow): string {
  const id = encodeURIComponent(a.id);
  return `<section class="panel" data-panel="account-notes" aria-labelledby="notes-h">
    <div class="panel-head"><div>
      <h2 id="notes-h">Operator notes</h2>
      <p class="hint">Whatever future-you needs to know about this account. Never shown to the
        customer. The text is not copied into the audit trail — only the fact that it changed.</p>
    </div></div>
    <form class="op-form" method="post" action="/admin/platform/accounts/${id}/notes" data-form="notes">
      <label class="sr-only" for="acct-notes">Notes</label>
      <textarea id="acct-notes" name="notes" rows="5" maxlength="${MAX_ACCOUNT_NOTES_LENGTH}"
        placeholder="Migrating from a self-hosted instance. Invoices by bank transfer.">${esc(
          a.notes ?? ""
        )}</textarea>
      <div class="row-actions"><button type="submit" class="small">Save notes</button>
        <span class="hint">Up to ${num(MAX_ACCOUNT_NOTES_LENGTH)} characters. Saving an empty box clears them.</span></div>
    </form>
  </section>`;
}

export function platformAccountPage(viewer: PortalViewer, d: AccountDetail): string {
  const a = d.summary.account;
  return portalShell({
    viewer,
    section: "platform",
    title: `${a.name} · Platform`,
    heading: a.name,
    lede: `Everything this deployment knows about <span class="mono">${esc(a.id)}</span>, and the
      controls that change what it may do.`,
    crumbs: [{ label: "Platform", href: "/admin/platform" }, { label: a.name }],
    body: `${flashBanner(d.flash)}
      ${detailStats(d.summary)}
      ${identityPanel(d.summary)}
      ${planPanel(d.summary, d.now)}
      ${statusPanel(a)}
      ${notesPanel(a)}
      ${auditPanel(d.audit, d.audit.length, "account")}
      ${billingPanel(d.billing, "account")}`,
    style: PLATFORM_STYLE,
  });
}

// --- styles -----------------------------------------------------------------

/**
 * The operator surface is the one place in the product with a real table. Every
 * other section shows one workspace's worth of things and reads better as cards;
 * this one is a dozen accounts × ten columns, and a card grid for that is a
 * scavenger hunt.
 */
export const PLATFORM_STYLE = `
.op-scroll{overflow-x:auto;margin:0 -.35rem}
.optable{width:100%;border-collapse:collapse;font-size:.86rem}
.optable th,.optable td{text-align:left;padding:.55rem .5rem;border-bottom:1px solid var(--border);
  vertical-align:top;white-space:nowrap}
.optable thead th{font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);
  font-weight:600;border-bottom:1px solid var(--border-strong)}
.optable tbody tr:last-child td{border-bottom:0}
.optable tbody tr:hover{background:rgba(255,255,255,.03)}
.optable .numeric{text-align:right;font-variant-numeric:tabular-nums}
.optable td[data-cell=name]{white-space:normal;min-width:12rem}
.optable td[data-cell=name] a{font-weight:620;color:var(--fg)}
.optable td[data-cell=name] a:hover{color:var(--accent)}
.optable td[data-cell=name] .hint{display:block;font-size:.72rem}

.op-search{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;flex:none}
.op-search input{margin:0;min-width:15rem}

.op-form{margin-top:1.05rem;padding-top:1.05rem;border-top:1px solid var(--border)}
.op-form .row-actions{margin-top:.75rem}
.op-form textarea{font-family:inherit}

/* The outcome of the operator's last action, carried across the redirect that
   follows it. A sentence on the page, not a toast that vanishes before it is
   read — and never colour alone: the text always says what happened. */
.op-flash{background:var(--card);border:1px solid var(--border);border-left:3px solid var(--accent);
  border-radius:var(--radius);padding:.8rem 1.05rem;margin:0 0 1.25rem;font-size:.92rem;color:var(--fg)}
.op-flash[data-flash=error]{border-left-color:var(--danger)}

.op-message{white-space:pre-wrap;margin-top:.3rem}
.op-detail{margin-top:.35rem}
.op-detail summary{font-size:.78rem;color:var(--muted);cursor:pointer}
.op-detail pre{margin:.4rem 0 0;font-size:.75rem;color:var(--muted);white-space:pre-wrap;
  background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:10px;padding:.55rem .7rem}

.panel[data-panel=platform-accounts] .panel-head{align-items:center}
@media(max-width:720px){.op-search input{min-width:0;width:100%}}
`;
