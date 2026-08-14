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
  plan: string;
  limits: PlanLimits;
  usage: Usage;
  warning: UsageWarningInfo | null;
  nextPlan: PaidPlan | null;
  checkout: CheckoutLinks;
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
