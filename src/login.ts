import { layout, esc, type HeadMeta } from "./pages";
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

const LOGIN_STYLE = `
main.auth{display:flex;align-items:center;justify-content:center;min-height:72vh;padding:2rem 0}
.sheet .steps{margin:1.4rem 0 0;padding:0;list-style:none;display:grid;gap:.75rem;counter-reset:step}
.sheet .steps li{display:flex;gap:.7rem;align-items:flex-start;color:var(--muted);font-size:.94rem}
.sheet .steps li:before{counter-increment:step;content:counter(step);flex:none;width:1.5rem;height:1.5rem;
  border-radius:999px;border:1px solid var(--border);background:rgba(255,255,255,.05);color:var(--fg);
  font-size:.78rem;font-weight:650;display:inline-flex;align-items:center;justify-content:center}
.auth-foot{text-align:center;color:var(--muted);font-size:.88rem;padding:1.6rem 0 0}
.who{font-family:var(--mono);font-size:.9rem;overflow-wrap:anywhere}
`;

/** Shared chrome so every auth state feels like the same quiet room. */
function sheet(state: string, inner: string): string {
  return `<header class="top"><a class="brand" href="/">rtfx.pro</a>
      <nav class="nav" aria-label="Primary"><a href="/">Home</a></nav></header>
    <main class="auth"><section class="sheet" data-page="login" data-state="${esc(state)}">${inner}</section></main>
    <footer class="auth-foot"><a href="/docs">Docs</a> · Access is by invitation · Cloudflare Access
      secures every sign-in</footer>`;
}

/**
 * The signed-out state. Two routes in, and the copy's only real job is to make
 * clear which one applies to *you* — "I was invited" vs "I wasn't". Everything
 * else on this page is subordinate to that one fork.
 */
function signedOut(): string {
  return sheet(
    "signed-out",
    `<p class="eyebrow">rtfx.pro</p>
     <h1>Sign in</h1>
     <p class="lede">Continue with the email address your invitation was sent to. We'll email
       you a one-time code — there's no password to remember.</p>
     <div class="actions">
       <a class="link-button" href="/admin" data-cta="sign-in">Continue with email</a>
       <a class="ghost link-button" href="/#waitlist" data-cta="request-access">Request access</a>
     </div>
     <ol class="steps">
       <li>Enter your email on the Cloudflare Access screen.</li>
       <li>Paste the one-time code it sends you.</li>
       <li>You land in your dashboard.</li>
     </ol>
     <hr class="divider">
     <p class="hint">No account yet? <a href="/#waitlist">Request access</a> and we'll be in
       touch — rtfx.pro is invite-only, so signing in only works once your address has been
       added. New here? <a href="/docs">Read the docs</a>.</p>`
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
       <a class="ghost link-button" href="/gallery">Browse artifacts</a>
     </div>
     <hr class="divider">
     <p class="hint">Signing in as somebody else? Sign out of Cloudflare Access first, at
       <span class="mono">/cdn-cgi/access/logout</span> on this domain.</p>`
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
    image: canonicalUrl(env, "/og.svg"),
    socialTitle: "Sign in to rtfx.pro",
  };
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
