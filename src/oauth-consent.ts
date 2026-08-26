/**
 * The consent screen, and the two pages that replace it when a request cannot
 * safely be redirected anywhere.
 *
 * This is the one browser POST in the product that mints a credential, so the
 * page has one job beyond looking like the rest of rtfx: say exactly what is
 * about to be granted, to whom, and inside which workspace — in words, not in
 * scope strings. A person who clicks "Allow" without reading this file must
 * still know what they agreed to.
 */

import { layout, esc, brandLockup, siteHeader, siteFooter, PUBLIC_CHROME_STYLE } from "./pages";
import type { Env } from "./env";
import { OAUTH_SCOPE_COPY, type OAuthScope } from "./oauth";

const CONSENT_PAGE_STYLE = `${PUBLIC_CHROME_STYLE}
main.auth{display:flex;align-items:center;justify-content:center;min-height:62vh;padding:2rem 0}
.auth-brand{display:flex;justify-content:center;margin-bottom:1.15rem}
.auth-brand .brand-lockup{font-size:1.34rem;gap:.65rem}
.sheet[data-page="consent"]{max-width:36rem}
.grant{margin:1.4rem 0 0;padding:0;list-style:none;display:grid;gap:.85rem}
.grant li{display:grid;gap:.2rem;padding:.8rem .9rem;border:1px solid var(--border);
  border-radius:var(--radius-sm);background:rgba(255,255,255,.035)}
.grant .scope-title{font-weight:650;font-size:.95rem}
.grant .scope-detail{color:var(--muted);font-size:.86rem;line-height:1.45}
.grant li[data-elevated="1"]{border-color:var(--border-strong)}
.grant .scope-flag{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--faint)}
.facts{margin:1.3rem 0 0;font-size:.88rem}
.facts dt{color:var(--muted)}
.facts dd{font-family:var(--mono);overflow-wrap:anywhere}
.consent-actions{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1.7rem}
.consent-actions button{flex:1 1 10rem;justify-content:center}
.warn{margin:1.2rem 0 0;padding:.8rem .9rem;border:1px solid var(--border-strong);
  border-radius:var(--radius-sm);color:var(--muted);font-size:.86rem;line-height:1.5}
`;

function sheet(state: string, inner: string): string {
  return `${siteHeader("login")}
    <main class="auth" id="main"><section class="sheet" data-page="${esc(state)}">
      <div class="auth-brand">${brandLockup("/")}</div>
      ${inner}</section></main>
    ${siteFooter()}`;
}

export interface ConsentPageInput {
  /** The `client_name` the client registered. Never trusted as markup. */
  clientName: string;
  /** The scopes actually requested, already validated against what we support. */
  scopes: OAuthScope[];
  /** RFC 8707 audience — the MCP endpoint this credential will be pinned to. */
  resource: string;
  /** Who is granting. */
  email: string;
  /** The workspace the credential will act inside, when there is one. */
  workspace: string | null;
  /** Access-token lifetime, in words. */
  expiresIn: string;
  /** Double-submit CSRF value; also set as a host-only cookie. */
  csrf: string;
  /**
   * The authorization request, echoed back as hidden fields. POST re-validates
   * every one of them from scratch — this form is a convenience, never a
   * statement that GET already checked something.
   */
  params: Record<string, string>;
}

/**
 * The consent screen.
 *
 * `client_name` is attacker-controlled (registration is unauthenticated), so it
 * is escaped here like any other untrusted string, and the page says plainly
 * that the name is self-reported rather than verified.
 */
export function consentPage(env: Env, input: ConsentPageInput): string {
  const hidden = Object.entries(input.params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("\n       ");

  const grants = input.scopes
    .map((scope) => {
      const copy = OAUTH_SCOPE_COPY[scope];
      const elevated = scope === "rtfx:manage";
      return `<li data-elevated="${elevated ? 1 : 0}">
         <span class="scope-title">${esc(copy.title)}</span>
         <span class="scope-detail">${esc(copy.detail)}</span>
         ${elevated ? `<span class="scope-flag">Destructive — grant only if you meant to</span>` : ""}
       </li>`;
    })
    .join("\n       ");

  return layout(
    "Authorize an application · rtfx.pro",
    sheet(
      "consent",
      `<p class="eyebrow">Authorize</p>
     <h1>${esc(input.clientName)} wants access</h1>
     <p class="lede">It is asking to act as you on rtfx.pro. Nothing is granted until you allow it.</p>

     <ul class="grant">
       ${grants}
     </ul>

     <dl class="facts sheet-facts">
       <dt>Signed in as</dt><dd>${esc(input.email)}</dd>
       ${input.workspace ? `<dt>Workspace</dt><dd>${esc(input.workspace)}</dd>` : ""}
       <dt>Endpoint</dt><dd>${esc(input.resource)}</dd>
       <dt>Expires</dt><dd>${esc(input.expiresIn)}</dd>
     </dl>

     <p class="warn">The application name above is what the client told us when it registered — it is
     not verified. If you did not just start a sign-in from ${esc(input.clientName)}, close this page.</p>

     <form method="post" action="/oauth/authorize">
       ${hidden}
       <input type="hidden" name="csrf" value="${esc(input.csrf)}">
       <div class="consent-actions">
         <button type="submit" name="decision" value="deny" class="ghost">Cancel</button>
         <button type="submit" name="decision" value="allow">Allow access</button>
       </div>
     </form>

     <hr class="divider">
     <p class="hint">You can revoke this at any time from
     <a href="/admin/integrations">Integrations</a>. Access tokens issued this way expire on their
     own; revoking one takes effect immediately.</p>`
    ),
    CONSENT_PAGE_STYLE
  );
}

/**
 * An authorization request that cannot be redirected back to the client.
 *
 * Reached only when `client_id` or `redirect_uri` is unrecognized — the two
 * cases where bouncing the person onward would mean sending an error (and, with
 * a different bug, a code) to a URL we have no reason to trust. Every other
 * failure is reported to the client at its registered redirect URI, as OAuth
 * requires.
 */
export function oauthErrorPage(
  env: Env,
  input: { error: string; detail: string; retryHref?: string | null }
): string {
  const retry = input.retryHref
    ? `<a class="link-button" href="${esc(input.retryHref)}">Start authorization again</a>`
    : "";
  return layout(
    "Authorization failed · rtfx.pro",
    sheet(
      "consent-error",
      `<p class="eyebrow">Authorization</p>
     <h1>That request can't be completed</h1>
     <p class="lede">${esc(input.detail)}</p>
     <dl class="facts sheet-facts"><dt>Error</dt><dd>${esc(input.error)}</dd></dl>
     <p class="warn">Nothing was granted and nobody was signed out. If Claude or another MCP client
     already says the rtfx connection is active, you can close this tab. This usually means an old
     or parallel consent tab was submitted after the live sign-in had already completed.</p>
     <div class="actions">${retry}<a class="ghost link-button" href="/admin">Back to rtfx</a></div>`
    ),
    CONSENT_PAGE_STYLE
  );
}
