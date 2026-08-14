import type { Env } from "./env";
import { PLANS, limitsFor, usageFor, type PlanName, type PlanLimits, type QuotaLimit, type Usage } from "./quota";
import { checkoutUrl, type PaidPlan } from "./billing";

/**
 * The one place plan *copy* is assembled — price, display label, "what the
 * next plan up gives you" — for the landing page, Settings and the
 * quota-exceeded API response (issue: free-to-paid path).
 *
 * Deliberately separate from `src/quota.ts` (limits, the enforcement policy)
 * and `src/billing.ts` (Lemon Squeezy plumbing): this file turns those into
 * sentences and numbers a person reads, and it is the only file three very
 * different callers (a JSON error, a settings row, a marketing page) share,
 * so the numbers cannot drift between them.
 */

/** Display name for a plan, in the product's own voice — never "TEAM" or "pro". */
export const PLAN_LABEL: Record<PlanName, string> = { free: "Free", pro: "Pro", team: "Team" };

/**
 * Monthly price in whole dollars, or `null` for the plan that has none.
 * Not part of `PLANS` (src/quota.ts) because that table is limits — the thing
 * enforcement reads — and price is presentation only; keeping it here means a
 * change to what a plan *costs* never risks touching what a plan *allows*.
 */
export const PLAN_PRICE: Record<PlanName, number | null> = { free: null, pro: 12, team: 40 };

export function priceLabel(plan: PlanName): string {
  const price = PLAN_PRICE[plan];
  return price === null ? "Free" : `$${price}/mo`;
}

const PLAN_ORDER: readonly PlanName[] = ["free", "pro", "team"];

/**
 * The paid plan one step above `plan`, or `null` when there is nowhere left to
 * go (already `team`). An unrecognized plan value is treated as `free` — the
 * same fallback `limitsFor` uses — so a legacy or malformed value still gets a
 * sensible upgrade offer rather than none at all.
 */
export function nextPaidPlan(plan: string): PaidPlan | null {
  const idx = PLAN_ORDER.indexOf(plan as PlanName);
  const from = idx === -1 ? 0 : idx;
  const next = PLAN_ORDER[from + 1];
  return next === "pro" || next === "team" ? next : null;
}

/** One tier's worth of marketing copy, built from the real numbers in `PLANS` — never hand-typed. */
export interface PlanFeatures {
  name: PlanName;
  label: string;
  price: string;
  limits: PlanLimits;
}

export function planFeatures(name: PlanName): PlanFeatures {
  return { name, label: PLAN_LABEL[name], price: priceLabel(name), limits: PLANS[name] };
}

/** All three tiers, in the order they're sold — for the pricing section. */
export const ALL_PLANS: readonly PlanName[] = PLAN_ORDER;

// --- the public tier ladder --------------------------------------------------
//
// `PLANS` (src/quota.ts) is what enforcement reads, and Enterprise is not in it
// — deliberately. Enterprise is a conversation, not a row: there is no variant
// to buy, no limit table to enforce, and nothing about it is provisioned
// automatically. Modelling it as a `PlanName` would put a plan into the type
// that quota enforcement, billing and the seat table all have to pretend to
// understand. So the *public* ladder is its own type, and it is the only thing
// marketing surfaces iterate.

/** A tier as the public site sells it: the three billable plans plus Enterprise. */
export type PublicTier = PlanName | "enterprise";

/** The ladder, in the order it is sold. */
export const PUBLIC_TIERS: readonly PublicTier[] = [...PLAN_ORDER, "enterprise"];

export const TIER_LABEL: Record<PublicTier, string> = { ...PLAN_LABEL, enterprise: "Enterprise" };

/** True for a tier that has a limits row in `PLANS` — i.e. anything but Enterprise. */
export function isPlanName(tier: PublicTier): tier is PlanName {
  return tier !== "enterprise";
}

/**
 * How somebody actually starts on a tier **today** — not how we would like them
 * to. Two kinds, and the distinction is the whole point of this table:
 *
 *  - `self-serve` — they can complete it alone, right now, with no human in the
 *    loop. Free and Pro qualify: verify an email, and upgrade from Settings
 *    against a real hosted checkout (`checkoutUrl`, src/billing.ts).
 *  - `contact` — a person has to be involved. The button says so.
 *
 * **Team is `contact`, and that is not a pricing decision — it is an accuracy
 * one.** The Team *plan* is real and enforced (50 GB, 25 seats, roles), and the
 * checkout exists; what is missing is the part that makes a team plan usable
 * without us: `POST /api/workspace/:id/members` writes the membership row and
 * sends the invitee nothing at all (see src/members-routes.ts — there is no
 * mail call on that path). Somebody who bought Team alone would invite four
 * colleagues, none of whom would ever hear about it. So we set Team workspaces
 * up with the customer until invite mail ships, and the button says "Talk to
 * us" rather than implying a flow that would strand them.
 *
 * Enterprise is `contact` for the ordinary reason: nothing about it is
 * automated, and the page is careful to frame SSO/SCIM/SLAs as things to talk
 * to us about rather than things that exist. See `src/plan-pages.ts`.
 */
export type TierCta =
  | { kind: "self-serve"; href: string; label: string }
  | { kind: "contact"; href: string; label: string };

export function tierCta(tier: PublicTier): TierCta {
  switch (tier) {
    case "free":
      return { kind: "self-serve", href: "/signup", label: "Start free" };
    case "pro":
      return { kind: "self-serve", href: "/signup", label: "Start free, upgrade anytime" };
    case "team":
      return { kind: "contact", href: "/contact?plan=team", label: "Talk to us" };
    case "enterprise":
      return { kind: "contact", href: "/contact?plan=enterprise", label: "Talk to us" };
  }
}

/**
 * The tier's own page, or `null` for Free — which has no page of its own
 * because `/signup` already is one, and a second surface arguing for the plan
 * you get by default is a click in the way of the thing it argues for.
 */
export function tierPath(tier: PublicTier): string | null {
  return tier === "free" ? null : `/${tier}`;
}

/** Price as the pricing table shows it. Enterprise has no number to show. */
export function tierPrice(tier: PublicTier): string {
  return tier === "enterprise" ? "Talk to us" : priceLabel(tier);
}

/** The fraction of a limit usage has to reach before a near-limit warning fires. */
const WARNING_RATIO = 0.8;

export interface UsageWarningInfo {
  limit: QuotaLimit;
  /** usage / max for the limit being warned about, e.g. 0.83. */
  ratio: number;
  current: number;
  max: number;
}

/**
 * Which limit `usage` is close to (>= 80%) but has not necessarily crossed, or
 * `null` when both are comfortably under. Mirrors `exceeds` (src/quota.ts):
 * artifacts is checked first, so an account near both limits at once gets one
 * legible warning rather than two competing ones.
 *
 * Pure and D1-free on purpose, same reasoning as `exceeds` — the boundary is
 * exhaustively table-testable without a database.
 */
export function usageWarning(usage: Usage, limits: PlanLimits): UsageWarningInfo | null {
  const artifactsRatio = limits.maxArtifacts > 0 ? usage.artifacts / limits.maxArtifacts : 0;
  if (artifactsRatio >= WARNING_RATIO) {
    return { limit: "artifacts", ratio: artifactsRatio, current: usage.artifacts, max: limits.maxArtifacts };
  }
  const storageRatio = limits.maxStorageBytes > 0 ? usage.storageBytes / limits.maxStorageBytes : 0;
  if (storageRatio >= WARNING_RATIO) {
    return { limit: "storage", ratio: storageRatio, current: usage.storageBytes, max: limits.maxStorageBytes };
  }
  return null;
}

/** Hosted checkout links for each paid plan, or `null` where this deployment has no store/variant configured. */
export type CheckoutLinks = Record<PaidPlan, string | null>;

/** Everything a dashboard page needs to render plan status, usage and an upgrade path for one workspace. */
export interface WorkspaceBilling {
  /**
   * The EFFECTIVE plan — an operator override while one is live, otherwise
   * what billing says. Every number beside it (`limits`, `warning`, `nextPlan`)
   * is derived from this one, so a comped workspace sees the limits it actually
   * has rather than the ones its subscription pays for.
   */
  plan: string;
  limits: PlanLimits;
  usage: Usage;
  warning: UsageWarningInfo | null;
  nextPlan: PaidPlan | null;
  checkout: CheckoutLinks;
  /**
   * Set only when an operator override is making `plan` differ from the
   * subscription. Present so the dashboard can say *why* somebody is on a plan
   * they never bought — a Team-sized workspace with a Free invoice is
   * alarming until it is explained.
   */
  override?: { billedPlan: string; expiresAt: string | null };
}

/**
 * Assembles `WorkspaceBilling` for one account: current usage (a D1
 * aggregate — see `usageFor`), whether it's near either limit, and a real
 * checkout link for the next plan up (never hand-built — see `checkoutUrl`).
 *
 * Callers are expected to be per-request page renders (Settings, Overview),
 * so this does one `usageFor` query and two pure `checkoutUrl` calls — no
 * caching, matching how `usageFor` is already used at publish time.
 */
export async function workspaceBilling(
  env: Env,
  account: { id: string; plan: string },
  email: string
): Promise<WorkspaceBilling> {
  const limits = limitsFor(account.plan);
  const usage = await usageFor(env, account.id);
  return {
    plan: account.plan,
    limits,
    usage,
    warning: usageWarning(usage, limits),
    nextPlan: nextPaidPlan(account.plan),
    checkout: {
      pro: checkoutUrl(env, "pro", account, email),
      team: checkoutUrl(env, "team", account, email),
    },
  };
}
