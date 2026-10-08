/**
 * Read receipts: the first time a person a document was shared with opens
 * it, tell the owner. This answers exactly the question an owner dashboard
 * exists for — "did they see it yet" — as it happens, instead of making them
 * go look.
 *
 * Scoped narrowly on purpose:
 *  - never for the owner's own view (they already know they opened it);
 *  - never for an anonymous or share-link view — there is no person to name.
 *    A share-link open IS logged (migration 0023) but through `logView`
 *    directly (src/index.ts `logLinkEvent`), never through this function, so
 *    it cannot trigger a mail. The `viewerEmail` guard below exists anyway, so
 *    this module has no silent dependency on that upstream behaviour;
 *  - only once per (artifact, person) — decided by checking history
 *    *before* the new view is recorded, not after;
 *  - only when the owner has not turned it off (`artifacts.read_receipts`).
 *
 * Delivery goes through `sendMail`, which never throws: a failed or
 * misconfigured send can never turn a successful page view into an error.
 * `recordViewAndMaybeNotify` is a drop-in replacement for calling `logView`
 * directly — same inputs plus the artifact row the call site already has in
 * hand, same single promise to await inline or hand to `ctx.waitUntil` — so
 * wiring it in is a one-line swap, and the non-blocking behaviour the
 * existing view-logging call site already has (see the `ctx.waitUntil` next
 * to `logView` in src/index.ts) covers this too: the mail send rides on the
 * exact same background promise as the view log it follows.
 */
import type { ArtifactRow, Env, ViewRow } from "./env";
import { hasViewed, logView, readReceiptsEnabled } from "./db";
import { sendMail } from "./mail";
import { viewNoticeMail } from "./mail-templates";
import { siteOrigin } from "./seo";

function ownerDashboardUrl(env: Env, slug: string): string {
  const origin = env.PUBLIC_BASE_URL || siteOrigin(env);
  return `${origin}/admin/artifacts/${encodeURIComponent(slug)}`;
}

/**
 * Log one view and, if this is the first time this person has opened this
 * artifact, tell its owner.
 *
 * Integration point: at the artifact-serving call site (src/index.ts, next to
 * the existing `logView(c.env, {...})` call), replace that call with
 * `recordViewAndMaybeNotify(c.env, {...}, art)` — same view object, same
 * `art` already in scope — and leave the surrounding `ctx.waitUntil(p)` /
 * `await p` handling untouched.
 */
export async function recordViewAndMaybeNotify(
  env: Env,
  view: ViewRow,
  artifact: ArtifactRow
): Promise<void> {
  const viewerEmail = view.email?.trim().toLowerCase() || null;

  // Must run before the insert below: once this view is logged it is
  // indistinguishable from any other row, so "is this their first view"
  // can only be answered by looking at history that predates it.
  const firstView = viewerEmail ? !(await hasViewed(env, view.slug, viewerEmail)) : false;

  await logView(env, view);

  if (!viewerEmail || !firstView) return;
  if (!readReceiptsEnabled(artifact)) return;

  const owner = artifact.owner_email?.trim().toLowerCase();
  if (!owner || owner === viewerEmail) return;

  await sendMail(env, {
    to: owner,
    kind: "view_notice",
    message: viewNoticeMail({
      viewerEmail,
      title: artifact.title || artifact.slug,
      dashboardUrl: ownerDashboardUrl(env, artifact.slug),
    }),
    now: view.viewed_at,
  });
}
