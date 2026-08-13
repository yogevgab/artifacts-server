import type { ArtifactRow, VersionRow, ViewRow } from "./env";
import { layout, esc } from "./pages";
import { MAX_UPLOAD_BYTES } from "./upload";
import { isTokenUsable, MAX_TOKEN_NAME_LENGTH, type PublicApiToken } from "./tokens";
import { MAX_DISPLAY_NAME_LENGTH, MAX_NOTES_LENGTH, type PublicUser } from "./users";
import type { AllowlistView } from "./access-api";

export interface ViewsInfo {
  counts: Map<string, { total: number; unique: number }>;
  recent: Map<string, ViewRow[]>;
}

/** Everything the People panel needs. Mirrors the GET /api/users payload. */
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

/**
 * Who is looking at the dashboard. `users` is the people directory, which is
 * admin-only data — it is null for a beta user, who sees only their own
 * artifacts and no team management at all. `tokens` is null when the caller
 * may not manage tokens at all (an API-token caller), mirroring the API.
 */
export interface DashboardViewer {
  isAdmin: boolean;
  users: UsersInfo | null;
  tokens: PublicApiToken[] | null;
}

// --- formatting helpers -----------------------------------------------------

function num(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function plural(n: number, word: string): string {
  return `${num(n)} ${word}${n === 1 ? "" : "s"}`;
}

function people(n: number): string {
  return n === 1 ? "1 person" : `${num(n)} people`;
}

function stamp(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

// --- pieces -----------------------------------------------------------------

function statTile(key: string, label: string, value: string, hint: string): string {
  return `<div class="stat" data-stat="${esc(key)}">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value" data-stat-value>${esc(value)}</div>
    <div class="stat-hint">${esc(hint)}</div>
  </div>`;
}

/**
 * Drag-and-drop target for a publish form. The real file inputs stay in the
 * DOM (visually hidden but focusable) so keyboard users and no-JS submits keep
 * working; the script mirrors dropped files into them.
 */
function dropzone(idle: string, sub: string, compact = false): string {
  return `<div class="dropzone${compact ? " compact" : ""}" data-dropzone>
    <div class="dz-icon" aria-hidden="true">↑</div>
    <p class="dz-title" data-pick-label data-idle="${esc(idle)}">${esc(idle)}</p>
    <p class="dz-sub">${esc(sub)}</p>
    <div class="dz-actions">
      <button type="button" class="ghost small" data-browse="file">Choose .html</button>
      <button type="button" class="ghost small" data-browse="bundle">Choose .zip</button>
      <button type="button" class="ghost small" data-clear-pick hidden>Clear</button>
    </div>
    <input class="sr-file" type="file" name="file" accept=".html,.htm" aria-label="Single HTML file">
    <input class="sr-file" type="file" name="bundle" accept=".zip" aria-label="Zip bundle">
  </div>`;
}

function publishPanel(): string {
  const cap = `${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`;
  return `<section class="panel publish" aria-labelledby="publish-h">
    <div class="panel-head">
      <div>
        <h2 id="publish-h">Publish an artifact</h2>
        <p class="hint">Drop a file to ship it. New artifacts start private — only you can see them
          until you grant access.</p>
      </div>
    </div>

    <form id="up" data-publish-form>
      ${dropzone("Drop a .html page or .zip bundle here", `Single-file pages, or a zip with index.html at the root · up to ${cap}`)}
      <div class="field-grid">
        <div><label for="pub-title">Title *</label>
          <input id="pub-title" name="title" required placeholder="Q3 Landing Page" autocomplete="off"></div>
        <div><label for="pub-slug">Slug <span class="faint">(optional — derived from the title)</span></label>
          <input id="pub-slug" name="slug" placeholder="q3-landing" autocomplete="off"></div>
      </div>
      <div><label for="pub-desc">Description <span class="faint">(optional)</span></label>
        <textarea id="pub-desc" name="description" rows="2" placeholder="What is this page for?"></textarea></div>
      <div class="publish-foot">
        <button type="submit">Publish</button>
        <span class="hint">Publishing an existing slug adds a new version and takes it live —
          previous versions are kept.</span>
      </div>
      <p class="status" id="publish-msg" data-publish-error role="alert" hidden></p>
    </form>

    <div class="published" data-publish-success hidden>
      <div class="published-head"><span class="tick" aria-hidden="true">✓</span>
        <div><b data-published-title>Published</b>
          <div class="hint" data-published-meta></div></div>
      </div>
      <label for="published-url">Share link</label>
      <div class="linkrow">
        <input id="published-url" data-artifact-url readonly spellcheck="false">
        <button type="button" data-copy-link>Copy link</button>
      </div>
      <p class="hint">This artifact is private until you grant access below.</p>
      <div class="published-actions">
        <a class="ghost link-button" data-open-link target="_blank" rel="noopener">Open artifact ↗</a>
        <button type="button" class="ghost" data-publish-another>Publish another</button>
        <button type="button" class="ghost" data-refresh>Refresh dashboard</button>
      </div>
    </div>
  </section>`;
}

function versionsPanel(r: ArtifactRow, versions: VersionRow[]): string {
  const list = versions
    .map((v) => {
      const isCur = v.version === r.current_version;
      const meta = [
        v.created_at.slice(0, 10),
        `${plural(v.file_count, "file")} · ${bytes(v.size_bytes)}`,
        v.note ? esc(v.note) : "",
        v.created_by ? esc(v.created_by) : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `<div class="row" data-version="${v.version}">
        <div class="info"><b>v${v.version}${isCur ? ' <span class="badge is-open">live</span>' : ""}</b>
          <span class="hint">${meta}</span></div>
        <div class="row-actions"><a href="/v/${esc(r.slug)}/${v.version}/" target="_blank" rel="noopener">preview ↗</a>
          ${isCur ? "" : `<button class="ghost small" data-slug="${esc(r.slug)}" data-current="${v.version}">Make live</button>`}
        </div>
      </div>`;
    })
    .join("");
  return `<div class="sub-panel" data-panel="versions">
    <h4>Versions <span class="hint">${plural(versions.length, "version")}</span></h4>
    ${list || `<p class="note">No version history recorded yet.</p>`}
    <form class="newver" data-newver>
      <input type="hidden" name="slug" value="${esc(r.slug)}">
      ${dropzone("Drop a new version here", "Replaces what visitors see — older versions stay available", true)}
      <input type="text" name="note" placeholder="What changed? (optional note)" autocomplete="off">
      <div class="row-actions"><button type="submit" class="small">Upload new version</button>
        <span class="status" data-status hidden></span></div>
    </form>
  </div>`;
}

function viewsPanel(slug: string, info: ViewsInfo): string {
  const c = info.counts.get(slug) ?? { total: 0, unique: 0 };
  const recent = info.recent.get(slug) ?? [];
  const rows = recent
    .map(
      (v) => `<div class="row"><div class="info">${esc(v.email ?? "anonymous")}
        <span class="hint">${stamp(v.viewed_at)} · v${v.version}${v.country ? " · " + esc(v.country) : ""}${v.path ? " · /" + esc(v.path) : ""}</span></div></div>`
    )
    .join("");
  return `<div class="sub-panel" data-panel="views">
    <h4>Views <span class="hint">${plural(c.total, "view")} · ${plural(c.unique, "viewer")}</span></h4>
    ${
      recent.length
        ? rows
        : `<p class="note">No views yet — copy the share link above and send it to someone who has access.</p>`
    }
  </div>`;
}

function accessPanel(r: ArtifactRow, emails: string[]): string {
  const restricted = r.visibility === "restricted";
  return `<div class="sub-panel" data-panel="access" id="acc-${esc(r.slug)}">
    <h4>Access</h4>
    <label for="vis-${esc(r.slug)}">Who can open this artifact</label>
    <select id="vis-${esc(r.slug)}" name="visibility" data-vis="${esc(r.slug)}">
      <option value="restricted"${restricted ? " selected" : ""}>Restricted — only the people you list (plus admins)</option>
      <option value="everyone"${!restricted ? " selected" : ""}>Everyone — any signed-in user</option>
    </select>
    <div class="emails-wrap"${restricted ? "" : " hidden"}>
      <label for="em-${esc(r.slug)}">Allowed emails <span class="faint">(comma or newline separated)</span></label>
      <textarea id="em-${esc(r.slug)}" name="emails" rows="2" placeholder="alice@example.com, bob@example.com">${esc(emails.join(", "))}</textarea>
      <p class="hint">${
        emails.length
          ? `${people(emails.length)} can open it today.`
          : "Nobody else can open this yet — add an email to share it."
      }</p>
    </div>
    <div class="row-actions"><button class="small" data-save="${esc(r.slug)}">Save access</button>
      <span class="status acc-status" data-status hidden></span></div>
  </div>`;
}

function artifactCard(
  r: ArtifactRow,
  emails: string[],
  vers: VersionRow[],
  views: ViewsInfo,
  showOwner = false
): string {
  const viewCount = views.counts.get(r.slug)?.total ?? 0;
  const visBadge =
    r.visibility === "everyone"
      ? `<span class="badge is-open" data-badge="visibility">Everyone</span>`
      : `<span class="badge is-locked" data-badge="visibility">Restricted · ${num(emails.length)}</span>`;
  const verBadge = `<span class="badge" data-badge="version">v${r.current_version}${
    vers.length > 1 ? ` of ${vers.length}` : ""
  }</span>`;
  const fileBadge = `<span class="badge" data-badge="files">${plural(r.file_count, "file")}</span>`;
  const viewBadge = `<span class="badge" data-badge="views">${plural(viewCount, "view")}</span>`;
  // Admins manage everyone's artifacts, so they need to see whose each one is.
  const ownerBadge =
    showOwner && r.owner_email
      ? `<span class="badge" data-badge="owner">${esc(r.owner_email)}</span>`
      : "";

  const search = `${r.title} ${r.slug} ${r.description ?? ""} ${showOwner ? r.owner_email ?? "" : ""}`.toLowerCase();
  const bodyId = `art-${esc(r.slug)}`;
  // A disclosure button (rather than <details>/<summary>) keeps the row's own
  // links and buttons out of the summary's activation target — nesting them
  // there makes them unreliable for keyboard and screen-reader users.
  return `<article class="artifact" data-artifact="${esc(r.slug)}" data-search="${esc(search)}">
    <div class="art-head">
      <button type="button" class="art-toggle" aria-expanded="false" aria-controls="${bodyId}">
        <span class="chevron" aria-hidden="true">▸</span>
        <span class="art-id">
          <span class="art-title">${esc(r.title)}</span>
          <span class="mono art-slug">/${esc(r.slug)}/</span>
          ${r.description ? `<span class="hint art-desc">${esc(r.description)}</span>` : ""}
        </span>
        <span class="art-badges">${visBadge}${verBadge}${fileBadge}${viewBadge}${ownerBadge}
          <span class="badge">${esc(r.type)}</span></span>
      </button>
      <div class="art-actions">
        <a href="/${esc(r.slug)}/" target="_blank" rel="noopener">Open ↗</a>
        <button class="ghost small" data-copy="/${esc(r.slug)}/">Copy link</button>
        <button class="danger small" data-del="${esc(r.slug)}">Delete</button>
      </div>
    </div>
    <div class="art-body" id="${bodyId}" hidden>
      ${versionsPanel(r, vers)}
      ${viewsPanel(r.slug, views)}
      ${accessPanel(r, emails)}
    </div>
  </article>`;
}

// --- people -----------------------------------------------------------------

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

/**
 * The People panel: the local directory first, Cloudflare Access as a fact about
 * each person rather than the list itself. That inversion is the point of issue
 * #24 — an operator thinks in people ("has Dana signed in yet?"), not in policy
 * rows.
 */
function usersPanel(info: UsersInfo): string {
  const counts = {
    active: info.users.filter((u) => u.status === "active").length,
    invited: info.users.filter((u) => u.status === "invited").length,
    paused: info.users.filter((u) => u.status === "disabled").length,
  };
  const summary = [
    `${counts.active} active`,
    counts.invited ? `${counts.invited} invited` : "",
    counts.paused ? `${counts.paused} paused` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const rows = info.users.map((u) => userRow(u, info)).join("");

  return `<section class="panel" data-panel="users" aria-labelledby="users-h">
    <div class="panel-head"><div>
      <h2 id="users-h">People <span class="hint" data-user-summary>${esc(summary)}</span></h2>
      <p class="hint">Cloudflare Access verifies every sign-in; this is who the product knows
        about. Inviting somebody adds them to the Access allow-list — grant them individual
        artifacts below.</p>
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
        <p>Invite the first beta user above. They'll get a one-time code by email the first
          time they open the dashboard — there's no password to share.</p></div>`
    }</div>
  </section>`;
}

// --- API tokens -------------------------------------------------------------

type TokenState = "active" | "expired" | "revoked";

/** Revoked wins over expired, so a revoked row never reads as merely stale. */
function tokenState(t: PublicApiToken, now: Date): TokenState {
  if (t.revoked_at) return "revoked";
  return isTokenUsable(t, now) ? "active" : "expired";
}

function tokenRow(t: PublicApiToken, now: Date, showOwner: boolean): string {
  const state = tokenState(t, now);
  const stateBadge =
    state === "revoked"
      ? `<span class="badge is-revoked" data-badge="token-state">Revoked</span>`
      : state === "expired"
        ? `<span class="badge is-locked" data-badge="token-state">Expired</span>`
        : `<span class="badge is-open" data-badge="token-state">Active</span>`;
  // An admin token manages every artifact, so it is worth calling out even in a
  // beta user's own list (an admin may have issued one on their behalf).
  const adminBadge = t.is_admin ? `<span class="badge" data-badge="token-admin">admin</span>` : "";
  const meta = [
    `<span class="mono">${esc(t.id)}</span>`,
    esc(t.scopes.join(" · ")),
    // Only an admin sees other people's tokens, so only they need the owner.
    showOwner ? esc(t.owner_email ?? "no owner") : "",
    `created ${stamp(t.created_at)}`,
    t.last_used_at ? `last used ${stamp(t.last_used_at)}` : "never used",
    t.revoked_at
      ? `revoked ${stamp(t.revoked_at)}`
      : t.expires_at
        ? `expires ${stamp(t.expires_at)}`
        : "no expiry",
  ]
    .filter(Boolean)
    .join(" · ");
  // Revoking is a tombstone, so an already-revoked token has no action left —
  // the badge and the meta line already say so.
  const action =
    state === "revoked"
      ? ""
      : `<button class="ghost small" data-revoke="${esc(t.id)}">Revoke</button>`;
  return `<div class="row" data-token="${esc(t.id)}" data-token-state="${state}" data-token-name="${esc(t.name)}">
    <div class="info"><b>${esc(t.name)} ${stateBadge}${adminBadge}</b>
      <span class="hint">${meta}</span></div>
    <div class="row-actions">${action}<span class="status" data-status hidden></span></div>
  </div>`;
}

/**
 * Token management. The secret is shown exactly once, right after creation —
 * the list can only ever render metadata, because that is all the API returns.
 * A beta user may only mint tokens that act as themselves, so the owner/admin
 * controls are rendered for admins only (the API enforces this regardless).
 */
function tokensPanel(tokens: PublicApiToken[], isAdmin: boolean): string {
  const now = new Date();
  const active = tokens.filter((t) => tokenState(t, now) === "active").length;
  const rows = tokens.map((t) => tokenRow(t, now, isAdmin)).join("");

  const scopeBox = (value: string, hint: string, checked: boolean) =>
    `<label class="check"><input type="checkbox" name="scope" value="${value}"${checked ? " checked" : ""}>
      <span><b>${value}</b> <span class="faint">— ${esc(hint)}</span></span></label>`;

  const adminFields = isAdmin
    ? `<div class="field-grid" data-token-admin-fields>
        <div><label for="tok-owner">Owner email <span class="faint">(the beta user it acts as)</span></label>
          <input id="tok-owner" name="owner_email" type="email" placeholder="person@example.com" autocomplete="off"></div>
        <div><span class="field-label">Admin token</span>
          <label class="check"><input type="checkbox" id="tok-admin" name="is_admin">
            <span>Manages every artifact <span class="faint">— admin reach wins even when an owner is set</span></span></label></div>
      </div>`
    : `<p class="note" data-token-self-only>Tokens you create act as you — same artifacts, never more.
        Ask an admin if you need a token for someone else.</p>`;

  return `<section class="panel" data-panel="tokens" aria-labelledby="tokens-h">
    <div class="panel-head"><div>
      <h2 id="tokens-h">API tokens <span class="hint" data-token-active-count="${active}">${plural(active, "active token")}</span></h2>
      <p class="hint">Bearer credentials for the CLI, Hermes Cloud and CI. A token publishes as its
        owner and can be narrowed by scope — it can never manage tokens or team members.</p>
    </div></div>

    <form id="tokenform" data-token-form>
      <div class="field-grid">
        <div><label for="tok-name">Name *</label>
          <input id="tok-name" name="name" required maxlength="${MAX_TOKEN_NAME_LENGTH}"
            placeholder="hermes-cloud" autocomplete="off"></div>
        <div><label for="tok-expires">Expires</label>
          <select id="tok-expires" name="expires_in_days">
            <option value="30">In 30 days</option>
            <option value="90" selected>In 90 days</option>
            <option value="365">In 365 days</option>
            <option value="">Never — until revoked</option>
          </select></div>
      </div>
      <fieldset class="scopes" data-token-scopes>
        <legend>Scopes</legend>
        ${scopeBox("read", "list artifacts, versions and views", true)}
        ${scopeBox("publish", "upload new artifacts and versions, roll back", true)}
        ${scopeBox("manage", "change who can open an artifact, delete artifacts", false)}
      </fieldset>
      ${adminFields}
      <div class="row-actions"><button type="submit" class="small">Create token</button>
        <span class="status" id="token-status" data-status hidden></span></div>
    </form>

    <div class="token-secret" data-token-secret hidden>
      <div class="published-head"><span class="tick" aria-hidden="true">✓</span>
        <div><b data-secret-title>Token created</b>
          <div class="hint">Copy it now — only a hash is stored, so this is the only time it can be
            shown. Store it as <span class="mono">RTFX_API_TOKEN</span>.</div></div>
      </div>
      <label for="token-value">Token</label>
      <div class="linkrow">
        <input id="token-value" data-token-value readonly spellcheck="false" aria-label="New API token">
        <button type="button" data-copy-token>Copy token</button>
      </div>
      <div class="published-actions">
        <button type="button" class="ghost" data-token-another>Create another</button>
        <button type="button" class="ghost" data-token-refresh>Refresh list</button>
      </div>
    </div>

    <div class="token-list" data-token-list>
      ${rows || `<p class="note" data-empty="tokens">No API tokens yet — create one above to publish from the CLI or CI.</p>`}
    </div>
  </section>`;
}

// --- client script ----------------------------------------------------------

const SCRIPT = `
var $ = function(s, r){ return (r||document).querySelector(s); };
var $$ = function(s, r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); };

function setStatus(el, text, kind){
  if(!el) return;
  el.textContent = text || '';
  el.hidden = !text;
  el.className = 'status' + (el.classList.contains('acc-status') ? ' acc-status' : '') + (kind ? ' is-' + kind : '');
}
function fmtBytes(n){
  if(n < 1024) return n + ' B';
  if(n < 1048576) return (n/1024).toFixed(1) + ' KB';
  return (n/1048576).toFixed(1) + ' MB';
}
async function detail(res){
  try { var d = await res.json(); return d.detail || d.error || ''; } catch(e){ return ''; }
}

/* ---- file picking: drag/drop + browse, shared by every publish form ---- */
var picks = new WeakMap();
function pickOf(form){
  var p = picks.get(form);
  if(!p){ p = { file:null, bundle:null }; picks.set(form, p); }
  return p;
}
function kindOf(name){
  if(/\\.zip$/i.test(name)) return 'bundle';
  if(/\\.html?$/i.test(name)) return 'file';
  return null;
}
function renderPick(form){
  var p = pickOf(form), f = p.file || p.bundle;
  var label = $('[data-pick-label]', form);
  var clear = $('[data-clear-pick]', form);
  if(label){
    if(f){ label.textContent = f.name + ' · ' + fmtBytes(f.size); label.setAttribute('data-picked',''); }
    else { label.textContent = label.getAttribute('data-idle') || ''; label.removeAttribute('data-picked'); }
  }
  if(clear) clear.hidden = !f;
}
function setPick(form, f){
  var kind = kindOf(f.name);
  if(!kind) return 'Unsupported file "' + f.name + '" — choose a .html page or a .zip bundle.';
  var p = pickOf(form);
  p.file = null; p.bundle = null; p[kind] = f;
  var target = $('input[type=file][name=' + kind + ']', form);
  if(target){ try { var dt = new DataTransfer(); dt.items.add(f); target.files = dt.files; } catch(e){} }
  var other = $('input[type=file][name=' + (kind === 'file' ? 'bundle' : 'file') + ']', form);
  if(other) other.value = '';
  renderPick(form);
  return null;
}
function clearPick(form){
  var p = pickOf(form); p.file = null; p.bundle = null;
  $$('input[type=file]', form).forEach(function(i){ i.value = ''; });
  renderPick(form);
}
function hasPick(form){ var p = pickOf(form); return !!(p.file || p.bundle); }
function bodyFor(form){
  var fd = new FormData(form);
  fd.delete('file'); fd.delete('bundle');
  var p = pickOf(form);
  if(p.file) fd.set('file', p.file);
  if(p.bundle) fd.set('bundle', p.bundle);
  return fd;
}
function initDropzone(zone){
  var form = zone.closest('form');
  if(!form) return;
  var status = $('[data-status]', form) || $('#publish-msg');
  var stop = function(e){ e.preventDefault(); e.stopPropagation(); };
  ['dragenter','dragover'].forEach(function(ev){
    zone.addEventListener(ev, function(e){ stop(e); zone.classList.add('is-drag'); });
  });
  ['dragleave','dragend'].forEach(function(ev){
    zone.addEventListener(ev, function(e){ stop(e); zone.classList.remove('is-drag'); });
  });
  zone.addEventListener('drop', function(e){
    stop(e);
    zone.classList.remove('is-drag');
    var files = e.dataTransfer && e.dataTransfer.files;
    if(!files || !files.length) return;
    var err = setPick(form, files[0]);
    setStatus(status, err || '', err ? 'error' : null);
  });
  zone.addEventListener('click', function(e){
    if(e.target.closest('button, input, a')) return;
    var input = $('input[type=file][name=file]', form);
    if(input) input.click();
  });
  $$('[data-browse]', zone).forEach(function(btn){
    btn.addEventListener('click', function(){
      var input = $('input[type=file][name=' + btn.getAttribute('data-browse') + ']', form);
      if(input) input.click();
    });
  });
  $$('input[type=file]', form).forEach(function(input){
    input.addEventListener('change', function(){
      if(!input.files || !input.files.length) return;
      var err = setPick(form, input.files[0]);
      setStatus(status, err || '', err ? 'error' : null);
    });
  });
  var clear = $('[data-clear-pick]', zone);
  if(clear) clear.addEventListener('click', function(){ clearPick(form); setStatus(status, ''); });
  renderPick(form);
}
/* Dropping outside a dropzone should not navigate away from the dashboard. */
['dragover','drop'].forEach(function(ev){
  document.addEventListener(ev, function(e){
    var t = e.target;
    if(!t || !t.closest || !t.closest('[data-dropzone]')) e.preventDefault();
  });
});

/* ---- copy to clipboard ---- */
async function copyText(text){
  try { await navigator.clipboard.writeText(text); return true; } catch(e){}
  try {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly',''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch(e){ return false; }
}
function wireCopy(btn, getText){
  btn.addEventListener('click', async function(){
    var idle = btn.getAttribute('data-idle') || btn.textContent;
    btn.setAttribute('data-idle', idle);
    var ok = await copyText(getText());
    btn.textContent = ok ? 'Copied!' : 'Copy failed — select and press ⌘C';
    btn.classList.toggle('is-copied', ok);
    setTimeout(function(){ btn.textContent = idle; btn.classList.remove('is-copied'); }, 2000);
  });
}
$$('[data-copy]').forEach(function(b){
  wireCopy(b, function(){ return new URL(b.getAttribute('data-copy'), location.href).href; });
});

/* ---- publish ---- */
var upForm = $('#up');
var publishMsg = $('#publish-msg');
var success = $('[data-publish-success]');
if(upForm){
  upForm.addEventListener('submit', async function(e){
    e.preventDefault();
    if(!hasPick(upForm)){
      setStatus(publishMsg, 'Add a .html page or a .zip bundle before publishing.', 'error');
      return;
    }
    var btn = $('button[type=submit]', upForm);
    btn.disabled = true;
    var idle = btn.textContent;
    btn.textContent = 'Publishing…';
    setStatus(publishMsg, 'Uploading…');
    try {
      var res = await fetch('/api/artifacts', { method:'POST', body: bodyFor(upForm) });
      if(!res.ok){
        var d = await detail(res);
        setStatus(publishMsg, d || 'Publish failed — check the file and try again.', 'error');
        return;
      }
      showPublished(await res.json());
    } catch(err){
      setStatus(publishMsg, 'Network error — check your connection and try again.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = idle;
    }
  });
}
function showPublished(data){
  if(!success) return;
  var url = data.url || (location.origin + '/' + data.slug + '/');
  var input = $('[data-artifact-url]', success);
  input.value = url;
  $('[data-open-link]', success).href = url;
  $('[data-published-title]', success).textContent = 'Published to /' + data.slug + '/';
  $('[data-published-meta]', success).textContent =
    'Version ' + data.version + ' · ' + data.file_count + ' file' + (data.file_count === 1 ? '' : 's') + ' · ' + data.type;
  setStatus(publishMsg, '');
  upForm.hidden = true;
  success.hidden = false;
  var copyBtn = $('[data-copy-link]', success);
  copyBtn.focus();
}
if(success){
  wireCopy($('[data-copy-link]', success), function(){ return $('[data-artifact-url]', success).value; });
  $('[data-artifact-url]', success).addEventListener('focus', function(e){ e.target.select(); });
  $('[data-publish-another]', success).addEventListener('click', function(){
    upForm.reset(); clearPick(upForm);
    success.hidden = true; upForm.hidden = false;
    setStatus(publishMsg, '');
    var t = $('#pub-title'); if(t) t.focus();
  });
  $('[data-refresh]', success).addEventListener('click', function(){ location.reload(); });
}

/* ---- new version per artifact ---- */
$$('form[data-newver]').forEach(function(form){
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    var status = $('[data-status]', form);
    if(!hasPick(form)){ setStatus(status, 'Choose a .html page or .zip bundle first.', 'error'); return; }
    var btn = $('button[type=submit]', form);
    btn.disabled = true;
    setStatus(status, 'Uploading…');
    try {
      var res = await fetch('/api/artifacts', { method:'POST', body: bodyFor(form) });
      if(!res.ok){
        var d = await detail(res);
        setStatus(status, d || 'Upload failed — try again.', 'error');
        return;
      }
      var data = await res.json();
      setStatus(status, 'v' + data.version + ' is live — reloading…', 'ok');
      setTimeout(function(){ location.reload(); }, 700);
    } catch(err){
      setStatus(status, 'Network error — try again.', 'error');
    } finally { btn.disabled = false; }
  });
});

/* ---- artifact actions ---- */
$$('.art-toggle').forEach(function(btn){
  btn.addEventListener('click', function(){
    var open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    document.getElementById(btn.getAttribute('aria-controls')).hidden = open;
    btn.closest('.artifact').classList.toggle('is-open', !open);
  });
});
$$('button[data-del]').forEach(function(b){
  b.addEventListener('click', async function(){
    var slug = b.getAttribute('data-del');
    if(!confirm('Delete "' + slug + '"? This removes every version and file. It cannot be undone.')) return;
    b.disabled = true;
    var res = await fetch('/api/artifacts/' + encodeURIComponent(slug), { method:'DELETE' });
    if(res.ok) location.reload();
    else { b.disabled = false; alert((await detail(res)) || 'Delete failed — try again.'); }
  });
});
$$('button[data-current]').forEach(function(b){
  b.addEventListener('click', async function(){
    var slug = b.getAttribute('data-slug'), version = b.getAttribute('data-current');
    if(!confirm('Make v' + version + ' the live version of "' + slug + '"?')) return;
    b.disabled = true;
    var res = await fetch('/api/artifacts/' + encodeURIComponent(slug) + '/current', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ version: Number(version) })
    });
    if(res.ok) location.reload();
    else { b.disabled = false; alert((await detail(res)) || 'Could not switch version.'); }
  });
});

/* ---- access ---- */
function onVis(slug){
  var card = document.getElementById('acc-' + slug);
  var restricted = $('[name=visibility]', card).value === 'restricted';
  $('.emails-wrap', card).hidden = !restricted;
}
$$('select[data-vis]').forEach(function(s){
  s.addEventListener('change', function(){ onVis(s.getAttribute('data-vis')); });
});
$$('button[data-save]').forEach(function(b){
  b.addEventListener('click', async function(){
    var slug = b.getAttribute('data-save');
    var card = document.getElementById('acc-' + slug);
    var status = $('[data-status]', card);
    var visibility = $('[name=visibility]', card).value;
    var emails = $('[name=emails]', card).value.split(/[\\s,]+/).map(function(s){ return s.trim(); }).filter(Boolean);
    b.disabled = true;
    setStatus(status, 'Saving…');
    try {
      var res = await fetch('/api/artifacts/' + encodeURIComponent(slug) + '/access', {
        method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ visibility: visibility, emails: emails })
      });
      var data = await res.json();
      if(!res.ok){ setStatus(status, data.detail || 'Could not save access.', 'error'); return; }
      var who = data.visibility === 'everyone'
        ? 'Saved — visible to everyone signed in.'
        : 'Saved — ' + (data.emails.length === 1 ? '1 person' : data.emails.length + ' people') + ' can open it.';
      setStatus(status, data.allowlistWarning ? who + ' (sign-in list warning: ' + data.allowlistWarning + ')' : who,
        data.allowlistWarning ? 'error' : 'ok');
      var badge = $('[data-artifact="' + slug + '"] [data-badge=visibility]');
      if(badge){
        badge.textContent = data.visibility === 'everyone' ? 'Everyone' : 'Restricted · ' + data.emails.length;
        badge.classList.toggle('is-open', data.visibility === 'everyone');
        badge.classList.toggle('is-locked', data.visibility !== 'everyone');
      }
    } catch(err){ setStatus(status, 'Network error — try again.', 'error'); }
    finally { b.disabled = false; }
  });
});

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
    confirm: function(e){ return 'Remove ' + e + ' from the beta?\\n\\nThey lose sign-in, every artifact grant, and every API token. Artifacts they published are NOT deleted. This cannot be undone.'; },
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

/* ---- API tokens ---- */
var tokenForm = $('#tokenform');
var tokenSecret = $('[data-token-secret]');
function showToken(data){
  if(!tokenSecret) return;
  $('[data-token-value]', tokenSecret).value = data.token;
  $('[data-secret-title]', tokenSecret).textContent =
    'Created "' + data.name + '" · ' + data.id + ' · ' + (data.scopes || []).join(', ');
  setStatus($('#token-status'), '');
  tokenForm.hidden = true;
  tokenSecret.hidden = false;
  $('[data-copy-token]', tokenSecret).focus();
}
if(tokenForm){
  tokenForm.addEventListener('submit', async function(e){
    e.preventDefault();
    var status = $('#token-status');
    var name = $('#tok-name').value.trim();
    if(!name){ setStatus(status, 'Give the token a name so you can recognise it later.', 'error'); return; }
    var scopes = $$('input[name=scope]:checked', tokenForm).map(function(i){ return i.value; });
    if(!scopes.length){ setStatus(status, 'Pick at least one scope.', 'error'); return; }
    var payload = { name: name, scopes: scopes };
    var days = $('#tok-expires').value;
    if(days) payload.expires_in_days = Number(days);
    /* Owner/admin controls exist for admins only; the API enforces the same rule. */
    var ownerInput = $('#tok-owner'), adminBox = $('#tok-admin');
    if(ownerInput){
      var owner = ownerInput.value.trim();
      var wantsAdmin = !!(adminBox && adminBox.checked);
      if(!owner && !wantsAdmin){
        setStatus(status, 'Enter an owner email, or tick the admin-token box.', 'error');
        return;
      }
      if(owner) payload.owner_email = owner;
      if(wantsAdmin) payload.is_admin = true;
    }
    var btn = $('button[type=submit]', tokenForm);
    btn.disabled = true;
    setStatus(status, 'Creating…');
    try {
      var res = await fetch('/api/tokens', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
      });
      if(!res.ok){
        setStatus(status, (await detail(res)) || 'Could not create that token.', 'error');
        return;
      }
      showToken(await res.json());
    } catch(err){ setStatus(status, 'Network error — try again.', 'error'); }
    finally { btn.disabled = false; }
  });
}
if(tokenSecret){
  wireCopy($('[data-copy-token]', tokenSecret), function(){ return $('[data-token-value]', tokenSecret).value; });
  $('[data-token-value]', tokenSecret).addEventListener('focus', function(e){ e.target.select(); });
  $('[data-token-another]', tokenSecret).addEventListener('click', function(){
    /* Drop the secret from the DOM as soon as the user is done with it. */
    $('[data-token-value]', tokenSecret).value = '';
    tokenForm.reset();
    tokenSecret.hidden = true; tokenForm.hidden = false;
    var n = $('#tok-name'); if(n) n.focus();
  });
  $('[data-token-refresh]', tokenSecret).addEventListener('click', function(){ location.reload(); });
}
$$('button[data-revoke]').forEach(function(b){
  b.addEventListener('click', async function(){
    var id = b.getAttribute('data-revoke');
    var row = $('[data-token="' + id + '"]');
    var name = (row && row.getAttribute('data-token-name')) || id;
    if(!confirm('Revoke "' + name + '"? Anything using this token stops working immediately. This cannot be undone.')) return;
    var status = row ? $('[data-status]', row) : null;
    b.disabled = true;
    setStatus(status, 'Revoking…');
    try {
      var res = await fetch('/api/tokens/' + encodeURIComponent(id), { method:'DELETE' });
      if(!res.ok){
        b.disabled = false;
        setStatus(status, (await detail(res)) || 'Could not revoke that token.', 'error');
        return;
      }
      /* Update in place rather than reloading — a just-created secret may still
         be on screen, and a reload would take it away for good. */
      if(row){
        row.setAttribute('data-token-state', 'revoked');
        var badge = $('[data-badge=token-state]', row);
        if(badge){ badge.textContent = 'Revoked'; badge.className = 'badge is-revoked'; }
        var count = $('[data-token-active-count]');
        if(count){
          var n = Math.max(0, Number(count.getAttribute('data-token-active-count') || '0') - 1);
          count.setAttribute('data-token-active-count', String(n));
          count.textContent = n + ' active token' + (n === 1 ? '' : 's');
        }
      }
      b.remove();
      setStatus(status, 'Revoked — it no longer works.', 'ok');
    } catch(err){
      b.disabled = false;
      setStatus(status, 'Network error — try again.', 'error');
    }
  });
});

/* ---- filter ---- */
var filter = $('#filter');
if(filter){
  filter.addEventListener('input', function(){
    var q = filter.value.trim().toLowerCase();
    var shown = 0;
    $$('.artifact').forEach(function(el){
      var hit = !q || (el.getAttribute('data-search') || '').indexOf(q) !== -1;
      el.hidden = !hit;
      if(hit) shown++;
    });
    var none = $('[data-empty=filter]');
    if(none) none.hidden = shown !== 0;
  });
}

$$('[data-dropzone]').forEach(initDropzone);
`;

const ADMIN_STYLE = `
.wrap{max-width:1180px}
header.top{align-items:center;padding:1rem 1.15rem;border:1px solid var(--border);border-radius:28px;background:var(--elev);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);box-shadow:var(--shadow);margin-bottom:1.35rem}
header.top .brand{font-weight:750;letter-spacing:-.03em}
header.top .eyebrow{font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;color:var(--faint)}
.faint{color:var(--faint);font-weight:400}
.sr-file{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;opacity:0}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:.8rem;margin-bottom:1.35rem}
.stat{position:relative;overflow:hidden;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.05rem 1.1rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.stat:after{content:"";position:absolute;inset:auto -20% -55% 38%;height:5rem;background:radial-gradient(circle,rgba(10,132,255,.18),transparent 65%)}
.stat-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:var(--faint)}
.stat-value{font-size:1.85rem;font-weight:780;line-height:1.1;letter-spacing:-.045em;margin:.2rem 0}
.stat-hint{font-size:.8rem;color:var(--muted)}

.panel{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.35rem;margin-bottom:1.35rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1.05rem}
.panel h2{font-size:1.2rem;margin:0 0 .22rem;letter-spacing:-.035em}
.panel-head p{margin:0}
.publish{background:linear-gradient(145deg,var(--card),rgba(10,132,255,.08))}
.publish form{display:grid;gap:.95rem}
.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:.95rem}
.publish-foot{display:flex;align-items:center;gap:.9rem;flex-wrap:wrap}
.publish-foot .hint{flex:1;min-width:14rem}

.dropzone{border:1.5px dashed var(--border-strong);border-radius:22px;background:rgba(255,255,255,.045);padding:1.9rem 1rem;text-align:center;cursor:pointer;transition:border-color .15s,background .15s,transform .15s}
.dropzone:hover{border-color:rgba(10,132,255,.62);transform:translateY(-1px)}
.dropzone.is-drag{border-color:var(--accent);background:var(--accent-weak)}
.dropzone.compact{padding:1rem .75rem;border-radius:18px}
.dz-icon{font-size:1.1rem;line-height:1;color:var(--accent);border:1.5px solid rgba(10,132,255,.5);background:var(--accent-weak);border-radius:999px;width:2.1rem;height:2.1rem;display:inline-flex;align-items:center;justify-content:center;margin-bottom:.55rem}
.dropzone.compact .dz-icon{display:none}
.dz-title{margin:0;font-weight:650;font-size:.96rem;letter-spacing:-.02em}
.dz-title[data-picked]{color:var(--accent);font-family:var(--mono);font-size:.85rem}
.dz-sub{margin:.22rem 0 .75rem;font-size:.82rem;color:var(--muted)}
.dz-actions{display:flex;gap:.5rem;justify-content:center;flex-wrap:wrap}

.published{border:1px solid rgba(48,209,88,.55);background:var(--ok-weak);border-radius:22px;padding:1.15rem}
.published-head{display:flex;align-items:center;gap:.65rem;margin-bottom:.9rem}
.published .tick{width:1.7rem;height:1.7rem;flex:none;border-radius:999px;background:var(--ok);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:.85rem;font-weight:750}
.linkrow{display:flex;gap:.5rem;align-items:center}
.linkrow input{font-family:var(--mono);font-size:.85rem;background:rgba(255,255,255,.05)}
.linkrow button{flex:none}
.linkrow button.is-copied{background:var(--ok)}
.published-actions{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.9rem}

.section-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin:0 0 .95rem}
.section-head h2{font-size:1.22rem;margin:0;letter-spacing:-.035em}
.section-head input{width:auto;min-width:16rem}

.artifact{border:1px solid var(--border);border-radius:var(--radius);background:var(--card);margin-bottom:.78rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);transition:border-color .15s,transform .15s}
.artifact:hover{border-color:var(--border-strong);transform:translateY(-1px)}
.artifact.is-open{border-color:rgba(10,132,255,.55)}
.art-head{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;padding:1rem 1.15rem}
.art-toggle{flex:1;min-width:14rem;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;text-align:left;background:transparent;border:0;padding:0;color:inherit;font:inherit;font-weight:400;cursor:pointer;border-radius:12px;box-shadow:none}
.art-toggle:hover{opacity:1;transform:none;box-shadow:none;background:transparent}
.art-toggle:hover .art-title{color:var(--accent)}
.art-id{display:flex;flex-direction:column;min-width:11rem;flex:1}
.art-title{font-weight:680;letter-spacing:-.025em;transition:color .15s}
.art-slug{color:var(--muted)}
.art-desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:36rem}
.art-badges{display:flex;gap:.35rem;flex-wrap:wrap}
.art-actions{display:flex;gap:.42rem;align-items:center}
.chevron{color:var(--faint);font-size:.8rem;flex:none;transition:transform .15s}
.art-toggle[aria-expanded=true] .chevron{transform:rotate(90deg)}
.art-body{display:grid;grid-template-columns:1fr 1fr;gap:.78rem;align-items:start;padding:0 1.15rem 1.15rem}
.sub-panel{border:1px solid var(--border);border-radius:18px;padding:.92rem 1rem;background:rgba(255,255,255,.04)}
.sub-panel[data-panel=access]{grid-column:1/-1}
.sub-panel h4{margin:0 0 .55rem;font-size:.78rem;text-transform:uppercase;letter-spacing:.075em;color:var(--faint);display:flex;align-items:baseline;gap:.5rem}
.sub-panel h4 .hint{text-transform:none;letter-spacing:0}
.sub-panel .row{padding:.55rem 0}
.row-actions{display:flex;gap:.5rem;align-items:center;flex:none}
form.newver{display:grid;gap:.55rem;margin-top:.75rem;padding-top:.75rem;border-top:1px solid var(--border)}
.emails-wrap{margin-bottom:.5rem}
.userform{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.75rem}
.userform input{flex:1;min-width:11rem}
.userform input#newuser{min-width:15rem;flex:1.4}
.user-row{align-items:flex-start}
.user-row .info{display:grid;gap:.3rem}
.user-row .info b{font-weight:650;letter-spacing:-.015em}
.user-row .art-badges{margin-top:.1rem}
.user-note{border-left:2px solid var(--border-strong);padding-left:.6rem;color:var(--faint)}
.user-row .row-actions{align-items:center;flex-wrap:wrap;justify-content:flex-end}
.user-list .empty{padding:2.4rem 1.5rem}

#tokenform{display:grid;gap:.95rem;margin-bottom:.5rem}
.badge.is-revoked{color:var(--danger);border-color:var(--danger);background:var(--danger-weak)}
fieldset.scopes{border:1px solid var(--border);border-radius:18px;padding:.82rem .95rem;margin:0;display:grid;gap:.45rem;background:rgba(255,255,255,.03)}
fieldset.scopes legend{font-size:.85rem;color:var(--muted);padding:0 .35rem}
label.check{display:flex;align-items:flex-start;gap:.5rem;margin:0;font-size:.88rem;color:var(--fg)}
label.check input{width:auto;flex:none;margin-top:.2rem}
.field-label{display:block;font-size:.85rem;color:var(--muted);margin-bottom:.25rem}
.token-secret{border:1px solid rgba(48,209,88,.55);background:var(--ok-weak);border-radius:22px;padding:1.15rem;margin-bottom:1rem}
.token-secret .linkrow input{font-family:var(--mono);font-size:.85rem;background:rgba(255,255,255,.05)}
.token-list .row [data-token-state]{min-width:0}
.token-list .row .info b{display:flex;align-items:center;gap:.35rem;flex-wrap:wrap}
.token-list .hint{overflow-wrap:anywhere}

@media(max-width:720px){
  .field-grid,.art-body{grid-template-columns:1fr}
  .art-actions{width:100%;justify-content:flex-start}
  .linkrow{align-items:stretch;flex-direction:column}
}
`;

export function adminPage(
  rows: ArtifactRow[],
  grants: Map<string, string[]>,
  versions: Map<string, VersionRow[]>,
  views: ViewsInfo,
  email: string,
  viewer: DashboardViewer
): string {
  const totalVersions = rows.reduce((n, r) => n + (versions.get(r.slug)?.length ?? 1), 0);
  const totalViews = rows.reduce((n, r) => n + (views.counts.get(r.slug)?.total ?? 0), 0);
  const totalFiles = rows.reduce((n, r) => n + r.file_count, 0);
  const totalBytes = rows.reduce((n, r) => n + r.size_bytes, 0);
  const openCount = rows.filter((r) => r.visibility === "everyone").length;

  const stats = `<section class="stats" aria-label="Overview">
    ${statTile("artifacts", "Artifacts", num(rows.length), `${num(rows.length - openCount)} restricted · ${num(openCount)} everyone`)}
    ${statTile("versions", "Versions", num(totalVersions), "immutable, roll back anytime")}
    ${statTile("views", "Views", num(totalViews), "all-time page loads")}
    ${statTile("storage", "Storage", bytes(totalBytes), plural(totalFiles, "file"))}
  </section>`;

  const list = rows
    .map((r) =>
      artifactCard(r, grants.get(r.slug) ?? [], versions.get(r.slug) ?? [], views, viewer.isAdmin)
    )
    .join("");

  const emptyState = `<div class="empty" data-empty="artifacts">
    <h3>Nothing published yet</h3>
    <p>Drop a <span class="mono">.html</span> page or a <span class="mono">.zip</span> bundle into the
      panel above to publish your first artifact. It stays private to you until you grant access —
      then you'll get a share link to send.</p>
  </div>`;

  const searchable = rows.length > 3;
  const artifactsSection = `<section aria-labelledby="artifacts-h">
    <div class="section-head">
      <h2 id="artifacts-h">${viewer.isAdmin ? "Artifacts" : "Your artifacts"} <span class="hint">${plural(rows.length, "published artifact")}</span></h2>
      ${searchable ? `<input id="filter" type="search" placeholder="Filter by title or slug…" aria-label="Filter artifacts">` : ""}
    </div>
    ${rows.length ? list : emptyState}
    ${
      searchable
        ? `<div class="empty" data-empty="filter" hidden><h3>No matches</h3>
             <p>No artifact matches that filter. Try a different title or slug.</p></div>`
        : ""
    }
  </section>`;

  const body = `<header class="top">
      <div><div class="eyebrow">${viewer.isAdmin ? "Admin" : "Beta"}</div><h1>Dashboard</h1>
        <div class="sub">Signed in as ${esc(email)}${
          viewer.isAdmin ? "" : " · you only see artifacts you published"
        }</div></div>
      <div><a href="/gallery">View gallery →</a></div>
    </header>

    ${stats}
    ${publishPanel()}
    ${artifactsSection}
    ${viewer.tokens ? tokensPanel(viewer.tokens, viewer.isAdmin) : ""}
    ${viewer.isAdmin && viewer.users ? usersPanel(viewer.users) : ""}
    <script>${SCRIPT}</script>`;
  return layout("Dashboard · Artifacts", body, ADMIN_STYLE);
}
