/**
 * Message bodies, kept apart from delivery (`src/mail.ts`).
 *
 * These two files change for different reasons and are reviewed by different
 * eyes: copy and brand here, transport and failure handling there.
 */

/** A message rendered into the three parts the binding needs. */
export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

/** Minimal HTML escape — the same policy as `esc` elsewhere in the app. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Email HTML is not web HTML: no external stylesheets, no webfonts, and a
 * layout simple enough that Gmail, Outlook and Apple Mail all render it the
 * same way. Inline styles only, and a light ground that survives both a light
 * and a dark mail client without inverting into something unreadable.
 */
function shell(bodyHtml: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f2f3f7;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#14182b;">
    <div style="font-size:20px;font-weight:600;letter-spacing:-0.02em;margin-bottom:24px;">rtfx<span style="color:#2438c8;">.</span>pro</div>
    ${bodyHtml}
    <hr style="border:0;border-top:1px solid #d3d7e4;margin:28px 0 16px;">
    <div style="font-size:12px;color:#565d78;line-height:1.5;">
      You received this because somebody entered this address at rtfx.pro.
      If that wasn't you, no action is needed &mdash; nothing happens until the code is used.
    </div>
  </div>
</body></html>`;
}

export function signinMail(o: {
  code: string;
  magicUrl: string;
  expiresMinutes: number;
}): RenderedMail {
  const code = esc(o.code);
  const url = esc(o.magicUrl);

  const html = shell(
    `<p style="font-size:16px;line-height:1.5;margin:0 0 20px;">Here's your sign-in code.</p>
     <div style="font-size:32px;font-weight:600;letter-spacing:0.12em;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:16px 0;">${code}</div>
     <p style="font-size:15px;line-height:1.5;margin:0 0 24px;color:#565d78;">It expires in ${o.expiresMinutes} minutes and can be used once.</p>
     <a href="${url}" style="display:inline-block;background:#2438c8;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:15px;font-weight:500;">Open rtfx.pro</a>
     <p style="font-size:13px;line-height:1.5;margin:20px 0 0;color:#565d78;">Or paste this link:<br>${url}</p>`
  );

  const text = [
    "Here's your sign-in code for rtfx.pro.",
    "",
    `  ${o.code}`,
    "",
    `It expires in ${o.expiresMinutes} minutes and can be used once.`,
    "",
    "Or open this link:",
    o.magicUrl,
    "",
    "You received this because somebody entered this address at rtfx.pro.",
    "If that wasn't you, no action is needed.",
  ].join("\n");

  return { subject: "Your rtfx.pro sign-in code", html, text };
}

/**
 * Somebody shared an artifact with an address that has no account. The message
 * leads with what they were sent, not with the mechanics of signing in — they
 * did not ask for an account and are not getting one.
 */
export function guestMail(o: {
  title: string;
  magicUrl: string;
  expiresMinutes: number;
}): RenderedMail {
  const url = esc(o.magicUrl);
  const title = esc(o.title);

  const html = shell(
    `<p style="font-size:16px;line-height:1.5;margin:0 0 20px;">You've been given access to
       <b>${title}</b>.</p>
     <a href="${url}" style="display:inline-block;background:#2438c8;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:15px;font-weight:500;">Open it</a>
     <p style="font-size:15px;line-height:1.5;margin:22px 0 0;color:#565d78;">This link is yours
       alone and expires in ${o.expiresMinutes} minutes. You don't need an account.</p>
     <p style="font-size:13px;line-height:1.5;margin:16px 0 0;color:#565d78;">Or paste this:<br>${url}</p>`
  );

  const text = [
    `You've been given access to ${o.title}.`,
    "",
    "Open it:",
    o.magicUrl,
    "",
    `This link is yours alone and expires in ${o.expiresMinutes} minutes.`,
    "You don't need an account.",
  ].join("\n");

  return { subject: `${o.title} was shared with you`, html, text };
}
