/**
 * Consent, in two parts (issue #36; extended for the PostHog rollout).
 *
 * **The public notice below** (`cookieNotice`) covers every public page —
 * landing, docs, sign-in, /privacy, /terms. Those pages set no analytics,
 * advertising or profiling cookies, full stop, and never will without this
 * component changing: the browser storage involved is strictly necessary
 * (the app's own `rtfx_session` cookie when somebody signs in, Cloudflare's own
 * edge security cookies, and this notice's first-party localStorage
 * dismissal). Two things follow, and they are the whole design:
 *
 *  1. **There is nothing to consent to here, so this asks for nothing.** A
 *     banner with an "Accept analytics" toggle would be a lie about what runs
 *     on a public page. It is a notice: it says what is stored and why, links
 *     to the detail, and lets you dismiss it.
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
 * **The dashboard is different**, and has its own component further down this
 * file (`analyticsConsentNotice`/`analyticsConsentScript`): `/admin` can load
 * PostHog for session recording and error tracking, but only after a real
 * accept/decline choice, and only when the deployment has `POSTHOG_KEY` set at
 * all — see `src/posthog.ts` and `src/portal.ts`. `window.rtfxConsent.analytics`
 * below stays hard-coded `false` on every page this file's public notice
 * renders on; it was reserved for exactly this feature, and this feature did
 * not touch it, because it belongs to a different origin's worth of pages.
 */

/**
 * Bumping this re-shows the notice to everyone, for when the copy changes
 * materially. Bumped for the PostHog rollout: the site's overall privacy
 * posture changed (the dashboard now offers optional analytics), even though
 * this specific notice's own claim — nothing optional on the public pages —
 * did not.
 */
export const CONSENT_VERSION = "2026-08-14";

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
        <p>We use only necessary storage on this page: our own sign-in session cookie, Cloudflare's
          edge security cookies, and this notice's first-party localStorage dismissal. There is no
          analytics, no advertising and no third-party tracking here — so there is
          nothing on this page to opt out of. The dashboard, once you sign in, is different: it
          offers optional session recording with its own accept/decline choice —
          <a href="/privacy#dashboard-analytics" data-legal="dashboard-analytics">see what it collects</a>.
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

// --- dashboard analytics consent (PostHog rollout) --------------------------
//
// A different component from the notice above, on purpose: the public notice
// has nothing to consent to, so it only asks to be dismissed. The dashboard
// does have something optional to consent to, so it asks a real question with
// a real "no" — see the module comment at the top of this file.
//
// Rendered only by `portalShell` (src/portal.ts), and only when the caller
// passes a `PostHogConfig` — i.e. only when `POSTHOG_KEY` is set for this
// deployment at all. No key, no markup, no script, no mention: see
// `posthogConfig` in src/posthog.ts.

/**
 * Where the dashboard's session-recording/error-tracking decision is
 * remembered: `"granted"` or `"declined"`. A different key from `CONSENT_KEY`
 * above on purpose — that one records "I saw this," this one records an
 * actual choice, and the two must never be conflated or share a reappearance
 * trigger.
 */
export const ANALYTICS_CONSENT_KEY = "rtfx.dashboard-analytics";

/**
 * The accept/decline banner. Rendered `hidden`, exactly like `cookieNotice`
 * above — `analyticsConsentScript` is the only thing that ever unhides it, and
 * only when there is genuinely a decision left to make (no stored choice, and
 * no Do Not Track / Global Privacy Control signal).
 */
export function analyticsConsentNotice(): string {
  return `<aside class="cnotice" id="analytics-consent" data-analytics-consent hidden
      role="region" aria-labelledby="analytics-consent-title">
      <div class="cnotice-body">
        <h2 class="cnotice-title" id="analytics-consent-title">Session recording on this dashboard</h2>
        <p>With your OK, we record dashboard sessions — mouse movement, clicks, page navigation —
          and unhandled errors, to see what breaks and fix it before you have to report it. Every
          input value and every piece of text on the page is masked before anything leaves your
          browser, so a recording never shows an artifact's title, an email address, a token id or
          a view-log row.
          <a href="/privacy#dashboard-analytics" data-legal="dashboard-analytics">What this records</a>.</p>
      </div>
      <div class="cnotice-actions">
        <button type="button" class="ghost small" data-analytics-decline>Decline</button>
        <button type="button" class="small" data-analytics-accept>Accept</button>
      </div>
    </aside>`;
}

/** The two-button row `cookieNotice`'s single dismiss button never needed. */
export const ANALYTICS_CONSENT_STYLE = `
.cnotice-actions{display:flex;gap:.5rem;flex:none}
`;

/**
 * The gating script, parameterized by the deployment's PostHog project key
 * and host. Every rule from the PostHog rollout's privacy requirements is
 * enforced right here, in order:
 *
 *  1. **Nothing before consent.** `loadPostHog` — which is the only place
 *     `posthog.init` is ever called — is reachable from exactly three sites:
 *     a stored `"granted"` decision on page load, and the Accept button. It
 *     is never called at parse time, never called unconditionally, and never
 *     called on a `"declined"` or undecided visit.
 *  2. **Declining means nothing loads, not "loads but doesn't send."** There
 *     is no `posthog.init` call, no opt-out flag, no stub left running on
 *     decline — the function that would have made the network request simply
 *     never runs.
 *  3. **DNT/GPC is checked first, before storage is even read.** A signal
 *     either way is treated as a permanent, silent decline: no banner, no
 *     `localStorage` read or write, no load. This runs before rule 1 gets a
 *     chance to look at anything.
 *  4. **Masking is not a suggestion.** `maskAllInputs: true` and
 *     `maskTextSelector: "*"` are hard-coded into the one place PostHog is
 *     configured — see the comment beside them for exactly what that does and
 *     does not capture.
 */
export function analyticsConsentScript(cfg: { key: string; host: string }): string {
  return `
(function(){
  var KEY = ${JSON.stringify(ANALYTICS_CONSENT_KEY)};
  var box = document.querySelector('[data-analytics-consent]');
  if(!box) return; // Not rendered means no PostHog key configured — see portalShell.

  /* Checked before anything else touches storage or the DOM. Either signal is
     a permanent, silent decline: no banner, ever, on this browser. */
  function dntOrGpc(){
    try {
      if (navigator.doNotTrack === "1") return true;
      if (navigator.globalPrivacyControl) return true;
    } catch(e){}
    return false;
  }
  if(dntOrGpc()) return;

  function read(){ try { return localStorage.getItem(KEY); } catch(e){ return null; } }
  function write(v){ try { localStorage.setItem(KEY, v); } catch(e){} }

  /* The official PostHog web snippet, verbatim (installs the async loader and
     the posthog.init/capture stub queue), wrapped so the whole thing — the
     <script src> insertion included — only ever runs from inside
     loadPostHog(), which is only ever called after "granted". Nothing above
     this function makes a network request or reads/writes a cookie. */
  function loadPostHog(){
    !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
    posthog.init(${JSON.stringify(cfg.key)}, {
      api_host: ${JSON.stringify(cfg.host)},
      /* Autocapture logs the text and DOM attributes of whatever you click as
         event properties — a separate pipeline from session-replay masking
         below. On a page whose buttons and rows are literally named after
         grantee email addresses and artifact titles, that default is its own
         leak. Off. Manual events and error tracking still work without it. */
      autocapture: false,
      /* Unhandled errors and unhandled promise rejections, window.onerror and
         window.onunhandledrejection. console.error calls are NOT captured —
         posthog-js's own default — so this is error tracking, not a mirror of
         the browser console. */
      capture_exceptions: true,
      session_recording: {
        /* The two strongest privacy settings posthog-js has. maskAllInputs
           replaces every <input>/<textarea>/<select> value with asterisks
           before it is ever serialized; maskTextSelector: "*" does the same
           to every element's rendered text. Together they mean a session
           replay of this dashboard shows shapes, motion, layout and timing —
           never an artifact's title, a grantee's email address, an API token
           id, or a view-log row's contents. Mouse position, clicks, scrolling
           and page navigation ARE captured (that is what "record a session"
           means); the words under the cursor are not. */
        maskAllInputs: true,
        maskTextSelector: "*"
      }
    });
  }

  var decision = read();
  if(decision === "granted"){ loadPostHog(); return; }
  if(decision === "declined") return;

  box.hidden = false;
  document.documentElement.classList.add('has-cnotice');
  var accept = box.querySelector('[data-analytics-accept]');
  var decline = box.querySelector('[data-analytics-decline]');
  function decide(value){
    write(value);
    box.hidden = true;
    document.documentElement.classList.remove('has-cnotice');
  }
  if(accept) accept.addEventListener('click', function(){ decide("granted"); loadPostHog(); });
  if(decline) decline.addEventListener('click', function(){ decide("declined"); });
})();
`;
}
