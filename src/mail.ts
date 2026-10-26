/**
 * Transactional email over the Cloudflare Email Sending binding, with Resend as
 * an optional fallback (RESEND_API_KEY) for anything but a recipient failure.
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
  let code: string | undefined;
  let failureClass: MailFailureClass;
  if (!env.EMAIL) {
    // Ours, not Cloudflare's, and "config" is exactly right: a deployment that
    // forgot the binding.
    code = "E_NO_BINDING";
    failureClass = "config";
  } else {
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
      code = (e as { code?: string }).code ?? "E_UNKNOWN";
      failureClass = classifyMailError(code);
    }
  }

  // A second provider can rescue an outage, a rate limit or a sender problem on
  // Cloudflare's side; it cannot rescue an address that refuses mail, so a
  // recipient failure is final. Without RESEND_API_KEY this is exactly the old
  // behaviour.
  if (env.RESEND_API_KEY && failureClass !== "recipient") {
    const resend = await sendViaResend(env, o);
    if (resend.ok) {
      await recordMail(env, {
        email: o.to,
        kind: o.kind,
        status: "sent",
        errorCode: `resend_fallback:${code}`,
        now: o.now,
      });
      return { ok: true };
    }
    await recordMail(env, {
      email: o.to,
      kind: o.kind,
      status: "failed",
      errorCode: `${code}|resend:${resend.detail}`,
      now: o.now,
    });
    return { ok: false, code, class: failureClass };
  }

  await recordMail(env, { email: o.to, kind: o.kind, status: "failed", errorCode: code, now: o.now });
  return { ok: false, code: code === "E_UNKNOWN" ? undefined : code, class: failureClass };
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * The fallback sender: Resend's HTTP API, same message, same From. The sending
 * domain (MAIL_FROM's) must be verified in the Resend account; until it is,
 * every fallback fails with a 4xx that lands in `mail_log` next to the
 * Cloudflare code, so the gap is visible rather than silent.
 */
async function sendViaResend(
  env: Env,
  o: { to: string; message: RenderedMail }
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const from = env.RESEND_FROM || `rtfx.pro <${env.MAIL_FROM || DEFAULT_FROM}>`;
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [o.to],
        subject: o.message.subject,
        html: o.message.html,
        text: o.message.text,
      }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as { name?: string } | null;
    return { ok: false, detail: `${res.status} ${body?.name ?? "error"}` };
  } catch {
    return { ok: false, detail: "network" };
  }
}
