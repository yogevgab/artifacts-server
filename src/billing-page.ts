import { esc } from "./pages";
import {
  portalShell,
  statTile,
  num,
  bytes,
  plural,
  people,
  workspaceLabel,
  type PortalViewer,
} from "./portal";
import { accountRoleLabel, type AccountRole, type AccountRow } from "./accounts";
import {
  PLAN_LABEL,
  PUBLIC_TIERS,
  TIER_LABEL,
  isPlanName,
  tierCta,
  tierPath,
  tierPrice,
  type PublicTier,
  type WorkspaceBilling,
} from "./plan-copy";
import { PLANS, type PlanName, type ViewLimitStatus } from "./quota";

/**
 * `/admin/billing` — the customer's own view of what this workspace is on, what
 * it is using, and what changing it would actually take.
 *
 * The rule this page is written under: **every control on it must do what it
 * says**. rtfx stores no Lemon Squeezy customer id, subscription id or portal
 * URL — `billing_events` holds a delivery digest, an event name, an account id
 * and a timestamp, and nothing else — so there is nothing here that could open
 * a subscription-management portal, list invoices, or cancel a plan. Rather
 * than render three buttons that would 404 or, worse, silently do nothing, the
 * page names those three gaps and points at the one route that does work today
 * (`/contact`). A billing page that lies is worse than one that is small.
 *
 * What it *does* do for real:
 *  - states the EFFECTIVE plan (`effectivePlan`, src/accounts.ts) — and, when an
 *    operator override makes that differ from the subscription, says so and
 *    names the billed plan, because a Team-sized workspace with a Free invoice
 *    is alarming until it is explained;
 *  - counts usage against the limits enforcement actually reads (`PLANS`,
 *    src/quota.ts) — artifacts, storage, seats and this month's views;
 *  - offers the hosted Pro checkout where this deployment has one configured
 *    (`checkoutUrl`, src/billing.ts) and a contact link where the tier is sold
 *    by a person (Team, Enterprise — see `tierCta` in src/plan-copy.ts);
 *  - spells out what a downgrade or an over-limit state does, because "nothing
 *    is deleted" is only true if you also say what *is* refused.
 */

// --- input -------------------------------------------------------------------

export interface BillingPageInput {
  viewer: PortalViewer;
  /** The workspace this page is about: the one the request is acting in. */
  account: AccountRow;
  /** The viewer's ACCOUNT role here. Decides whether they can act, not what they see. */
  role: AccountRole;
  /** Plan, limits, usage and checkout links — see `workspaceBilling`. */
  billing: WorkspaceBilling;
  /** How many people hold a seat in this workspace right now. */
  members: number;
  /**
   * This month's views against the plan's cap, or `null` when there is nothing
   * to report (`viewLimitStatus` returns null for a database that predates the
   * accounts tables). Absent means the row is simply not on the page — never
   * that the count is zero.
   */
  views: ViewLimitStatus | null;
}

// --- small helpers ------------------------------------------------------------

/** The label a plan value goes by, falling back to the raw value for a legacy one. */
function planLabelOf(plan: string): string {
  return PLAN_LABEL[plan as PlanName] ?? plan;
}

/** A date as this page says it — the day, not the millisecond. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The price beside a tier's name. `tierPrice` renders Free as the word "Free",
 * which reads as "Free · Free" once the tier's own label is in front of it.
 */
function tierPriceLabel(tier: PublicTier): string {
  return tier === "free" ? "No charge" : tierPrice(tier);
}

/**
 * One usage line: the numbers in text first, then a decorative bar.
 *
 * The bar is `aria-hidden` and carries no information the sentence does not
 * already state, which is the rule the near-limit banner follows too — nothing
 * in this product may signal by colour or width alone (docs/DESIGN.md §4).
 */
function usageRow(
  key: string,
  label: string,
  used: number,
  max: number,
  render: (n: number) => string,
  hint: string
): string {
  const ratio = max > 0 ? Math.min(used / max, 1) : 0;
  const over = used > max;
  return `<div class="row bill-usage" data-usage="${esc(key)}" data-usage-state="${over ? "over" : "ok"}">
    <div class="info">
      <b>${esc(label)}</b>
      <span class="hint" data-usage-text>${esc(render(used))} of ${esc(render(max))} &middot; ${hint}</span>
      <span class="bill-meter" aria-hidden="true"><span class="bill-meter-fill${
        over ? " is-over" : ""
      }" style="width:${(ratio * 100).toFixed(1)}%"></span></span>
    </div>
    <div class="row-actions"><span class="badge${over ? " is-warn" : ""}" data-usage-value="${esc(key)}">${esc(
      render(used)
    )} / ${esc(render(max))}</span></div>
  </div>`;
}

// --- panels -------------------------------------------------------------------

/**
 * Which workspace this is, who the viewer is in it, and what it is on.
 *
 * The billed-plan row appears only under a live operator override. It is the
 * honest half of a comp: the customer is told what they are entitled to *and*
 * what their subscription says, so neither number is a surprise later.
 */
function workspacePanel(input: BillingPageInput): string {
  const { account, billing, viewer } = input;
  const suspended = account.status === "suspended";
  const override = billing.override;
  // A personal workspace is named after its owner's email, which the header
  // already prints — see `workspaceLabel`. Saying "Everyone in you@example.com
  // shares these limits" is both odd and redundant.
  const label = workspaceLabel(account, viewer.email);

  const operatorRow =
    viewer.role === "super_admin"
      ? `<div class="row" data-setting="operator-link">
      <div class="info"><b>Operator view</b><span class="hint">You are a platform operator, so you can
        also see this workspace's control-plane page — overrides, suspension and the audit trail.
        Nobody else in the workspace is shown this link.</span></div>
      <div class="row-actions"><a class="ghost link-button small-link"
        href="/admin/platform/accounts/${esc(account.id)}" data-operator-account="${esc(
          account.id
        )}">Open in Platform &rarr;</a></div>
    </div>`
      : "";

  return `<section class="panel" data-panel="billing-workspace" aria-labelledby="billing-workspace-h">
    <div class="panel-head"><div>
      <h2 id="billing-workspace-h">This workspace</h2>
      <p class="hint">A plan belongs to a workspace, not to a person. Everyone in
        ${esc(label)} shares these limits, and switching workspaces in the header changes which one
        this page is about.</p>
    </div></div>
    <div class="row" data-setting="workspace-name">
      <div class="info"><b>Workspace</b><span class="hint">${
        account.kind === "personal"
          ? "Your own workspace — created automatically, nobody else is in it."
          : "A shared workspace. Artifacts and seats belong to it, not to you personally."
      }</span></div>
      <div class="row-actions"><span class="mono" data-billing-workspace="${esc(
        account.id
      )}">${esc(account.name)}</span></div>
    </div>
    <div class="row" data-setting="workspace-role">
      <div class="info"><b>Your role here</b><span class="hint">${
        input.role === "owner" || input.role === "admin"
          ? "You can change this workspace's plan and manage its members."
          : "You can see the plan and what it allows. Changing it is the owner's to do."
      }</span></div>
      <div class="row-actions"><span class="badge is-role" data-badge="workspace-role">${esc(
        accountRoleLabel(input.role)
      )}</span></div>
    </div>
    <div class="row" data-setting="workspace-status">
      <div class="info"><b>Status</b><span class="hint">${
        suspended
          ? "This workspace is suspended: its artifacts do not serve, and nothing new can be published. Contact us to sort it out."
          : "Serving normally. Artifacts are reachable and publishing is open."
      }</span></div>
      <div class="row-actions"><span class="badge is-${
        suspended ? "disabled" : "active"
      }" data-badge="workspace-status">${suspended ? "Suspended" : "Active"}</span></div>
    </div>
    <div class="row" data-setting="current-plan">
      <div class="info"><b>Plan</b><span class="hint">${
        override
          ? "What this workspace is entitled to right now. It is not what the subscription says — see below."
          : "What this workspace is entitled to, and what every limit below is measured against."
      }</span></div>
      <div class="row-actions">
        <span class="badge is-open" data-badge="effective-plan">${esc(planLabelOf(billing.plan))}</span>
        ${
          isPlanName(billing.plan as PublicTier)
            ? `<span class="hint" data-plan-price>${esc(tierPrice(billing.plan as PublicTier))}</span>`
            : ""
        }
      </div>
    </div>
    ${
      override
        ? `<div class="row" data-setting="billed-plan">
      <div class="info"><b>Billed plan</b><span class="hint">Your subscription is on
        <b>${esc(planLabelOf(override.billedPlan))}</b>. We have put this workspace on
        <b>${esc(planLabelOf(billing.plan))}</b> ${
          override.expiresAt
            ? `until <b>${esc(day(override.expiresAt))}</b>, after which it returns to
               ${esc(planLabelOf(override.billedPlan))}`
            : `until we remove that, with no end date set`
        }. You are charged for ${esc(
          planLabelOf(override.billedPlan)
        )} and you get ${esc(planLabelOf(billing.plan))}'s limits.</span></div>
      <div class="row-actions"><span class="badge" data-badge="billed-plan">${esc(
        planLabelOf(override.billedPlan)
      )}</span></div>
    </div>`
        : ""
    }
    ${operatorRow}
  </section>`;
}

/** Usage against the limits enforcement actually reads. */
function usagePanel(input: BillingPageInput): string {
  const { billing, members, views } = input;
  const limits = billing.limits;
  const left = (used: number, max: number) => Math.max(max - used, 0);

  const viewsRow = views
    ? usageRow(
        "views",
        "Views this month",
        views.views,
        views.limit,
        num,
        views.overLimit
          ? "over the cap — visitors see an over-limit page until the month resets"
          : "counted per calendar month, across every artifact in this workspace"
      )
    : "";

  return `<section class="panel" data-panel="billing-usage" aria-labelledby="billing-usage-h">
    <div class="panel-head"><div>
      <h2 id="billing-usage-h">Usage</h2>
      <p class="hint">The same numbers enforcement reads. Storage counts every version ever
        published, not just the live one, which is why republishing a large page moves it.</p>
    </div></div>
    ${usageRow(
      "artifacts",
      "Artifacts",
      billing.usage.artifacts,
      limits.maxArtifacts,
      num,
      `${num(left(billing.usage.artifacts, limits.maxArtifacts))} left on ${esc(
        planLabelOf(billing.plan)
      )}`
    )}
    ${usageRow(
      "storage",
      "Storage",
      billing.usage.storageBytes,
      limits.maxStorageBytes,
      bytes,
      "every version of every artifact in this workspace"
    )}
    ${viewsRow}
    ${usageRow(
      "seats",
      "Seats",
      members,
      limits.maxSeats,
      num,
      `${people(members)} in this workspace`
    )}
  </section>`;
}

/**
 * The one panel with real buttons on it, and every one of them goes somewhere
 * that works: a hosted Lemon Squeezy checkout where this deployment has the
 * variant configured, and `/contact` where the tier is sold by a person.
 *
 * Team is a contact link rather than a checkout even though the variant exists
 * — see the long note on `tierCta` (src/plan-copy.ts): member invites send no
 * mail yet, so somebody who bought Team alone would strand every colleague they
 * added. Enterprise has nothing to buy at all.
 */
function changePlanPanel(input: BillingPageInput): string {
  const { billing } = input;
  const current = billing.plan;

  const rows = PUBLIC_TIERS.map((tier) => {
    const isCurrent = tier === current;
    const cta = tierCta(tier);
    const page = tierPath(tier);

    let action: string;
    if (isCurrent) {
      action = `<span class="badge is-active" data-tier-current="${esc(tier)}">Current plan</span>`;
    } else if (tier === "free") {
      // There is no self-serve downgrade: nothing in this deployment can cancel
      // a subscription, so a "Downgrade" button would be a button that does
      // nothing. Say who to ask instead.
      action = `<a class="ghost link-button small-link" href="/contact?plan=free"
        data-contact="free">Ask us to downgrade &rarr;</a>`;
    } else if (tier === "pro") {
      const url = billing.checkout.pro;
      action = url
        ? `<a class="ghost link-button small-link" href="${esc(url)}" data-checkout="pro">Upgrade to Pro &rarr;</a>`
        : `<span class="hint" data-checkout-unavailable="pro">Checkout isn't configured on this
             deployment — <a href="/contact?plan=pro">talk to us</a> and we'll set it up.</span>`;
    } else {
      action = `<a class="ghost link-button small-link" href="${esc(cta.href)}" data-contact="${esc(
        tier
      )}">${esc(cta.label)} &rarr;</a>`;
    }

    // Straight out of `PLANS` — the table enforcement reads — so a tier can
    // never advertise a limit the publish route would not actually honour.
    const blurb = isPlanName(tier)
      ? `${num(PLANS[tier].maxArtifacts)} artifacts &middot; ${bytes(
          PLANS[tier].maxStorageBytes
        )} &middot; ${plural(PLANS[tier].maxSeats, "seat")}`
      : "SSO, custom terms and a contract — all of it a conversation, none of it self-serve.";

    return `<div class="row" data-tier="${esc(tier)}" data-tier-state="${
      isCurrent ? "current" : "available"
    }">
      <div class="info"><b>${esc(TIER_LABEL[tier])} &middot; ${esc(tierPriceLabel(tier))}</b>
        <span class="hint">${blurb}${
          page ? ` <a href="${esc(page)}" data-tier-page="${esc(tier)}">What's in it &rarr;</a>` : ""
        }</span></div>
      <div class="row-actions">${action}</div>
    </div>`;
  }).join("");

  return `<section class="panel" data-panel="billing-change-plan" aria-labelledby="billing-plans-h">
    <div class="panel-head"><div>
      <h2 id="billing-plans-h">Change plan</h2>
      <p class="hint">Pro is the only tier you can buy without us. Team and Enterprise are set up
        with a person on our side — that is a limitation of what has shipped, not a sales tactic:
        adding a member sends no invitation email yet, so a team bought unattended would strand
        everybody it invited.</p>
    </div></div>
    ${rows}
  </section>`;
}

/**
 * Managing an existing subscription: the honest list of what this page cannot
 * do yet, and the route that can.
 *
 * Deliberately rendered as locked rows rather than as buttons — see the module
 * note. `billing_events` stores no customer id, no subscription id and no
 * portal URL, so there is no link to build, and building a plausible-looking
 * one would be the single worst thing this page could do.
 */
function subscriptionPanel(input: BillingPageInput): string {
  const paid = input.billing.plan !== "free";
  const row = (key: string, label: string, hint: string) =>
    `<div class="row" data-unavailable="${esc(key)}">
      <div class="info"><b>${esc(label)}</b><span class="hint">${hint}</span></div>
      <div class="row-actions">
        <span class="badge is-locked" data-badge="unavailable">Not self-serve yet</span>
        <a class="small-link" href="/contact?plan=${esc(
          input.billing.plan
        )}" data-contact-support="${esc(key)}">Email us &rarr;</a>
      </div>
    </div>`;

  return `<section class="panel" data-panel="billing-subscription" aria-labelledby="billing-sub-h">
    <div class="panel-head"><div>
      <h2 id="billing-sub-h">Managing your subscription</h2>
      <p class="hint">Three things you would expect here and will not find, listed so you know they
        are missing rather than hidden. rtfx does not store a payment-provider customer or
        subscription id, so there is no portal we could send you to${
          paid ? "" : " — and on Free there is no subscription to manage in the first place"
        }. Ask us and a person will do it.</p>
    </div></div>
    ${row(
      "invoices",
      "Invoices and receipts",
      "Not listed here. Ask us for a copy and we'll send it."
    )}
    ${row(
      "payment-method",
      "Payment method",
      "Changing the card on file is not something this page can do."
    )}
    ${row(
      "cancel",
      "Cancel or downgrade",
      `No button here does it. Cancelling takes effect at the end of the period you have already
       paid for — you keep the plan you bought until then, and the workspace drops to Free
       afterwards. Nothing you published is deleted at any point.`
    )}
  </section>`;
}

/**
 * What actually happens when a plan changes or a limit is crossed.
 *
 * Every sentence here is checked against the code that enforces it: publish
 * refusal (`exceeds` in src/quota.ts, the 413 in src/api.ts), the seat refusal
 * (`seatLimitDenial`, src/members.ts), the over-limit page
 * (`blocksOnViewLimit`, src/quota.ts) and version retention
 * (`versionsToExpire` + `applyRetention`, src/db.ts). The retention row exists
 * because "nothing is deleted" would otherwise be a lie on Free — that plan
 * keeps a bounded number of versions, and pretending otherwise is how somebody
 * loses bytes they were told were safe.
 */
function policyPanel(input: BillingPageInput): string {
  const keep = input.billing.limits.keepVersions;
  const retention =
    keep === null
      ? `On ${esc(
          planLabelOf(input.billing.plan)
        )} every version you publish is kept, however many there are.`
      : `On ${esc(planLabelOf(input.billing.plan))} the most recent ${esc(
          plural(keep, "version")
        )} of each artifact are kept. Older ones are expired the next time you publish to that same
         artifact — never on a schedule, and never the version that is currently live. Moving to a
         paid plan stops that happening; it cannot bring back bytes already expired.`;

  const row = (key: string, label: string, hint: string) =>
    `<div class="row" data-policy="${esc(key)}">
      <div class="info"><b>${esc(label)}</b><span class="hint">${hint}</span></div>
    </div>`;

  return `<section class="panel" data-panel="billing-policy" aria-labelledby="billing-policy-h">
    <div class="panel-head"><div>
      <h2 id="billing-policy-h">If you downgrade, or go over a limit</h2>
      <p class="hint">Going over a limit stops you adding <i>more</i>. It never removes what is
        already there, and it never takes an artifact off the internet.</p>
    </div></div>
    ${row(
      "no-deletion",
      "Nothing is deleted when your plan changes",
      `Dropping to a smaller plan does not remove artifacts, versions or members. A workspace over
       its new plan's limits simply sits over them until you are back under.`
    )}
    ${row(
      "publishes",
      "New publishes are refused while you are over",
      `Past the artifact or storage limit, publishing answers <code class="mono">quota_exceeded</code>
       and says which limit you hit. Everything already published keeps serving exactly as before.`
    )}
    ${row(
      "invites",
      "New members are refused while you are over seats",
      `Past the seat limit, adding somebody is refused and names the plan that would raise it.
       People already in the workspace keep their access — nobody is removed to fit.`
    )}
    ${row(
      "views",
      "Over the monthly view cap, visitors see an over-limit page",
      `For the rest of the calendar month, artifact URLs answer with a page explaining the limit
       instead of the content. You and platform admins still reach your own artifacts, so you can
       do something about it. The count resets on the 1st.`
    )}
    ${row("retention", "Version history", retention)}
  </section>`;
}

// --- page ---------------------------------------------------------------------

const BILLING_STYLE = `
a.ghost.link-button.small-link{padding:.42rem .85rem;font-size:.82rem}
a.small-link{font-size:.82rem}
.bill-usage .info{display:grid;gap:.3rem}
.bill-meter{display:block;height:5px;border-radius:999px;background:rgba(255,255,255,.08);
  overflow:hidden;max-width:22rem;margin-top:.15rem}
.bill-meter-fill{display:block;height:100%;background:var(--accent);border-radius:999px}
.bill-meter-fill.is-over{background:var(--danger)}
.bill-usage .row-actions .badge{font-variant-numeric:tabular-nums}
[data-panel="billing-policy"] .row{align-items:flex-start}
[data-panel="billing-policy"] .info{max-width:52rem}
`;

export function billingPage(input: BillingPageInput): string {
  const { billing, account, members, views } = input;
  const tiles = `<section class="stats" aria-label="Plan and usage at a glance">
    ${statTile(
      "billing-plan",
      "Plan",
      planLabelOf(billing.plan),
      billing.override
        ? `billed as ${planLabelOf(billing.override.billedPlan)}`
        : isPlanName(billing.plan as PublicTier)
          ? tierPrice(billing.plan as PublicTier)
          : "current plan"
    )}
    ${statTile(
      "billing-artifacts",
      "Artifacts",
      `${num(billing.usage.artifacts)} / ${num(billing.limits.maxArtifacts)}`,
      "published in this workspace"
    )}
    ${statTile(
      "billing-storage",
      "Storage",
      bytes(billing.usage.storageBytes),
      `of ${bytes(billing.limits.maxStorageBytes)}`
    )}
    ${statTile(
      "billing-seats",
      "Seats",
      `${num(members)} / ${num(billing.limits.maxSeats)}`,
      views ? `${num(views.views)} views this month` : "people in this workspace"
    )}
  </section>`;

  return portalShell({
    viewer: input.viewer,
    section: "billing",
    title: `Billing · ${account.name}`,
    heading: "Billing",
    lede: `What <b>${esc(account.name)}</b> is on, what it is using, and what changing it takes.
      A plan belongs to the workspace, so these numbers are the same for everyone in it.`,
    body: `${tiles}${workspacePanel(input)}${usagePanel(input)}${changePlanPanel(
      input
    )}${subscriptionPanel(input)}${policyPanel(input)}`,
    style: BILLING_STYLE,
  });
}
