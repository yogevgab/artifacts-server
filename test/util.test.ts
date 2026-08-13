import { describe, it, expect } from "vitest";
import { isValidSlug, slugify, contentType } from "../src/util";

describe("isValidSlug", () => {
  it("accepts lowercase alnum + hyphen", () => {
    expect(isValidSlug("ab-1")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
  });
  it("rejects invalid slugs", () => {
    expect(isValidSlug("Ab")).toBe(false);
    expect(isValidSlug("-x")).toBe(false);
    expect(isValidSlug("a_b")).toBe(false);
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("a".repeat(101))).toBe(false);
  });
  it("rejects reserved route slugs", () => {
    for (const s of ["api", "admin", "health", "whoami", "v", "waitlist", "gallery", "login"]) expect(isValidSlug(s)).toBe(false);
  });
  // Issue #29: the public product pages and crawler files own these names.
  it("rejects slugs that would shadow a public page or crawler file", () => {
    for (const s of ["docs", "robots", "sitemap", "llms", "og"]) expect(isValidSlug(s)).toBe(false);
  });
});

describe("slugify", () => {
  it("normalizes titles", () => {
    expect(slugify("My Page!")).toBe("my-page");
    expect(slugify("  Hello   World  ")).toBe("hello-world");
    expect(slugify("Q3 — Landing")).toBe("q3-landing");
  });
});

describe("contentType", () => {
  it("maps known extensions", () => {
    expect(contentType("a.css")).toBe("text/css; charset=utf-8");
    expect(contentType("a.js")).toBe("text/javascript; charset=utf-8");
    expect(contentType("index.html")).toBe("text/html; charset=utf-8");
    expect(contentType("a.png")).toBe("image/png");
    expect(contentType("a.svg")).toBe("image/svg+xml");
  });
  it("falls back for unknown", () => {
    expect(contentType("a.xyz")).toBe("application/octet-stream");
    expect(contentType("noext")).toBe("application/octet-stream");
  });
});
