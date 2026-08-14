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
    send_email: [{ name: "EMAIL", allowed_sender_addresses: ["no-reply@rtfx.pro"] }],
    vars: {
      ADMIN_EMAILS: "admin@rtfx.pro",
      MAIL_FROM: "no-reply@rtfx.pro",
      CONTENT_HOSTNAMES: "a.rtfx.pro",
      LEMONSQUEEZY_STORE_ID: "rtfxpro",
      LEMONSQUEEZY_VARIANT_FREE: "free",
      LEMONSQUEEZY_VARIANT_PRO: "pro",
      LEMONSQUEEZY_VARIANT_TEAM: "team",
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
  it("reports a fully-configured launch config with no errors or pending config", () => {
    const { errors, pending, ok } = checkWranglerConfig(baseConfig());
    expect(errors).toEqual([]);
    expect(pending).toEqual([]);
    expect(ok.some((m: string) => m.includes("SESSION_SECRET"))).toBe(true);
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

  it("flags empty billing vars as pending", () => {
    const cfg = baseConfig();
    (cfg.vars as Record<string, string>).LEMONSQUEEZY_VARIANT_PRO = "";
    const { pending } = checkWranglerConfig(cfg);
    expect(pending.some((p: string) => p.includes("LEMONSQUEEZY_VARIANT_PRO"))).toBe(true);
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

describe("email sending binding", () => {
  it("requires a send_email binding named EMAIL", () => {
    const { errors } = checkWranglerConfig(baseConfig({ send_email: [] }));
    expect(errors).toContain('send_email must declare a binding named "EMAIL"');
  });

  it("refuses a remote binding, which would send real mail from local dev", () => {
    const { errors } = checkWranglerConfig(
      baseConfig({ send_email: [{ name: "EMAIL", remote: true }] })
    );
    expect(errors).toContain(
      'send_email binding "EMAIL" must not set "remote" in committed config'
    );
  });

  it("requires MAIL_FROM to be one of the allowed sender addresses", () => {
    const cfg: any = baseConfig({
      send_email: [{ name: "EMAIL", allowed_sender_addresses: ["no-reply@rtfx.pro"] }],
    });
    cfg.vars.MAIL_FROM = "someone-else@rtfx.pro";
    const { errors } = checkWranglerConfig(cfg);
    expect(errors).toContain(
      'vars.MAIL_FROM "someone-else@rtfx.pro" is not in the EMAIL binding\'s allowed_sender_addresses'
    );
  });

  it("accepts a correctly restricted binding", () => {
    const cfg: any = baseConfig({
      send_email: [{ name: "EMAIL", allowed_sender_addresses: ["no-reply@rtfx.pro"] }],
    });
    cfg.vars.MAIL_FROM = "no-reply@rtfx.pro";
    const { errors } = checkWranglerConfig(cfg);
    expect(errors.filter((e: string) => e.includes("send_email") || e.includes("MAIL_FROM"))).toEqual([]);
  });
});
