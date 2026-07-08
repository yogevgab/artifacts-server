import { describe, it, expect } from "vitest";
import { canView } from "../src/authz";
import type { Identity } from "../src/auth";

const admin: Identity = { email: "admin@x.com", commonName: null, isAdmin: true };
const bob: Identity = { email: "bob@x.com", commonName: null, isAdmin: false };

describe("canView", () => {
  it("denies unauthenticated", () => {
    expect(canView(null, "everyone", true)).toBe(false);
    expect(canView(null, "restricted", true)).toBe(false);
  });
  it("admin sees everything", () => {
    expect(canView(admin, "restricted", false)).toBe(true);
    expect(canView(admin, "everyone", false)).toBe(true);
  });
  it("'everyone' is visible to any authenticated viewer", () => {
    expect(canView(bob, "everyone", false)).toBe(true);
  });
  it("'restricted' depends on the grant", () => {
    expect(canView(bob, "restricted", true)).toBe(true);
    expect(canView(bob, "restricted", false)).toBe(false);
  });
});
