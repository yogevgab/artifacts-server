import {
  layout,
  esc,
  brandLockup,
  siteHeader,
  siteFooter,
  PUBLIC_CHROME_STYLE,
  type HeadMeta,
} from "./pages";
import { cookieNotice, CONSENT_STYLE, CONSENT_SCRIPT } from "./consent";
import type { Env } from "./env";
import { canonicalUrl } from "./seo";

/**
 * The sign-in surface (issue #24).
 *
 * `/login` is deliberately a *public, unauthenticated* page — it must not sit
 * behind the Cloudflare Access application, or a visitor would meet Cloudflare's
 * own login screen with no explanation of what this product is or how to get in.
 * See docs/DEPLOY_RTFX.md.
 *
 * It does not authenticate anybody. Cloudflare Access is the identity provider
 * and there is no password here by design (issue #24 non-goal). The page's whole
 * job is to make the next step obvious, which is one of exactly three things:
 *
 *  - **Signed out** → "Continue with email" hands off to `/admin`, which Access
 *    gates, which is what triggers the one-time-code email.
 *  - **Signed in** → say who they are and get out of the way.
 *  - **Paused** → explain, in plain words, that the account is disabled and what
 *    to do about it. Never a generic 403: being told "forbidden" when you were
 *    invited last week is the worst moment in the product.
 *
 * See docs/DESIGN.md for the visual language these states share.
 */

const LOGIN_STYLE = `${PUBLIC_CHROME_STYLE}${CONSENT_STYLE}
main.auth{display:flex;align-items:center;justify-content:center;min-height:62vh;padding:2rem 0}
.sheet .steps{margin:1.4rem 0 0;padding:0;list-style:none;display:grid;gap:.75rem;counter-reset:step}
.sheet .steps li{display:flex;gap:.7rem;align-items:flex-start;color:var(--muted);font-size:.94rem}
.sheet .steps li:before{counter-increment:step;content:counter(step);flex:none;width:1.5rem;height:1.5rem;
  border-radius:999px;border:1px solid var(--border);background:rgba(255,255,255,.05);color:var(--fg);
  font-size:.78rem;font-weight:650;display:inline-flex;align-items:center;justify-content:center}
.who{font-family:var(--mono);font-size:.9rem;overflow-wrap:anywhere}
/* The lockup inside the sheet is the page's own signature — bigger than the one
   in the header bar, and centred, because on this page the brand IS the content
   above the fold. */
.auth-brand{display:flex;justify-content:center;margin-bottom:1.15rem}
.auth-brand .brand-lockup{font-size:1.34rem;gap:.65rem}
.sheet[data-page="login"]{text-align:center}
.sheet[data-page="login"] .steps li,.sheet[data-page="login"] .hint{text-align:left}
.sheet[data-page="login"] .actions{justify-content:center}
.mail-help{margin:1rem 0 0;padding:1rem;border:1px solid var(--border);border-radius:var(--radius-sm);
  background:rgba(255,255,255,.035);text-align:left}
.mail-help h2{font-size:.95rem;margin:0 0 .35rem;letter-spacing:-.02em}
.mail-help ul{margin:.45rem 0 0;padding-inline-start:1.1rem;color:var(--muted);font-size:.86rem}
/* The sign-in form. Two steps in one sheet — address, then code — so the page
   never navigates and the brand never hands off mid-flow. */
.auth-form{display:grid;gap:.85rem;margin:1.35rem 0 0;text-align:left}
.field{display:grid;gap:.35rem}
.field-label{font-size:.82rem;font-weight:600;letter-spacing:.01em;color:var(--muted)}
.auth-form input{width:100%;padding:.7rem .8rem;border:1px solid var(--border);border-radius:var(--radius-sm);
  background:rgba(255,255,255,.04);color:var(--fg);font:inherit;font-size:1rem}
.auth-form input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.auth-form input[name="code"]{font-family:var(--mono);font-size:1.4rem;letter-spacing:.28em;text-align:center}
.auth-form button{width:100%;justify-content:center}
.status[data-auth-status]{margin:.9rem 0 0;font-size:.9rem;text-align:left}
.status[data-auth-status][data-tone="error"]{color:var(--danger,#f2889a)}
`;

/**
 * Progressive enhancement is not on offer here: without JavaScript there is no
 * sign-in, which is the same trade the dashboard already makes. Kept in ES5-ish
 * style to match `CONSENT_SCRIPT` and the People panel.
 */
const AUTH_SCRIPT = `(function(){
  var emailForm=document.querySelector('[data-step="email"]');
  var codeForm=document.querySelector('[data-step="code"]');
  var status=document.querySelector('[data-auth-status]');
  var sentTo=document.querySelector('[data-sent-to]');
  if(!emailForm||!codeForm) return;
  var address='';

  function say(msg,tone){
    status.hidden=!msg; status.textContent=msg||'';
    if(tone){status.setAttribute('data-tone',tone);}else{status.removeAttribute('data-tone');}
  }
  function busy(form,on){
    var b=form.querySelector('button[type="submit"]');
    if(b){b.disabled=on; b.textContent=on?'Working…':b.getAttribute('data-label')||b.textContent;}
  }
  Array.prototype.forEach.call(document.querySelectorAll('button[type="submit"]'),function(b){
    b.setAttribute('data-label',b.textContent);
  });

  emailForm.addEventListener('submit',function(e){
    e.preventDefault();
    address=emailForm.elements.email.value.trim();
    if(!address){say('Enter your email address.','error');return;}
    busy(emailForm,true); say('');
    fetch('/auth/start',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email:address})}).then(function(r){
      busy(emailForm,false);
      if(r.status===429){say('Too many attempts. Try again in an hour.','error');return;}
      if(!r.ok){say('That address does not look right.','error');return;}
      emailForm.hidden=true; codeForm.hidden=false;
      sentTo.textContent='We sent a code to '+address+'. It expires in 15 minutes.';
      codeForm.elements.code.focus();
    }).catch(function(){busy(emailForm,false);say('Network problem. Try again.','error');});
  });

  codeForm.addEventListener('submit',function(e){
    e.preventDefault();
    var code=codeForm.elements.code.value.trim();
    if(!/^[0-9]{6}$/.test(code)){say('Enter the six digits from the email.','error');return;}
    busy(codeForm,true); say('');
    fetch('/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email:address,code:code})}).then(function(r){
      busy(codeForm,false);
      if(r.ok){return r.json().then(function(j){window.location.href=j.redirect||'/admin';});}
      say(r.status===401?'That code is wrong or has expired. Request a new one.':'Something went wrong.','error');
    }).catch(function(){busy(codeForm,false);say('Network problem. Try again.','error');});
  });

  var back=codeForm.querySelector('[data-back]');
  if(back){back.addEventListener('click',function(){
    codeForm.hidden=true; emailForm.hidden=false; say('');
    emailForm.elements.email.focus();
  });}
})();`;

/**
 * Shared chrome so every auth state feels like the same quiet room — and, since
 * the very next screen belongs to Cloudflare rather than to us, so that the
 * screen before it is unmistakably ours (issue #37). The mark is the same one
 * the dashboard and the browser tab use; see `brandMark` in src/pages.ts.
 */
function sheet(state: string, inner: string): string {
  return `${siteHeader("login")}
    <main class="auth" id="main"><section class="sheet" data-page="login" data-state="${esc(state)}">
      <div class="auth-brand">${brandLockup("/")}</div>
      ${inner}</section></main>
    ${siteFooter()}
    ${cookieNotice()}
    <script>${CONSENT_SCRIPT}</script>`;
}

/**
 * The signed-out state. Two routes in, and the copy's only real job is to make
 * clear which one applies to *you* — "I was invited" vs "I wasn't". Everything
 * else on this page is subordinate to that one fork.
 *
 * The second job, added in issue #37: name the handoff before it happens. The
 * next screen is hosted by Cloudflare Access and looks nothing like this one, so
 * a person who wasn't told lands on an unfamiliar page asking for their email —
 * which is exactly what a phishing page looks like. Saying "the next screen is
 * Cloudflare's" costs one line and removes the doubt entirely.
 */
interface SignedOutCopy {
  eyebrow?: string;
  heading?: string;
  lede?: string;
  footerHtml?: string;
}

function signedOut(copy: SignedOutCopy = {}): string {
  return sheet(
    "signed-out",
    `<p class="eyebrow">${esc(copy.eyebrow ?? "Sign in")}</p>
     <h1>${esc(copy.heading ?? "Welcome")}</h1>
     <p class="lede">${esc(
       copy.lede ??
         "Enter your email and we'll send you a code. There's no password to create or remember."
     )}</p>

     <form class="auth-form" data-step="email" novalidate>
       <label class="field">
         <span class="field-label">Email address</span>
         <input type="email" name="email" autocomplete="email" inputmode="email"
                placeholder="you@example.com" required autofocus>
       </label>
       <button type="submit" class="link-button" data-cta="sign-in">Email me a code</button>
     </form>

     <form class="auth-form" data-step="code" hidden novalidate>
       <p class="lede" data-sent-to></p>
       <label class="field">
         <span class="field-label">Six-digit code</span>
         <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code"
                pattern="[0-9]{6}" maxlength="6" placeholder="000000" required>
       </label>
       <button type="submit" class="link-button" data-cta="verify">Sign in</button>
       <button type="button" class="ghost link-button" data-back>Use a different address</button>
     </form>

     <p class="status" data-auth-status role="status" aria-live="polite" hidden></p>

     <div class="mail-help" data-otp-help>
       <h2>Didn't get the email?</h2>
       <ul>
         <li>The code takes up to a minute. Check spam, junk and promotions.</li>
         <li>The link in the message signs you in directly — no code to type.</li>
         <li>Request another and the previous code stops working.</li>
       </ul>
     </div>
     <hr class="divider">
     ${
       copy.footerHtml ??
       `<p class="hint">New here? <a href="/signup">Create an account</a> — it takes one email and
       nothing else. Or <a href="/docs">read the docs</a> first.</p>`
     }
     <p class="hint">Signing in sets one cookie, the session that keeps you signed in. Nothing
       here tracks you: see the <a href="/privacy">privacy policy</a> and the
       <a href="/terms">terms of use</a>.</p>
     <script>${AUTH_SCRIPT}</script>`
  );
}

/** Already authenticated: confirm who, then get out of the way. */
function signedIn(email: string): string {
  return sheet(
    "signed-in",
    `<p class="eyebrow">Signed in</p>
     <h1>You're already in</h1>
     <p class="lede">This browser is signed in as <span class="who" data-viewer-email>${esc(email)}</span>.</p>
     <div class="actions">
       <a class="link-button" href="/admin" data-cta="dashboard">Go to dashboard</a>
       <a class="ghost link-button" href="/admin/gallery">Browse the gallery</a>
       <a class="ghost link-button" href="/logout" data-cta="logout">Sign out</a>
     </div>
     <hr class="divider">
     <p class="hint">Signing in as somebody else? Use Sign out first, then continue with email again.</p>`
  );
}

/**
 * A real person whose access was paused. They authenticated fine, so this is not
 * a security boundary being explained — it's a status. Say what happened, say it
 * is reversible, say who can reverse it, and don't imply they did something wrong.
 */
function paused(email: string | null): string {
  return sheet(
    "paused",
    `<p class="eyebrow">Account paused</p>
     <h1>Your access is paused</h1>
     <p class="lede">${
       email
         ? `<span class="who" data-viewer-email>${esc(email)}</span> is signed in, but an admin has
            paused this account, so the dashboard and API are unavailable right now.`
         : `An admin has paused this account, so the dashboard and API are unavailable right now.`
     }</p>
     <p class="note">Nothing has been deleted. Anything you published is still stored, and an
       admin can re-enable the account at any time — ask whoever invited you.</p>
     <div class="actions">
       <a class="ghost link-button" href="/">Back to rtfx.pro</a>
     </div>`
  );
}

export type LoginState =
  | { kind: "signed-out" }
  | { kind: "signed-in"; email: string }
  | { kind: "paused"; email: string | null };

/**
 * Only the signed-out sheet is public content worth indexing: it explains how
 * to get in. The signed-in and paused sheets describe a specific person's
 * account, so they stay `noindex` (the default when `layout` gets no metadata).
 */
function signedOutMeta(env: Env): HeadMeta {
  return {
    description:
      "Sign in to rtfx.pro. Access is by invitation and sign-in is passwordless — we email " +
      "you a one-time code. No account yet? Request access in a click.",
    canonical: canonicalUrl(env, "/login"),
    image: canonicalUrl(env, "/og.png"),
    socialTitle: "Sign in to rtfx.pro",
  };
}

/**
 * `/signup` is the same sheet with different copy. It must be, because signup
 * and sign-in are literally the same endpoint (`/auth/start`) — giving them two
 * different forms would let the two paths disagree about who you are.
 */
export function signupPage(env: Env, state: LoginState): string {
  if (state.kind === "signed-in") {
    return layout("Signed in \u00b7 rtfx.pro", signedIn(state.email), LOGIN_STYLE);
  }
  return layout(
    "Create an account \u00b7 rtfx.pro",
    signedOut({
      eyebrow: "Create an account",
      heading: "Get started",
      lede:
        "Enter your email and we'll send you a code. No password, no credit card \u2014 " +
        "you'll have a workspace in about thirty seconds.",
      footerHtml:
        '<p class="hint">Already have an account? <a href="/login">Sign in</a> \u2014 ' +
        "it's the same code either way.</p>",
    }),
    LOGIN_STYLE,
    signedOutMeta(env)
  );
}

export function loginPage(env: Env, state: LoginState): string {
  if (state.kind === "signed-in") {
    return layout("Signed in · rtfx.pro", signedIn(state.email), LOGIN_STYLE);
  }
  if (state.kind === "paused") {
    return layout("Access paused · rtfx.pro", paused(state.email), LOGIN_STYLE);
  }
  return layout("Sign in · rtfx.pro", signedOut(), LOGIN_STYLE, signedOutMeta(env));
}

/** The paused sheet on its own, for HTML routes that reject a disabled caller. */
export function accountPausedPage(env: Env, email: string | null): string {
  return loginPage(env, { kind: "paused", email });
}

/**
 * The magic-link confirm step.
 *
 * A mail scanner will fetch this page; it will not press the button. That one
 * fact is the whole reason the page exists — see the route comment in
 * src/auth-routes.ts.
 */
export function magicLinkConfirmPage(env: Env, token: string): string {
  return layout(
    "Confirm sign-in \u00b7 rtfx.pro",
    sheet(
      "confirm",
      `<p class="eyebrow">Almost there</p>
       <h1>Confirm sign-in</h1>
       <p class="lede">Press the button to finish signing in to rtfx.pro. We ask because mail
         providers open links automatically, and a sign-in should happen when you say so.</p>
       <form class="auth-form" method="post" action="/auth/m/${esc(token)}">
         <button type="submit" class="link-button" data-cta="confirm-signin">Sign me in</button>
       </form>
       <hr class="divider">
       <p class="hint">Didn't ask for this? Close the tab and nothing happens — the link stops
         working on its own.</p>`
    ),
    LOGIN_STYLE
  );
}

/**
 * Guest sign-in, reached when somebody opens a shared artifact and we do not
 * know them. It asks for nothing but the address the share was sent to, and it
 * never says whether that address holds a grant — the answer is identical
 * either way, because otherwise this page enumerates who can see what.
 */
export function guestSigninPage(env: Env, slug: string): string {
  return layout(
    "Open a shared page \u00b7 rtfx.pro",
    sheet(
      "guest",
      `<p class="eyebrow">Shared with you</p>
       <h1>Confirm it's you</h1>
       <p class="lede">Enter the email address this was shared with and we'll send you a link
         to open it. No account, no password.</p>
       <form class="auth-form" data-guest-form data-slug="${esc(slug)}" novalidate>
         <label class="field">
           <span class="field-label">Email address</span>
           <input type="email" name="email" autocomplete="email" inputmode="email"
                  placeholder="you@example.com" required autofocus>
         </label>
         <button type="submit" class="link-button">Send me the link</button>
       </form>
       <p class="status" data-auth-status role="status" aria-live="polite" hidden></p>
       <hr class="divider">
       <p class="hint">Have an rtfx.pro account? <a href="/login">Sign in</a> instead and it will
         open directly.</p>
       <script>${GUEST_SCRIPT}</script>`
    ),
    LOGIN_STYLE
  );
}

const GUEST_SCRIPT = `(function(){
  var form=document.querySelector('[data-guest-form]');
  var status=document.querySelector('[data-auth-status]');
  if(!form) return;
  form.addEventListener('submit',function(e){
    e.preventDefault();
    var email=form.elements.email.value.trim();
    if(!email){return;}
    var btn=form.querySelector('button'); btn.disabled=true; btn.textContent='Sending\u2026';
    fetch('/auth/guest?slug='+encodeURIComponent(form.getAttribute('data-slug')),{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email:email})
    }).then(function(){
      form.hidden=true; status.hidden=false;
      status.textContent='If that address has access, a link is on its way. It expires in 15 minutes.';
    }).catch(function(){
      btn.disabled=false; btn.textContent='Send me the link';
      status.hidden=false; status.setAttribute('data-tone','error');
      status.textContent='Network problem. Try again.';
    });
  });
})();`;
