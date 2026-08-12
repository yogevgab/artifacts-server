import { describe, it, expect } from "vitest";
import {
  parseHostnames,
  requestHostname,
  isContentHost,
  isManagementPath,
  firstContentHostname,
} from "../src/host";
import type { Env } from "../src/env";

describe("parseHostnames", () => {
  it("splits, trims, lowercases, and drops empties", () => {
    expect(parseHostnames("A.com, b.com ,,c.COM")).toEqual(new Set(["a.com", "b.com", "c.com"]));
  });
  it("handles undefined", () => {
    expect(parseHostnames(undefined)).toEqual(new Set());
  });
});

describe("requestHostname", () => {
  it("extracts a lowercase hostname from a URL", () => {
    expect(requestHostname("https://A.Rtfx.pro/solo/")).toBe("a.rtfx.pro");
  });
  it("returns empty string for an invalid URL", () => {
    expect(requestHostname("not-a-url")).toBe("");
  });
});

describe("isContentHost", () => {
  it("is false when CONTENT_HOSTNAMES is unset", () => {
    expect(isContentHost({} as Env, "https://a.rtfx.pro/x")).toBe(false);
  });
  it("is true only for a hostname in the configured list", () => {
    const env = { CONTENT_HOSTNAMES: "a.rtfx.pro,b.rtfx.pro" } as Env;
    expect(isContentHost(env, "https://a.rtfx.pro/x")).toBe(true);
    expect(isContentHost(env, "https://b.rtfx.pro/x")).toBe(true);
    expect(isContentHost(env, "https://rtfx.pro/x")).toBe(false);
  });
});

describe("firstContentHostname", () => {
  it("is undefined when CONTENT_HOSTNAMES is unset", () => {
    expect(firstContentHostname({} as Env)).toBeUndefined();
  });
  it("returns the first configured hostname, preserving list order", () => {
    const env = { CONTENT_HOSTNAMES: "a.rtfx.pro,b.rtfx.pro" } as Env;
    expect(firstContentHostname(env)).toBe("a.rtfx.pro");
  });
});

describe("isManagementPath", () => {
  it("blocks exact management paths", () => {
    for (const p of ["/", "/health", "/whoami", "/admin", "/api", "/v", "/waitlist", "/gallery"]) {
      expect(isManagementPath(p)).toBe(true);
    }
  });
  it("blocks nested management paths", () => {
    for (const p of ["/admin/", "/api/artifacts", "/v/slug/1/index.html"]) {
      expect(isManagementPath(p)).toBe(true);
    }
  });
  it("does not block artifact paths that merely start with a reserved word", () => {
    for (const p of ["/adminfoo", "/apidocs", "/vault/", "/waitlistfoo", "/galleryfoo"]) {
      expect(isManagementPath(p)).toBe(false);
    }
  });
  it("does not block ordinary artifact paths", () => {
    for (const p of ["/solo/", "/bundle/app.js"]) {
      expect(isManagementPath(p)).toBe(false);
    }
  });
});
