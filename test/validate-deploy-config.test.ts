import { describe, it, expect } from "vitest";
import {
  checkWranglerConfig,
  stripJsonComments,
  EXPECTED_APP_HOSTNAME,
  EXPECTED_CONTENT_HOSTNAME,
} from "../scripts/validate-deploy-config.lib.mjs";

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    routes: [
      { pattern: "rtfx.pro", custom_domain: true },
      { pattern: "a.rtfx.pro", custom_domain: true },
    ],
    r2_buckets: [{ binding: "FILES", bucket_name: "artifacts-files" }],
    d1_databases: [{ binding: "DB", database_name: "artifacts-meta", database_id: "abc-123" }],
    vars: {
      ADMIN_EMAILS: "admin@rtfx.pro",
      ACCESS_TEAM_DOMAIN: "rtfx.cloudflareaccess.com",
      ACCESS_AUD: "aud1,aud2",
      CF_ACCOUNT_ID: "acct123",
      ACCESS_VIEWER_APP_ID: "app1",
      ACCESS_VIEWER_POLICY_ID: "pol1",
      ADMIN_SERVICE_TOKENS: "cli-token.access",
      CONTENT_HOSTNAMES: "a.rtfx.pro",
    },
    ...overrides,
  };
}

describe("stripJsonComments", () => {
  it("removes line comments outside strings", () => {
    expect(stripJsonComments('{"a": 1, // comment\n"b": 2}')).toBe('{"a": 1, \n"b": 2}');
  });
  it("removes block comments", () => {
    expect(stripJsonComments('{"a": /* x */ 1}')).toBe('{"a":  1}');
  });
  it("does not touch // inside string values", () => {
    expect(stripJsonComments('{"url": "https://example.com"}')).toBe('{"url": "https://example.com"}');
  });
});

describe("checkWranglerConfig", () => {
  it("reports a fully-configured config with no errors and only the CF_API_TOKEN secret reminder pending", () => {
    const { errors, pending } = checkWranglerConfig(baseConfig());
    expect(errors).toEqual([]);
    expect(pending).toEqual([expect.stringContaining("CF_API_TOKEN")]);
  });

  it("errors when the app hostname route is missing", () => {
    const cfg = baseConfig({ routes: [{ pattern: "a.rtfx.pro", custom_domain: true }] });
    const { errors } = checkWranglerConfig(cfg);
    expect(errors.some((e: string) => e.includes(EXPECTED_APP_HOSTNAME))).toBe(true);
  });

  it("errors when the content hostname route is missing", () => {
    const cfg = baseConfig({ routes: [{ pattern: "rtfx.pro", custom_domain: true }] });
    const { errors } = checkWranglerConfig(cfg);
    expect(errors.some((e: string) => e.includes(EXPECTED_CONTENT_HOSTNAME))).toBe(true);
  });

  it("errors when CONTENT_HOSTNAMES lists a host with no matching route", () => {
    const cfg = baseConfig();
    (cfg.vars as Record<string, string>).CONTENT_HOSTNAMES = "stray.rtfx.pro";
    const { errors } = checkWranglerConfig(cfg);
    expect(errors.some((e: string) => e.includes("stray.rtfx.pro"))).toBe(true);
  });

  it("errors when CONTENT_HOSTNAMES includes the app hostname", () => {
    const cfg = baseConfig();
    (cfg.vars as Record<string, string>).CONTENT_HOSTNAMES = "rtfx.pro,a.rtfx.pro";
    const { errors } = checkWranglerConfig(cfg);
    expect(errors.some((e: string) => e.includes("must not include the app hostname"))).toBe(true);
  });

  it("errors when CONTENT_HOSTNAMES is empty", () => {
    const cfg = baseConfig();
    (cfg.vars as Record<string, string>).CONTENT_HOSTNAMES = "";
    const { errors } = checkWranglerConfig(cfg);
    expect(errors.some((e: string) => e.includes("CONTENT_HOSTNAMES is empty"))).toBe(true);
  });

  it("flags a placeholder D1 database id as pending, not an error", () => {
    const cfg = baseConfig();
    (cfg.d1_databases as Array<Record<string, string>>)[0].database_id = "REPLACE_WITH_D1_DATABASE_ID";
    const { errors, pending } = checkWranglerConfig(cfg);
    expect(errors).toEqual([]);
    expect(pending.some((p: string) => p.includes("database_id"))).toBe(true);
  });

  it("flags the default ADMIN_EMAILS placeholder as pending", () => {
    const cfg = baseConfig();
    (cfg.vars as Record<string, string>).ADMIN_EMAILS = "you@example.com";
    const { pending } = checkWranglerConfig(cfg);
    expect(pending.some((p: string) => p.includes("ADMIN_EMAILS"))).toBe(true);
  });

  it("flags empty Access vars as pending", () => {
    const cfg = baseConfig();
    (cfg.vars as Record<string, string>).ACCESS_TEAM_DOMAIN = "";
    const { pending } = checkWranglerConfig(cfg);
    expect(pending.some((p: string) => p.includes("ACCESS_TEAM_DOMAIN"))).toBe(true);
  });

  it("errors when the R2 FILES binding is missing", () => {
    const cfg = baseConfig({ r2_buckets: [] });
    const { errors } = checkWranglerConfig(cfg);
    expect(errors.some((e: string) => e.includes("FILES"))).toBe(true);
  });

  it("errors when the D1 DB binding is missing", () => {
    const cfg = baseConfig({ d1_databases: [] });
    const { errors } = checkWranglerConfig(cfg);
    expect(errors.some((e: string) => e.includes('"DB" binding'))).toBe(true);
  });
});
