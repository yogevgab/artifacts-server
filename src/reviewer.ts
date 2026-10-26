/**
 * Directory-reviewer sign-in.
 *
 * Connector directories need a test account, and a reviewer cannot receive our
 * email. When BOTH `REVIEWER_EMAIL` and `REVIEWER_CODE` are configured, that one
 * address signs in with a fixed 6-digit code instead of an emailed one.
 *
 * It is deliberately a narrow exception to the normal flow, not a parallel one:
 * the challenge is created, rate limited and attempt-counted exactly as for
 * anyone (so brute force stays bounded by MAX_ATTEMPTS per challenge and the
 * hourly START limits), no mail and no magic link exist, and the account is an
 * ordinary member. Feature off => nothing here changes behaviour.
 */

import type { Env } from "./env";
import { adminEmails, superAdminEmails } from "./users";

export interface ReviewerConfig {
  email: string;
  code: string;
}

/** The active reviewer config, or null when the feature is off or unsafe. */
export function reviewerConfig(env: Env): ReviewerConfig | null {
  const email = (env.REVIEWER_EMAIL ?? "").trim().toLowerCase();
  const code = (env.REVIEWER_CODE ?? "").trim();
  if (!email || !code) return null;
  if (!/^\d{6}$/.test(code)) {
    console.warn(JSON.stringify({ event: "reviewer_signin_disabled", reason: "bad_code_format" }));
    return null;
  }
  if (adminEmails(env).includes(email) || superAdminEmails(env).includes(email)) {
    console.warn(JSON.stringify({ event: "reviewer_signin_disabled", reason: "reviewer_is_admin" }));
    return null;
  }
  return { email, code };
}

/** Constant-time string equality (length is public: always 6). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
