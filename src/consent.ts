/**
 * The cookie notice (issue #36).
 *
 * The honest version of this component, for the product we actually have.
 *
 * rtfx.pro sets no analytics, advertising or profiling cookies. The browser
 * storage involved in using it is strictly necessary: Cloudflare Access' session
 * cookie when somebody signs in, Cloudflare security cookies at the edge, and
 * this notice's first-party localStorage dismissal. None of those are optional
 * marketing storage that a consent regime asks you to opt into before running.
 * Two things follow, and they are the whole design:
 *
 *  1. **There is nothing to consent to, so this asks for nothing.** A banner
 *     with an "Accept analytics" toggle would be a lie about what runs on this
 *     page. It is a notice: it says what is stored and why, links to the detail,
 *     and lets you dismiss it.
 *  2. **It must never block the page.** No overlay, no focus trap, no modal, no
 *     scroll lock. It is a labelled region at the bottom of the page, last in
 *     the tab order after the content, and everything behind it stays usable —
 *     including for somebody who ignores it forever.
 *
 * The dismissal is remembered in `localStorage`, not in a cookie: a notice that
 * set a cookie to tell you it doesn't set cookies would be its own punchline.
 * `localStorage` is first-party, never sent to the server, and disclosed on
 * /privacy like everything else.
 *
 * If a non-essential script is ever introduced, `window.rtfxConsent.analytics`
 * is the gate it must pass, and this notice grows the choice that sets it. Until
 * then it is `false` and nothing reads it — see docs/PUBLIC_SITE.md.
 */

/** Bumping this re-shows the notice to everyone, for when the copy changes materially. */
export const CONSENT_VERSION = "2026-08-13";

/** Where the dismissal is remembered. First-party, local, never transmitted. */
export const CONSENT_KEY = "rtfx.cookie-notice";

/**
 * The notice markup. Rendered `hidden`, and unhidden by `CONSENT_SCRIPT` only
 * when it hasn't been dismissed — so a returning visitor never sees it flash,
 * and a visitor with JavaScript off never sees a banner whose dismiss button
 * could not possibly work.
 */
export function cookieNotice(): string {
  return `<aside class="cnotice" id="cookie-notice" data-cookie-notice hidden
      role="region" aria-labelledby="cookie-notice-title">
      <div class="cnotice-body">
        <h2 class="cnotice-title" id="cookie-notice-title">Cookies on rtfx.pro</h2>
        <p>We use only necessary storage: Cloudflare Access sign-in cookies, Cloudflare
          security cookies, and this notice's first-party localStorage dismissal. There is no
          analytics, no advertising and no third-party tracking on this site — so there is
          nothing here to opt out of.
          <a href="/privacy#cookies" data-legal="cookies">What we store and why</a>.</p>
      </div>
      <button type="button" class="ghost small" data-cookie-dismiss>Got it</button>
    </aside>`;
}

/**
 * Presentation. Fixed to the bottom on a wide screen, in the normal flow on a
 * narrow one — a fixed bar on a phone eats the part of the viewport a person is
 * reading, and this notice is never important enough to do that.
 */
export const CONSENT_STYLE = `
.cnotice{position:fixed;left:50%;transform:translateX(-50%);bottom:1rem;z-index:20;
  width:min(56rem,calc(100vw - 2rem));display:flex;align-items:center;gap:1.1rem;flex-wrap:wrap;
  padding:1rem 1.15rem;border:1px solid var(--border-strong);border-radius:var(--radius);
  background:var(--elev);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);
  box-shadow:0 26px 80px -40px rgba(0,0,0,.8)}
.cnotice-body{flex:1;min-width:15rem}
.cnotice .cnotice-title{margin:0 0 .2rem;font-size:.92rem;font-weight:650;letter-spacing:-.015em;
  color:var(--fg);line-height:1.3}
.cnotice p{margin:0;font-size:.86rem;line-height:1.5;color:var(--muted)}
.cnotice button{flex:none}
/* While the notice floats, the page reserves room for it, so the last paragraph
   of a short page is never parked underneath something you cannot scroll past. */
.has-cnotice .wrap{padding-bottom:11rem}
@media(max-width:720px){
  .cnotice{position:static;transform:none;width:auto;margin:2rem 0 0}
  .has-cnotice .wrap{padding-bottom:3rem}
}
/* A dismiss control is a 44px target on touch like everything else. */
@media(pointer:coarse){.cnotice button{min-height:44px}}
`;

/**
 * The behaviour, in the same plain style as the portal's core script: no build
 * step, no framework, and it degrades to "no banner" rather than to a broken one.
 *
 * Focus is deliberately never *taken* — the notice does not interrupt anyone —
 * but it is handed somewhere sensible when the notice is dismissed by keyboard,
 * because the element that had focus is about to stop existing.
 */
export const CONSENT_SCRIPT = `
(function(){
  var KEY = ${JSON.stringify(CONSENT_KEY)};
  var VERSION = ${JSON.stringify(CONSENT_VERSION)};
  var box = document.querySelector('[data-cookie-notice]');
  /* Private mode and blocked storage both throw on access, not on write. */
  function read(){ try { return localStorage.getItem(KEY); } catch(e){ return null; } }
  function write(v){ try { localStorage.setItem(KEY, v); } catch(e){} }

  /* The gate for any future non-essential script. Nothing reads it today, and
     nothing may run without it later. */
  window.rtfxConsent = { acknowledged: read() === VERSION, analytics: false };

  if(!box) return;
  if(window.rtfxConsent.acknowledged) return;
  box.hidden = false;
  document.documentElement.classList.add('has-cnotice');

  var btn = box.querySelector('[data-cookie-dismiss]');
  if(!btn) return;
  btn.addEventListener('click', function(){
    write(VERSION);
    window.rtfxConsent.acknowledged = true;
    var hadFocus = box.contains(document.activeElement);
    box.hidden = true;
    document.documentElement.classList.remove('has-cnotice');
    if(hadFocus){
      var next = document.querySelector('footer.site [data-legal="cookies"]');
      if(next && next.focus) next.focus();
    }
  });
})();
`;
