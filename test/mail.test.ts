import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { classifyMailError, isRetryable, recordMail, sendMail } from "../src/mail";
import { signinMail } from "../src/mail-templates";

async function initMailLog() {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, error_code TEXT, created_at TEXT NOT NULL)`
  ).run();
  await env.DB.prepare("DELETE FROM mail_log").run();
}

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

const message = signinMail({
  code: "418209",
  magicUrl: "https://rtfx.pro/auth/m/abc",
  expiresMinutes: 15,
});

function envWith(send: (m: any) => Promise<any>) {
  return { ...(env as any), EMAIL: { send }, MAIL_FROM: "no-reply@rtfx.pro" };
}

const at = "2026-08-14T12:00:00.000Z";

describe("sendMail", () => {
  beforeEach(initMailLog);

  it("sends both html and text, from the configured sender", async () => {
    let seen: any;
    const e = envWith(async (m) => {
      seen = m;
      return { messageId: "m1" };
    });
    const res = await sendMail(e, { to: "dana@acme.com", kind: "signin", message, now: at });
    expect(res.ok).toBe(true);
    expect(seen.to).toBe("dana@acme.com");
    expect(seen.from).toEqual({ email: "no-reply@rtfx.pro", name: "rtfx.pro" });
    expect(seen.html).toContain("418209");
    expect(seen.text).toContain("418209");
  });

  it("logs a successful send", async () => {
    await sendMail(envWith(async () => ({ messageId: "m1" })), {
      to: "dana@acme.com", kind: "signin", message, now: at,
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
    const res = await sendMail(e, { to: "dana@acme.com", kind: "signin", message, now: at });
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
    const res = await sendMail(e, { to: "dana@acme.com", kind: "signin", message, now: at });
    expect(res.class).toBe("config");
  });

  it("fails closed when no binding is configured", async () => {
    const res = await sendMail({ ...(env as any), EMAIL: undefined }, {
      to: "dana@acme.com", kind: "signin", message, now: at,
    });
    expect(res.ok).toBe(false);
    expect(res.class).toBe("config");
  });
});

describe("sendMail — Resend fallback", () => {
  beforeEach(initMailLog);
  afterEach(() => vi.restoreAllMocks());

  const failingCf = (code: string) => async () => {
    throw Object.assign(new Error("cf failed"), { code });
  };
  const withResend = (base: any) => ({ ...base, RESEND_API_KEY: "re_test_key" });

  function mockResend(status = 200, body: unknown = { id: "re_1" }) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    });
    return calls;
  }

  it("retries a transient Cloudflare failure through Resend and logs it as sent via the fallback", async () => {
    const calls = mockResend();
    const res = await sendMail(withResend(envWith(failingCf("E_RATE_LIMIT_EXCEEDED"))), {
      to: "dana@acme.com", kind: "signin", message, now: at,
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.to).toEqual(["dana@acme.com"]);
    expect(body.from).toBe("rtfx.pro <no-reply@rtfx.pro>");
    expect(body.html).toContain("418209");
    expect(body.text).toContain("418209");
    const row = await env.DB.prepare("SELECT * FROM mail_log").first<any>();
    expect(row.status).toBe("sent");
    expect(row.error_code).toBe("resend_fallback:E_RATE_LIMIT_EXCEEDED");
  });

  it("falls back when the Cloudflare binding is missing", async () => {
    mockResend();
    const e = withResend({ ...(env as any), EMAIL: undefined, MAIL_FROM: "no-reply@rtfx.pro" });
    const res = await sendMail(e, { to: "dana@acme.com", kind: "signin", message, now: at });
    expect(res.ok).toBe(true);
    const row = await env.DB.prepare("SELECT * FROM mail_log").first<any>();
    expect(row.error_code).toBe("resend_fallback:E_NO_BINDING");
  });

  it("does not fall back for a recipient failure — another provider will not fix a bad address", async () => {
    const calls = mockResend();
    const res = await sendMail(withResend(envWith(failingCf("E_RECIPIENT_SUPPRESSED"))), {
      to: "dana@acme.com", kind: "signin", message, now: at,
    });
    expect(res.ok).toBe(false);
    expect(res.class).toBe("recipient");
    expect(calls).toHaveLength(0);
  });

  it("does nothing new without a Resend key", async () => {
    const calls = mockResend();
    const res = await sendMail(envWith(failingCf("E_RATE_LIMIT_EXCEEDED")), {
      to: "dana@acme.com", kind: "signin", message, now: at,
    });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("reports the original failure when Resend fails too, and logs both codes", async () => {
    mockResend(422, { name: "validation_error", message: "domain not verified" });
    const res = await sendMail(withResend(envWith(failingCf("E_DELIVERY_FAILED"))), {
      to: "dana@acme.com", kind: "signin", message, now: at,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("E_DELIVERY_FAILED");
    expect(res.class).toBe("transient");
    const row = await env.DB.prepare("SELECT * FROM mail_log").first<any>();
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("E_DELIVERY_FAILED|resend:422 validation_error");
  });
});
