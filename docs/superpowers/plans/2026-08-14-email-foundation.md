# Email Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Worker the ability to send branded transactional email, with every send outcome classified and recorded, so later plans can build sign-in on top of it.

**Architecture:** One new module, `src/mail.ts`, wrapping the Cloudflare Email Sending `send_email` binding. A pure classifier maps Cloudflare's `E_*` error codes to three behaviors (config / recipient / transient). Every outcome is written to a `mail_log` table so "why didn't they get it" is answerable from data instead of source. Nothing routes to this module yet — it ships as unused, deployable code.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, D1, Vitest with `@cloudflare/vitest-pool-workers`, Cloudflare Email Sending (Workers binding — no npm dependency).

**Spec:** `docs/superpowers/specs/2026-08-14-app-owned-identity-design.md` (§7)

## Global Constraints

- **Zero new npm dependencies.** The mailer is a Workers binding. `package.json` dependencies stay exactly `fflate`, `hono`, `jose`.
- **Node 18+**, `compatibility_date` stays `2026-06-01`.
- **Every email sends both `html` and `text`.** Text-only clients and spam scoring both require it.
- **Sender is `no-reply@rtfx.pro`** and the binding is restricted to that address.
- **No secrets in source.** No API keys — the binding authenticates itself.
- **`"remote": true` must never reach production** in `wrangler.jsonc`.
- **Brand copy:** the product is written `rtfx.pro` (lowercase, with the dot). Never "RTFX" or "Rtfx".
- **Tests mock the binding.** No test sends real mail.

---

### Task 1: Classify send failures

A pure function, so the policy is testable without a binding. This is the piece that turns a silent failure into an actionable one.

**Files:**
- Create: `src/mail.ts`
- Test: `test/mail.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `export type MailFailureClass = "config" | "recipient" | "transient"`, `export function classifyMailError(code: string | undefined): MailFailureClass`, `export function isRetryable(code: string | undefined): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
// test/mail.test.ts
import { describe, it, expect } from "vitest";
import { classifyMailError, isRetryable } from "../src/mail";

describe("classifyMailError", () => {
  it("treats sender/domain problems as config failures", () => {
    expect(classifyMailError("E_SENDER_NOT_VERIFIED")).toBe("config");
    expect(classifyMailError("E_SENDER_DOMAIN_NOT_AVAILABLE")).toBe("config");
  });

  it("treats suppression and validation as recipient failures", () => {
    expect(classifyMailError("E_RECIPIENT_SUPPRESSED")).toBe("recipient");
    expect(classifyMailError("E_VALIDATION_ERROR")).toBe("recipient");
    expect(classifyMailError("E_FIELD_MISSING")).toBe("recipient");
  });

  it("treats rate limits and delivery errors as transient", () => {
    expect(classifyMailError("E_RATE_LIMIT_EXCEEDED")).toBe("transient");
    expect(classifyMailError("E_DELIVERY_FAILED")).toBe("transient");
    expect(classifyMailError("E_INTERNAL_SERVER_ERROR")).toBe("transient");
  });

  it("defaults an unknown or missing code to transient", () => {
    // Unknown codes must not be treated as permanent: a new Cloudflare code
    // should degrade to "retry", never to "give up on this address".
    expect(classifyMailError("E_SOMETHING_NEW")).toBe("transient");
    expect(classifyMailError(undefined)).toBe("transient");
  });
});

describe("isRetryable", () => {
  it("is true only for transient failures", () => {
    expect(isRetryable("E_RATE_LIMIT_EXCEEDED")).toBe(true);
    expect(isRetryable("E_RECIPIENT_SUPPRESSED")).toBe(false);
    expect(isRetryable("E_SENDER_NOT_VERIFIED")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mail.test.ts`
Expected: FAIL — `Failed to resolve import "../src/mail"`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/mail.ts

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/mail.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mail.ts test/mail.test.ts
git commit -m "Add mail failure classification"
```

---

### Task 2: Record every send outcome

**Files:**
- Create: `migrations/0011_mail_log.sql`
- Modify: `schema.sql` (append the same table so a fresh install matches a migrated one)
- Modify: `src/mail.ts`
- Test: `test/mail.test.ts`

**Interfaces:**
- Consumes: `classifyMailError` from Task 1
- Produces: `export type MailKind = "signin" | "magic_link" | "share_notice"`, `export async function recordMail(env: Env, entry: { email: string; kind: MailKind; status: "sent" | "failed"; errorCode?: string; now: string }): Promise<void>`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0011_mail_log.sql
-- Delivery outcomes, so "why didn't they get it" is answerable from data.
CREATE TABLE IF NOT EXISTS mail_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_log_email ON mail_log (email, created_at DESC);
```

Append the identical statements to `schema.sql`, under a comment reading
`-- Delivery outcomes for transactional email (see docs/superpowers/specs/2026-08-14-app-owned-identity-design.md §7).`

- [ ] **Step 2: Write the failing test**

```typescript
// append to test/mail.test.ts
import { env } from "cloudflare:test";
import { recordMail } from "../src/mail";

async function initMailLog() {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, error_code TEXT, created_at TEXT NOT NULL)`
  ).run();
  await env.DB.prepare("DELETE FROM mail_log").run();
}

describe("recordMail", () => {
  beforeEach(initMailLog);

  it("writes a successful send", async () => {
    await recordMail(env as any, {
      email: "Dana@Acme.com",
      kind: "signin",
      status: "sent",
      now: "2026-08-14T12:00:00.000Z",
    });
    const row = await env.DB.prepare("SELECT * FROM mail_log").first<any>();
    expect(row.email).toBe("dana@acme.com"); // normalized, so lookups match
    expect(row.status).toBe("sent");
    expect(row.error_code).toBeNull();
  });

  it("writes a failure with its code", async () => {
    await recordMail(env as any, {
      email: "dana@acme.com",
      kind: "signin",
      status: "failed",
      errorCode: "E_RECIPIENT_SUPPRESSED",
      now: "2026-08-14T12:00:00.000Z",
    });
    const row = await env.DB.prepare("SELECT * FROM mail_log").first<any>();
    expect(row.error_code).toBe("E_RECIPIENT_SUPPRESSED");
  });

  it("never throws — logging must not break a send path", async () => {
    await env.DB.prepare("DROP TABLE mail_log").run();
    await expect(
      recordMail(env as any, {
        email: "dana@acme.com",
        kind: "signin",
        status: "sent",
        now: "2026-08-14T12:00:00.000Z",
      })
    ).resolves.toBeUndefined();
  });
});
```

Add `beforeEach` to the existing vitest import at the top of the file.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/mail.test.ts`
Expected: FAIL — `recordMail is not a function`.

- [ ] **Step 4: Write minimal implementation**

```typescript
// append to src/mail.ts
import type { Env } from "./env";

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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/mail.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 6: Apply the migration locally and remotely**

```bash
npx wrangler d1 execute artifacts-meta --local  --file migrations/0011_mail_log.sql
npx wrangler d1 execute artifacts-meta --remote --file migrations/0011_mail_log.sql
```

- [ ] **Step 7: Commit**

```bash
git add src/mail.ts test/mail.test.ts migrations/0011_mail_log.sql schema.sql
git commit -m "Add mail_log table and best-effort delivery recording"
```

---

### Task 3: Branded message templates

**Files:**
- Create: `src/mail-templates.ts`
- Test: `test/mail-templates.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `export interface RenderedMail { subject: string; html: string; text: string }`, `export function signinMail(o: { code: string; magicUrl: string; expiresMinutes: number }): RenderedMail`

Separate file because templates change for copy reasons and `mail.ts` changes for
delivery reasons. They have different reviewers and different reasons to change.

- [ ] **Step 1: Write the failing test**

```typescript
// test/mail-templates.test.ts
import { describe, it, expect } from "vitest";
import { signinMail } from "../src/mail-templates";

const mail = signinMail({
  code: "418209",
  magicUrl: "https://rtfx.pro/auth/m/abc123",
  expiresMinutes: 15,
});

describe("signinMail", () => {
  it("carries the code in both html and text", () => {
    expect(mail.html).toContain("418209");
    expect(mail.text).toContain("418209");
  });

  it("carries the magic link in both html and text", () => {
    expect(mail.html).toContain("https://rtfx.pro/auth/m/abc123");
    expect(mail.text).toContain("https://rtfx.pro/auth/m/abc123");
  });

  it("states the expiry so the reader knows the code is short-lived", () => {
    expect(mail.text).toContain("15 minutes");
  });

  it("uses the product name exactly as branded", () => {
    expect(mail.subject).toContain("rtfx.pro");
    expect(mail.html).not.toContain("RTFX");
  });

  it("escapes nothing dangerous into the html", () => {
    const evil = signinMail({
      code: "<script>alert(1)</script>",
      magicUrl: "https://rtfx.pro/auth/m/x",
      expiresMinutes: 15,
    });
    expect(evil.html).not.toContain("<script>");
  });

  it("produces a text part that is not just stripped html", () => {
    expect(mail.text).not.toContain("<");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mail-templates.test.ts`
Expected: FAIL — cannot resolve `../src/mail-templates`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/mail-templates.ts

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
 * Email HTML is not web HTML: no external CSS, no custom fonts, table-free
 * layout kept simple enough that Gmail, Outlook and Apple Mail all render it
 * the same way. Inline styles only.
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
      If that wasn't you, no action is needed — nothing happens until the code is used.
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
     <p style="font-size:13px;line-height:1.5;margin:20px 0 0;color:#565d78;">Or paste this link: <br>${url}</p>`
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/mail-templates.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mail-templates.ts test/mail-templates.test.ts
git commit -m "Add branded sign-in email template"
```

---

### Task 4: The send wrapper

**Files:**
- Modify: `src/env.ts` (add the `EMAIL` binding and `MAIL_FROM`)
- Modify: `src/mail.ts`
- Test: `test/mail.test.ts`

**Interfaces:**
- Consumes: `classifyMailError`, `recordMail` (Tasks 1–2), `RenderedMail` (Task 3)
- Produces: `export interface MailResult { ok: boolean; code?: string; class?: MailFailureClass }`, `export async function sendMail(env: Env, o: { to: string; kind: MailKind; message: RenderedMail; now: string }): Promise<MailResult>`

- [ ] **Step 1: Add the binding to the Env interface**

```typescript
// in src/env.ts, inside `export interface Env {`, after the D1 binding:

  /**
   * Cloudflare Email Sending. Restricted in wrangler.jsonc to the single
   * `no-reply@rtfx.pro` sender: this Worker also serves user-uploaded HTML, so
   * capping what it can ever send From is cheap defense in depth.
   * Optional so dev and tests run without it.
   */
  EMAIL?: { send(message: unknown): Promise<{ messageId?: string }> };
  /** Envelope sender. Defaults to "no-reply@rtfx.pro" when unset. */
  MAIL_FROM?: string;
```

- [ ] **Step 2: Write the failing test**

```typescript
// append to test/mail.test.ts
import { sendMail } from "../src/mail";
import { signinMail } from "../src/mail-templates";

const message = signinMail({
  code: "418209",
  magicUrl: "https://rtfx.pro/auth/m/abc",
  expiresMinutes: 15,
});

function envWith(send: (m: any) => Promise<any>) {
  return { ...(env as any), EMAIL: { send }, MAIL_FROM: "no-reply@rtfx.pro" };
}

describe("sendMail", () => {
  beforeEach(initMailLog);

  it("sends both html and text, from the configured sender", async () => {
    let seen: any;
    const e = envWith(async (m) => {
      seen = m;
      return { messageId: "m1" };
    });
    const res = await sendMail(e, {
      to: "dana@acme.com",
      kind: "signin",
      message,
      now: "2026-08-14T12:00:00.000Z",
    });
    expect(res.ok).toBe(true);
    expect(seen.to).toBe("dana@acme.com");
    expect(seen.from).toEqual({ email: "no-reply@rtfx.pro", name: "rtfx.pro" });
    expect(seen.html).toContain("418209");
    expect(seen.text).toContain("418209");
  });

  it("logs a successful send", async () => {
    await sendMail(envWith(async () => ({ messageId: "m1" })), {
      to: "dana@acme.com",
      kind: "signin",
      message,
      now: "2026-08-14T12:00:00.000Z",
    });
    const row = await env.DB.prepare("SELECT * FROM mail_log").first<any>();
    expect(row.status).toBe("sent");
  });

  it("classifies and logs a suppressed recipient without throwing", async () => {
    const e = envWith(async () => {
      const err: any = new Error("suppressed");
      err.code = "E_RECIPIENT_SUPPRESSED";
      throw err;
    });
    const res = await sendMail(e, {
      to: "dana@acme.com",
      kind: "signin",
      message,
      now: "2026-08-14T12:00:00.000Z",
    });
    expect(res.ok).toBe(false);
    expect(res.class).toBe("recipient");
    const row = await env.DB.prepare("SELECT * FROM mail_log").first<any>();
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("E_RECIPIENT_SUPPRESSED");
  });

  it("reports a config failure distinctly, so an operator can be alerted", async () => {
    const e = envWith(async () => {
      const err: any = new Error("not verified");
      err.code = "E_SENDER_NOT_VERIFIED";
      throw err;
    });
    const res = await sendMail(e, {
      to: "dana@acme.com",
      kind: "signin",
      message,
      now: "2026-08-14T12:00:00.000Z",
    });
    expect(res.class).toBe("config");
  });

  it("fails closed when no binding is configured", async () => {
    const res = await sendMail({ ...(env as any), EMAIL: undefined }, {
      to: "dana@acme.com",
      kind: "signin",
      message,
      now: "2026-08-14T12:00:00.000Z",
    });
    expect(res.ok).toBe(false);
    expect(res.class).toBe("config");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/mail.test.ts`
Expected: FAIL — `sendMail is not a function`.

- [ ] **Step 4: Write minimal implementation**

```typescript
// append to src/mail.ts
import type { RenderedMail } from "./mail-templates";

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
 * response differs by class: a transient failure is worth retrying, a recipient
 * failure is worth telling an operator about, and neither should ever surface
 * to the person signing in — that would make this endpoint an account-
 * enumeration oracle.
 */
export async function sendMail(
  env: Env,
  o: { to: string; kind: MailKind; message: RenderedMail; now: string }
): Promise<MailResult> {
  if (!env.EMAIL) {
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
```

Note: `E_NO_BINDING` is ours, not Cloudflare's, and classifies as `config` because
that is exactly what it is — a deployment that forgot the binding.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/mail.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm run check`
Expected: typecheck clean, all tests pass, plugin validator passes.

- [ ] **Step 7: Commit**

```bash
git add src/mail.ts src/env.ts test/mail.test.ts
git commit -m "Add sendMail wrapper with outcome classification and logging"
```

---

### Task 5: Wire the binding and onboard the domain

This is the only task that touches infrastructure. It ends with a real message
delivered to a real inbox, because a mailer that has never sent anything is not
evidence of anything.

**Files:**
- Modify: `wrangler.jsonc`
- Modify: `scripts/validate-deploy-config.mjs` (assert the binding exists and `remote` is absent)
- Test: `test/validate-deploy-config.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: a deployed Worker with a working `EMAIL` binding

- [ ] **Step 1: Add the binding to wrangler.jsonc**

Add at the top level, after `d1_databases`:

```jsonc
  // Cloudflare Email Sending. Restricted to one sender on purpose: this Worker
  // also serves user-uploaded HTML from a.rtfx.pro, so capping the addresses it
  // can send From limits the blast radius of any future bug. Requires
  // `wrangler email sending enable rtfx.pro` to have been run on the account.
  "send_email": [
    { "name": "EMAIL", "allowed_sender_addresses": ["no-reply@rtfx.pro"] }
  ],
```

Add to `vars`:

```jsonc
    // Envelope sender for transactional email. Must be in allowed_sender_addresses.
    "MAIL_FROM": "no-reply@rtfx.pro",
```

- [ ] **Step 2: Write the failing test for the deploy validator**

```typescript
// append to test/validate-deploy-config.test.ts
it("requires the EMAIL binding", () => {
  const cfg = { send_email: [] };
  expect(problemsFor(cfg)).toContain(
    'send_email must declare a binding named "EMAIL"'
  );
});

it("refuses a remote email binding, which would send real mail from dev", () => {
  const cfg = { send_email: [{ name: "EMAIL", remote: true }] };
  expect(problemsFor(cfg)).toContain(
    'send_email binding "EMAIL" must not set "remote" in committed config'
  );
});
```

Match `problemsFor` to whatever the existing test file already uses to invoke the
validator; if it invokes the script directly, follow that pattern instead of
introducing a new helper.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/validate-deploy-config.test.ts`
Expected: FAIL — the validator reports neither problem.

- [ ] **Step 4: Implement the validator checks**

In `scripts/validate-deploy-config.mjs`, alongside the existing checks:

```javascript
const sendEmail = Array.isArray(config.send_email) ? config.send_email : [];
const emailBinding = sendEmail.find((b) => b && b.name === "EMAIL");
if (!emailBinding) {
  problems.push('send_email must declare a binding named "EMAIL"');
} else if (emailBinding.remote) {
  problems.push('send_email binding "EMAIL" must not set "remote" in committed config');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/validate-deploy-config.test.ts`
Expected: PASS.

- [ ] **Step 6: Onboard the domain**

```bash
npx wrangler email sending enable rtfx.pro
npx wrangler email sending dns get rtfx.pro
```

Expected: SPF (TXT) and DKIM records reported as present. DNS propagation takes
5–15 minutes; re-run `dns get` until clean before proceeding.

Then add a DMARC record on the zone if one does not exist:
`_dmarc.rtfx.pro TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@rtfx.pro"`

- [ ] **Step 7: Verify with a real send**

```bash
npx wrangler email sending send \
  --from "no-reply@rtfx.pro" \
  --to "yogevgab@gmail.com" \
  --subject "rtfx.pro mail check" \
  --text "If you can read this, Email Sending is working."
```

Expected: the message arrives. **Check whether it landed in Promotions or Spam** —
if it did, DMARC/DKIM propagation is incomplete and sign-in mail will be
unreliable. Do not proceed to Plan 2 until it lands in the inbox.

- [ ] **Step 8: Deploy**

```bash
npm run check && npm run deploy
```

Expected: deploy succeeds. Nothing user-visible changes — `mail.ts` is not yet
routed from anywhere. That is the point: the mailer ships and is provably
deployable before anything depends on it.

- [ ] **Step 9: Commit**

```bash
git add wrangler.jsonc scripts/validate-deploy-config.mjs test/validate-deploy-config.test.ts
git commit -m "Wire the Email Sending binding and validate it on deploy"
```

---

## Done when

- `npm run check` is clean.
- A real email sent from `no-reply@rtfx.pro` arrives in a Gmail **inbox**, not Promotions.
- The Worker is deployed with the `EMAIL` binding and no user-visible change.
- `mail_log` exists in both local and remote D1.

## Next

`docs/superpowers/plans/2026-08-14-identity-core.md` (Plan 2) builds `otp.ts` and
`session.ts` on top of `sendMail`.
