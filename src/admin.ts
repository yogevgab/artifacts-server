import type { ArtifactRow, VersionRow, ViewRow } from "./env";
import type { ViewerSummary, VersionViewSummary, ViewSources, MailStatusSummary } from "./db";
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
import { operatorSections, PLATFORM_STYLE, type OperatorData } from "./platform";
import { ANALYTICS_CONSENT_KEY } from "./consent";
import { PLAN_LABEL, priceLabel, type WorkspaceBilling } from "./plan-copy";
import type { PlanName } from "./quota";

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

/**
 * The near-limit warning (issue: free-to-paid path, §3). Shown BEFORE a
 * publish gets refused by quota_exceeded, not after — finding out an account
 * is full by failing is the worst version of this. Fires at >=80% of either
 * limit (`usageWarning` in src/plan-copy.ts) and only when there is
 * somewhere left to upgrade to; a workspace already on Team that is near its
 * (very large) limit has nothing to offer here, so it renders nothing.
 *
 * States a fact and offers an action — no colour-only signal (the numbers
 * and the sentence carry the meaning; the border tint is decorative), no
 * urgency language.
 */
function usageWarningBanner(billing: WorkspaceBilling | undefined): string {
  if (!billing || !billing.warning || !billing.nextPlan) return "";
  const { warning, nextPlan } = billing;
  const isArtifacts = warning.limit === "artifacts";
  const current = isArtifacts ? num(warning.current) : bytes(warning.current);
  const max = isArtifacts ? num(warning.max) : bytes(warning.max);
  const pct = Math.round(warning.ratio * 100);
  const upgradeUrl = billing.checkout[nextPlan];
  return `<div class="usage-warning" data-banner="usage-warning">
    <p><b>${pct}% of your ${isArtifacts ? "artifact" : "storage"} limit</b> &mdash;
      ${current} of ${max} ${isArtifacts ? "artifacts" : "used"}.
      ${
        upgradeUrl
          ? `<a href="${esc(upgradeUrl)}" data-upgrade-link="${esc(nextPlan)}">Upgrade to ${esc(PLAN_LABEL[nextPlan])} &rarr;</a>`
          : `Upgrading to ${esc(PLAN_LABEL[nextPlan])} isn't configured on this deployment yet.`
      }
    </p>
  </div>`;
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
    // Sign-in used to depend on a Cloudflare Access allow-list that could be
    // unconfigured or unreachable, so this row reported on that. The app owns
    // identity now: anybody in the directory who is not paused can sign in, and
    // there is no external system left to be out of sync with.
    const active = users.users.filter((u) => u.status !== "disabled").length;
    health.push({
      key: "sign-in",
      label: "Sign-in",
      state: active ? "ok" : "todo",
      detail: active
        ? `${people(active)} can sign in.`
        : `Nobody has signed in yet. <a href="/admin/people">Invite somebody →</a>`,
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
    body: `${usageWarningBanner(viewer.workspace?.billing)}
      ${statsRow(rows, versions, views)}
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
/* A fact, not an alarm: same card surface as everything else on the page, just
   with an accent-tinted left edge so it's findable at a glance — never colour
   alone, since the sentence itself always says what's true. */
.usage-warning{background:var(--card);border:1px solid var(--border);border-left:3px solid var(--accent);
  border-radius:var(--radius);padding:.95rem 1.15rem;margin-bottom:1.35rem;box-shadow:var(--shadow);
  backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.usage-warning p{margin:0;font-size:.92rem;color:var(--muted);line-height:1.55}
.usage-warning b{color:var(--fg)}
.usage-warning a{font-weight:620;white-space:nowrap}
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

// --- Gallery ----------------------------------------------------------------

/**
 * Everything this person can *open*, as opposed to everything they manage
 * (issue #35).
 *
 * This was the standalone `/gallery` page, which looked and behaved like a
 * second product: its own header, its own typography, no navigation back into
 * the dashboard. It is now a portal section like any other, so the answer to
 * "where do I find the thing somebody shared with me?" is a tab, not a URL you
 * had to be told about. `/gallery` still resolves — it redirects here.
 *
 * Read-only by design. A card links to the artifact itself; the management
 * affordances live in Artifacts, and only for artifacts this person owns.
 */
export function galleryPage(viewer: PortalViewer, rows: ArtifactRow[]): string {
  const cards = rows
    .map(
      (r) => `<a class="card" href="/${esc(r.slug)}/" data-artifact="${esc(r.slug)}">
      <h3>${esc(r.title)}</h3>
      ${r.description ? `<p>${esc(r.description)}</p>` : `<p class="hint">/${esc(r.slug)}/</p>`}
      <div class="meta"><span class="tag">${esc(r.type)}</span>
        <span class="badge" data-badge="version">v${r.current_version}</span>
        ${
          r.visibility === "everyone"
            ? `<span class="badge is-open" data-badge="visibility">everyone</span>`
            : `<span class="badge is-locked" data-badge="visibility">restricted</span>`
        }
        <span>${esc(r.created_at.slice(0, 10))}</span></div>
    </a>`
    )
    .join("");

  const empty = `<div class="empty" data-empty="gallery">
    <h3>No artifacts yet.</h3>
    <p>Nothing has been shared with you so far. When someone publishes an artifact and
      grants you access, it shows up here. Anything you publish yourself appears under
      <a href="/admin/artifacts">Artifacts</a>.</p>
  </div>`;

  return portalShell({
    viewer,
    section: "gallery",
    title: "Gallery",
    heading: "Gallery",
    lede: viewer.isAdmin
      ? `Every artifact on this instance, as a reader sees it. Open one to view the page itself.`
      : `Everything you can open — what you published, plus what other people have shared with
         you. Managing an artifact happens under <a href="/admin/artifacts">Artifacts</a>.`,
    body: `<section aria-labelledby="gallery-h">
      <div class="section-head">
        <h2 id="gallery-h">Shared with you
          <span class="hint">${plural(rows.length, "artifact")}</span></h2>
      </div>
      ${rows.length ? `<div class="grid">${cards}</div>` : empty}
    </section>`,
    style: GALLERY_STYLE,
  });
}

/* The same section heading the Artifacts list uses — repeated here rather than
   shared, because this section deliberately loads none of ARTIFACTS_STYLE (no
   publish form, no drag-and-drop, nothing that can change anything). */
const GALLERY_STYLE = `
.section-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin:0 0 .95rem}
.section-head h2{font-size:1.15rem;margin:0;letter-spacing:-.035em}
.section-head .hint{margin-left:.45rem;font-weight:400}
`;

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

/**
 * "Did the person I shared this with actually read it?" — the single most
 * valuable question an owner can ask, and the one the raw event log above
 * doesn't answer directly. One row per distinct viewer, aggregated in SQL by
 * `viewersFor`, not here.
 */
function viewersPanel(slug: string, viewers: ViewerSummary[]): string {
  const rows = viewers
    .map(
      (v) => `<div class="row"><div class="info">${esc(v.email ?? "Signed out")}
        <span class="hint">${plural(v.views, "view")} · last ${stamp(v.lastViewedAt)} · v${v.lastVersion}</span></div></div>`
    )
    .join("");
  return `<section class="panel sub-panel" data-panel="viewers" aria-labelledby="viewers-h">
    <div class="panel-head"><div>
      <h2 id="viewers-h">Viewers <span class="hint">${plural(viewers.length, "person")}</span></h2>
      <p class="hint">Everyone who has opened it, how often, and which version they last saw.</p>
    </div></div>
    ${
      viewers.length
        ? rows
        : `<p class="note">Nobody has opened this yet — copy the share link above and send it to someone who has access.</p>`
    }
  </section>`;
}

/** Which versions are still being opened, so rolling back doesn't quietly break someone's link. */
function versionViewsPanel(slug: string, versions: VersionViewSummary[]): string {
  const rows = versions
    .map(
      (v) => `<div class="row"><div class="info"><b>v${v.version}</b>
        <span class="hint">${plural(v.total, "view")} · ${plural(v.unique, "viewer")} · last ${stamp(v.lastViewedAt)}</span></div></div>`
    )
    .join("");
  return `<section class="panel sub-panel" data-panel="version-views" aria-labelledby="version-views-h">
    <div class="panel-head"><div>
      <h2 id="version-views-h">Views by version</h2>
      <p class="hint">Which versions people are still opening — check before making an older one live.</p>
    </div></div>
    ${versions.length ? rows : `<p class="note">No version has been opened yet.</p>`}
  </section>`;
}

/** One ranked list, shared by the referrer and country halves of `sourcesPanel`. */
function sourceList<T extends { count: number }>(
  rows: T[],
  label: (r: T) => string | null,
  unknown: string
): string {
  if (!rows.length) return "";
  return rows
    .map(
      (r) => `<div class="row"><div class="info">${esc(label(r) || unknown)}</div>
        <span class="hint">${plural(r.count, "view")}</span></div>`
    )
    .join("");
}

/** Where views came from — already captured on every row, never surfaced until now. */
function sourcesPanel(slug: string, sources: ViewSources): string {
  const empty = !sources.referrers.length && !sources.countries.length;
  return `<section class="panel sub-panel" data-panel="sources" aria-labelledby="sources-h">
    <div class="panel-head"><div>
      <h2 id="sources-h">Where views come from</h2>
      <p class="hint">Top referrers and countries, from the same view log.</p>
    </div></div>
    ${
      empty
        ? `<p class="note">No referrer or country data yet — it fills in as people open the link.</p>`
        : `<div class="pcols">
      <div data-sources="referrers">
        <p class="sources-h3">Referrers</p>
        ${sourceList(sources.referrers, (r) => r.referrer, "Direct / no referrer")}
      </div>
      <div data-sources="countries">
        <p class="sources-h3">Countries</p>
        ${sourceList(sources.countries, (r) => r.country, "Unknown")}
      </div>
    </div>`
    }
  </section>`;
}

/** One granted address's display state, computed once for `accessPanel`'s rows. */
export interface GrantRow {
  email: string;
  /** Human-readable last-opened / never-opened / delivery-failure sentence. */
  status: string;
  /** True when the most recent `mail_log` entry for this address failed. */
  mailFailed: boolean;
}

/**
 * "Has this person actually opened it, and did the mail we sent them even
 * arrive?" — the two questions the old comma-separated textarea had no way to
 * answer. Both come from data that already exists: `viewersFor` (artifact
 * views) and `mailStatusFor` (mail_log), matched to each grant case-
 * insensitively since email casing is never normalized on the way in.
 */
export function grantRowsFor(
  emails: string[],
  viewers: ViewerSummary[],
  mailStatus: Map<string, MailStatusSummary>
): GrantRow[] {
  return emails.map((email) => {
    const lower = email.toLowerCase();
    const viewer = viewers.find((v) => v.email?.toLowerCase() === lower);
    const opened = viewer
      ? `Last opened ${stamp(viewer.lastViewedAt)} · v${viewer.lastVersion} · ${plural(viewer.views, "view")}`
      : "Hasn't opened it yet";
    const mail = mailStatus.get(lower);
    const mailFailed = mail?.status === "failed";
    const status = mailFailed
      ? `${opened} · we couldn't deliver mail to this address (last tried ${stamp(mail!.createdAt)})`
      : opened;
    return { email, status, mailFailed };
  });
}

/**
 * The list PUT to `/api/artifacts/:slug/access` after removing one address —
 * pure, and exported so "removing Dana can never remove Sam" is a provable,
 * unit-tested invariant rather than something a manual click-through happens
 * to catch. This is the typed twin of the one-line filter the Remove button's
 * handler runs in the browser (see DETAIL_SCRIPT below); this file has no
 * bundler, so the browser copy can't simply `import` this one.
 */
export function withoutGrant(emails: string[], removed: string): string[] {
  const target = removed.trim().toLowerCase();
  return emails.filter((e) => e.trim().toLowerCase() !== target);
}

/** Same idea for the Add button: appends, de-duplicating case-insensitively. */
export function withAddedGrant(emails: string[], added: string): string[] {
  const clean = added.trim();
  if (!clean) return emails;
  const lower = clean.toLowerCase();
  if (emails.some((e) => e.trim().toLowerCase() === lower)) return emails;
  return [...emails, clean];
}

function grantRowHtml(slug: string, row: GrantRow): string {
  return `<div class="row" data-grant="${esc(row.email)}">
    <div class="info"><b>${esc(row.email)}</b><span class="hint">${esc(row.status)}</span></div>
    <div class="row-actions">
      ${row.mailFailed ? `<span class="badge is-warn" data-badge="mail">Delivery failed</span>` : ""}
      <button type="button" class="ghost small" data-remove-grant="${esc(row.email)}" data-slug="${esc(slug)}"
        aria-label="Remove ${esc(row.email)}">Remove</button>
    </div>
  </div>`;
}

/**
 * Exported (unlike this file's other panel functions) so the delivery-failure
 * and never-opened states can be unit-tested directly, without threading a
 * full `ArtifactDetailInput` — and without going through the `/admin/…` HTTP
 * route, whose handler in src/index.ts is not this task's to wire up.
 */
export function accessPanel(
  r: ArtifactRow,
  emails: string[],
  viewers: ViewerSummary[],
  mailStatus: Map<string, MailStatusSummary>
): string {
  const restricted = r.visibility === "restricted";
  const rows = grantRowsFor(emails, viewers, mailStatus);
  return `<section class="panel sub-panel" data-panel="access" id="acc-${esc(r.slug)}" aria-labelledby="access-h">
    <div class="panel-head"><div>
      <h2 id="access-h">Access</h2>
      <p class="hint">Signing in decides who reaches rtfx.pro at all; this decides who may open
        this artifact once they have.</p>
    </div></div>
    <label for="vis-${esc(r.slug)}">Who can open this artifact</label>
    <select id="vis-${esc(r.slug)}" name="visibility" data-vis="${esc(r.slug)}">
      <option value="restricted"${restricted ? " selected" : ""}>Restricted — only the people you list (plus admins)</option>
      <option value="everyone"${!restricted ? " selected" : ""}>Everyone — any signed-in user</option>
    </select>
    <div class="emails-wrap"${restricted ? "" : " hidden"}>
      <div class="grant-list" data-grant-list aria-label="People with access to this artifact">
        ${rows.map((row) => grantRowHtml(r.slug, row)).join("")}
      </div>
      <p class="hint"${rows.length ? "" : " data-no-grants"}>${
        rows.length
          ? `${people(rows.length)} can open it today.`
          : "Nobody else can open this yet — add an email below to share it."
      }</p>
      <div class="grant-add">
        <label for="add-em-${esc(r.slug)}">Add someone</label>
        <div class="grant-add-row">
          <input id="add-em-${esc(r.slug)}" type="email" inputmode="email" placeholder="alice@example.com"
            autocomplete="off" data-add-email>
          <button type="button" class="ghost small" data-add-grant="${esc(r.slug)}">Add</button>
        </div>
        <p class="status" data-add-error role="alert" hidden></p>
      </div>
    </div>
    <div class="row-actions"><button class="small" data-save="${esc(r.slug)}">Save access</button>
      <span class="status acc-status" data-status aria-live="polite" hidden></span></div>
  </section>`;
}

export interface ArtifactDetailInput {
  viewer: PortalViewer;
  row: ArtifactRow;
  emails: string[];
  versions: VersionRow[];
  views: ViewsInfo;
  viewers: ViewerSummary[];
  versionViews: VersionViewSummary[];
  sources: ViewSources;
  /**
   * Most recent mail_log entry per granted address (src/db.ts `mailStatusFor`).
   * Optional and defaulted to empty: a caller that hasn't wired the lookup yet
   * still renders — the access panel just shows no delivery-failure state,
   * rather than the whole page failing to compile or render.
   */
  mailStatus?: Map<string, MailStatusSummary>;
}

export function artifactDetailPage(o: ArtifactDetailInput): string {
  const { viewer, row, emails, versions, views, viewers, versionViews, sources, mailStatus = new Map() } = o;
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
        ${viewersPanel(row.slug, viewers)}
      </div>
      <div class="pcols">
        ${versionViewsPanel(row.slug, versionViews)}
        ${sourcesPanel(row.slug, sources)}
      </div>
      ${viewsPanel(row.slug, views)}
      ${accessPanel(row, emails, viewers, mailStatus)}
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
    ${planRow(ws.billing)}
  </section>`;
}

/**
 * The workspace-plan row (issue: free-to-paid path). Billing attaches to the
 * workspace, not to any one member — the plan, usage and upgrade link shown
 * here are the same for everyone in it.
 *
 * `billing` is optional (see `PortalViewer.workspace.billing`): the caller
 * that builds the viewer needs an extra `usageFor` D1 aggregate plus a
 * `checkoutUrl` call to populate it, both async. When it's missing, this
 * falls back to naming the plan as Free with no usage line and no upgrade
 * link, rather than guessing — an absent value is "not computed yet", never
 * "definitely free with room to spare".
 */
function planRow(billing: WorkspaceBilling | undefined): string {
  if (!billing) {
    return `<div class="row" data-setting="workspace-plan">
      <div class="info"><b>Plan</b><span class="hint">Billing attaches to the workspace, not to you.</span></div>
      <div class="row-actions"><span class="badge" data-badge="workspace-plan">Free</span></div>
    </div>`;
  }
  const planName = billing.plan as PlanName;
  const label = PLAN_LABEL[planName] ?? billing.plan;
  const usageLine = `${num(billing.usage.artifacts)} of ${num(billing.limits.maxArtifacts)} artifacts &middot;
    ${bytes(billing.usage.storageBytes)} of ${bytes(billing.limits.maxStorageBytes)}.`;
  const nextPlan = billing.nextPlan;
  const upgradeUrl = nextPlan ? billing.checkout[nextPlan] : null;
  const upgrade = !nextPlan
    ? ""
    : upgradeUrl
      ? `<a class="ghost link-button small-link" href="${esc(upgradeUrl)}" data-upgrade-link="${esc(nextPlan)}">Upgrade to ${esc(PLAN_LABEL[nextPlan])} &mdash; ${esc(priceLabel(nextPlan))} &rarr;</a>`
      : `<span class="hint" data-upgrade-unavailable>Upgrade not configured on this deployment.</span>`;
  return `<div class="row" data-setting="workspace-plan">
    <div class="info"><b>Plan</b><span class="hint">${usageLine}</span></div>
    <div class="row-actions"><span class="badge" data-badge="workspace-plan">${esc(label)}</span>${upgrade}</div>
  </div>`;
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
      <div class="info"><b>Email</b><span class="hint">Verified by a one-time code the first time you signed in.</span></div>
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
        sent by rtfx.pro. There is no password to change here.</span></div>
      <div class="row-actions"><a href="/login">Sign-in page →</a></div>
    </div>
  </section>`;

  const security = `<section class="panel" data-panel="security" aria-labelledby="security-h">
    <div class="panel-head"><div>
      <h2 id="security-h">Security</h2>
      <p class="hint">Two independent layers decide every request, and both must say yes.</p>
    </div></div>
    <div class="row" data-setting="access-layer">
      <div class="info"><b>Who may sign in</b><span class="hint">Anyone who verifies an email
        address. Pausing somebody signs them out everywhere and revokes their API tokens.</span></div>
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
    ${
      viewer.posthog
        ? `<div class="row" data-setting="dashboard-analytics">
      <div class="info"><b>Session recording &amp; error tracking</b><span class="hint">Off until you
        say yes — the first dashboard page you opened after signing in asked. Declining, or your
        browser sending Do Not Track / Global Privacy Control, means nothing loads, ever. Change
        your mind by clearing <code class="mono">${esc(ANALYTICS_CONSENT_KEY)}</code> from this
        browser's storage — you'll be asked again.</span></div>
      <div class="row-actions"><a href="/privacy#dashboard-analytics">What this collects →</a></div>
    </div>`
        : ""
    }
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

/**
 * `operator` carries the control plane's readouts (accounts, audit, enquiries,
 * billing, mail — see src/platform.ts). Optional so that this page still renders
 * for a caller that has only computed the configuration half; absent means those
 * panels are simply not on the page, never that they are empty.
 */
export function platformPage(
  viewer: PortalViewer,
  info: PlatformInfo,
  operator?: OperatorData
): string {
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
      "Sign-in",
      info.accessConfigured,
      info.accessConfigured
        ? `Team domain <span class="mono">${esc(info.accessTeamDomain)}</span>. Every request carries a verified identity.`
        : `<span class="mono">ACCESS_AUD</span> / <span class="mono">ACCESS_TEAM_DOMAIN</span> are unset.
           Sign-in is not enforced by Access on this deployment.`
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
    body: `${stats}${operator ? operatorSections(operator) : ""}${config}${operators}`,
    style: operator ? PLATFORM_STYLE : undefined,
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

/* The DOM row list is the source of truth for who gets submitted — read off
   fresh on every save, never a shared editable field. That is what makes
   "remove Dana" structurally incapable of also dropping Sam: her row is
   simply one of the elements this reads back. */
function grantEmails(card){
  return $$('[data-grant-list] [data-grant]', card).map(function(row){
    return row.getAttribute('data-grant');
  });
}
/* Mirrors the typed, unit-tested withoutGrant() in src/admin.ts — see its
   comment for why this can't just import that one. */
function grantsAfterRemoving(list, removed){
  var target = removed.trim().toLowerCase();
  return list.filter(function(e){ return e.trim().toLowerCase() !== target; });
}
/* Mirrors withAddedGrant(). */
function grantsAfterAdding(list, added){
  var clean = added.trim();
  if(!clean) return list;
  var lower = clean.toLowerCase();
  if(list.some(function(e){ return e.trim().toLowerCase() === lower; })) return list;
  return list.concat([clean]);
}
var EMAIL_RE = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;

async function putAccess(slug, visibility, emails, status){
  var res = await fetch('/api/artifacts/' + encodeURIComponent(slug) + '/access', {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ visibility: visibility, emails: emails })
  });
  var data = await res.json().catch(function(){ return {}; });
  if(!res.ok){ setStatus(status, data.detail || 'Could not save access.', 'error'); return null; }
  return data;
}

$$('button[data-save]').forEach(function(b){
  b.addEventListener('click', async function(){
    var slug = b.getAttribute('data-save');
    var card = document.getElementById('acc-' + slug);
    var status = $('[data-status]', card);
    var visibility = $('[name=visibility]', card).value;
    b.disabled = true;
    setStatus(status, 'Saving…');
    try {
      var data = await putAccess(slug, visibility, grantEmails(card), status);
      if(!data) return;
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

/* Each row's Remove button only ever knows its own email and its own slug —
   there is no way for it to compute a list that touches another row. */
$$('button[data-remove-grant]').forEach(function(b){
  b.addEventListener('click', async function(){
    var slug = b.getAttribute('data-slug');
    var email = b.getAttribute('data-remove-grant');
    var card = document.getElementById('acc-' + slug);
    var status = $('[data-status]', card);
    var visibility = $('[name=visibility]', card).value;
    var next = grantsAfterRemoving(grantEmails(card), email);
    b.disabled = true;
    setStatus(status, 'Removing ' + email + '…');
    try {
      var data = await putAccess(slug, visibility, next, status);
      if(!data){ b.disabled = false; return; }
      setStatus(status, 'Removed ' + email + '.', 'ok');
      location.reload();
    } catch(err){ setStatus(status, 'Network error — try again.', 'error'); b.disabled = false; }
  });
});

$$('button[data-add-grant]').forEach(function(b){
  b.addEventListener('click', async function(){
    var slug = b.getAttribute('data-add-grant');
    var card = document.getElementById('acc-' + slug);
    var input = $('[data-add-email]', card);
    var err = $('[data-add-error]', card);
    var status = $('[data-status]', card);
    var value = input.value.trim();
    if(!EMAIL_RE.test(value)){
      err.textContent = value
        ? '"' + value + '" is not a valid email address.'
        : 'Enter an email address to add.';
      err.hidden = false;
      input.focus();
      return;
    }
    err.hidden = true; err.textContent = '';
    var visibility = $('[name=visibility]', card).value;
    var next = grantsAfterAdding(grantEmails(card), value);
    b.disabled = true;
    setStatus(status, 'Adding ' + value + '…');
    try {
      var data = await putAccess(slug, visibility, next, status);
      if(!data){ b.disabled = false; return; }
      setStatus(status, 'Added ' + value + '.', 'ok');
      location.reload();
    } catch(err2){ setStatus(status, 'Network error — try again.', 'error'); b.disabled = false; }
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
.grant-list{display:flex;flex-direction:column}
.grant-add{margin-top:.85rem;padding-top:.85rem;border-top:1px solid var(--border);display:grid;gap:.4rem}
.grant-add label{font-size:.82rem;font-weight:620}
.grant-add-row{display:flex;gap:.5rem;flex-wrap:wrap}
.grant-add-row input{flex:1;min-width:14rem}
.grant-add-row button{flex:none}
.panel[data-panel=views] .row{padding:.55rem 0}
/* A referrer is an arbitrary URL with no break opportunities, so it has to be
   allowed to wrap and the count beside it must never shrink — otherwise the
   count is squeezed to zero width and prints on top of the URL. */
.panel[data-panel=sources] .row{gap:.6rem;align-items:baseline}
.panel[data-panel=sources] .row .info{min-width:0;overflow-wrap:anywhere}
.panel[data-panel=sources] .row .hint{flex:none;white-space:nowrap}
/* A column label, deliberately not a heading: as an <h3> it sat at .72rem
   beside 15px h3s elsewhere, which is the size mismatch a reader notices
   without being able to name. */
.sources-h3{font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);margin:0 0 .35rem}

@media(max-width:720px){
  .art-actions{width:100%;justify-content:flex-start}
  .linkrow{align-items:stretch;flex-direction:column}
}
`;
