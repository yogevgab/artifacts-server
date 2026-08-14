/**
 * Shown instead of an artifact's content when its owning account is over its
 * plan's monthly view limit (src/quota.ts, `blocksOnViewLimit`).
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

export function overViewLimitPage(slug?: string): string {
  const body = `${skipLink()}
    <header class="top">${brandLockup("/")}</header>
    <main class="empty" id="main" data-empty="over-limit">
      <h1>${
        slug
          ? `<span class="mono">/${esc(slug)}/</span> is temporarily unavailable`
          : "This page is temporarily unavailable"
      }</h1>
      <p>Its owner's plan has reached its monthly view limit. There is nothing wrong
        with the link — it will work again once the limit resets, or the owner
        upgrades their plan.</p>
      <p style="margin-top:1rem"><a href="/">← Back to rtfx.pro</a></p>
    </main>`;
  return layout("Temporarily unavailable", body, BRAND_STYLE);
}
