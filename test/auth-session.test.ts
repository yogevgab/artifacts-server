import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { resolveAuth, SESSION_COOKIE } from "../src/auth";
import { mintSession } from "../src/session";

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const AT = "2026-08-14T12:00:00.000Z";

function ctx(cookie?: string, envOverrides: Record<string, unknown> = {}) {
  return {
    env: { ...(env as any), SESSION_SECRET: SECRET, DEV_LOGIN: undefined, ...envOverrides },
    req: {
      header: (n: string) => (n.toLowerCase() === "cookie" ? cookie : undefined),
      url: "https://rtfx.pro/admin",
    },
  } as any;
}

const cookieFor = async (token: string) => `${SESSION_COOKIE}=${token}`;

describe("app session authentication", () => {
  it("authenticates a member from the session cookie", async () => {
    const t = await mintSession(SECRET, { email: "dana@acme.com", kind: "member" }, AT);
    const { identity } = await resolveAuth(ctx(await cookieFor(t)));
    expect(identity?.email).toBe("dana@acme.com");
    expect(identity?.kind).toBe("member");
  });

  it("authenticates a guest and never marks them admin", async () => {
    // Even when the address is in ADMIN_EMAILS: a guest session is a narrower
    // credential than a sign-in, and must not be silently upgraded.
    const t = await mintSession(
      SECRET,
      { email: "yogevgab@gmail.com", kind: "guest", slug: "q3-report" },
      AT
    );
    const { identity } = await resolveAuth(
      ctx(await cookieFor(t), { ADMIN_EMAILS: "yogevgab@gmail.com" })
    );
    expect(identity?.kind).toBe("guest");
    expect(identity?.isAdmin).toBe(false);
  });

  it("ignores a cookie signed with the wrong secret", async () => {
    const t = await mintSession("a-completely-different-secret-32-bytes!!", {
      email: "mallory@evil.com",
      kind: "member",
    }, AT);
    const { identity } = await resolveAuth(ctx(await cookieFor(t)));
    expect(identity).toBeNull();
  });

  it("ignores a malformed cookie", async () => {
    expect((await resolveAuth(ctx(`${SESSION_COOKIE}=garbage`))).identity).toBeNull();
    expect((await resolveAuth(ctx("unrelated=1"))).identity).toBeNull();
    expect((await resolveAuth(ctx(undefined))).identity).toBeNull();
  });

  it("picks the session cookie out of a crowded Cookie header", async () => {
    const t = await mintSession(SECRET, { email: "dana@acme.com", kind: "member" }, AT);
    const { identity } = await resolveAuth(
      ctx(`CF_Authorization=xyz; ${SESSION_COOKIE}=${t}; other=1`)
    );
    expect(identity?.email).toBe("dana@acme.com");
  });

  it("lets a bearer token still win, so the machine API is unaffected", async () => {
    const t = await mintSession(SECRET, { email: "dana@acme.com", kind: "member" }, AT);
    const c = ctx(await cookieFor(t));
    c.req.header = (n: string) => {
      const k = n.toLowerCase();
      if (k === "cookie") return `${SESSION_COOKIE}=${t}`;
      if (k === "authorization") return "Bearer rtfx_deadbeef_nonsense";
      return undefined;
    };
    const { identity, invalidToken } = await resolveAuth(c);
    // A bad bearer token is still rejected outright rather than falling through
    // to the cookie — presenting a credential and having a different one used
    // would be surprising and exploitable.
    expect(identity).toBeNull();
    expect(invalidToken).toBe(true);
  });

  it("does nothing when SESSION_SECRET is unset, rather than throwing", async () => {
    const t = await mintSession(SECRET, { email: "dana@acme.com", kind: "member" }, AT);
    const { identity } = await resolveAuth(
      ctx(await cookieFor(t), { SESSION_SECRET: undefined })
    );
    expect(identity).toBeNull();
  });
});
