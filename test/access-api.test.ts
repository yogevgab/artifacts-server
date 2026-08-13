import { describe, it, expect } from "vitest";
import { AccessApiError, mergeAdmins, isConfigured, policyWithEmails, removeUser } from "../src/access-api";
import type { Env } from "../src/env";

const env = { ADMIN_EMAILS: "admin@x.com, boss@x.com" } as Env;

describe("mergeAdmins", () => {
  it("always includes admins, deduped, lowercased, sorted", () => {
    expect(mergeAdmins(env, ["Bob@X.com", "bob@x.com", "  "])).toEqual([
      "admin@x.com",
      "boss@x.com",
      "bob@x.com",
    ].sort());
  });
  it("admins present even with empty input", () => {
    expect(mergeAdmins(env, [])).toEqual(["admin@x.com", "boss@x.com"].sort());
  });
  it("falls back to the first admin as super admin when SUPER_ADMIN_EMAILS is unset", () => {
    expect(mergeAdmins({ ADMIN_EMAILS: "Owner@X.com, admin@x.com" } as Env, ["viewer@x.com"])).toEqual([
      "admin@x.com",
      "owner@x.com",
      "viewer@x.com",
    ].sort());
  });
  it("merges explicit super admins even when they are not also listed as admins", () => {
    expect(
      mergeAdmins({ ADMIN_EMAILS: "admin@x.com", SUPER_ADMIN_EMAILS: "Owner@X.com" } as Env, ["viewer@x.com"])
    ).toEqual(["admin@x.com", "owner@x.com", "viewer@x.com"].sort());
  });
});

describe("policyWithEmails", () => {
  const current = {
    id: "pol-1",
    uid: "u-1",
    created_at: "2020",
    updated_at: "2021",
    name: "Artifacts (viewers) — humans",
    decision: "allow",
    precedence: 1,
    session_duration: "24h",
    require: [{ geo: { country_code: "US" } }],
    include: [{ email: { email: "old@x.com" } }],
  };

  it("overrides include but preserves other policy fields", () => {
    const body = policyWithEmails(current, ["a@x.com", "b@x.com"]);
    expect(body.include).toEqual([
      { email: { email: "a@x.com" } },
      { email: { email: "b@x.com" } },
    ]);
    expect(body.precedence).toBe(1);
    expect(body.session_duration).toBe("24h");
    expect(body.require).toEqual([{ geo: { country_code: "US" } }]);
    expect(body.name).toBe("Artifacts (viewers) — humans");
    expect(body.decision).toBe("allow");
  });

  it("strips read-only fields", () => {
    const body = policyWithEmails(current, []);
    for (const k of ["id", "uid", "created_at", "updated_at"]) {
      expect(body).not.toHaveProperty(k);
    }
  });
});

describe("isConfigured", () => {
  it("false when secrets/ids absent", () => {
    expect(isConfigured(env)).toBe(false);
  });
  it("true when all present", () => {
    expect(
      isConfigured({
        ...env,
        CF_API_TOKEN: "t",
        CF_ACCOUNT_ID: "a",
        ACCESS_VIEWER_APP_ID: "app",
        ACCESS_VIEWER_POLICY_ID: "pol",
      } as Env)
    ).toBe(true);
  });
});

describe("removeUser anti-lockout", () => {
  it("refuses to remove an explicit super admin before any Cloudflare call", async () => {
    await expect(
      removeUser({ ADMIN_EMAILS: "admin@x.com", SUPER_ADMIN_EMAILS: "owner@x.com" } as Env, "OWNER@x.com")
    ).rejects.toThrow(AccessApiError);
  });

  it("refuses to remove the fallback super admin before any Cloudflare call", async () => {
    await expect(removeUser({ ADMIN_EMAILS: "owner@x.com, admin@x.com" } as Env, "owner@x.com")).rejects.toThrow(
      "cannot remove an admin"
    );
  });
});
