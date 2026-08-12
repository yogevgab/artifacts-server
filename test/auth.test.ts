import { describe, it, expect } from "vitest";
import { accessEmail, isAdmin, resolveIsAdmin } from "../src/auth";
import type { Env } from "../src/env";

const baseEnv = {
  ADMIN_EMAILS: "a@b.com",
  ADMIN_SERVICE_TOKENS: "cli-admin.access",
  ACCESS_TEAM_DOMAIN: "",
  ACCESS_AUD: "",
} as Env;
const ctx = (env: Env, headers: Record<string, string> = {}) => ({
  env,
  req: { header: (n: string) => headers[n] },
});

describe("accessEmail dev/prod gating", () => {
  it("dev login returns the admin email", async () => {
    expect(await accessEmail(ctx({ ...baseEnv, DEV_LOGIN: "true" }))).toBe("a@b.com");
  });
  it("production without Access config returns null (locked)", async () => {
    expect(await accessEmail(ctx(baseEnv))).toBeNull();
  });
  it("production with Access configured but no token returns null", async () => {
    expect(
      await accessEmail(ctx({ ...baseEnv, ACCESS_AUD: "aud", ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com" }))
    ).toBeNull();
  });
  it("dev login honors X-Dev-Anonymous to simulate an unauthenticated caller", async () => {
    expect(
      await accessEmail(ctx({ ...baseEnv, DEV_LOGIN: "true" }, { "X-Dev-Anonymous": "true" }))
    ).toBeNull();
  });
});

describe("isAdmin", () => {
  it("matches the admin list case-insensitively", () => {
    expect(isAdmin(baseEnv, "A@B.com")).toBe(true);
    expect(isAdmin(baseEnv, "x@y.com")).toBe(false);
    expect(isAdmin(baseEnv, null)).toBe(false);
  });
});

describe("resolveIsAdmin (service tokens are not implicitly admin)", () => {
  it("admin email is admin", () => {
    expect(resolveIsAdmin(baseEnv, "a@b.com", null)).toBe(true);
  });
  it("non-admin email is not admin", () => {
    expect(resolveIsAdmin(baseEnv, "x@y.com", null)).toBe(false);
  });
  it("allow-listed service token common_name is admin", () => {
    expect(resolveIsAdmin(baseEnv, null, "cli-admin.access")).toBe(true);
    expect(resolveIsAdmin(baseEnv, null, "CLI-Admin.access")).toBe(true); // case-insensitive
  });
  it("a service token NOT in ADMIN_SERVICE_TOKENS is not admin", () => {
    expect(resolveIsAdmin(baseEnv, null, "monitoring.access")).toBe(false);
    expect(resolveIsAdmin({ ...baseEnv, ADMIN_SERVICE_TOKENS: "" } as Env, null, "cli-admin.access")).toBe(false);
  });
});
