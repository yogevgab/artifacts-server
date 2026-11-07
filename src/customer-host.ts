/**
 * What a customer host (an ACTIVE custom domain) serves, and nothing else.
 *
 * A customer host is `docs.acme.com`: it shows one workspace's documents at
 * `/<artifact-slug>` and carries the same sign-in as rtfx.pro (email code, magic
 * link, guest link, share link). It must NEVER expose the management surface, so
 * this is an allowlist, applied before any route runs (src/index.ts):
 *
 *   GET/HEAD  /                       small "documents shared by <workspace>" page
 *             /login                  minimal sign-in
 *             /logout
 *             /shared/<slug>          guest sign-in (where the viewer sends a visitor)
 *             /auth/m/<token>         magic-link confirm page
 *             /_chat/<slug>           chat socket
 *             /robots.txt             Disallow: /
 *             favicon / icons
 *             /<slug>[/<path>]        the viewer (src/viewer-routes.ts)
 *   POST      /auth/start /auth/verify /auth/guest /auth/signout /auth/m/<token>
 *             /_frame-stall
 *             /_access-request/<slug> the "ask for access" form on the 404 page
 *
 * Everything else answers 404: /admin, /api, /oauth, /.well-known, /mcp, /u,
 * /share, /upgrade, the marketing pages, llms.txt, sitemap.xml. The owner manages
 * from rtfx.pro.
 */

import type { Env } from "./env";
import type { AppContext } from "./viewing";
import type { CustomDomainRow } from "./custom-domains";
import { resolveAuth } from "./auth";
import { getAccount } from "./accounts";
import { esc, notFoundPage } from "./pages";
import { AUTH_SCRIPT, GUEST_SCRIPT } from "./login";
import { pendingNextCookie } from "./auth-routes";
import { isManagementPath } from "./host";
import { safeNextPath } from "./util";
import { siteOrigin } from "./seo";

const ICON_PATHS = new Set(["/favicon.ico", "/icon.svg", "/icon.png", "/apple-touch-icon.png"]);
const POST_ALLOWED = new Set(["/auth/start", "/auth/verify", "/auth/guest", "/auth/signout", "/_frame-stall"]);

function notFound(c: AppContext): Response {
  return c.html(notFoundPage(undefined, siteOrigin(c.env)), 404);
}

/**
 * Decide a request on a customer host. Returns a Response to answer it now, or
 * null to let it continue to the route that serves it (auth, chat, icons, the
 * viewer wildcard).
 */
export async function customerHostGate(c: AppContext, domain: CustomDomainRow): Promise<Response | null> {
  const path = c.req.path;
  const method = c.req.method;

  if (method === "GET" || method === "HEAD") {
    if (path === "/") return rootResponse(c, domain);
    if (path === "/login") return loginResponse(c, domain);
    if (path === "/logout" || ICON_PATHS.has(path)) return null;
    if (path === "/robots.txt") {
      return c.text("User-agent: *\nDisallow: /\n", 200, { "Cache-Control": "public, max-age=3600" });
    }
    const shared = path.match(/^\/shared\/([^/]+)$/);
    if (shared) return guestResponse(c, domain, decodeSegment(shared[1]));
    const magic = path.match(/^\/auth\/m\/([^/]+)$/);
    if (magic) return c.html(page("Confirm sign-in", confirmBody(magic[1]), domain), 200, NO_STORE);
    if (/^\/_chat\/[^/]+$/.test(path)) return null;
    // /admin, /api, /oauth, /mcp, /share, marketing pages, llms.txt, sitemap...
    if (isManagementPath(path) || path.startsWith("/_access-request")) return notFound(c);
    return null; // a viewer path: /<slug> or /<slug>/<path>
  }

  if (POST_ALLOWED.has(path) || /^\/auth\/m\/[^/]+$/.test(path) || /^\/_access-request\/[^/]+$/.test(path)) {
    return null;
  }
  return notFound(c);
}

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

const NO_STORE = { "Cache-Control": "private, no-store" };

// --- pages ---------------------------------------------------------------------

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#14172b;--muted:#565d78;--line:#d9dcea;--accent:#2438c8;--on:#fff;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#0f1220;--fg:#eceef8;--muted:#a3a9c4;--line:#2a2f4a;--accent:#8a98ff;--on:#0f1220;--err:#f2889a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:26rem;margin:0 auto;padding:12vh 16px 4rem}
h1{font-size:1.4rem;letter-spacing:-.02em;margin:0 0 .6rem}
p{color:var(--muted);margin:.4rem 0}
form{display:grid;gap:.8rem;margin:1.2rem 0 0}
label span{display:block;font-size:.82rem;font-weight:600;color:var(--muted);margin-bottom:.3rem}
input{width:100%;padding:.7rem .8rem;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--fg);font:inherit}
input[name=code]{font-family:ui-monospace,monospace;font-size:1.4rem;letter-spacing:.28em;text-align:center}
button,.btn{display:inline-block;padding:.7rem 1rem;border:0;border-radius:6px;background:var(--accent);color:var(--on);font:inherit;font-weight:600;cursor:pointer;text-decoration:none;text-align:center}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
button:disabled{opacity:.6}
a{color:var(--accent)}
.status{font-size:.9rem}.status[data-tone=error]{color:var(--err)}
.foot{margin-top:2.4rem;font-size:.8rem}
`;

function page(title: string, body: string, domain: CustomDomainRow): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · ${esc(domain.hostname)}</title>
<style>${STYLE}</style></head><body><main id="main">${body}</main></body></html>`;
}

async function workspaceName(env: Env, domain: CustomDomainRow): Promise<string> {
  const account = await getAccount(env, domain.account_id);
  return account?.name?.trim() || domain.hostname;
}

async function rootResponse(c: AppContext, domain: CustomDomainRow): Promise<Response> {
  const name = await workspaceName(c.env, domain);
  const body = `<h1>${esc(domain.hostname)}</h1>
    <p>This domain hosts documents shared by <strong>${esc(name)}</strong>.</p>
    <p>If someone sent you a link, open it directly. If you were asked to sign in, you can do that here.</p>
    <p style="margin-top:1.2rem"><a class="btn" href="/login">Sign in</a></p>`;
  return c.html(page(name, body, domain), 200, { "Cache-Control": "public, max-age=300" });
}

function signInBody(): string {
  return `<h1>Sign in</h1>
    <p>Enter your email and we'll send you a code. There's no password.</p>
    <form data-step="email" novalidate>
      <label><span>Email address</span><input type="email" name="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required autofocus></label>
      <button type="submit">Email me a code</button>
    </form>
    <form data-step="code" hidden novalidate>
      <p data-sent-to></p>
      <label><span>Six-digit code</span><input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required></label>
      <button type="submit">Sign in</button>
      <button type="button" class="ghost" data-back>Use a different address</button>
    </form>
    <p class="status" data-auth-status role="status" aria-live="polite" hidden></p>
    <script>${AUTH_SCRIPT}</script>`;
}

async function loginResponse(c: AppContext, domain: CustomDomainRow): Promise<Response> {
  const { identity } = await resolveAuth(c);
  const next = safeNextPath(c.req.query("next"));
  if (identity?.email) {
    if (next) return c.redirect(next, 302);
    const body = `<h1>You're signed in</h1>
      <p>This browser is signed in as <strong>${esc(identity.email)}</strong>.</p>
      <p style="margin-top:1.2rem"><a class="btn" href="/">Continue</a> <a href="/logout">Sign out</a></p>`;
    return c.html(page("Signed in", body, domain), 200, NO_STORE);
  }
  // Like /login on the app host: parks (or clears) the post-sign-in destination.
  return c.html(page("Sign in", signInBody(), domain), 200, {
    ...NO_STORE,
    "Set-Cookie": pendingNextCookie(next),
  });
}

async function guestResponse(c: AppContext, domain: CustomDomainRow, slug: string): Promise<Response> {
  const { identity } = await resolveAuth(c);
  const next = safeNextPath(c.req.query("next"));
  if (identity?.email) return c.redirect(next ?? `/${encodeURIComponent(slug)}`, 302);
  const body = `<h1>Confirm it's you</h1>
    <p>Enter the email address this was shared with \u2014 or your own, if it's yours \u2014 and we'll email you a way in. No password.</p>
    <form method="post" data-guest-form data-slug="${esc(slug)}" novalidate>
      <label><span>Email address</span><input type="email" name="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required autofocus></label>
      <button type="submit">Email me</button>
    </form>
    <form method="post" data-guest-code hidden novalidate>
      <p id="guest-sent-to" data-sent-to></p>
      <label><span>Six-digit code</span><input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required aria-describedby="guest-sent-to"></label>
      <button type="submit">Open</button>
      <button type="button" class="ghost" data-back>Use a different address</button>
    </form>
    <p class="status" data-auth-status role="status" aria-live="polite" hidden></p>
    <p class="foot">Have an account? <a href="${esc(next ? `/login?next=${encodeURIComponent(next)}` : "/login")}">Sign in</a> instead.</p>
    <script>${GUEST_SCRIPT}</script>`;
  return c.html(page("Open a shared page", body, domain), 200, NO_STORE);
}

function confirmBody(token: string): string {
  return `<h1>Confirm sign-in</h1>
    <p>Press the button to finish signing in. We ask because mail providers open links automatically, and a sign-in should happen when you say so.</p>
    <form method="post" action="/auth/m/${esc(token)}"><button type="submit">Sign me in</button></form>
    <p class="foot">Didn't ask for this? Close the tab and nothing happens.</p>`;
}
