/**
 * Branded account addresses: `rtfx.pro/yogev/q3-board-report`.
 *
 * An artifact has always had one address — its slug on the content origin
 * (`a.rtfx.pro/q3-board-report/`). That address is correct, permanent and
 * completely anonymous: nothing in it says *who sent it*, which is exactly what
 * a consultant mailing a board report to a client wants it to say.
 *
 * A branded address adds a second, human one on the APP origin, made of two
 * parts that already exist: the workspace's public slug and the artifact's own
 * slug. It is a *link*, not a second copy of the content — the branded route
 * (src/index.ts) authorizes and then redirects to the content origin, so
 * uploaded HTML is still only ever served from the origin that hosts files and
 * nothing else. See docs/POSITIONING.md: this is emphatically NOT a custom
 * domain, and public copy must not let the two blur together.
 *
 * This module is deliberately pure — no D1, no `Env` — so every rule about what
 * a workspace may call itself is exhaustively table-testable. The reads and
 * writes live in src/accounts.ts.
 */

import { reservedTopLevelSegments } from "./host";
import { isValidSlug } from "./util";

/**
 * The shape of a workspace's public slug: 3–63 characters, lowercase
 * alphanumerics and hyphens, never starting or ending with a hyphen.
 *
 * Three characters minimum rather than one, because the one- and two-character
 * namespace is the scarce, contested part of a shared root path and giving it
 * away first-come-first-served on day one is not reversible. The 63 ceiling is
 * the DNS label length: if this ever *does* become a subdomain, the addresses
 * already handed out stay legal.
 */
export const ACCOUNT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export const MIN_ACCOUNT_SLUG_LENGTH = 3;
export const MAX_ACCOUNT_SLUG_LENGTH = 63;

/**
 * Names a workspace may never claim.
 *
 * The first source is the router itself — {@link reservedTopLevelSegments}
 * derives it from the same tables that decide which paths the app host answers,
 * so a route added to src/host.ts is protected here without anybody remembering
 * to. Claiming one would not merely be confusing: `/docs` is a real page, so
 * whoever held that slug would have a branded namespace nobody could reach.
 *
 * The second source is this list: words the product is likely to want as a
 * top-level path later, plus the handful that read as the operator when they
 * are not ("support", "admin", "billing", "security"). Handing those out is a
 * phishing surface, and taking one back from a paying customer afterwards is
 * worse than never having offered it.
 */
const EXTRA_RESERVED = [
  "about",
  "account",
  "accounts",
  "app",
  "assets",
  "billing",
  "blog",
  "cdn",
  "changelog",
  "chat",
  "checkout",
  "cli",
  "compare",
  "dashboard",
  "developer",
  "developers",
  "download",
  "downloads",
  "email",
  "explore",
  "faq",
  "favicon",
  "feed",
  "files",
  "help",
  "home",
  "img",
  "images",
  "integrations",
  "invite",
  "jobs",
  "legal",
  "llms",
  "logo",
  "logos",
  "mail",
  "me",
  "media",
  "members",
  "new",
  "news",
  "og",
  "operator",
  "org",
  "orgs",
  "people",
  "plans",
  "platform",
  "policy",
  "portal",
  "pricing",
  "public",
  "receipts",
  "robots",
  "root",
  "rtfx",
  "search",
  "security",
  "session",
  "settings",
  "setup",
  "share",
  "shares",
  "signin",
  "signout",
  "sitemap",
  "static",
  "status",
  "support",
  "system",
  "tokens",
  "upgrade",
  "upload",
  "user",
  "users",
  "webhook",
  "webhooks",
  "well-known",
  "workspace",
  "workspaces",
  "www",
] as const;

/** Every name a workspace slug may not be, lowercase. */
export const RESERVED_ACCOUNT_SLUGS: ReadonlySet<string> = new Set([
  ...reservedTopLevelSegments(),
  ...EXTRA_RESERVED,
]);

export function isReservedAccountSlug(slug: string): boolean {
  return RESERVED_ACCOUNT_SLUGS.has(slug);
}

/** Lowercase and trim a submitted slug. Does not validate it. */
export function normalizeAccountSlug(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** Turn any label into something slug-shaped, for the "suggested" address. */
export function suggestAccountSlug(raw: string): string {
  const base = raw
    .toLowerCase()
    .trim()
    // An email suggests a slug from its local part: "maya@example.com" → "maya".
    .split("@")[0]
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ACCOUNT_SLUG_LENGTH)
    .replace(/-+$/, "");
  return isAccountSlugShape(base) && !isReservedAccountSlug(base) ? base : "";
}

/** Shape only — says nothing about reservation or uniqueness. */
export function isAccountSlugShape(slug: string): boolean {
  return ACCOUNT_SLUG_RE.test(slug);
}

export type SlugRejection = "shape" | "reserved";

/** The message a person sees. One sentence, and it says what to do next. */
export const SLUG_REJECTION_DETAIL: Record<SlugRejection, string> = {
  shape:
    `a workspace address is ${MIN_ACCOUNT_SLUG_LENGTH}–${MAX_ACCOUNT_SLUG_LENGTH} characters, ` +
    "lowercase letters, numbers and hyphens, and cannot start or end with a hyphen",
  reserved: "that address is reserved for the product's own pages and cannot be claimed",
};

export type SlugCheck =
  | { ok: true; slug: string }
  | { ok: false; reason: SlugRejection; detail: string };

/**
 * Validate a submitted workspace address. Uniqueness is NOT checked here — that
 * is a database question, answered by `setAccountPublicSlug` in src/accounts.ts,
 * and keeping it out is what lets every rule in this file be tested as a table.
 */
export function checkAccountSlug(raw: unknown): SlugCheck {
  const slug = normalizeAccountSlug(raw);
  if (!isAccountSlugShape(slug)) {
    return { ok: false, reason: "shape", detail: SLUG_REJECTION_DETAIL.shape };
  }
  if (isReservedAccountSlug(slug)) {
    return { ok: false, reason: "reserved", detail: SLUG_REJECTION_DETAIL.reserved };
  }
  return { ok: true, slug };
}

// --- the branded path itself -------------------------------------------------

export interface BrandedPath {
  accountSlug: string;
  artifactSlug: string;
}

/**
 * Is this request path *shaped* like a branded artifact link, and if so, what
 * are its two halves?
 *
 * Shape only: this never touches the database, so it is safe to call on the hot
 * path before deciding whether a lookup is worth doing at all. Exactly two
 * segments, with one optional trailing slash — deliberately not deeper. On a
 * single-host deployment `/report/index.html` is a real artifact asset path, and
 * every extra segment this matched would be one more artifact URL that could be
 * mistaken for somebody's namespace. Relative assets never need to resolve here
 * anyway: the branded route redirects to the content origin, and everything the
 * page references loads from there.
 */
export function brandedPathParts(path: string): BrandedPath | null {
  if (!path.startsWith("/")) return null;
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const segments = trimmed.slice(1).split("/");
  if (segments.length !== 2) return null;
  let accountSlug: string;
  let artifactSlug: string;
  try {
    accountSlug = decodeURIComponent(segments[0]).toLowerCase();
    artifactSlug = decodeURIComponent(segments[1]);
  } catch {
    return null;
  }
  if (!isAccountSlugShape(accountSlug) || isReservedAccountSlug(accountSlug)) return null;
  // The second half has to be a slug somebody could actually have published.
  if (!isValidSlug(artifactSlug)) return null;
  return { accountSlug, artifactSlug };
}

/**
 * The branded URL for one artifact. Built here rather than assembled by a
 * caller for the same reason `artifactUrl` is (src/api.ts): a client that
 * guesses is right on rtfx.pro and wrong on every self-hosted instance.
 */
export function brandedArtifactUrl(appOrigin: string, accountSlug: string, artifactSlug: string): string {
  return `${appOrigin.replace(/\/+$/, "")}/${encodeURIComponent(accountSlug)}/${encodeURIComponent(artifactSlug)}`;
}

// --- plan gate ---------------------------------------------------------------

/**
 * Plans that may claim a branded address. Free deliberately cannot: the shared
 * root path is a finite namespace, and an open signup that hands out `/maya`
 * for nothing exhausts it in a week.
 *
 * `enterprise` is here even though it is not a key in `PLANS` (src/quota.ts) —
 * it is reachable today only as an operator `plan_override`, and an account an
 * operator has explicitly put above Team must not have fewer rights than Team.
 */
const BRANDED_SLUG_PLANS: ReadonlySet<string> = new Set(["pro", "team", "enterprise"]);

/** May an account on this (effective) plan claim a branded address? */
export function planAllowsBrandedSlug(plan: string): boolean {
  return BRANDED_SLUG_PLANS.has(plan);
}

export const PLAN_REQUIRED_DETAIL =
  "a workspace address is a Pro feature — upgrade at /pro to claim one. " +
  "Every artifact keeps its existing URL either way.";
