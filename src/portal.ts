import { layout, esc, brandLockup, BRAND_STYLE } from "./pages";
import type { UserRole } from "./users";
import { accountRoleLabel, type AccountRole } from "./accounts";
import {
  CONSENT_STYLE,
  ANALYTICS_CONSENT_STYLE,
  analyticsConsentNotice,
  analyticsConsentScript,
} from "./consent";
import { posthogCsp, type PostHogConfig } from "./posthog";
import type { WorkspaceBilling } from "./plan-copy";

/**
 * The /admin portal shell: navigation, the page chrome every section shares,
 * and the small client script that every section needs. Sections themselves
 * live in `admin.ts` (overview, artifacts, settings, platform), `people.ts` and
 * `integrations.ts` — see docs/DESIGN.md §8.
 *
 * The portal is server-rendered and navigates with ordinary links. There is no
 * client router: every section is a real URL that survives a reload, a bookmark
 * and a right-click, and works with JavaScript switched off.
 */

/** Top-level sections, in nav order. */
export type SectionId =
  | "overview"
  | "artifacts"
  | "gallery"
  | "members"
  | "billing"
  | "people"
  | "integrations"
  | "settings"
  | "platform";

/**
 * Who is looking at the portal — enough to decide which sections exist for this
 * person, and nothing more. What they may *do* inside a section is decided by
 * the API on every request; hiding a nav item has never protected anything.
 */
export interface PortalViewer {
  email: string;
  /**
   * PLATFORM authority: email in ADMIN_EMAILS/SUPER_ADMIN_EMAILS, or an
   * allow-listed service token. Config-derived; never an account role.
   */
  isAdmin: boolean;
  /**
   * Effective PLATFORM role for this request (capped at `admin` for
   * non-interactive callers). Not to be confused with `workspace.role`, which is
   * the caller's role inside one account and carries no instance-wide authority.
   */
  role: UserRole;
  /** True when the caller authenticated with an `Authorization: Bearer` API token. */
  isTokenCaller: boolean;
  /**
   * The account/workspace this request is acting in (issue #27), or null when the
   * caller has none yet (un-migrated instance, or a platform token). Shown on
   * every page so it is always obvious *whose* artifacts are listed and where a
   * publish will land; switchable from the header when {@link workspaces} holds
   * more than one.
   */
  workspace?: {
    id: string;
    name: string;
    kind: "personal" | "team";
    /** The viewer's ACCOUNT role here: owner | admin | member | viewer. */
    role: AccountRole;
    /** How many workspaces this person belongs to, for the "+N more" hint. */
    count: number;
    /**
     * Plan, usage against its limits, and an upgrade path for this workspace
     * (free-to-paid path). Optional — and every renderer that reads it must
     * treat its absence as "unknown, not free": a caller that hasn't computed
     * this yet (it needs a `usageFor` D1 aggregate plus `checkoutUrl`, both
     * async — see `workspaceBilling` in src/plan-copy.ts) should get a page
     * that quietly omits usage/upgrade UI, never one that shows a wrong plan.
     */
    billing?: WorkspaceBilling;
  } | null;
  /**
   * Every workspace this person belongs to, in the order the switcher lists
   * them (personal first — see `listMemberships`). Optional: a caller that
   * hasn't computed it gets the passive chip instead of a switcher, which is
   * the pre-switcher behavior rather than an empty dropdown.
   *
   * Absent for a bearer token on purpose. A token is pinned to one workspace
   * and must never be handed the list of the workspaces its owner belongs to.
   */
  workspaces?: { id: string; name: string; kind: "personal" | "team"; role: AccountRole }[];
  /**
   * PostHog project key/host for this deployment, or `null`/absent when
   * `POSTHOG_KEY` is unset — see `posthogConfig` in src/posthog.ts. Optional
   * so that a caller which does not populate it (nothing does yet — see the
   * PostHog rollout report) still type-checks: an absent field here means
   * `portalShell` renders no consent banner and no script at all, which is
   * required behavior, not a bug. Whoever constructs `PortalViewer` from a
   * request (`viewerOf` in src/index.ts) is the one place that needs to call
   * `posthogConfig(c.env)` to light this up for real.
   */
  posthog?: PostHogConfig | null;
}

interface SectionDef {
  id: SectionId;
  path: string;
  label: string;
  /** The one line that says what this section is for. */
  blurb: string;
  visible(v: PortalViewer): boolean;
}

const SECTIONS: SectionDef[] = [
  {
    id: "overview",
    path: "/admin",
    label: "Overview",
    blurb: "Usage and next steps",
    visible: () => true,
  },
  {
    id: "artifacts",
    path: "/admin/artifacts",
    label: "Artifacts",
    blurb: "Publish and manage",
    visible: () => true,
  },
  {
    id: "gallery",
    path: "/admin/gallery",
    label: "Gallery",
    blurb: "Shared with you",
    // What used to be the standalone /gallery page (issue #35). It is the only
    // section that answers "what can I open?" rather than "what do I manage?",
    // and it is the whole product for somebody who has only ever been granted
    // access to other people's work.
    visible: () => true,
  },
  {
    id: "members",
    path: "/admin/members",
    label: "Members",
    blurb: "Who's in this workspace",
    // The workspace half of access, next to the workspace's artifacts and above
    // the platform directory it is constantly confused with. Only for somebody
    // who can act on it — a `member` or `viewer` opening it would find a
    // read-only list and every control refused — and never for a bearer token,
    // which `POST /api/workspace/:id/members` rejects outright.
    visible: (v) =>
      !v.isTokenCaller && (v.workspace?.role === "owner" || v.workspace?.role === "admin"),
  },
  {
    id: "billing",
    path: "/admin/billing",
    label: "Billing",
    blurb: "Plan, usage and limits",
    // The customer half of billing, next to the workspace it bills. Everyone in
    // the workspace sees it — a member who cannot buy anything still needs to
    // know which plan's limits are about to refuse their publish, and the page
    // states plainly that changing the plan is an owner's job.
    //
    // Never for a bearer token: a token is pinned to one workspace and has no
    // business holding a checkout link prefilled with its owner's email. And
    // never without a workspace — there is no plan to talk about yet.
    visible: (v) => !v.isTokenCaller && !!v.workspace,
  },
  {
    id: "people",
    path: "/admin/people",
    label: "People",
    blurb: "Members and invites",
    // Admin-only data, and never for a bearer token: /api/users refuses one
    // outright (denyApiToken), so the portal must not hand it the same
    // directory by another route.
    visible: (v) => v.isAdmin && !v.isTokenCaller,
  },
  {
    id: "integrations",
    path: "/admin/integrations",
    label: "Integrations",
    blurb: "API tokens and agents",
    visible: () => true,
  },
  {
    id: "settings",
    path: "/admin/settings",
    label: "Settings",
    blurb: "Account and security",
    visible: () => true,
  },
  {
    id: "platform",
    path: "/admin/platform",
    label: "Platform",
    blurb: "Operator tools",
    // The operator surface. `role` is capped at `admin` for every
    // non-interactive caller, so a token can never reach this.
    visible: (v) => v.role === "super_admin",
  },
];

/** The sections this person can navigate to, in nav order. */
export function sectionsFor(v: PortalViewer): { id: SectionId; path: string; label: string }[] {
  return SECTIONS.filter((s) => s.visible(v)).map(({ id, path, label }) => ({ id, path, label }));
}

/** May this person open this section at all? Routes check this before rendering. */
export function canSeeSection(v: PortalViewer, id: SectionId): boolean {
  const def = SECTIONS.find((s) => s.id === id);
  return !!def && def.visible(v);
}

/** The word for a PLATFORM role, as the product says it. */
export function roleLabel(role: UserRole): string {
  return role === "super_admin" ? "Owner" : role === "admin" ? "Admin" : "Member";
}

/**
 * The name a workspace goes by in the UI.
 *
 * A personal workspace is named after its owner's email, which the identity
 * beside it already shows. Repeating it put the same address on screen twice, so
 * that case is labelled by what it IS rather than by its name.
 */
export function workspaceLabel(
  ws: { name: string; kind: "personal" | "team" },
  viewerEmail: string | null | undefined
): string {
  const sameAsEmail =
    ws.kind === "personal" && ws.name.trim().toLowerCase() === (viewerEmail ?? "").trim().toLowerCase();
  return sameAsEmail ? "Personal" : ws.name;
}

/**
 * The workspace control in the header: which account this page is about, the
 * viewer's role in it, and — once they belong to more than one — a way to move.
 *
 * A plain `<form method="post">` with a real `<select>`: no client router, no
 * fetch, no JavaScript at all, which is the same bargain every other navigation
 * in the portal makes. `next` carries the section back so switching leaves you
 * where you were rather than dumping you on the overview. It is re-validated
 * server-side (`safeNext`, src/workspace-routes.ts) — a hidden field is a
 * request, not a fact.
 *
 * A token caller never gets the switcher: it is pinned to the workspace its
 * credential names, and offering a control that cannot work would be a lie.
 */
function workspaceControl(v: PortalViewer, section: SectionId): string {
  const ws = v.workspace;
  if (!ws) return "";
  const label = workspaceLabel(ws, v.email);
  const kindWord = ws.kind === "personal" ? "Personal workspace" : "Team workspace";
  const roleWord = accountRoleLabel(ws.role).toLowerCase();

  const others = v.workspaces ?? [];
  if (v.isTokenCaller || others.length < 2) {
    const extra = ws.count > 1 ? ` +${ws.count - 1}` : "";
    const title = `${kindWord} · you are ${roleWord} here${
      ws.count > 1 ? ` · ${ws.count} workspaces in total` : ""
    }`;
    return `<span class="badge is-workspace" data-viewer-workspace data-workspace-id="${esc(ws.id)}"
    data-workspace-kind="${esc(ws.kind)}" data-workspace-role="${esc(ws.role)}"
    title="${esc(title)}">${esc(label)}${esc(extra)}</span>`;
  }

  const back = SECTIONS.find((s) => s.id === section)?.path ?? "/admin";
  const options = others
    .map((w) => {
      const name = workspaceLabel(w, v.email);
      const suffix = w.kind === "personal" ? "Personal" : "Team";
      return `<option value="${esc(w.id)}"${w.id === ws.id ? " selected" : ""}
        data-workspace-kind="${esc(w.kind)}" data-workspace-role="${esc(w.role)}"
      >${esc(name)} · ${esc(suffix)} · ${esc(accountRoleLabel(w.role))}</option>`;
    })
    .join("");

  return `<form class="wsswitch" method="post" action="/admin/workspace"
    data-viewer-workspace data-workspace-switcher data-workspace-id="${esc(ws.id)}"
    data-workspace-kind="${esc(ws.kind)}" data-workspace-role="${esc(ws.role)}">
    <input type="hidden" name="next" value="${esc(back)}">
    <select name="account_id" class="small" data-workspace-select
      aria-label="Active workspace — everything you publish and manage belongs to it">${options}</select>
    <button type="submit" class="small ghost" data-workspace-switch>Switch</button>
  </form>`;
}

// --- formatting, shared by every section ------------------------------------

export function num(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function plural(n: number, word: string): string {
  return `${num(n)} ${word}${n === 1 ? "" : "s"}`;
}

export function people(n: number): string {
  return n === 1 ? "1 person" : `${num(n)} people`;
}

export function stamp(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

/** A number-first tile. One figure, one label, one hint — never a sparkline. */
export function statTile(key: string, label: string, value: string, hint: string): string {
  return `<div class="stat" data-stat="${esc(key)}">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value" data-stat-value>${esc(value)}</div>
    <div class="stat-hint">${esc(hint)}</div>
  </div>`;
}

/**
 * Destructive actions, kept away from everything reversible. A danger zone is
 * not an error state, so it is a quiet card with a red heading — never a red
 * box, and never a filled red button (docs/DESIGN.md §4).
 */
export function dangerZone(title: string, explain: string, actions: string): string {
  return `<section class="danger-zone" data-danger-zone aria-labelledby="danger-h">
    <h3 id="danger-h">${esc(title)}</h3>
    <p class="hint">${explain}</p>
    <div class="row-actions">${actions}</div>
  </section>`;
}

// --- shell ------------------------------------------------------------------

export interface Crumb {
  label: string;
  href?: string;
}

export interface ShellOptions {
  viewer: PortalViewer;
  /** Which nav item is current. */
  section: SectionId;
  /** Browser tab title, without the product suffix. */
  title: string;
  /** The page's single `h1`. */
  heading: string;
  /** One sentence saying what this page is for. */
  lede: string;
  /** Trail above the heading, for detail pages. The last crumb is the page. */
  crumbs?: Crumb[];
  /** Buttons/links rendered opposite the heading. */
  actions?: string;
  body: string;
  /** Section-specific CSS, appended after the portal's own. */
  style?: string;
  /** Section-specific JS. `CORE_SCRIPT` is always included before it. */
  script?: string;
}

function nav(viewer: PortalViewer, current: SectionId): string {
  const items = sectionsFor(viewer)
    .map((s) => {
      const def = SECTIONS.find((d) => d.id === s.id)!;
      const isCurrent = s.id === current;
      return `<a class="pnav-item${isCurrent ? " is-current" : ""}" data-nav="${esc(s.id)}"
        href="${esc(s.path)}"${isCurrent ? ' aria-current="page"' : ""}>
        <span class="pnav-label">${esc(s.label)}</span>
        <span class="pnav-blurb">${esc(def.blurb)}</span>
      </a>`;
    })
    .join("");
  return `<nav class="pnav" id="portal-nav" data-portal-nav aria-label="Portal sections">${items}</nav>`;
}

function crumbTrail(crumbs: Crumb[]): string {
  const parts = crumbs.map((c, i) => {
    const last = i === crumbs.length - 1;
    const label = esc(c.label);
    const node =
      c.href && !last ? `<a href="${esc(c.href)}">${label}</a>` : `<span aria-current="page">${label}</span>`;
    return `<li>${node}</li>`;
  });
  return `<nav class="crumbs" data-crumbs aria-label="Breadcrumb"><ol>${parts.join(
    `<li aria-hidden="true" class="crumb-sep">/</li>`
  )}</ol></nav>`;
}

export function portalShell(o: ShellOptions): string {
  const { viewer } = o;
  // `null`/absent means POSTHOG_KEY is unset for this deployment: no banner,
  // no script, no CSP change, no mention anywhere in the response — see the
  // `posthog` field's doc comment above and src/posthog.ts.
  const ph = viewer.posthog ?? null;
  const body = `<a class="skip" href="#main">Skip to content</a>
    <header class="ptop" data-portal-top>
      ${brandLockup("/admin")}
      <div class="who" data-portal-identity>
        ${workspaceControl(viewer, o.section)}
        <span class="badge is-role" data-viewer-role>${esc(roleLabel(viewer.role))}</span>
        <span class="mono" data-viewer-email>${esc(viewer.email)}</span>
        <a href="/docs">Docs</a>
        <a href="/logout" data-cta="logout">Sign out</a>
      </div>
    </header>
    <div class="pgrid" data-portal data-section="${esc(o.section)}">
      ${nav(viewer, o.section)}
      <main class="pmain" id="main" data-portal-main>
        <div class="phero">
          ${o.crumbs?.length ? crumbTrail(o.crumbs) : ""}
          <div class="phero-row">
            <div>
              <h1>${esc(o.heading)}</h1>
              <p class="lede">${o.lede}</p>
            </div>
            ${o.actions ? `<div class="phero-actions">${o.actions}</div>` : ""}
          </div>
        </div>
        ${o.body}
      </main>
    </div>
    <footer class="pfoot" data-portal-footer>
      <nav aria-label="Legal">
        <a href="/privacy" data-legal="privacy">Privacy</a>
        <a href="/terms" data-legal="terms">Terms</a>
        <a href="/docs">Docs</a>
      </nav>
    </footer>
    ${ph ? analyticsConsentNotice() : ""}
    <script>${CORE_SCRIPT}${o.script ?? ""}${ph ? analyticsConsentScript(ph) : ""}</script>`;
  return layout(
    `${o.title} · rtfx.pro`,
    body,
    BRAND_STYLE + PORTAL_STYLE + CONSENT_STYLE + ANALYTICS_CONSENT_STYLE + (o.style ?? ""),
    undefined,
    ph ? posthogCsp(ph) : undefined
  );
}

/**
 * The page a member gets for a section that isn't theirs (People, Platform) or
 * an artifact they don't manage. Served with a 404 so the portal never confirms
 * that something exists just because it refused it — but rendered inside the
 * shell, so they still have somewhere to go.
 */
export function portalNotFound(viewer: PortalViewer, what: string): string {
  return portalShell({
    viewer,
    section: "overview",
    title: "Not found",
    heading: "Not found",
    lede: `${esc(what)} isn't here — it may have been removed, or it may not be yours to open.`,
    body: `<div class="empty" data-empty="section">
      <h3>Nothing to show</h3>
      <p>Pick a section from the navigation, or head back to the
        <a href="/admin">overview</a>.</p>
    </div>`,
  });
}

// --- shared client script ---------------------------------------------------

/**
 * The helpers every section uses. Sections append their own script after this
 * one; nothing here touches navigation, which is plain links by design.
 */
export const CORE_SCRIPT = `
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
  if(!btn) return;
  btn.addEventListener('click', async function(){
    var idle = btn.getAttribute('data-idle') || btn.textContent;
    btn.setAttribute('data-idle', idle);
    var ok = await copyText(getText());
    btn.textContent = ok ? 'Copied!' : 'Copy failed — select and press ⌘C';
    btn.classList.toggle('is-copied', ok);
    setTimeout(function(){ btn.textContent = idle; btn.classList.remove('is-copied'); }, 2000);
  });
}
/* [data-copy] holds a URL (resolved against this page); [data-copy-text] holds
   literal text, for the setup snippets in Integrations. */
$$('[data-copy]').forEach(function(b){
  wireCopy(b, function(){ return new URL(b.getAttribute('data-copy'), location.href).href; });
});
$$('[data-copy-text]').forEach(function(b){
  wireCopy(b, function(){
    var target = document.getElementById(b.getAttribute('data-copy-text'));
    return target ? target.textContent : '';
  });
});

/* Keep the current nav item in view on a narrow screen, where the nav is a
   horizontally scrolling strip rather than a sidebar. */
(function(){
  var current = $('.pnav-item.is-current');
  if(current && current.scrollIntoView) {
    try { current.scrollIntoView({ block:'nearest', inline:'center' }); } catch(e){}
  }
})();
`;

// --- portal styles ----------------------------------------------------------

export const PORTAL_STYLE = `
.wrap{max-width:1240px}
.faint{color:var(--faint);font-weight:400}
/* The .skip rules live in the base stylesheet now — every surface has one. */

/* The one place inside the app that points at the legal pages. Quiet, at the
   bottom, where somebody goes looking for it (issue #36). */
.pfoot{margin-top:2.6rem;padding-top:1.2rem;border-top:1px solid var(--border);
  display:flex;justify-content:center}
.pfoot nav{display:flex;gap:1.1rem;flex-wrap:wrap;font-size:.83rem}
.pfoot a{color:var(--muted)}
.pfoot a:hover{color:var(--fg)}
@media(pointer:coarse){.pfoot a{min-height:44px;display:inline-flex;align-items:center}}

.ptop{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;
  padding:.75rem 1.15rem;border:1px solid var(--border);border-radius:999px;background:var(--elev);
  backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);box-shadow:var(--shadow);margin-bottom:1.25rem}
.ptop .who{display:flex;align-items:center;gap:.85rem;font-size:.85rem;color:var(--muted);flex-wrap:wrap}
.ptop .who .mono{color:var(--fg);font-size:.8rem}
/* The workspace control sits left of the role badge: whose stuff, then who you
   are. Quieter than the role badge — it is context, not status. */
.badge.is-workspace{max-width:14rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The switcher replaces the chip for somebody in more than one workspace. Sized
   to read as chrome rather than as a form: it is a place-marker you can move,
   not a setting you fill in. */
.wsswitch{display:flex;align-items:center;gap:.35rem;margin:0}
.wsswitch select{max-width:15rem;min-height:2.1rem;font-size:.8rem;padding:.25rem .5rem;
  border-radius:999px}
.wsswitch button{min-height:2.1rem;font-size:.78rem;padding:.25rem .7rem;border-radius:999px}
@media(pointer:coarse){.wsswitch select,.wsswitch button{min-height:44px}}

.pgrid{display:grid;grid-template-columns:14.5rem 1fr;gap:1.4rem;align-items:start}
/* Grid items default to min-width:auto, which lets a wide child (a long slug, a
   code block, the scrolling nav strip) push the whole page sideways. */
.pnav,.pmain{min-width:0}
.pnav{display:grid;gap:.2rem;position:sticky;top:1.1rem}
.pnav-item{display:block;padding:.55rem .8rem;border-radius:16px;border:1px solid transparent;
  color:var(--fg);transition:background .15s,border-color .15s,color .15s}
.pnav-item:hover{background:rgba(255,255,255,.055);border-color:var(--border);color:var(--fg)}
.pnav-item.is-current{background:var(--accent-weak);border-color:rgba(10,132,255,.42);color:var(--accent)}
.pnav-label{display:block;font-weight:620;font-size:.94rem;letter-spacing:-.015em}
.pnav-blurb{display:block;font-size:.75rem;color:var(--faint);margin-top:.05rem}
.pnav-item.is-current .pnav-blurb{color:var(--muted)}

.phero{margin:0 0 1.3rem}
.phero-row{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.phero h1{font-size:clamp(1.5rem,2.6vw,2.1rem);letter-spacing:-.04em}
.phero .lede{color:var(--muted);margin:.42rem 0 0;max-width:46rem;font-size:.95rem;line-height:1.5}
.phero-actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.crumbs{margin:0 0 .55rem}
.crumbs ol{list-style:none;display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin:0;padding:0;
  font-size:.8rem;color:var(--muted)}
.crumbs a{color:var(--muted)}.crumbs a:hover{color:var(--accent)}
.crumb-sep{color:var(--faint)}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:.8rem;margin-bottom:1.35rem}
.stat{position:relative;overflow:hidden;background:var(--card);border:1px solid var(--border);
  border-radius:var(--radius);padding:1.05rem 1.1rem;box-shadow:var(--shadow);
  backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.stat:after{content:"";position:absolute;inset:auto -20% -55% 38%;height:5rem;
  background:radial-gradient(circle,rgba(10,132,255,.18),transparent 65%)}
.stat-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:var(--faint)}
.stat-value{font-size:1.85rem;font-weight:780;line-height:1.1;letter-spacing:-.045em;margin:.2rem 0}
.stat-hint{font-size:.8rem;color:var(--muted)}

.panel{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.35rem;
  margin-bottom:1.35rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1.05rem}
.panel h2{font-size:1.15rem;margin:0 0 .22rem;letter-spacing:-.035em}
.panel-head p{margin:0}
.panel > .row:last-child{border-bottom:0}
.row-actions{display:flex;gap:.5rem;align-items:center;flex:none;flex-wrap:wrap}
.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:.95rem}

.danger-zone{border:1px solid var(--border-strong);border-radius:var(--radius);padding:1.15rem 1.25rem;
  margin-top:1.6rem;background:var(--card);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.danger-zone h3{margin:0 0 .3rem;font-size:.95rem;letter-spacing:-.02em;color:var(--danger)}
.danger-zone p{margin:0 0 .85rem;max-width:46rem}

.pcols{display:grid;grid-template-columns:1fr 1fr;gap:1.35rem;align-items:start}
.pcols > *{margin-bottom:0;
  /* Grid items default to min-width:auto, so one long unbreakable string — a
     referrer URL, a slug — refuses to shrink and shoves its column wider than
     its 1fr share. That is what made two side-by-side panels different widths
     while a pair with no long content lined up perfectly. */
  min-width:0}

@media(max-width:900px){
  .pgrid{grid-template-columns:1fr;gap:1.1rem}
  .pnav{position:static;grid-auto-flow:column;grid-auto-columns:max-content;gap:.4rem;
    justify-content:start;max-width:100%;
    overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x proximity;padding-bottom:.3rem;
    -webkit-overflow-scrolling:touch;scrollbar-width:none}
  .pnav::-webkit-scrollbar{display:none}
  .pnav-item{scroll-snap-align:center;border-color:var(--border);white-space:nowrap;
    padding:.55rem .95rem;border-radius:999px;min-height:44px;display:flex;align-items:center}
  .pnav-blurb{display:none}
  .pcols{grid-template-columns:1fr}
}
@media(max-width:720px){
  .ptop{border-radius:24px;align-items:flex-start;flex-direction:column;gap:.6rem}
  .field-grid{grid-template-columns:1fr}
}
/* Touch needs 44px, which a text link in a row of buttons does not have on its
   own. Only on coarse pointers — a mouse is fine with the tighter rhythm. */
@media(pointer:coarse){
  .row-actions a,.row-actions button,.art-actions a,.art-actions button,
  .published-actions a,.published-actions button{min-height:44px;display:inline-flex;align-items:center}
}
`;
