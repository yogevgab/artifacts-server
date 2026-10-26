/**
 * The viewer shell.
 *
 * Product UI — the share banner, the chat, the version indicator — cannot live
 * inside the artifact. Artifact HTML runs arbitrary JavaScript by design (see
 * the CSP in `src/serve.ts`), so a share control in that document would be
 * privileged UI sitting same-origin with attacker-controlled code.
 *
 * So the chrome lives here, on OUR (app) origin at the artifact's canonical
 * address, and the artifact renders in a frame — served from the separate
 * content origin — with `sandbox` and deliberately WITHOUT `allow-same-origin`. That omission is
 * the entire security property: the browser hands the framed document an opaque
 * origin, so it cannot read cookies, cannot make credentialed same-origin
 * requests, and cannot reach `window.parent`.
 *
 * See docs/superpowers/specs/2026-08-14-viewer-shell-design.md.
 */

import { esc } from "./pages";
import { ARTIFACT_SANDBOX } from "./serve";

/** The path segment that introduces a frame token: `/<slug>/~t/<token>/<file>`. */
export const FRAME_TOKEN_SEGMENT = "~t";

export interface ShellInput {
  slug: string;
  title: string;
  version: number;
  /** Whether this caller may change access — decides if the banner exists at all. */
  canManage: boolean;
  /** Current visibility, for the banner's summary line. */
  visibility: "restricted" | "everyone";
  /** How many people are named on a restricted artifact. */
  grantCount: number;
  /** The path inside the artifact being viewed, "" for the root. */
  filePath: string;
  /**
   * The artifact's entry file. Usually index.html, but a PDF artifact's entry
   * is document.pdf — the frame must point at what actually exists, or the
   * shell renders around a 404.
   */
  entry?: string;
  /** True when this artifact is a single document rather than a site. */
  isDocument?: boolean;
  /**
   * Prefix for app-host links (home, Share). The shell now renders ON the app
   * host, so this is normally omitted and those links are origin-relative.
   */
  appBaseUrl?: string;
  /**
   * Origin of the content host that serves the framed bytes (`https://a.rtfx.pro`),
   * or omitted on a single-host deployment, where the frame is same-origin.
   * This is the only place the content host appears in the viewer: the address
   * bar and every link a person copies stay on the canonical app URL.
   */
  contentOrigin?: string;
  /**
   * Show the artifact alone — no rtfx bar, chat or controls. Used for somebody
   * who arrived through a share link: they are a reader of one artifact, and
   * the product chrome is noise to them (and the controls are not theirs).
   * The frame, its sandbox and the frame token are unchanged.
   */
  chromeless?: boolean;
  /**
   * The artifact's canonical URL (`rtfx.pro/<workspace>/<slug>`). When present the
   * toolbar's "Copy link" copies this instead of the address bar's URL.
   */
  brandedUrl?: string;
  /**
   * Path capability for the frame (see `mintFrameToken` in src/session.ts).
   * Without it the sandboxed frame's relative assets carry no credential.
   */
  frameToken?: string;
}

/**
 * Layering, once, so nothing has to guess:
 *
 *   frame 0 · scrim 35 · chat 40 · bar 45 (and the share popover inside it) · peek 50
 *
 * The bar outranks the chat deliberately. The share popover is a *child* of the
 * bar so it can be anchored to the Share button, which means the bar's z-index
 * is also the popover's — put the bar below the chat and the popover disappears
 * behind the drawer.
 */
const SHELL_STYLE = `
:root{color-scheme:light dark;
  --sh-bg:#F2F3F7;--sh-fg:#14182B;--sh-muted:#565D78;--sh-rule:#D7DAE6;
  --sh-accent:#2438C8;--sh-accent-fg:#FFFFFF;--sh-surface:#FFFFFF;--sh-danger:#B3261E;
  --sh-glass:rgba(255,255,255,.86);--sh-hover:rgba(20,24,43,.055);--sh-press:rgba(20,24,43,.1);
  --sh-scrim:rgba(14,17,32,.36);
  --sh-shadow:0 20px 48px rgba(16,20,40,.16),0 2px 6px rgba(16,20,40,.06);
  --sh-r:16px;--sh-r-sm:10px}
@media(prefers-color-scheme:dark){:root{
  --sh-bg:#0D1020;--sh-fg:#E7E9F3;--sh-muted:#9AA1BC;--sh-rule:#2E3556;
  --sh-accent:#8C9BFF;--sh-accent-fg:#101427;--sh-surface:#161A2E;--sh-danger:#FF6B6B;
  --sh-glass:rgba(22,26,46,.86);--sh-hover:rgba(255,255,255,.07);--sh-press:rgba(255,255,255,.13);
  --sh-scrim:rgba(4,6,14,.5);
  --sh-shadow:0 20px 52px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.35)}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--sh-bg);color:var(--sh-fg);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  display:flex;flex-direction:column;-webkit-font-smoothing:antialiased}

/* --- controls, shared by the bar and both panels ------------------------- */
.btn{font:inherit;font-size:13px;line-height:1.2;padding:7px 12px;border-radius:999px;
  border:1px solid var(--sh-rule);background:transparent;color:var(--sh-fg);cursor:pointer;
  white-space:nowrap;transition:background .15s ease,border-color .15s ease,opacity .15s ease}
.btn:hover{background:var(--sh-hover)}
.btn:active{background:var(--sh-press)}
.btn[disabled]{opacity:.55;cursor:default}
.btn.quiet{border-color:transparent}
.btn.quiet[aria-expanded=true]{background:var(--sh-press)}
.btn.sm{font-size:12px;padding:4px 10px}
.btn.primary{border-color:var(--sh-accent);background:var(--sh-accent);color:var(--sh-accent-fg);
  font-weight:590}
.btn.primary:hover{background:var(--sh-accent);filter:brightness(1.07)}
.btn.icon{width:28px;height:28px;padding:0;border-color:transparent;color:var(--sh-muted);
  display:inline-flex;align-items:center;justify-content:center;font-size:17px;line-height:1}
.btn.icon:hover{color:var(--sh-fg);background:var(--sh-hover)}
.field{font:inherit;font-size:13px;padding:7px 11px;min-width:0;color:var(--sh-fg);
  border:1px solid var(--sh-rule);border-radius:var(--sh-r-sm);background:var(--sh-surface)}
.field::placeholder{color:var(--sh-muted)}
.field:hover{border-color:var(--sh-muted)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,
[tabindex]:focus-visible{outline:2px solid var(--sh-accent);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.bar,.btn,.peek,.field{transition:none}}

/* --- the toolbar ---------------------------------------------------------
   One row, always. It shrinks the title rather than wrapping, because a bar
   that reflows to two rows changes --bar-h under the collapse animation. */
.bar{position:relative;z-index:45;flex:none;display:flex;align-items:center;gap:10px;
  flex-wrap:nowrap;min-height:48px;padding:0 10px 0 14px;
  background:var(--sh-surface);border-bottom:1px solid var(--sh-rule);
  box-shadow:0 1px 2px rgba(16,20,40,.04);transition:margin-top .18s ease}
.bar[data-collapsed]{margin-top:calc(-1 * var(--bar-h,48px))}
.bar .mark{flex:none;font-weight:600;letter-spacing:-.02em;font-size:14px;
  text-decoration:none;color:var(--sh-fg);opacity:.82;transition:opacity .15s ease}
.bar .mark:hover{opacity:1}
.bar .mark .dot{color:var(--sh-accent)}
.bar .rule{flex:none;width:1px;height:18px;background:var(--sh-rule)}
.bar .title{flex:0 1 auto;min-width:0;font-weight:590;letter-spacing:-.01em;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar .ver{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;
  color:var(--sh-muted);border:1px solid var(--sh-rule);border-radius:999px;padding:1px 7px}
.bar .spacer{flex:1 1 auto;min-width:8px}
.actions{flex:none;display:flex;align-items:center;gap:6px}
/* The peek tab is the only way back once the bar is hidden, so it is always
   reachable and never covers content it would obscure. */
.peek{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:50;
  display:inline-flex;align-items:center;gap:6px;
  border:1px solid var(--sh-rule);border-top:0;border-radius:0 0 12px 12px;
  background:var(--sh-glass);-webkit-backdrop-filter:saturate(180%) blur(20px);
  backdrop-filter:saturate(180%) blur(20px);color:var(--sh-muted);font:inherit;font-size:11px;
  letter-spacing:.06em;text-transform:uppercase;padding:4px 12px 5px;cursor:pointer;
  box-shadow:0 6px 18px rgba(16,20,40,.1);transition:color .15s ease}
.peek:hover{color:var(--sh-fg)}
.peek[hidden]{display:none}
.frame{flex:1 1 auto;width:100%;border:0;display:block;background:var(--sh-surface)}
/* Shown when the frame never reported in — the browser refused it. Over the
   content, never replacing it: a page whose own CSP blocks our reporter still
   renders, and then this is a dismissible false alarm, not a blank screen. */
.stall{position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:40;
  width:min(560px,calc(100vw - 32px));box-sizing:border-box;
  display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;
  padding:12px 14px;border:1px solid var(--sh-rule);border-radius:12px;
  background:var(--sh-glass);-webkit-backdrop-filter:saturate(180%) blur(20px);
  backdrop-filter:saturate(180%) blur(20px);box-shadow:0 10px 30px rgba(16,20,40,.14);
  font-size:13px;line-height:1.45;color:var(--sh-fg)}
.stall b{flex:1 0 100%}
.stall span{flex:1 1 260px;color:var(--sh-muted)}
.stall code{font-size:12px}
.stall[hidden]{display:none}

/* --- the scrim, mobile only ----------------------------------------------
   On a wide screen the popover and the drawer sit in their own corners and
   dimming the artifact behind them would be theatre. On a phone they cover it,
   so the scrim is what makes "tap outside to dismiss" discoverable. */
.scrim{position:fixed;inset:0;z-index:35;display:none;background:var(--sh-scrim);
  -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}

/* --- the share popover ---------------------------------------------------
   Anchored under the Share button rather than pinned to a screen corner, so
   the panel reads as belonging to the control that opened it. */
.share{position:relative;align-self:stretch;display:flex;align-items:center}
.panel{position:absolute;top:calc(100% + 6px);right:0;
  width:min(384px,calc(100vw - 24px));max-height:min(70vh,560px);
  overflow:auto;overscroll-behavior:contain;
  background:var(--sh-glass);-webkit-backdrop-filter:saturate(180%) blur(24px);
  backdrop-filter:saturate(180%) blur(24px);
  border:1px solid var(--sh-rule);border-radius:var(--sh-r);box-shadow:var(--sh-shadow);
  padding:14px 16px 16px}
.panel[hidden]{display:none}
.panel-head{display:flex;align-items:center;gap:8px;margin:0 0 10px}
.panel-head h2{flex:1;margin:0;font-size:14px;font-weight:640;letter-spacing:-.01em}
.panel h3{margin:0 0 5px;font-size:11px;font-weight:640;letter-spacing:.05em;
  text-transform:uppercase;color:var(--sh-muted)}
.panel .hint{color:var(--sh-muted);font-size:12.5px;line-height:1.45;margin:0 0 10px}
.row{display:flex;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid var(--sh-rule)}
.row:last-child{border-bottom:0}
.row .who{flex:1;width:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.row .role{flex:none;font-size:12px;padding:4px 8px}
.row{flex-wrap:wrap}
.add{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.add .field{flex:1 1 150px}
.add input[type=number]{flex:0 0 82px}
.sep{border:0;border-top:1px solid var(--sh-rule);margin:16px 0 12px}
.link-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:7px 0;font-size:12px;
  border-bottom:1px solid var(--sh-rule)}
.link-row:last-child{border-bottom:0}
.link-row code{flex:1;width:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--sh-muted)}
.link-row .name{flex:1;width:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:13px;font-weight:600;color:var(--sh-fg)}
.link-row .name.unnamed{font-weight:400;color:var(--sh-muted)}
.link-row .acts{flex:1 0 100%;display:flex;flex-wrap:wrap;gap:6px}
.link-row .edit{flex:1 0 100%;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.link-row .edit .field{flex:1 1 120px}
.link-row .edit input[type=number]{flex:0 0 82px}
.link-row .exp{flex:none;color:var(--sh-muted);white-space:nowrap}
.link-row .exp.expired{color:var(--sh-danger);font-weight:600}
.link-row .meta{flex:1 0 100%;color:var(--sh-muted);font-size:11.5px}
.link-row .meta.warn{color:var(--sh-danger)}
.vrow{display:flex;flex-wrap:wrap;gap:2px 8px;padding:7px 0;font-size:12px;border-bottom:1px solid var(--sh-rule)}
.vrow:last-child{border-bottom:0}
.vrow .when{color:var(--sh-fg);font-weight:600}
.vrow .sub{flex:1 0 100%;color:var(--sh-muted);font-size:11.5px;overflow-wrap:anywhere}
.vrow .tag{border:1px solid var(--sh-rule);border-radius:999px;padding:0 7px;font-size:11px;color:var(--sh-muted)}
.vrow .tag.warn{color:var(--sh-danger);border-color:var(--sh-danger)}

/* --- the chat drawer -----------------------------------------------------
   A floating card in the bottom-right corner, clear of the toolbar and clear
   of the share popover, with head / log / composer as three fixed bands. */
.chat{position:fixed;right:16px;bottom:16px;z-index:40;
  width:min(376px,calc(100vw - 32px));
  height:min(540px,calc(100vh - var(--bar-h,48px) - 44px));
  display:flex;flex-direction:column;overflow:hidden;
  background:var(--sh-glass);-webkit-backdrop-filter:saturate(180%) blur(24px);
  backdrop-filter:saturate(180%) blur(24px);
  border:1px solid var(--sh-rule);border-radius:var(--sh-r);box-shadow:var(--sh-shadow)}
.chat[hidden]{display:none}
.chat-head{flex:none;display:flex;align-items:flex-start;gap:8px;
  padding:10px 10px 10px 14px;border-bottom:1px solid var(--sh-rule)}
.chat-title{flex:1;min-width:0;display:flex;flex-direction:column}
.chat-title b{font-size:13px;font-weight:640;letter-spacing:-.01em}
.chat-title .sub{font-size:11.5px;line-height:1.35;color:var(--sh-muted)}
.chat-log{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;
  padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.msg{display:flex;flex-direction:column;gap:3px;align-items:flex-start}
.msg .who{font-size:11px;color:var(--sh-muted);padding:0 2px}
.msg .who b{color:var(--sh-fg);font-weight:600}
.msg .body{font-size:13.5px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;
  max-width:100%;background:var(--sh-hover);border-radius:12px;padding:7px 10px}
.chat-form{flex:none;display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--sh-rule)}
.chat-form .field{flex:1;border-radius:999px}
.chat-empty{color:var(--sh-muted);font-size:12.5px;margin:0;padding:2px}

/* --- phones: both panels become bottom sheets ---------------------------
   A 384px popover anchored to a button has nowhere to go at 360px wide, and
   two floating cards in the same corner would sit on top of each other. */
.grip{display:none}
@media(max-width:640px){
  .bar{gap:8px;padding:0 8px 0 12px}
  .bar .ver,.bar .rule,.wide{display:none}
  .scrim:not([hidden]){display:block}
  .grip{display:block;flex:none;width:36px;height:4px;border-radius:999px;
    background:var(--sh-rule);margin:0 auto 10px}
  .panel{position:fixed;top:auto;inset:auto 0 0 0;width:auto;
    max-height:min(78vh,calc(100vh - 56px));
    border-radius:20px 20px 0 0;border-bottom:0;
    padding:12px 16px calc(16px + env(safe-area-inset-bottom,0px))}
  .chat{inset:auto 0 0 0;width:auto;height:min(72vh,calc(100vh - 56px));
    border-radius:20px 20px 0 0;border-bottom:0}
  .chat .grip{margin:8px auto 0}
  .chat-form{padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))}
}
`;

/**
 * The two chevrons that pair the hide control with the peek tab: the bar folds
 * up and comes back down. Both are decorative — the accessible name is on the
 * button, so the glyph is `aria-hidden` and carries no text of its own.
 */
const chevron = (d: string) =>
  `<svg class="chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">` +
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" ` +
  `stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHEVRON_UP = chevron("M2.5 7.5 6 4l3.5 3.5");
const CHEVRON_DOWN = chevron("M2.5 4.5 6 8l3.5-3.5");

/**
 * The banner is rendered only for a caller who may manage the artifact. A
 * viewer gets no markup at all rather than a disabled control — advertising a
 * button somebody cannot press is worse than not having one.
 */
function banner(i: ShellInput): string {
  if (!i.canManage) return "";
  // Sharing is its own app-host page. The viewer used to run on the content
  // origin, which refuses every /api route, so the panel could not live here;
  // it is a separate page now and stays one (a popover would also have to sit
  // above a cross-origin frame).
  const appBase = (i.appBaseUrl ?? "").replace(/\/+$/, "");
  const href = `${appBase}/share/${encodeURIComponent(i.slug)}`;
  return `<a class="btn primary" data-share-banner href="${esc(href)}" target="_blank"
      rel="noopener">Share</a>`;
}

/** Who-can-open + share-link controls, shared by nothing else but the share page. */
function sharePanel(i: { visibility: "restricted" | "everyone"; grantCount: number }): string {
  const summary =
    i.visibility === "everyone"
      ? "Anyone signed in can open this"
      : i.grantCount === 1
        ? "1 person can open this"
        : `${i.grantCount} people can open this`;
  return `<section class="panel standalone" id="rtfx-share" data-share-panel aria-label="Sharing">
        <span class="grip" aria-hidden="true"></span>
        <div class="panel-head">
          <h2>Share</h2>
        </div>
        <h3>Who can open this</h3>
        <p class="hint" data-share-summary>${esc(summary)}</p>
        <p class="hint">Viewers can open it. Editors can also publish new versions and roll back; they need an rtfx account to publish.</p>
        <div class="list" data-share-list></div>
        <form class="add" data-share-add>
          <input class="field" type="email" name="email" placeholder="name@example.com" aria-label="Email address">
          <button type="submit" class="btn">Add</button>
        </form>
        <hr class="sep">
        <h3>Or share a link</h3>
        <p class="hint">Anyone with the link can open this — no sign-in. Make one per person and name it so you can tell them apart. Extend or revoke any of them any time.</p>
        <div class="add">
          <input class="field" type="text" maxlength="80" data-link-name placeholder="Name (e.g. who it's for)" aria-label="Link name (optional)" autocomplete="off">
          <select class="field" data-link-expiry aria-label="Link expiry">
            <option value="">Never expires</option>
            <option value="7">Expires in 7 days</option>
            <option value="30">Expires in 30 days</option>
            <option value="custom">Custom…</option>
          </select>
          <input class="field" type="number" min="1" max="365" data-link-days hidden aria-label="Days until the link expires" placeholder="Days">
          <button type="button" class="btn" data-make-link>Create share link</button>
        </div>
        <div class="list" data-link-list></div>
        <hr class="sep">
        <h3>Recent views</h3>
        <p class="hint">Who opened it lately, from where, on what. IP addresses are erased after 90 days.</p>
        <div class="list" data-view-list></div>
      </section>`;
}

/**
 * The frame's sandbox, or null to omit the attribute entirely.
 *
 * `allow-scripts` with `allow-same-origin` is the pair that defeats a sandbox —
 * framed content can reach its own frame element and strip the attribute. So
 * HTML artifacts, which are attacker-controlled and need scripts, never get
 * same-origin. That is what stops an artifact reading cookies or touching the
 * shell, and it must not be relaxed.
 *
 * PDFs get no sandbox at all, and this was established by experiment rather
 * than assumption: Chrome refuses to instantiate its PDF viewer inside a
 * sandboxed frame under ANY combination of flags, rendering a broken-document
 * icon with no console error and no failed request. Only removing the attribute
 * works.
 *
 * That is acceptable here for one reason: no attacker-controlled document can
 * occupy that URL. `singlePdf` verifies the leading %PDF bytes at publish, and
 * the response is served `application/pdf` with `nosniff`, so the browser
 * cannot be talked into treating it as HTML. Both layers must hold. If either
 * is ever removed, PDFs must stop being framed this way.
 */
function sandboxFor(i: ShellInput): string | null {
  return i.isDocument
    ? null
    : ARTIFACT_SANDBOX;
}

/**
 * Will the framed document say "I loaded"? Only HTML gets the reporter script
 * (src/serve.ts), so only an HTML target can be expected to — a PDF or an image
 * never would, and must not trip the "is this page blank?" banner.
 */
/** The content origin's host for the frame-stall banner, or "" when one origin serves everything. */
function contentHost(origin: string): string {
  try {
    return origin ? new URL(origin).host : "";
  } catch {
    return "";
  }
}

function expectsReady(i: ShellInput, target: string): boolean {
  if (sandboxFor(i) === null) return false;
  const file = target || i.entry || "index.html";
  return /\.html?$/i.test(file) || file.endsWith("/");
}

export function shellPage(i: ShellInput): string {
  // An empty filePath means "the artifact itself", which is its entry — not
  // necessarily index.html.
  const target = i.filePath || (i.entry && i.entry !== "index.html" ? i.entry : "");
  // Absolute on the content host (cross-origin frame); origin-relative when one
  // origin serves everything. Each path segment is encoded so a filePath taken
  // from the address bar can never add a query, a fragment or a `..`.
  const origin = (i.contentOrigin ?? "").replace(/\/+$/, "");
  const base = i.frameToken
    ? `${origin}/${encodeURIComponent(i.slug)}/${FRAME_TOKEN_SEGMENT}/${i.frameToken}/`
    : `${origin}/${encodeURIComponent(i.slug)}/`;
  const targetPath = target
    .split("/")
    .filter((seg) => seg !== "" && seg !== "." && seg !== "..")
    .map(encodeURIComponent)
    .join("/");
  const src = `${base}${targetPath}?raw=1`;
  const appHome = i.appBaseUrl ? `${i.appBaseUrl.replace(/\/+$/, "")}/` : "/";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(i.title)} · rtfx.pro</title>
<style>${SHELL_STYLE}</style>
</head><body>${
  i.chromeless
    ? `
<iframe class="frame" title="${esc(i.title)}"
  ${sandboxFor(i) === null ? "" : `sandbox="${sandboxFor(i)}"`}
  src="${esc(src)}"></iframe>
</body></html>`
    : `
<button class="peek" data-show-bar hidden aria-label="Show toolbar">${CHEVRON_DOWN}rtfx.pro</button>
<header class="bar" data-bar>
  <a class="mark" href="${esc(appHome)}" aria-label="rtfx.pro home">rtfx<span class="dot">.</span>pro</a>
  <span class="rule" aria-hidden="true"></span>
  <span class="title" title="${esc(i.title)}">${esc(i.title)}</span>
  <span class="ver">v${i.version}</span>
  <span class="spacer"></span>
  <div class="actions" data-actions>
    <button type="button" class="btn quiet" data-open-chat
      aria-expanded="false" aria-controls="rtfx-chat">Chat</button>
    <button type="button" class="btn quiet" data-copy-link${i.brandedUrl ? ` data-branded-url="${esc(i.brandedUrl)}"` : ""}>Copy<span class="wide"> link</span></button>
    ${banner(i)}
    <button type="button" class="btn icon" data-hide-bar
      aria-label="Hide toolbar" title="Hide toolbar">${CHEVRON_UP}</button>
  </div>
</header>
<div class="scrim" data-scrim hidden></div>
<section class="chat" id="rtfx-chat" data-chat data-slug="${esc(i.slug)}" hidden role="dialog" aria-label="Conversation">
  <span class="grip" aria-hidden="true"></span>
  <header class="chat-head">
    <span class="chat-title">
      <b>Conversation</b>
      <span class="sub">Everyone who can open this artifact</span>
    </span>
    <button type="button" class="btn icon" data-close-chat aria-label="Close conversation">&times;</button>
  </header>
  <div class="chat-log" data-chat-log role="log" aria-live="polite" tabindex="0"></div>
  <form class="chat-form" data-chat-form>
    <input class="field" name="body" placeholder="Say something…" autocomplete="off" aria-label="Message">
    <button type="submit" class="btn primary">Send</button>
  </form>
</section>
<iframe class="frame" title="${esc(i.title)}"
  ${sandboxFor(i) === null ? "" : `sandbox="${sandboxFor(i)}"`}
  ${expectsReady(i, target) ? "data-expect-ready" : ""}
  src="${esc(src)}"></iframe>
<div class="stall" data-stall role="status" hidden>
  <b>Is this page blank?</b>
  <span>Your browser may be blocking content from ${contentHost(origin) ? `<code>${esc(contentHost(origin))}</code>` : "this site"} — an ad or privacy
    extension, or old site data. Try a private window, or allow rtfx.pro in the extension.</span>
  <button type="button" class="btn" data-stall-reload>Reload</button>
  <button type="button" class="btn quiet" data-stall-close aria-label="Dismiss">✕</button>
</div>
<script>${SHELL_SCRIPT}</script>
</body></html>`
}`;
}

const SHELL_SCRIPT = `(function(){
  /* --- chrome: hide by hand, or get out of the way while reading ---------- */
  var bar=document.querySelector('[data-bar]');
  var peek=document.querySelector('[data-show-bar]');
  var hide=document.querySelector('[data-hide-bar]');
  var scrim=document.querySelector('[data-scrim]');
  var chat=document.querySelector('[data-chat]');
  var chatBtn=document.querySelector('[data-open-chat]');
  /* Sharing moved to the app-host share page; nothing here opens a panel. */
  var panel=null, shareBtn=null;
  var pinnedHidden=false;

  /* --- one panel at a time -------------------------------------------------
     On a wide screen the popover and the drawer have their own corners, but on
     a phone both are the same bottom sheet. Rather than have them fight, only
     one is ever open — which also keeps the scrim's meaning unambiguous. */
  function syncScrim(){
    if(scrim) scrim.hidden = !((chat&&!chat.hidden)||(panel&&!panel.hidden));
  }
  function closeShare(){
    if(!panel||panel.hidden) return;
    panel.hidden=true;
    if(shareBtn) shareBtn.setAttribute('aria-expanded','false');
    syncScrim();
  }
  function closeChat(){
    if(!chat||chat.hidden) return;
    chat.hidden=true;
    if(chatBtn) chatBtn.setAttribute('aria-expanded','false');
    syncScrim();
  }

  addEventListener('keydown',function(ev){
    if(ev.key!=='Escape') return;
    if(panel&&!panel.hidden){ closeShare(); if(shareBtn) shareBtn.focus(); return; }
    if(chat&&!chat.hidden){ closeChat(); if(chatBtn) chatBtn.focus(); }
  });
  if(scrim) scrim.addEventListener('click',function(){ closeShare(); closeChat(); });

  try{ pinnedHidden = localStorage.getItem('rtfx.bar')==='hidden'; }catch(e){}

  function measure(){
    if(!bar.hasAttribute('data-collapsed'))
      document.documentElement.style.setProperty('--bar-h', bar.offsetHeight+'px');
  }
  function collapse(on){
    /* The popover hangs off the bar, so it has to go when the bar does. The
       chat is anchored to the viewport and deliberately survives — reading is
       the reason the bar hides, and closing a conversation mid-scroll would
       throw away what somebody was typing. */
    if(on){ bar.setAttribute('data-collapsed',''); peek.hidden=false; closeShare(); }
    else { bar.removeAttribute('data-collapsed'); peek.hidden=true; }
  }
  measure(); addEventListener('resize',measure);
  if(pinnedHidden) collapse(true);

  if(hide) hide.addEventListener('click',function(){
    pinnedHidden=true; collapse(true);
    try{ localStorage.setItem('rtfx.bar','hidden'); }catch(e){}
  });
  if(peek) peek.addEventListener('click',function(){
    pinnedHidden=false; collapse(false);
    try{ localStorage.removeItem('rtfx.bar'); }catch(e){}
  });

  /* The frame is cross-origin, so it tells us where it is rather than us
     reading it. Down hides, up reveals — the message is cosmetic only. */
  var lastY=0;
  var frameEl=document.querySelector('iframe.frame');

  /* --- frame-stall --------------------------------------------------------
     An HTML artifact says 'rtfx:ready' before any of its own scripts run
     (src/serve.ts, READY_SIGNAL).
     If that never comes, the browser refused the frame before it reached us
     (an extension, stale site data) and the visitor sees a blank box or the
     browser's own error page. Say so, offer a reload, and leave one log line
     so we can see how often it happens. Advisory only: it never hides the
     frame, so a false alarm costs a dismissible banner. */
  var stall=document.querySelector('[data-stall]');
  var ready=false, stallTimer=null;
  function frameReady(){ ready=true; if(stallTimer) clearTimeout(stallTimer); if(stall) stall.hidden=true; }
  if(stall&&frameEl&&frameEl.hasAttribute('data-expect-ready')){
    stallTimer=setTimeout(function(){
      if(ready) return;
      stall.hidden=false;
      try{
        navigator.sendBeacon('/_frame-stall',JSON.stringify({
          slug:(chat&&chat.getAttribute('data-slug'))||'',
          ms:12000, online:navigator.onLine
        }));
      }catch(e){}
    },12000);
    var rl=stall.querySelector('[data-stall-reload]');
    var cl=stall.querySelector('[data-stall-close]');
    if(rl) rl.addEventListener('click',function(){ location.reload(); });
    if(cl) cl.addEventListener('click',function(){ stall.hidden=true; });
  }
  addEventListener('message',function(ev){
    /* Only the artifact frame may speak here. Its origin is opaque (sandbox
       without allow-same-origin), so the window identity is the check, not
       ev.origin; nothing else is trusted to move the toolbar. */
    if(!frameEl||ev.source!==frameEl.contentWindow) return;
    var d=ev.data;
    if(d&&d.type==='rtfx:ready'){ frameReady(); return; }
    if(!d||d.type!=='rtfx:scroll'||typeof d.y!=='number') return;
    if(pinnedHidden) return;
    var dy=d.y-lastY; lastY=d.y;
    if(d.y<40){ collapse(false); return; }
    if(dy>6) collapse(true);
    else if(dy<-6) collapse(false);
  });

  /* --- chat ---------------------------------------------------------------
     The socket lives on this (app) origin at /_chat/<slug>, where the session
     and share-link cookies are. Authorization happens in the Worker before the
     socket is handed to the room. */
  var log=document.querySelector('[data-chat-log]');
  var slugForChat=chat&&chat.getAttribute('data-slug');
  var sock=null;

  function stamp(m){
    var el=document.createElement('div'); el.className='msg';
    var who=document.createElement('span'); who.className='who';
    var name=document.createElement('b');
    name.textContent=m.author_email||(m.author_kind==='link'?'Someone with the link':'Signed out');
    who.appendChild(name);
    who.appendChild(document.createTextNode(' \u00b7 v'+m.version));
    var body=document.createElement('div'); body.className='body'; body.textContent=m.body;
    el.appendChild(who); el.appendChild(body); log.appendChild(el);
    log.scrollTop=log.scrollHeight;
  }
  function empty(text){
    log.innerHTML=''; var p=document.createElement('p');
    p.className='chat-empty'; p.textContent=text; log.appendChild(p);
  }

  function connect(){
    if(sock) return;
    var proto=location.protocol==='https:'?'wss://':'ws://';
    try{ sock=new WebSocket(proto+location.host+'/_chat/'+encodeURIComponent(slugForChat)); }
    catch(e){ empty('Chat is unavailable here.'); return; }
    sock.addEventListener('message',function(ev){
      var d; try{ d=JSON.parse(ev.data); }catch(e){ return; }
      if(d.type==='history'){
        if(!d.messages.length){ empty('No messages yet. Say the first thing.'); return; }
        log.innerHTML=''; d.messages.forEach(stamp);
      } else if(d.type==='message'){
        if(log.querySelector('.chat-empty')) log.innerHTML='';
        stamp(d.message);
      }
    });
    sock.addEventListener('close',function(){ sock=null; });
    sock.addEventListener('error',function(){ empty('Lost the connection. Reopen to retry.'); });
  }

  if(chatBtn) chatBtn.addEventListener('click',function(){
    if(!chat.hidden){ closeChat(); return; }
    closeShare();
    chat.hidden=false;
    chatBtn.setAttribute('aria-expanded','true');
    syncScrim();
    /* Reopening a drawer whose socket is still live must not wipe the log back
       to "Connecting\u2026" \u2014 the socket would never re-send its history. */
    if(!sock){ empty('Connecting\u2026'); connect(); }
    var field=chat.querySelector('[data-chat-form] input');
    if(field) field.focus();
  });
  var closeChatBtn=document.querySelector('[data-close-chat]');
  if(closeChatBtn) closeChatBtn.addEventListener('click',function(){
    closeChat(); if(chatBtn) chatBtn.focus();
  });

  var chatForm=document.querySelector('[data-chat-form]');
  if(chatForm) chatForm.addEventListener('submit',function(ev){
    ev.preventDefault();
    var input=chatForm.elements.body, text=input.value.trim();
    if(!text||!sock||sock.readyState!==1) return;
    sock.send(JSON.stringify({type:'post',body:text}));
    input.value='';
  });

  var copy=document.querySelector('[data-copy-link]');
  if(copy){
    /* The label carries a span the narrow layout hides, so it is restored as
       markup — writing textContent back would flatten it after one copy. */
    var copyLabel=copy.innerHTML;
    copy.addEventListener('click',function(){
      var url=copy.getAttribute('data-branded-url')||location.origin+location.pathname;
      navigator.clipboard.writeText(url).then(function(){
        copy.textContent='Copied';
        setTimeout(function(){copy.innerHTML=copyLabel;},1400);
      });
    });
  }

})();`;

const SHARE_SCRIPT = `(function(){
  var panel=document.querySelector('[data-share-panel]');
  if(!panel) return;
  var slug=panel.getAttribute('data-slug');

  var list=panel.querySelector('[data-share-list]');

  /* The server is the source of truth; grants is [{email,role}]. An older
     server only knows emails, and those people are all viewers. */
  var grants=[];
  function fromAccess(j){
    if(j.grants&&j.grants.length!==undefined) return j.grants.map(function(g){
      return {email:g.email,role:g.role==='editor'?'editor':'viewer'};
    });
    return (j.emails||[]).map(function(e){ return {email:e,role:'viewer'}; });
  }

  function render(){
    list.innerHTML='';
    if(!grants.length){
      var p=document.createElement('p');
      p.className='hint'; p.textContent='Nobody is named yet.';
      list.appendChild(p); return;
    }
    grants.forEach(function(g){
      var row=document.createElement('div'); row.className='row';
      var who=document.createElement('span'); who.className='who'; who.textContent=g.email;
      who.title=g.email;
      var sel=document.createElement('select'); sel.className='field role';
      sel.setAttribute('aria-label','Permission for '+g.email);
      [['viewer','Viewer'],['editor','Editor']].forEach(function(o){
        var op=document.createElement('option'); op.value=o[0]; op.textContent=o[1];
        if(o[0]===g.role) op.selected=true; sel.appendChild(op);
      });
      sel.addEventListener('change',function(){
        save(grants.map(function(x){
          return x.email===g.email?{email:x.email,role:sel.value}:x;
        }));
      });
      var rm=document.createElement('button');
      rm.type='button'; rm.className='btn sm'; rm.textContent='Remove';
      rm.setAttribute('aria-label','Remove '+g.email);
      rm.addEventListener('click',function(){ save(grants.filter(function(x){return x.email!==g.email;})); });
      row.appendChild(who); row.appendChild(sel); row.appendChild(rm); list.appendChild(row);
    });
  }

  function save(next){
    fetch('/api/artifacts/'+encodeURIComponent(slug)+'/access',{
      method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({visibility:'restricted',grants:next})
    }).then(function(r){return r.ok?r.json():null;}).then(function(j){
      if(j) grants=fromAccess(j);
      render(); /* on failure this snaps a changed select back to what is saved */
    },function(){ render(); });
  }

  var mk=panel.querySelector('[data-make-link]');
  var linkList=panel.querySelector('[data-link-list]');
  var expirySelect=panel.querySelector('[data-link-expiry]');
  var daysInput=panel.querySelector('[data-link-days]');
  var nameInput=panel.querySelector('[data-link-name]');

  if(expirySelect&&daysInput) expirySelect.addEventListener('change',function(){
    daysInput.hidden = expirySelect.value!=='custom';
    if(!daysInput.hidden) daysInput.focus();
  });

  function selectedExpiryDays(){
    if(!expirySelect) return null;
    var v=expirySelect.value;
    if(!v) return null;
    if(v==='custom'){
      var n=parseInt(daysInput.value,10);
      return (n>=1&&n<=365) ? n : NaN;
    }
    return parseInt(v,10);
  }

  function describeExpiry(expiresAt){
    if(!expiresAt) return {text:'Never expires',expired:false};
    var t=Date.parse(expiresAt);
    if(isNaN(t)) return {text:'Never expires',expired:false};
    var ds=new Date(t).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
    return t<=Date.now() ? {text:'Expired '+ds,expired:true} : {text:'Expires '+ds,expired:false};
  }

  function fmtDate(iso){
    var t=Date.parse(iso);
    return isNaN(t)?'':new Date(t).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
  }
  function plural(n,w){ return n+' '+w+(n===1?'':'s'); }

  /* l is a link as the API lists it ({id,name,expiresAt,revokedAt,views,...});
     url exists only for a link created in this page session - the key is
     hashed on the server and never comes back. */
  function linkRow(l,url){
    var row=document.createElement('div'); row.className='link-row';
    var nameEl=document.createElement('span');
    var expEl=document.createElement('span');
    var rev=document.createElement('button');
    rev.type='button'; rev.className='btn sm'; rev.textContent='Revoke';
    var ren=document.createElement('button');
    ren.type='button'; ren.className='btn sm'; ren.textContent='Rename';
    var ext=document.createElement('button');
    ext.type='button'; ext.className='btn sm'; ext.textContent='Extend';

    function paint(){
      var nm=l.name||'';
      nameEl.className='name'+(nm?'':' unnamed');
      nameEl.textContent=nm||'Unnamed link'; nameEl.title=nm;
      var label=nm||'unnamed link';
      ren.setAttribute('aria-label','Rename '+label);
      ext.setAttribute('aria-label','Extend '+label);
      rev.setAttribute('aria-label','Revoke '+label);
      if(l.revokedAt){ expEl.className='exp expired'; expEl.textContent='Revoked '+fmtDate(l.revokedAt); return; }
      var exp=describeExpiry(l.expiresAt);
      expEl.className='exp'+(exp.expired?' expired':''); expEl.textContent=exp.text;
    }
    paint();
    row.appendChild(nameEl); row.appendChild(expEl);

    var stats=l, views=stats.views||0, attempts=stats.expiredAttempts||0;
    var meta=document.createElement('span'); meta.className='meta';
    meta.textContent=plural(views,'view')+(stats.lastViewedAt?' \u00b7 last viewed '+fmtDate(stats.lastViewedAt):'');
    row.appendChild(meta);
    if(attempts>0){
      var warn=document.createElement('span'); warn.className='meta warn';
      warn.textContent=plural(attempts,'attempt')+(l.revokedAt?' after it was revoked':' after expiry');
      row.appendChild(warn);
    }
    if(url){
      var c=document.createElement('code'); c.textContent=url;
      var cp=document.createElement('button');
      cp.type='button'; cp.className='btn sm'; cp.textContent='Copy';
      cp.addEventListener('click',function(){
        navigator.clipboard.writeText(url).then(function(){ cp.textContent='Copied'; },
          function(){ var r=document.createRange(); r.selectNodeContents(c);
            var sel=getSelection(); sel.removeAllRanges(); sel.addRange(r); cp.textContent='Press \u2318C'; });
      });
      var once=document.createElement('span'); once.className='meta';
      once.textContent="Copy it now \u2014 it won't be shown again.";
      row.appendChild(c); row.appendChild(cp); row.appendChild(once);
    }
    if(l.revokedAt) return row;

    var status=document.createElement('span'); status.className='meta warn'; status.setAttribute('role','status');
    var editor=document.createElement('div'); editor.className='edit'; editor.hidden=true;
    function patch(body){
      status.textContent='';
      return fetch('/api/artifacts/'+encodeURIComponent(slug)+'/links/'+encodeURIComponent(l.id),{
        method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
      }).then(function(r){
        if(!r.ok) throw new Error(r.status===409?'This link was revoked.':'Could not save \u2014 try again.');
        return r.json();
      }).then(function(u){
        if(u.name!==undefined) l.name=u.name;
        if(u.expiresAt!==undefined) l.expiresAt=u.expiresAt;
        if(u.revokedAt!==undefined) l.revokedAt=u.revokedAt;
        paint(); closeEditor();
      },function(e){ status.textContent=e.message||'Could not save \u2014 try again.'; });
    }
    function closeEditor(back){ editor.hidden=true; editor.innerHTML=''; if(back) back.focus(); }
    function btn(text,cls,fn){
      var b=document.createElement('button'); b.type='button'; b.className='btn sm'+(cls?' '+cls:'');
      b.textContent=text; b.addEventListener('click',fn); return b;
    }
    ren.addEventListener('click',function(){
      editor.innerHTML=''; editor.hidden=false; status.textContent='';
      var inp=document.createElement('input'); inp.type='text'; inp.className='field'; inp.maxLength=80;
      inp.value=l.name||''; inp.setAttribute('aria-label','Link name'); inp.placeholder='Name (e.g. who it\u2019s for)';
      var go=function(){ patch({name:inp.value.trim()||null}); };
      inp.addEventListener('keydown',function(ev){
        if(ev.key==='Enter'){ ev.preventDefault(); go(); }
        else if(ev.key==='Escape') closeEditor(ren);
      });
      editor.appendChild(inp); editor.appendChild(btn('Save','primary',go));
      editor.appendChild(btn('Cancel','',function(){ closeEditor(ren); }));
      inp.focus(); inp.select();
    });
    ext.addEventListener('click',function(){
      editor.innerHTML=''; editor.hidden=false; status.textContent='';
      var sel=document.createElement('select'); sel.className='field'; sel.setAttribute('aria-label','Extend link by');
      [['7','7 days from now'],['30','30 days from now'],['never','Never expires'],['custom','Custom\u2026']].forEach(function(o){
        var op=document.createElement('option'); op.value=o[0]; op.textContent=o[1]; sel.appendChild(op);
      });
      var days=document.createElement('input'); days.type='number'; days.className='field'; days.min='1'; days.max='365';
      days.hidden=true; days.placeholder='Days'; days.setAttribute('aria-label','Days until the link expires');
      sel.addEventListener('change',function(){ days.hidden=sel.value!=='custom'; if(!days.hidden) days.focus(); });
      editor.onkeydown=function(ev){ if(ev.key==='Escape') closeEditor(ext); };
      editor.appendChild(sel); editor.appendChild(days);
      editor.appendChild(btn('Apply','primary',function(){
        var v=sel.value, n;
        if(v==='never') n=null;
        else if(v==='custom'){ n=parseInt(days.value,10); if(!(n>=1&&n<=365)){ status.textContent='Enter a number of days from 1 to 365.'; days.focus(); return; } }
        else n=parseInt(v,10);
        patch({expires_in_days:n});
      }));
      editor.appendChild(btn('Cancel','',function(){ closeEditor(ext); }));
      sel.focus();
    });
    rev.addEventListener('click',function(){
      fetch('/api/artifacts/'+encodeURIComponent(slug)+'/links/'+encodeURIComponent(l.id),
        {method:'DELETE'}).then(function(){ row.remove(); });
    });
    var acts=document.createElement('div'); acts.className='acts';
    acts.appendChild(ren); acts.appendChild(ext); acts.appendChild(rev);
    row.appendChild(acts); row.appendChild(editor); row.appendChild(status);
    return row;
  }

  var viewList=panel.querySelector('[data-view-list]');
  function cap(x){ return x ? x.charAt(0).toUpperCase()+x.slice(1) : ''; }
  function viewRow(v){
    var row=document.createElement('div'); row.className='vrow';
    var when=document.createElement('span'); when.className='when';
    var t=Date.parse(v.viewed_at);
    when.textContent=isNaN(t)?'':new Date(t).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    row.appendChild(when);
    var who=document.createElement('span');
    who.textContent=v.email||(v.link_id?'Someone with a link':'Anonymous');
    row.appendChild(who);
    var tagText=v.outcome==='preview'?'link preview':v.outcome==='link_expired'?'expired link':v.outcome==='link_revoked'?'revoked link':v.link_id?(v.link_name?'via link \u201c'+v.link_name+'\u201d':'via link'):'';
    if(tagText){
      var tag=document.createElement('span');
      tag.className='tag'+(v.outcome==='link_expired'||v.outcome==='link_revoked'?' warn':'');
      tag.textContent=tagText; row.appendChild(tag);
    }
    var place=[v.city,v.region,v.country].filter(Boolean);
    var loc=v.city&&v.country?v.city+', '+v.country:place.join(', ');
    var dev=[v.device==='bot'?'Bot':cap(v.device),v.os,v.browser].filter(Boolean).join(' \u00b7 ');
    var sub=[loc,dev,v.ip].filter(Boolean).join(' \u00b7 ');
    if(sub){ var s=document.createElement('span'); s.className='sub'; s.textContent=sub; row.appendChild(s); }
    return row;
  }
  function loadViews(){
    if(!viewList) return;
    fetch('/api/artifacts/'+encodeURIComponent(slug)+'/views?limit=20')
      .then(function(r){return r.ok?r.json():null;})
      .then(function(j){
        viewList.innerHTML='';
        var vs=(j&&j.views)||[];
        if(!vs.length){
          var p=document.createElement('p'); p.className='hint'; p.textContent='No views yet.';
          viewList.appendChild(p); return;
        }
        vs.forEach(function(v){ viewList.appendChild(viewRow(v)); });
      });
  }
  loadViews();

  fetch('/api/artifacts/'+encodeURIComponent(slug)+'/access')
    .then(function(r){return r.ok?r.json():null;})
    .then(function(j){ if(j){ grants=fromAccess(j); render(); } });
  fetch('/api/artifacts/'+encodeURIComponent(slug)+'/links')
    .then(function(r){return r.ok?r.json():null;})
    .then(function(j){
      linkList.innerHTML='';
      if(!j||!j.links) return;
      j.links.filter(function(l){return !l.revokedAt||l.expiredAttempts>0;}).forEach(function(l){
        linkList.appendChild(linkRow(l,null));
      });
    });

  /* The key comes back exactly once — it is hashed on the server and cannot be
     shown again — so it goes straight to the clipboard and is never re-fetched. */
  if(mk) mk.addEventListener('click',function(){
    var days=selectedExpiryDays();
    if(days!==null&&isNaN(days)){ daysInput.focus(); return; }
    var body={}; if(days) body.expires_in_days=days;
    var nm=nameInput?nameInput.value.trim():''; if(nm) body.name=nm;
    mk.disabled=true; mk.textContent='Creating\u2026';
    var made=fetch('/api/artifacts/'+encodeURIComponent(slug)+'/links',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)
    }).then(function(r){ if(!r.ok) throw new Error('create failed'); return r.json(); });
    /* Safari only allows a clipboard write that starts inside the click, so the
       write is started now with the URL still pending. writeText after the
       fetch was silently refused there — and the button said "Copied!". */
    var copied;
    try{
      if(window.ClipboardItem&&navigator.clipboard&&navigator.clipboard.write){
        copied=navigator.clipboard.write([new ClipboardItem({'text/plain':
          made.then(function(j){return new Blob([j.url],{type:'text/plain'});})})]);
      }
    }catch(e){ copied=null; }
    if(!copied) copied=made.then(function(j){return navigator.clipboard.writeText(j.url);});
    made.then(function(j){
      linkList.appendChild(linkRow({id:j.id,name:j.name||null,expiresAt:j.expires_at||null},j.url));
      if(nameInput) nameInput.value='';
      return copied.then(function(){ return true; },function(){ return false; });
    }).then(function(ok){
      mk.disabled=false;
      mk.textContent= ok ? 'Link copied' : 'Link created \u2014 copy it below';
      setTimeout(function(){ mk.textContent='Create share link'; },2400);
    },function(){
      mk.disabled=false; mk.textContent='Could not create a link \u2014 try again';
      setTimeout(function(){ mk.textContent='Create share link'; },2400);
    });
  });

  panel.querySelector('[data-share-add]').addEventListener('submit',function(e){
    e.preventDefault();
    var input=e.target.elements.email, v=input.value.trim().toLowerCase();
    if(!v||v.indexOf('@')===-1) return;
    var current=grants.slice();
    if(!current.some(function(g){return g.email===v;})) current.push({email:v,role:'viewer'});
    input.value=''; save(current);
  });
})();`;

/**
 * The share page, on the APP host (`/share/<slug>`).
 *
 * The viewer runs on the content origin, which refuses every /api route, so its
 * old in-page panel could never create a link or change access. This page is
 * the same panel where the session and the API actually are.
 */
export function sharePage(i: {
  slug: string;
  title: string;
  visibility: "restricted" | "everyone";
  grantCount: number;
  viewUrl: string;
}): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Share ${esc(i.title)} · rtfx.pro</title>
<style>${SHELL_STYLE}
body{overflow:auto}
.share-page{max-width:520px;margin:40px auto;padding:0 16px}
.share-page .back{display:inline-block;margin:0 0 14px;font-size:13px;color:var(--sh-muted)}
.panel.standalone{position:static;display:block;width:auto;max-width:none;inset:auto;
  max-height:none;overflow:visible;
  transform:none;box-shadow:none}
</style>
</head><body>
<main class="share-page">
  <a class="back" href="${esc(i.viewUrl)}">&larr; ${esc(i.title)}</a>
  ${sharePanel(i).replace('data-share-panel', `data-share-panel data-slug="${esc(i.slug)}"`)}
</main>
<script>${SHARE_SCRIPT}</script>
</body></html>`;
}
