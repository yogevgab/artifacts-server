import { describe, it, expect } from "vitest";
import { mintSession, verifySession, SESSION_TTL_SECONDS } from "../src/session";

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const AT = "2026-08-14T12:00:00.000Z";
const later = (s: number) => new Date(Date.parse(AT) + s * 1000).toISOString();

describe("mintSession / verifySession", () => {
  it("round-trips a member session", async () => {
    const token = await mintSession(SECRET, { email: "dana@acme.com", kind: "member" }, AT);
    expect(await verifySession(SECRET, token, AT)).toMatchObject({
      email: "dana@acme.com",
      kind: "member",
    });
  });

  it("round-trips a guest session carrying its slug", async () => {
    const token = await mintSession(
      SECRET,
      { email: "dana@acme.com", kind: "guest", slug: "q3-report" },
      AT
    );
    expect(await verifySession(SECRET, token, AT)).toMatchObject({
      kind: "guest",
      slug: "q3-report",
    });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await mintSession(SECRET, { email: "dana@acme.com", kind: "member" }, AT);
    expect(await verifySession("some-other-secret-of-sufficient-length!!", token, AT)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await mintSession(SECRET, { email: "dana@acme.com", kind: "guest" }, AT);
    const [h, , s] = token.split(".");
    const forged = btoa(JSON.stringify({ email: "dana@acme.com", kind: "member" }))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(await verifySession(SECRET, `${h}.${forged}.${s}`, AT)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await mintSession(SECRET, { email: "dana@acme.com", kind: "member" }, AT);
    expect(await verifySession(SECRET, token, later(SESSION_TTL_SECONDS + 60))).toBeNull();
  });

  it("accepts a token just inside its lifetime", async () => {
    const token = await mintSession(SECRET, { email: "dana@acme.com", kind: "member" }, AT);
    expect(await verifySession(SECRET, token, later(SESSION_TTL_SECONDS - 60))).not.toBeNull();
  });

  it("returns null rather than throwing on garbage", async () => {
    expect(await verifySession(SECRET, "not-a-jwt", AT)).toBeNull();
    expect(await verifySession(SECRET, "", AT)).toBeNull();
    expect(await verifySession(SECRET, "a.b.c", AT)).toBeNull();
  });

  it("normalizes the email so a session and a grant compare equal", async () => {
    const token = await mintSession(SECRET, { email: "  Dana@Acme.COM ", kind: "member" }, AT);
    expect((await verifySession(SECRET, token, AT))?.email).toBe("dana@acme.com");
  });

  it("refuses to mint with a weak secret, so a misconfigured deploy fails loudly", async () => {
    await expect(mintSession("short", { email: "d@a.com", kind: "member" }, AT)).rejects.toThrow();
  });
});
