import { describe, it, expect } from "vitest";
import { isValidSlug, slugify, contentType, safeNextPath } from "../src/util";

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

/**
 * ⚠️ Not yet called by anything: `/oauth/authorize` emits `/login?next=…` but
 * `/login` does not consume it yet. Tested now anyway, because the wiring is the
 * easy half — an open redirect on a sign-in route hands a freshly minted session
 * to whatever host an attacker names, so this function has to be right *before*
 * something depends on it.
 */
describe("safeNextPath", () => {
  it("accepts a path on this origin, query and all", () => {
    expect(safeNextPath("/admin")).toBe("/admin");
    expect(safeNextPath("/oauth/authorize?client_id=x&state=y")).toBe(
      "/oauth/authorize?client_id=x&state=y"
    );
    expect(safeNextPath("  /admin  ")).toBe("/admin");
  });

  it("rejects anything that could name another host", () => {
    for (const value of [
      "https://evil.example.com/",
      "//evil.example.com",
      "/\\evil.example.com",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "admin",
      "",
      "   ",
    ]) {
      expect(safeNextPath(value), value).toBeNull();
    }
  });

  it("rejects a smuggled control character, an over-long value, and a non-string", () => {
    expect(safeNextPath("/admin\nLocation: https://evil.example.com")).toBeNull();
    expect(safeNextPath("/admin\r\nSet-Cookie: a=b")).toBeNull();
    expect(safeNextPath("/admin")).toBeNull();
    expect(safeNextPath(`/${"a".repeat(512)}`)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(42)).toBeNull();
  });
});
