/**
 * Transactional email over the Cloudflare Email Sending binding.
 *
 * The module exists mostly to make failures legible. A send that fails silently
 * is the worst outcome for a sign-in system: the person waiting for a code has
 * no way to tell "we never sent it" from "your mail provider ate it", and
 * neither does an operator reading logs after the fact.
 */

import type { Env } from "./env";
import type { RenderedMail } from "./mail-templates";

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
export type MailKind = "signin" | "magic_link" | "share_notice" | "view_notice" | "access_request";

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

export interface MailResult {
  ok: boolean;
  code?: string;
  class?: MailFailureClass;
}

const DEFAULT_FROM = "no-reply@rtfx.pro";

/**
 * Send one transactional message and record the outcome.
 *
 * Never throws. Callers decide what to do from `MailResult`, because the right
 * response differs by class: a transient failure is worth retrying, a config
 * failure is an outage worth alerting on, and neither should ever surface to
 * the person signing in — that would turn this into an account-enumeration
 * oracle. The specific reason belongs in `mail_log`, where an operator can
 * read it, not in an HTTP response.
 */
export async function sendMail(
  env: Env,
  o: { to: string; kind: MailKind; message: RenderedMail; now: string }
): Promise<MailResult> {
  if (!env.EMAIL) {
    // Ours, not Cloudflare's, and "config" is exactly right: a deployment that
    // forgot the binding.
    await recordMail(env, {
      email: o.to,
      kind: o.kind,
      status: "failed",
      errorCode: "E_NO_BINDING",
      now: o.now,
    });
    return { ok: false, code: "E_NO_BINDING", class: "config" };
  }

  try {
    await env.EMAIL.send({
      to: o.to,
      from: { email: env.MAIL_FROM || DEFAULT_FROM, name: "rtfx.pro" },
      subject: o.message.subject,
      html: o.message.html,
      text: o.message.text,
    });
    await recordMail(env, { email: o.to, kind: o.kind, status: "sent", now: o.now });
    return { ok: true };
  } catch (e) {
    const code = (e as { code?: string }).code;
    await recordMail(env, {
      email: o.to,
      kind: o.kind,
      status: "failed",
      errorCode: code ?? "E_UNKNOWN",
      now: o.now,
    });
    return { ok: false, code, class: classifyMailError(code) };
  }
}
