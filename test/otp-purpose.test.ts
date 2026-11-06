import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { createChallenge, redeemCode, redeemToken } from "../src/otp";
import { initDb } from "./fixtures";

/**
 * Regression: `redeemCode` used to ignore the challenge `purpose`, so the code of
 * a guest-share challenge could be typed at /auth/verify and mint a MEMBER
 * session. /auth/verify is member-only; a guest challenge yields a guest
 * credential through its magic link and nothing else.
 */

const AT = "2026-08-14T12:00:00.000Z";
const later = (min: number) => new Date(Date.parse(AT) + min * 60_000).toISOString();
const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";

beforeEach(initDb);

describe("redeemCode and challenge purpose", () => {
  it("never redeems a guest-share challenge as a member sign-in", async () => {
    const guest = await createChallenge(env as any, {
      email: "dana@acme.com",
      purpose: "guest",
      slug: "report",
      now: AT,
    });
    expect(await redeemCode(env as any, "dana@acme.com", guest.code, AT)).toBeNull();
    // The guest challenge is untouched: its magic link still works, as a guest.
    expect(await redeemToken(env as any, guest.token, AT)).toMatchObject({ purpose: "guest", slug: "report" });
  });

  it("a newer guest challenge does not shadow the member challenge's code", async () => {
    const member = await createChallenge(env as any, { email: "dana@acme.com", purpose: "signin", now: AT });
    await createChallenge(env as any, { email: "dana@acme.com", purpose: "guest", slug: "report", now: later(1) });
    expect(await redeemCode(env as any, "dana@acme.com", member.code, later(2))).toMatchObject({
      purpose: "signin",
    });
  });

  it("POST /auth/verify with a guest challenge's code is a 401 and sets no session", async () => {
    const e = { ...(env as any), SESSION_SECRET: SECRET, DEV_LOGIN: undefined };
    const guest = await createChallenge(e, {
      email: "dana@acme.com",
      purpose: "guest",
      slug: "report",
      now: new Date().toISOString(),
    });
    const res = await app.request(
      "https://rtfx.pro/auth/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "dana@acme.com", code: guest.code }),
      },
      e
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
