import type { ArtifactRow, VersionRow, ViewRow } from "./env";
import { esc } from "./pages";
import { MAX_UPLOAD_BYTES } from "./upload";
import { tokenState } from "./integrations";
import type { PublicApiToken } from "./tokens";
import type { UsersInfo } from "./people";
import {
  portalShell,
  statTile,
  dangerZone,
  num,
  bytes,
  plural,
  people,
  stamp,
  roleLabel,
  type PortalViewer,
} from "./portal";
import { accountRoleLabel } from "./accounts";

/**
 * The portal's own sections: Overview, Artifacts (list + detail), Settings and
 * Platform. People lives in `people.ts` and Integrations in `integrations.ts`;
 * the shell and navigation live in `portal.ts`. See docs/DESIGN.md §8.
 */

export interface ViewsInfo {
  counts: Map<string, { total: number; unique: number }>;
  recent: Map<string, ViewRow[]>;
}

/** Everything the portal needs about the signed-in person, per request. */
export type { PortalViewer } from "./portal";
export type { UsersInfo } from "./people";

// --- shared pieces ----------------------------------------------------------

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

/** Totals across whatever slice of artifacts this viewer can see. */
function totals(rows: ArtifactRow[], versions: Map<string, VersionRow[]>, views: ViewsInfo) {
  return {
    artifacts: rows.length,
    versions: rows.reduce((n, r) => n + (versions.get(r.slug)?.length ?? 1), 0),
    views: rows.reduce((n, r) => n + (views.counts.get(r.slug)?.total ?? 0), 0),
    files: rows.reduce((n, r) => n + r.file_count, 0),
    bytes: rows.reduce((n, r) => n + r.size_bytes, 0),
    open: rows.filter((r) => r.visibility === "everyone").length,
  };
}

function statsRow(rows: ArtifactRow[], versions: Map<string, VersionRow[]>, views: ViewsInfo): string {
  const t = totals(rows, versions, views);
  return `<section class="stats" aria-label="Usage">
    ${statTile("artifacts", "Artifacts", num(t.artifacts), `${num(t.artifacts - t.open)} restricted · ${num(t.open)} everyone`)}
    ${statTile("versions", "Versions", num(t.versions), "immutable, roll back anytime")}
    ${statTile("views", "Views", num(t.views), "all-time page loads")}
    ${statTile("storage", "Storage", bytes(t.bytes), plural(t.files, "file"))}
  </section>`;
}

/** The badge strip an artifact carries wherever it appears. */
function artifactBadges(
  r: ArtifactRow,
  emails: string[],
  versionCount: number,
  viewCount: number,
  showOwner: boolean
): string {
  const vis =
    r.visibility === "everyone"
      ? `<span class="badge is-open" data-badge="visibility">Everyone</span>`
      : `<span class="badge is-locked" data-badge="visibility">Restricted · ${num(emails.length)}</span>`;
  const ver = `<span class="badge" data-badge="version">v${r.current_version}${
    versionCount > 1 ? ` of ${versionCount}` : ""
  }</span>`;
  const owner =
    showOwner && r.owner_email
      ? `<span class="badge" data-badge="owner">${esc(r.owner_email)}</span>`
      : "";
  return `${vis}${ver}
    <span class="badge" data-badge="files">${plural(r.file_count, "file")}</span>
    <span class="badge" data-badge="views">${plural(viewCount, "view")}</span>
    ${owner}<span class="badge">${esc(r.type)}</span>`;
}

// --- Overview ---------------------------------------------------------------

interface HealthRow {
  key: string;
  label: string;
  state: "ok" | "warn" | "todo";
  detail: string;
}

const HEALTH_BADGE: Record<HealthRow["state"], string> = {
  ok: `<span class="badge is-active" data-badge="health">Healthy</span>`,
  warn: `<span class="badge is-warn" data-badge="health">Needs attention</span>`,
  todo: `<span class="badge is-invited" data-badge="health">Not set up</span>`,
};

function healthPanel(rows: HealthRow[]): string {
  const list = rows
    .map(
      (h) => `<div class="row" data-health="${esc(h.key)}" data-health-state="${h.state}">
        <div class="info"><b>${esc(h.label)}</b><span class="hint">${h.detail}</span></div>
        <div class="row-actions">${HEALTH_BADGE[h.state]}</div>
      </div>`
    )
    .join("");
  return `<section class="panel" data-panel="health" aria-labelledby="health-h">
    <div class="panel-head"><div>
      <h2 id="health-h">Health</h2>
      <p class="hint">What is working, and what is still waiting on you.</p>
    </div></div>
    ${list}
  </section>`;
}

interface NextAction {
  key: string;
  title: string;
  body: string;
  href: string;
  cta: string;
}

function nextActionsPanel(actions: NextAction[]): string {
  const body = actions.length
    ? actions
        .map(
          (a) => `<div class="row" data-action="${esc(a.key)}">
            <div class="info"><b>${esc(a.title)}</b><span class="hint">${esc(a.body)}</span></div>
            <div class="row-actions"><a class="ghost link-button small-link" href="${esc(a.href)}">${esc(a.cta)}</a></div>
          </div>`
        )
        .join("")
    : `<p class="note" data-actions-done>Nothing needs you right now. Publish something new, or
        check who has been reading what.</p>`;
  return `<section class="panel" data-panel="next-actions" aria-labelledby="next-h">
    <div class="panel-head"><div>
      <h2 id="next-h">Next steps</h2>
      <p class="hint">The shortest path from here to a link you can send someone.</p>
    </div></div>
    ${body}
  </section>`;
}

function recentPanel(
  rows: ArtifactRow[],
  views: ViewsInfo,
  versions: Map<string, VersionRow[]>,
  grants: Map<string, string[]>,
  showOwner: boolean
): string {
  const recent = [...rows]
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, 5)
    .map((r) => {
      const emails = grants.get(r.slug) ?? [];
      const viewCount = views.counts.get(r.slug)?.total ?? 0;
      const versionCount = versions.get(r.slug)?.length ?? 1;
      return `<div class="row" data-recent="${esc(r.slug)}">
        <div class="info">
          <b><a href="/admin/artifacts/${encodeURIComponent(r.slug)}">${esc(r.title)}</a></b>
          <span class="hint mono">/${esc(r.slug)}/ · updated ${stamp(r.updated_at)}</span>
          <div class="art-badges">${artifactBadges(r, emails, versionCount, viewCount, showOwner)}</div>
        </div>
        <div class="row-actions">
          <a href="/${esc(r.slug)}/" target="_blank" rel="noopener">Open ↗</a>
        </div>
      </div>`;
    })
    .join("");

  return `<section class="panel" data-panel="recent" aria-labelledby="recent-h">
    <div class="panel-head"><div>
      <h2 id="recent-h">Recent artifacts</h2>
      <p class="hint">The five most recently published or updated.</p>
    </div>
    <a href="/admin/artifacts">All artifacts →</a></div>
    ${
      recent ||
      `<div class="empty" data-empty="recent"><h3>Nothing published yet</h3>
        <p>Publish a page and it shows up here, with its version, its audience and how often it has
          been opened. <a href="/admin/artifacts">Publish your first artifact →</a></p></div>`
    }
  </section>`;
}

export interface OverviewInput {
  viewer: PortalViewer;
  rows: ArtifactRow[];
  grants: Map<string, string[]>;
  versions: Map<string, VersionRow[]>;
  views: ViewsInfo;
  /** Null when the caller may not manage tokens (an API-token caller). */
  tokens: PublicApiToken[] | null;
  /** Null for anyone who is not an admin with an interactive sign-in. */
  users: UsersInfo | null;
}

export function overviewPage(o: OverviewInput): string {
  const { viewer, rows, grants, versions, views, tokens, users } = o;
  const t = totals(rows, versions, views);
  const now = new Date();

  const health: HealthRow[] = [];
  if (users) {
    const a = users.allowlist;
    health.push({
      key: "sign-in",
      label: "Sign-in (Cloudflare Access)",
      state: !a.configured ? "todo" : a.error ? "warn" : "ok",
      detail: !a.configured
        ? `Invites are recorded locally, but nobody new can sign in yet.
           <a href="/admin/people">Finish setup →</a>`
        : a.error
          ? `Couldn't reach Cloudflare Access — the local directory still applies.
             <a href="/admin/people">See the error →</a>`
          : `${people(users.users.filter((u) => u.status !== "disabled").length)} can sign in.`,
    });
  }
  if (tokens) {
    const active = tokens.filter((tk) => tokenState(tk, now) === "active").length;
    const stale = tokens.filter((tk) => tokenState(tk, now) === "expired").length;
    health.push({
      key: "tokens",
      label: "API tokens",
      state: stale ? "warn" : active ? "ok" : "todo",
      detail: stale
        ? `${plural(stale, "token")} expired — anything still using one is failing.
           <a href="/admin/integrations">Review tokens →</a>`
        : active
          ? `${plural(active, "active token")} for the CLI, Claude Code and CI.`
          : `No tokens yet — a browser is the only way to publish right now.
             <a href="/admin/integrations">Create one →</a>`,
    });
  }
  const unshared = rows.filter(
    (r) => r.visibility === "restricted" && (grants.get(r.slug)?.length ?? 0) === 0
  ).length;
  health.push({
    key: "sharing",
    label: "Sharing",
    state: unshared && rows.length ? "todo" : "ok",
    detail: !rows.length
      ? "Nothing published, so nothing to share."
      : unshared
        ? `${plural(unshared, "artifact")} that nobody else can open yet.
           <a href="/admin/artifacts">Grant access →</a>`
        : "Every artifact has an audience.",
  });
  health.push({
    key: "storage",
    label: "Storage",
    state: "ok",
    detail: `${bytes(t.bytes)} across ${plural(t.files, "file")} and ${plural(t.versions, "version")}.
      Old versions are kept on purpose.`,
  });

  const actions: NextAction[] = [];
  if (!rows.length) {
    actions.push({
      key: "publish",
      title: "Publish your first artifact",
      body: "Drop a .html page or a .zip bundle. It stays private to you until you share it.",
      href: "/admin/artifacts",
      cta: "Publish",
    });
  } else if (unshared) {
    actions.push({
      key: "share",
      title: "Give somebody access",
      body: `${
        unshared === 1 ? "1 artifact is" : `${num(unshared)} artifacts are`
      } private to you. Add an email to send a link that works.`,
      href: "/admin/artifacts",
      cta: "Open artifacts",
    });
  }
  if (users && users.users.filter((u) => u.role === "member").length === 0) {
    actions.push({
      key: "invite",
      title: "Invite your team",
      body: "Members publish their own artifacts and only ever see their own.",
      href: "/admin/people",
      cta: "Invite",
    });
  }
  if (tokens && tokens.filter((tk) => tokenState(tk, now) === "active").length === 0) {
    actions.push({
      key: "token",
      title: "Connect Claude Code or the CLI",
      body: "An API token lets an agent or a CI job publish here as you, with only the scopes you give it.",
      href: "/admin/integrations",
      cta: "Create a token",
    });
  }

  const lede = viewer.isAdmin
    ? `Everything published on this instance, who can reach it, and what still needs doing.`
    : `Your artifacts, who can open them, and what still needs doing. You only ever see your own.`;

  return portalShell({
    viewer,
    section: "overview",
    title: "Overview",
    heading: "Overview",
    lede,
    actions: `<a class="link-button" href="/admin/artifacts">Publish an artifact</a>`,
    body: `${statsRow(rows, versions, views)}
      ${nextActionsPanel(actions)}
      ${recentPanel(rows, views, versions, grants, viewer.isAdmin)}
      ${healthPanel(health)}`,
    style: OVERVIEW_STYLE,
  });
}

const OVERVIEW_STYLE = `
.art-badges{display:flex;gap:.35rem;flex-wrap:wrap;margin-top:.28rem}
.panel[data-panel=recent] .row .info b a{color:var(--fg);font-weight:680;letter-spacing:-.02em}
.panel[data-panel=recent] .row .info b a:hover{color:var(--accent)}
.panel-head a{font-size:.85rem;white-space:nowrap}
a.ghost.link-button.small-link{padding:.42rem .85rem;font-size:.82rem}
.panel[data-panel=health] .row .info b{font-weight:620}
`;

// --- Artifacts: the list ----------------------------------------------------

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
      <p class="hint">This artifact is private until you grant access on its own page.</p>
      <div class="published-actions">
        <a class="ghost link-button" data-open-link target="_blank" rel="noopener">Open artifact ↗</a>
        <a class="ghost link-button" data-manage-link>Manage &amp; share</a>
        <button type="button" class="ghost" data-publish-another>Publish another</button>
        <button type="button" class="ghost" data-refresh>Refresh list</button>
      </div>
    </div>
  </section>`;
}

function artifactCard(
  r: ArtifactRow,
  emails: string[],
  versionCount: number,
  viewCount: number,
  showOwner: boolean
): string {
  const search = `${r.title} ${r.slug} ${r.description ?? ""} ${showOwner ? (r.owner_email ?? "") : ""}`.toLowerCase();
  const href = `/admin/artifacts/${encodeURIComponent(r.slug)}`;
  return `<article class="artifact" data-artifact="${esc(r.slug)}" data-search="${esc(search)}">
    <a class="art-open" href="${esc(href)}" data-manage="${esc(r.slug)}">
      <span class="art-id">
        <span class="art-title">${esc(r.title)}</span>
        <span class="mono art-slug">/${esc(r.slug)}/</span>
        ${r.description ? `<span class="hint art-desc">${esc(r.description)}</span>` : ""}
      </span>
      <span class="art-badges">${artifactBadges(r, emails, versionCount, viewCount, showOwner)}</span>
    </a>
    <div class="art-actions">
      <a href="/${esc(r.slug)}/" target="_blank" rel="noopener">Open ↗</a>
      <button class="ghost small" data-copy="/${esc(r.slug)}/">Copy link</button>
      <a class="ghost link-button small-link" href="${esc(href)}">Manage</a>
    </div>
  </article>`;
}

export interface ArtifactsInput {
  viewer: PortalViewer;
  rows: ArtifactRow[];
  grants: Map<string, string[]>;
  versions: Map<string, VersionRow[]>;
  views: ViewsInfo;
}

export function artifactsPage(o: ArtifactsInput): string {
  const { viewer, rows, grants, versions, views } = o;
  const list = rows
    .map((r) =>
      artifactCard(
        r,
        grants.get(r.slug) ?? [],
        versions.get(r.slug)?.length ?? 1,
        views.counts.get(r.slug)?.total ?? 0,
        viewer.isAdmin
      )
    )
    .join("");

  const emptyState = `<div class="empty" data-empty="artifacts">
    <h3>Nothing published yet</h3>
    <p>Drop a <span class="mono">.html</span> page or a <span class="mono">.zip</span> bundle into the
      panel above to publish your first artifact. It stays private to you until you grant access —
      then you'll get a share link to send.</p>
  </div>`;

  const searchable = rows.length > 3;
  const listSection = `<section aria-labelledby="artifacts-h">
    <div class="section-head">
      <h2 id="artifacts-h">${viewer.isAdmin ? "All artifacts" : "Your artifacts"}
        <span class="hint">${plural(rows.length, "published artifact")}</span></h2>
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

  return portalShell({
    viewer,
    section: "artifacts",
    title: "Artifacts",
    heading: "Artifacts",
    lede: viewer.isAdmin
      ? `Everything published here. Open one to manage its versions, its audience and its view log.`
      : `Everything you have published. Open one to manage its versions, its audience and its
         view log — you only ever see your own.`,
    body: `${publishPanel()}${listSection}`,
    style: ARTIFACTS_STYLE,
    script: PICK_SCRIPT + PUBLISH_SCRIPT + FILTER_SCRIPT,
  });
}

// --- Artifacts: one artifact ------------------------------------------------

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
  return `<section class="panel sub-panel" data-panel="versions" aria-labelledby="versions-h">
    <div class="panel-head"><div>
      <h2 id="versions-h">Versions <span class="hint">${plural(versions.length, "version")}</span></h2>
      <p class="hint">Every publish is kept. Making an older one live is instant and reversible.</p>
    </div></div>
    ${list || `<p class="note">No version history recorded yet.</p>`}
    <form class="newver" data-newver>
      <input type="hidden" name="slug" value="${esc(r.slug)}">
      ${dropzone("Drop a new version here", "Replaces what visitors see — older versions stay available", true)}
      <input type="text" name="note" placeholder="What changed? (optional note)" autocomplete="off"
        aria-label="Version note">
      <div class="row-actions"><button type="submit" class="ghost small">Upload new version</button>
        <span class="status" data-status hidden></span></div>
    </form>
  </section>`;
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
  return `<section class="panel sub-panel" data-panel="views" aria-labelledby="views-h">
    <div class="panel-head"><div>
      <h2 id="views-h">Views <span class="hint">${plural(c.total, "view")} · ${plural(c.unique, "viewer")}</span></h2>
      <p class="hint">Who opened it, when, and which version they saw.</p>
    </div></div>
    ${
      recent.length
        ? rows
        : `<p class="note">No views yet — copy the share link above and send it to someone who has access.</p>`
    }
  </section>`;
}

function accessPanel(r: ArtifactRow, emails: string[]): string {
  const restricted = r.visibility === "restricted";
  return `<section class="panel sub-panel" data-panel="access" id="acc-${esc(r.slug)}" aria-labelledby="access-h">
    <div class="panel-head"><div>
      <h2 id="access-h">Access</h2>
      <p class="hint">Cloudflare Access decides who may sign in; this decides who may open
        this artifact once they have.</p>
    </div></div>
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
  </section>`;
}

export interface ArtifactDetailInput {
  viewer: PortalViewer;
  row: ArtifactRow;
  emails: string[];
  versions: VersionRow[];
  views: ViewsInfo;
}

export function artifactDetailPage(o: ArtifactDetailInput): string {
  const { viewer, row, emails, versions, views } = o;
  const viewCount = views.counts.get(row.slug)?.total ?? 0;
  const badges = artifactBadges(row, emails, versions.length, viewCount, viewer.isAdmin);

  const summary = `<section class="panel art-summary" data-artifact-detail="${esc(row.slug)}"
      aria-labelledby="summary-h">
    <div class="panel-head"><div>
      <h2 id="summary-h" class="sr-only">Summary</h2>
      <div class="art-badges">${badges}</div>
      ${row.description ? `<p class="hint art-desc-full">${esc(row.description)}</p>` : ""}
    </div></div>
    <label for="share-url">Share link</label>
    <div class="linkrow">
      <input id="share-url" data-share-url readonly spellcheck="false" value="/${esc(row.slug)}/">
      <button type="button" data-copy="/${esc(row.slug)}/">Copy link</button>
    </div>
    <p class="hint">${
      row.visibility === "everyone"
        ? "Anyone signed in to this instance can open it."
        : emails.length
          ? `${people(emails.length)} can open it, plus admins.`
          : "Only you and admins can open it — grant access below before sending the link."
    } Published ${stamp(row.created_at)} · updated ${stamp(row.updated_at)}${
      row.owner_email ? ` · owned by ${esc(row.owner_email)}` : ""
    }.</p>
  </section>`;

  const danger = dangerZone(
    "Delete this artifact",
    `Removes every version, every file and every grant. The slug becomes free again, and
     nothing here can be recovered. The view log goes with it.`,
    `<button class="danger small" data-del="${esc(row.slug)}">Delete ${esc(row.slug)}</button>
     <span class="status" data-status hidden></span>`
  );

  return portalShell({
    viewer,
    section: "artifacts",
    title: `${row.title} · Artifacts`,
    heading: row.title,
    lede: `Everything about <span class="mono">/${esc(row.slug)}/</span> — its versions, who has
      opened it, and who may.`,
    crumbs: [
      { label: "Artifacts", href: "/admin/artifacts" },
      { label: row.title },
    ],
    actions: `<a class="ghost link-button" href="/${esc(row.slug)}/" target="_blank" rel="noopener">Open ↗</a>`,
    body: `${summary}
      <div class="pcols">
        ${versionsPanel(row, versions)}
        ${viewsPanel(row.slug, views)}
      </div>
      ${accessPanel(row, emails)}
      ${danger}`,
    style: ARTIFACTS_STYLE,
    script: PICK_SCRIPT + DETAIL_SCRIPT,
  });
}

// --- Settings ---------------------------------------------------------------

/**
 * The workspace the viewer is acting in (issue #27).
 *
 * Deliberately a plain readout rather than a management surface: the point is to
 * make the *distinction* legible — this account owns the artifacts, your platform
 * role is a separate thing — without inventing an org-admin UI the product does
 * not need while every workspace is personal. Membership is managed through
 * `/api/accounts/:id/members` until a second workspace kind is common.
 */
function workspacePanel(viewer: PortalViewer): string {
  const ws = viewer.workspace;
  if (!ws) {
    return `<section class="panel" data-panel="workspace" data-workspace-state="none"
      aria-labelledby="workspace-h">
      <div class="panel-head"><div>
        <h2 id="workspace-h">Workspace</h2>
        <p class="hint">Artifacts and API tokens belong to a workspace. Yours is created the first
          time you publish, so there is nothing to see here yet.</p>
      </div></div>
    </section>`;
  }
  const kindWord = ws.kind === "personal" ? "Personal" : "Team";
  return `<section class="panel" data-panel="workspace" data-workspace-state="active"
    data-workspace-id="${esc(ws.id)}" aria-labelledby="workspace-h">
    <div class="panel-head"><div>
      <h2 id="workspace-h">Workspace</h2>
      <p class="hint">The container that owns your artifacts, your API tokens and — later — your
        plan. Your role here is separate from your role on this instance.</p>
    </div></div>
    <div class="row" data-setting="workspace-name">
      <div class="info"><b>Name</b><span class="hint">${
        ws.kind === "personal"
          ? "Your own workspace. Created automatically; nobody else is in it."
          : "A shared workspace. Everything published into it belongs to the workspace, not to you personally."
      }</span></div>
      <div class="row-actions"><span class="mono">${esc(ws.name)}</span></div>
    </div>
    <div class="row" data-setting="workspace-kind">
      <div class="info"><b>Type</b><span class="hint">${
        ws.count > 1
          ? `You belong to ${plural(ws.count, "workspace")}. Pages show the one above.`
          : "You belong to this one workspace."
      }</span></div>
      <div class="row-actions"><span class="badge" data-badge="workspace-kind">${esc(kindWord)}</span></div>
    </div>
    <div class="row" data-setting="workspace-role">
      <div class="info"><b>Your role here</b><span class="hint">${
        ws.role === "owner"
          ? "Full rights inside this workspace, including who else is in it. It grants nothing outside it."
          : ws.role === "admin"
            ? "Manages this workspace's artifacts and members. It grants nothing outside it."
            : ws.role === "member"
              ? "Publishes and manages this workspace's artifacts, but not its members."
              : "Reads this workspace's artifacts. You cannot publish or change them."
      }</span></div>
      <div class="row-actions"><span class="badge is-role" data-badge="workspace-role">${esc(
        accountRoleLabel(ws.role)
      )}</span></div>
    </div>
    <div class="row" data-setting="workspace-plan">
      <div class="info"><b>Plan</b><span class="hint">Billing attaches to the workspace, not to you.
        Nothing is charged during the beta.</span></div>
      <div class="row-actions"><span class="badge is-locked">Beta</span></div>
    </div>
  </section>`;
}

export function settingsPage(viewer: PortalViewer): string {
  const account = `<section class="panel" data-panel="account" aria-labelledby="account-h">
    <div class="panel-head"><div>
      <h2 id="account-h">You</h2>
      <p class="hint">Who you are on this instance — your identity, and what it lets you do across
        the whole deployment. Roles here come from deployment configuration, so nobody can change
        their own, and nothing stored in the database can grant one.</p>
    </div></div>
    <div class="row" data-setting="email">
      <div class="info"><b>Email</b><span class="hint">Verified by Cloudflare Access on every request.</span></div>
      <div class="row-actions"><span class="mono">${esc(viewer.email)}</span></div>
    </div>
    <div class="row" data-setting="role">
      <div class="info"><b>Instance role</b><span class="hint">${
        viewer.role === "super_admin"
          ? "The operator. Can manage other admins, and can never be paused or removed."
          : viewer.role === "admin"
            ? "Manages every artifact and every member, but not other admins."
            : "Publishes and manages your own artifacts. You never see anyone else's."
      }</span></div>
      <div class="row-actions"><span class="badge is-role" data-badge="role">${esc(roleLabel(viewer.role))}</span></div>
    </div>
    <div class="row" data-setting="sign-in">
      <div class="info"><b>Sign-in</b><span class="hint">Passwordless — a one-time code by email,
        issued by Cloudflare Access. There is no password to change here.</span></div>
      <div class="row-actions"><a href="/login">Sign-in page →</a></div>
    </div>
  </section>`;

  const security = `<section class="panel" data-panel="security" aria-labelledby="security-h">
    <div class="panel-head"><div>
      <h2 id="security-h">Security</h2>
      <p class="hint">Two independent layers decide every request, and both must say yes.</p>
    </div></div>
    <div class="row" data-setting="access-layer">
      <div class="info"><b>Who may sign in</b><span class="hint">Cloudflare Access, in front of the
        whole app. Pausing somebody signs them out everywhere and revokes their API tokens.</span></div>
      <div class="row-actions">${
        viewer.isAdmin ? `<a href="/admin/people">People →</a>` : `<span class="hint">Managed by an admin</span>`
      }</div>
    </div>
    <div class="row" data-setting="artifact-layer">
      <div class="info"><b>Who may open an artifact</b><span class="hint">Set per artifact:
        restricted to a list, or everyone signed in. Granting access never grants management.</span></div>
      <div class="row-actions"><a href="/admin/artifacts">Artifacts →</a></div>
    </div>
    <div class="row" data-setting="tokens-layer">
      <div class="info"><b>Machine credentials</b><span class="hint">API tokens act as their owner
        and carry only the scopes you gave them. They can never manage tokens or people.</span></div>
      <div class="row-actions"><a href="/admin/integrations">Integrations →</a></div>
    </div>
  </section>`;

  const later = `<section class="panel" data-panel="upcoming" aria-labelledby="upcoming-h">
    <div class="panel-head"><div>
      <h2 id="upcoming-h">Not here yet</h2>
      <p class="hint">Listed so you know they're deliberate gaps rather than things you failed to
        find.</p>
    </div></div>
    <div class="row" data-placeholder="custom-domain">
      <div class="info"><b>Custom domains</b><span class="hint">Serve artifacts from your own
        hostname. Content already runs on its own origin, which is the hard part.</span></div>
      <div class="row-actions"><span class="badge is-locked">Planned</span></div>
    </div>
    <div class="row" data-placeholder="webhooks">
      <div class="info"><b>Webhooks</b><span class="hint">Notify a system when an artifact is
        published or viewed.</span></div>
      <div class="row-actions"><span class="badge is-locked">Planned</span></div>
    </div>
    <div class="row" data-placeholder="audit-log">
      <div class="info"><b>Audit log</b><span class="hint">A durable record of every access change,
        beyond the per-artifact view log.</span></div>
      <div class="row-actions"><span class="badge is-locked">Planned</span></div>
    </div>
  </section>`;

  return portalShell({
    viewer,
    section: "settings",
    title: "Settings",
    heading: "Settings",
    lede: `You, your workspace, and how this instance decides who reaches what.`,
    body: `${account}${workspacePanel(viewer)}${security}${later}`,
  });
}

// --- Platform (super admin only) --------------------------------------------

/**
 * A read-only picture of how this deployment is configured. Deliberately says
 * *whether* a secret is set and never what it is — this page exists so an
 * operator can diagnose an instance, not so a screenshot can leak one.
 */
export interface PlatformInfo {
  origin: string;
  accessConfigured: boolean;
  accessTeamDomain: string;
  accessManagementConfigured: boolean;
  contentHosts: string[];
  devLogin: boolean;
  adminCount: number;
  superAdminCount: number;
  serviceTokenCount: number;
  totals: { artifacts: number; versions: number; bytes: number; people: number; tokens: number };
}

function configRow(key: string, label: string, ok: boolean, detail: string, okWord = "Configured"): string {
  return `<div class="row" data-config="${esc(key)}" data-config-state="${ok ? "ok" : "unset"}">
    <div class="info"><b>${esc(label)}</b><span class="hint">${detail}</span></div>
    <div class="row-actions">${
      ok
        ? `<span class="badge is-active">${esc(okWord)}</span>`
        : `<span class="badge is-locked">Not set</span>`
    }</div>
  </div>`;
}

export function platformPage(viewer: PortalViewer, info: PlatformInfo): string {
  const config = `<section class="panel" data-panel="platform-config" aria-labelledby="config-h">
    <div class="panel-head"><div>
      <h2 id="config-h">Instance configuration</h2>
      <p class="hint">Read-only. Every value below comes from deployment configuration — this page
        reports whether a secret is set, never what it is.</p>
    </div></div>
    ${configRow(
      "origin",
      "Canonical origin",
      true,
      `<span class="mono">${esc(info.origin)}</span> — canonical links, sitemap and share URLs.`,
      "Set"
    )}
    ${configRow(
      "access",
      "Cloudflare Access (sign-in)",
      info.accessConfigured,
      info.accessConfigured
        ? `Team domain <span class="mono">${esc(info.accessTeamDomain)}</span>. Every request carries a verified identity.`
        : `<span class="mono">ACCESS_AUD</span> / <span class="mono">ACCESS_TEAM_DOMAIN</span> are unset.
           Sign-in is not enforced by Access on this deployment.`
    )}
    ${configRow(
      "access-management",
      "Access management API",
      info.accessManagementConfigured,
      info.accessManagementConfigured
        ? `Invites and pauses are written straight to the Access allow-list.`
        : `<span class="mono">CF_API_TOKEN</span>, <span class="mono">CF_ACCOUNT_ID</span>,
           <span class="mono">ACCESS_VIEWER_APP_ID</span> and
           <span class="mono">ACCESS_VIEWER_POLICY_ID</span> are needed to manage sign-in from here.`
    )}
    ${configRow(
      "content-hosts",
      "Content-origin isolation",
      info.contentHosts.length > 0,
      info.contentHosts.length
        ? `Artifacts are served only from <span class="mono">${esc(info.contentHosts.join(", "))}</span>,
           so uploaded HTML never runs on the app origin.`
        : `<span class="mono">CONTENT_HOSTNAMES</span> is unset, so uploaded artifact HTML runs on the
           same origin as this portal. Set it before serving untrusted content.`
    )}
    ${configRow(
      "dev-login",
      "Dev login bypass",
      !info.devLogin,
      info.devLogin
        ? `<span class="mono">DEV_LOGIN</span> is on: any caller is trusted as the email they claim.
           This must never be set in production.`
        : `Off — identity always comes from a verified Access token.`,
      "Off"
    )}
  </section>`;

  const operators = `<section class="panel" data-panel="platform-operators" aria-labelledby="ops-h">
    <div class="panel-head"><div>
      <h2 id="ops-h">Operators</h2>
      <p class="hint">Roles are configuration, not data — nothing in the product can grant or revoke
        them, which is what makes lockout impossible.</p>
    </div></div>
    <div class="row" data-operator="super-admins">
      <div class="info"><b>Super admins</b><span class="hint"><span class="mono">SUPER_ADMIN_EMAILS</span>
        — can manage other admins, and can never be paused or removed.</span></div>
      <div class="row-actions"><span class="badge is-role">${num(info.superAdminCount)}</span></div>
    </div>
    <div class="row" data-operator="admins">
      <div class="info"><b>Admins</b><span class="hint"><span class="mono">ADMIN_EMAILS</span>
        — manage every artifact and every member.</span></div>
      <div class="row-actions"><span class="badge is-role">${num(info.adminCount)}</span></div>
    </div>
    <div class="row" data-operator="service-tokens">
      <div class="info"><b>Admin service tokens</b><span class="hint"><span class="mono">ADMIN_SERVICE_TOKENS</span>
        — non-interactive callers with admin reach, capped below super admin.</span></div>
      <div class="row-actions"><span class="badge is-role">${num(info.serviceTokenCount)}</span></div>
    </div>
  </section>`;

  const t = info.totals;
  const stats = `<section class="stats" aria-label="Instance totals">
    ${statTile("instance-artifacts", "Artifacts", num(t.artifacts), `${plural(t.versions, "version")} kept`)}
    ${statTile("instance-people", "People", num(t.people), "in the directory")}
    ${statTile("instance-tokens", "API tokens", num(t.tokens), "issued, all states")}
    ${statTile("instance-storage", "Storage", bytes(t.bytes), "across every version")}
  </section>`;

  return portalShell({
    viewer,
    section: "platform",
    title: "Platform",
    heading: "Platform",
    lede: `Operator tools for this deployment. Only a super admin can open this page.`,
    body: `${stats}${config}${operators}`,
  });
}

// --- client scripts ---------------------------------------------------------

/** File picking: drag/drop + browse. Needed by any page with a publish form. */
const PICK_SCRIPT = `
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
/* Dropping outside a dropzone should not navigate away from the portal. */
['dragover','drop'].forEach(function(ev){
  document.addEventListener(ev, function(e){
    var t = e.target;
    if(!t || !t.closest || !t.closest('[data-dropzone]')) e.preventDefault();
  });
});
$$('[data-dropzone]').forEach(initDropzone);
`;

const PUBLISH_SCRIPT = `
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
  $('[data-manage-link]', success).href = '/admin/artifacts/' + encodeURIComponent(data.slug);
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
`;

const FILTER_SCRIPT = `
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
`;

/** Everything the single-artifact page does: new version, rollback, access, delete. */
const DETAIL_SCRIPT = `
/* ---- share link is stored relative, shown absolute ---- */
var shareUrl = $('[data-share-url]');
if(shareUrl){
  shareUrl.value = new URL(shareUrl.value, location.href).href;
  shareUrl.addEventListener('focus', function(e){ e.target.select(); });
}

/* ---- new version ---- */
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

/* ---- roll back to an older version ---- */
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
      var badge = $('[data-artifact-detail="' + slug + '"] [data-badge=visibility]');
      if(badge){
        badge.textContent = data.visibility === 'everyone' ? 'Everyone' : 'Restricted · ' + data.emails.length;
        badge.classList.toggle('is-open', data.visibility === 'everyone');
        badge.classList.toggle('is-locked', data.visibility !== 'everyone');
      }
    } catch(err){ setStatus(status, 'Network error — try again.', 'error'); }
    finally { b.disabled = false; }
  });
});

/* ---- danger zone: delete ---- */
$$('button[data-del]').forEach(function(b){
  b.addEventListener('click', async function(){
    var slug = b.getAttribute('data-del');
    if(!confirm('Delete "' + slug + '"? This removes every version and file. It cannot be undone.')) return;
    var status = $('[data-status]', b.parentNode);
    b.disabled = true;
    setStatus(status, 'Deleting…');
    var res = await fetch('/api/artifacts/' + encodeURIComponent(slug), { method:'DELETE' });
    if(res.ok) location.href = '/admin/artifacts';
    else {
      b.disabled = false;
      setStatus(status, (await detail(res)) || 'Delete failed — try again.', 'error');
    }
  });
});
`;

// --- artifact styles --------------------------------------------------------

const ARTIFACTS_STYLE = `
.sr-file{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;opacity:0}
.publish{background:linear-gradient(145deg,var(--card),rgba(10,132,255,.08))}
.publish form{display:grid;gap:.95rem}
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
.section-head h2{font-size:1.15rem;margin:0;letter-spacing:-.035em}
.section-head input{width:auto;min-width:16rem}

.artifact{border:1px solid var(--border);border-radius:var(--radius);background:var(--card);margin-bottom:.78rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);transition:border-color .15s,transform .15s;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;padding:1rem 1.15rem}
.artifact:hover{border-color:var(--border-strong);transform:translateY(-1px)}
.artifact:focus-within{border-color:rgba(10,132,255,.55)}
.art-open{flex:1;min-width:14rem;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;color:inherit;border-radius:14px}
.art-open:hover{color:inherit}
.art-open:hover .art-title{color:var(--accent)}
.art-id{display:flex;flex-direction:column;min-width:11rem;flex:1}
.art-title{font-weight:680;letter-spacing:-.025em;transition:color .15s}
.art-slug{color:var(--muted)}
.art-desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:36rem}
.art-badges{display:flex;gap:.35rem;flex-wrap:wrap}
.art-actions{display:flex;gap:.42rem;align-items:center;flex-wrap:wrap}
a.ghost.link-button.small-link{padding:.42rem .85rem;font-size:.82rem}

.art-summary .art-badges{margin-bottom:.5rem}
.art-desc-full{margin:0;max-width:46rem}
.sub-panel{margin-bottom:0}
.sub-panel h2{font-size:1.02rem}
form.newver{display:grid;gap:.55rem;margin-top:.9rem;padding-top:.9rem;border-top:1px solid var(--border)}
.emails-wrap{margin-bottom:.5rem}
.panel[data-panel=views] .row{padding:.55rem 0}

@media(max-width:720px){
  .art-actions{width:100%;justify-content:flex-start}
  .linkrow{align-items:stretch;flex-direction:column}
}
`;
