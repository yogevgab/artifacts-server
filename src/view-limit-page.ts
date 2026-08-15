/**
 * The two pages served instead of an artifact's content when its owning account
 * may not serve it: over the plan's monthly view limit (src/quota.ts,
 * `blocksOnViewLimit`), or suspended by an operator (`blocksOnSuspension`).
 *
 * Both are deliberately vague about the account behind them, for the same
 * reason — a stranger who followed a link is owed "this isn't working right
 * now", not the owner's plan, usage, or standing with us.
 *
 * A viewer who lands here did nothing wrong — they followed a link that used
 * to work — so this is a 503, not a 404: the artifact still exists, access is
 * still fine, the content is just temporarily unavailable. And it is
 * deliberately unspecific about the account behind it: no plan name, no usage
 * numbers, no owner identity. "Come back later" is everything a stranger
 * needs to know; the owner (who is never shown this page — see
 * `blocksOnViewLimit`) is the one who needs the rest, and they see it in
 * their dashboard, not here.
 */
import { esc, layout, brandLockup, skipLink, BRAND_STYLE } from "./pages";

function appHref(appBaseUrl: string | undefined, path: string): string {
  return appBaseUrl ? `${appBaseUrl.replace(/\/+$/, "")}${path}` : path;
}

export function overViewLimitPage(slug?: string, appBaseUrl?: string): string {
  const body = `${skipLink()}
    <header class="top">${brandLockup(appHref(appBaseUrl, "/"))}</header>
    <main class="empty" id="main" data-empty="over-limit">
      <h1>${
        slug
          ? `<span class="mono">/${esc(slug)}/</span> is temporarily unavailable`
          : "This page is temporarily unavailable"
      }</h1>
      <p>Its owner's plan has reached its monthly view limit. There is nothing wrong
        with the link — it will work again once the limit resets, or the owner
        upgrades their plan.</p>
      <p style="margin-top:1rem"><a href="${esc(appHref(appBaseUrl, "/"))}">← Back to rtfx.pro</a></p>
    </main>`;
  return layout("Temporarily unavailable", body, BRAND_STYLE);
}

/**
 * Shown instead of an artifact's content when an operator has suspended the
 * workspace that owns it (src/quota.ts, `blocksOnSuspension`).
 *
 * A 403 rather than the view limit's 503: this is not a transient capacity
 * condition that will clear on its own, and a "try again later" would be a lie
 * to a viewer and an invitation to retry to an abuser. It stops short of a 404
 * because the artifact does still exist and the owner has a route back — the
 * page says so without saying why, since the reason is between the owner and
 * us, and "suspended" published to every visitor would convict them in public
 * on the strength of an operator action they may be contesting.
 */
export function suspendedContentPage(slug?: string, appBaseUrl?: string): string {
  const body = `${skipLink()}
    <header class="top">${brandLockup(appHref(appBaseUrl, "/"))}</header>
    <main class="empty" id="main" data-empty="suspended">
      <h1>${
        slug
          ? `<span class="mono">/${esc(slug)}/</span> is unavailable`
          : "This page is unavailable"
      }</h1>
      <p>This page is not being served right now. If it is yours, sign in and
        check your workspace, or <a href="${esc(appHref(appBaseUrl, "/contact"))}">contact support</a> and we
        will review it. Nothing has been deleted.</p>
      <p style="margin-top:1rem"><a href="${esc(appHref(appBaseUrl, "/"))}">← Back to rtfx.pro</a></p>
    </main>`;
  return layout("Unavailable", body, BRAND_STYLE);
}
