import { describe, it, expect } from "vitest";
import { canView, canManage, isOwner, canUseDashboard } from "../src/authz";
import type { Identity } from "../src/auth";

const admin: Identity = { email: "admin@x.com", commonName: null, isAdmin: true };
const bob: Identity = { email: "bob@x.com", commonName: null, isAdmin: false };
const carol: Identity = { email: "carol@x.com", commonName: null, isAdmin: false };
const adminToken: Identity = { email: null, commonName: "cli-admin.access", isAdmin: true };
const plainToken: Identity = { email: null, commonName: "monitoring.access", isAdmin: false };

const ownedBy = (owner: string | null) => ({ owner_email: owner });

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
  it("the owner sees their own restricted artifact without a grant", () => {
    expect(canView(bob, "restricted", false, true)).toBe(true);
  });
});

describe("isOwner", () => {
  it("matches the owner email case- and whitespace-insensitively", () => {
    expect(isOwner(bob, ownedBy("bob@x.com"))).toBe(true);
    expect(isOwner(bob, ownedBy("  BOB@X.com "))).toBe(true);
  });
  it("does not match a different user", () => {
    expect(isOwner(carol, ownedBy("bob@x.com"))).toBe(false);
  });
  it("nobody owns an unowned artifact", () => {
    expect(isOwner(bob, ownedBy(null))).toBe(false);
    expect(isOwner(bob, ownedBy(""))).toBe(false);
    expect(isOwner(bob, ownedBy("   "))).toBe(false);
    expect(isOwner(admin, ownedBy(null))).toBe(false); // admin manages it, but doesn't own it
  });
  it("an identity with no email owns nothing", () => {
    expect(isOwner(adminToken, ownedBy("bob@x.com"))).toBe(false);
    expect(isOwner(null, ownedBy("bob@x.com"))).toBe(false);
  });
});

describe("canManage", () => {
  it("admins manage every artifact, owned or not", () => {
    expect(canManage(admin, ownedBy("bob@x.com"))).toBe(true);
    expect(canManage(admin, ownedBy(null))).toBe(true);
    expect(canManage(adminToken, ownedBy("bob@x.com"))).toBe(true);
  });
  it("a beta user manages only their own", () => {
    expect(canManage(bob, ownedBy("bob@x.com"))).toBe(true);
    expect(canManage(bob, ownedBy("carol@x.com"))).toBe(false);
    expect(canManage(bob, ownedBy(null))).toBe(false);
  });
  it("denies unauthenticated and non-admin tokens", () => {
    expect(canManage(null, ownedBy("bob@x.com"))).toBe(false);
    expect(canManage(plainToken, ownedBy("bob@x.com"))).toBe(false);
  });
});

describe("canUseDashboard", () => {
  it("admins and signed-in humans may", () => {
    expect(canUseDashboard(admin)).toBe(true);
    expect(canUseDashboard(bob)).toBe(true);
    expect(canUseDashboard(adminToken)).toBe(true);
  });
  it("a non-admin service token and anonymous callers may not", () => {
    expect(canUseDashboard(plainToken)).toBe(false);
    expect(canUseDashboard(null)).toBe(false);
  });
});
