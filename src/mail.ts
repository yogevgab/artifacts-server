/**
 * Transactional email over the Cloudflare Email Sending binding.
 *
 * The module exists mostly to make failures legible. A send that fails silently
 * is the worst outcome for a sign-in system: the person waiting for a code has
 * no way to tell "we never sent it" from "your mail provider ate it", and
 * neither does an operator reading logs after the fact.
 */

import type { Env } from "./env";

/**
 * How a failed send should be handled. The distinction is the whole point of
 * this module: a suppressed recipient and a rate limit look identical at the
 * call site, but retrying one is correct and retrying the other is pointless.
 */
export type MailFailureClass = "config" | "recipient" | "transient";

/** Sender/domain problems — an operator must fix these; they are an outage. */
const CONFIG_CODES = new Set([
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
]);

/** The recipient cannot receive this message. Retrying changes nothing. */
const RECIPIENT_CODES = new Set([
  "E_RECIPIENT_SUPPRESSED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_CONTENT_TOO_LARGE",
]);

/**
 * Unknown codes fall through to "transient" on purpose. If Cloudflare adds a
 * code we have never seen, retrying it briefly is a smaller mistake than
 * permanently writing off somebody's address.
 */
export function classifyMailError(code: string | undefined): MailFailureClass {
  if (code && CONFIG_CODES.has(code)) return "config";
  if (code && RECIPIENT_CODES.has(code)) return "recipient";
  return "transient";
}

export function isRetryable(code: string | undefined): boolean {
  return classifyMailError(code) === "transient";
}

/** What a message was for. Used to read the log by purpose. */
export type MailKind = "signin" | "magic_link" | "share_notice";

/**
 * Record a delivery outcome. Best-effort, exactly like `api_tokens.last_used_at`
 * — a logging failure must never turn a successful send into an error.
 */
export async function recordMail(
  env: Env,
  entry: {
    email: string;
    kind: MailKind;
    status: "sent" | "failed";
    errorCode?: string;
    now: string;
  }
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO mail_log (email, kind, status, error_code, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        entry.email.trim().toLowerCase(),
        entry.kind,
        entry.status,
        entry.errorCode ?? null,
        entry.now
      )
      .run();
  } catch {
    // Best-effort by design.
  }
}
