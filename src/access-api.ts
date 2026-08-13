import type { Env } from "./env";
import { privilegedEmails } from "./users";

/** Thrown when Cloudflare user-management config/secret is absent (e.g. dev). */
export class AccessNotConfiguredError extends Error {}
/** Thrown when the Cloudflare API call fails. */
export class AccessApiError extends Error {}

/** Admins and super admins — the emails that must always be able to sign in. */
function adminEmails(env: Env): string[] {
  return privilegedEmails(env);
}

/**
 * The list that should always be present in the policy = the requested emails
 * plus every admin and super-admin email (so an operator can never be removed /
 * locked out). Deduped, lowercased, sorted.
 */
export function mergeAdmins(env: Env, emails: string[]): string[] {
  const set = new Set<string>(adminEmails(env));
  for (const e of emails) {
    const v = e.trim().toLowerCase();
    if (v) set.add(v);
  }
  return [...set].sort();
}

function config(env: Env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.ACCESS_VIEWER_APP_ID || !env.ACCESS_VIEWER_POLICY_ID) {
    throw new AccessNotConfiguredError("Cloudflare user management is not configured");
  }
  return {
    token: env.CF_API_TOKEN,
    url: `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/apps/${env.ACCESS_VIEWER_APP_ID}/policies/${env.ACCESS_VIEWER_POLICY_ID}`,
  };
}

interface Policy {
  name: string;
  decision: string;
  include: Array<{ email?: { email: string } }>;
  // Preserve any other policy fields (require, exclude, precedence,
  // session_duration, mfa_config, approval…) across a round-trip.
  [key: string]: unknown;
}

// Read-only fields Cloudflare rejects/ignores on PUT.
const READONLY_POLICY_FIELDS = ["id", "uid", "created_at", "updated_at"];

/**
 * Build the PUT body from the current policy, overriding ONLY the email include
 * list. Everything else (require, exclude, precedence, session_duration, …) is
 * preserved so user edits never silently weaken the login policy.
 */
export function policyWithEmails(
  current: Record<string, unknown>,
  emails: string[]
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(current)) {
    if (!READONLY_POLICY_FIELDS.includes(k)) body[k] = v;
  }
  body.decision = (current.decision as string) || "allow";
  body.include = emails.map((email) => ({ email: { email } }));
  return body;
}

async function callCf(env: Env, method: "GET" | "PUT", body?: unknown): Promise<Policy> {
  const { token, url } = config(env);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => null)) as { success?: boolean; result?: Policy; errors?: unknown } | null;
  if (!data?.success || !data.result) {
    throw new AccessApiError(`Cloudflare API ${method} failed: ${JSON.stringify(data?.errors ?? res.status)}`);
  }
  return data.result;
}

function emailsFrom(policy: Policy): string[] {
  return (policy.include ?? [])
    .map((r) => r.email?.email?.toLowerCase())
    .filter((e): e is string => !!e)
    .sort();
}

/** Read the current login allow-list (emails in the viewer policy). */
export async function getAllowlist(env: Env): Promise<string[]> {
  return emailsFrom(await callCf(env, "GET"));
}

/** Set the allow-list to exactly `emails` (+ admins). Returns the new list. */
export async function setAllowlist(env: Env, emails: string[]): Promise<string[]> {
  // Read-modify-write. This is a last-write-wins update with no compare-and-swap
  // (the CF policy API exposes no ETag); acceptable for this admin-only, low-
  // concurrency tool.
  const current = await callCf(env, "GET");
  const merged = mergeAdmins(env, emails);
  const updated = await callCf(env, "PUT", policyWithEmails(current as Record<string, unknown>, merged));
  return emailsFrom(updated);
}

/** Add emails to the allow-list. Returns the new list. */
export async function addUsers(env: Env, emails: string[]): Promise<string[]> {
  const current = await getAllowlist(env);
  return setAllowlist(env, [...current, ...emails]);
}

/**
 * Remove one email. Refuses to remove an admin or super admin — the same
 * invariant `mergeAdmins` enforces, checked up front so the caller gets a clear
 * error instead of a silent no-op round-trip.
 */
export async function removeUser(env: Env, email: string): Promise<string[]> {
  const target = email.trim().toLowerCase();
  if (adminEmails(env).includes(target)) {
    throw new AccessApiError("cannot remove an admin from the allow-list");
  }
  const current = await getAllowlist(env);
  return setAllowlist(env, current.filter((e) => e !== target));
}

export function isConfigured(env: Env): boolean {
  return !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.ACCESS_VIEWER_APP_ID && env.ACCESS_VIEWER_POLICY_ID);
}

/**
 * What we can see of the Cloudflare Access allow-list right now, as three
 * distinct states rather than a throw. The distinction matters to the person
 * reading the Users panel: "not wired up yet" is a setup task, "we couldn't
 * reach Cloudflare" is an incident, and neither should look like "nobody has
 * access".
 */
export interface AllowlistView {
  /** False when the CF_* / ACCESS_* configuration is absent (e.g. local dev). */
  configured: boolean;
  /** The allow-listed emails, or null when unreadable. */
  emails: string[] | null;
  /** Why the read failed, when it did. */
  error: string | null;
}

/** Read the allow-list without throwing. Shared by the JSON API and the dashboard. */
export async function allowlistView(env: Env): Promise<AllowlistView> {
  if (!isConfigured(env)) return { configured: false, emails: null, error: null };
  try {
    return { configured: true, emails: await getAllowlist(env), error: null };
  } catch (e) {
    return { configured: true, emails: null, error: (e as Error).message };
  }
}
