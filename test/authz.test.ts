import { describe, it, expect } from "vitest";
import {
  canView,
  canManage,
  isOwner,
  canUseDashboard,
  userActionDenial,
  type UserAction,
} from "../src/authz";
import type { Identity } from "../src/auth";

const admin: Identity = { email: "admin@x.com", commonName: null, isAdmin: true, role: "admin" };
const bob: Identity = { email: "bob@x.com", commonName: null, isAdmin: false, role: "member" };
const carol: Identity = { email: "carol@x.com", commonName: null, isAdmin: false, role: "member" };
const adminToken: Identity = {
  email: null,
  commonName: "cli-admin.access",
  isAdmin: true,
  role: "admin",
};
const plainToken: Identity = {
  email: null,
  commonName: "monitoring.access",
  isAdmin: false,
  role: "member",
};

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
  it("'everyone' means everyone in the artifact workspace, not every authenticated viewer", () => {
    expect(canView(bob, "everyone", false)).toBe(false);
    expect(canView(bob, "everyone", false, false, true)).toBe(true);
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

/**
 * The user-directory policy as pure rules (issue #24). The API tests cover the
 * same ground end-to-end; these pin the rule *ordering*, which end-to-end tests
 * can't distinguish — e.g. that "super admin is protected" wins over "you may
 * not act on yourself", so the reason an operator sees is the right one.
 */
describe("userActionDenial", () => {
  const owner: Identity = {
    email: "owner@x.com",
    commonName: null,
    isAdmin: true,
    role: "super_admin",
  };
  const member = { email: "bob@x.com", role: "member" } as const;
  const otherAdmin = { email: "admin2@x.com", role: "admin" } as const;
  const operator = { email: "owner@x.com", role: "super_admin" } as const;
  const ALL: UserAction[] = ["invite", "edit", "disable", "enable", "remove"];

  const allowed = (actor: Identity | null, target: { email: string; role: any }) =>
    ALL.filter((a) => userActionDenial(actor, target, a) === null);

  it("requires admin rights at all", () => {
    expect(allowed(null, member)).toEqual([]);
    expect(allowed(bob, member)).toEqual([]);
  });

  it("lets an admin run the whole lifecycle on a member", () => {
    expect(allowed(admin, member)).toEqual(ALL);
    expect(allowed(owner, member)).toEqual(ALL);
  });

  it("protects the super admin from everything but their own edit", () => {
    // The operator may still fix their own display name; nothing else lands,
    // and the reason given is the protection rule rather than self-lockout.
    expect(allowed(owner, operator)).toEqual(["edit"]);
    expect(userActionDenial(owner, operator, "remove")).toMatch(/protected/);
    // A plain admin can't even edit them: rule 1 blocks the lifecycle actions,
    // rule 2 ("only a super admin can manage another admin") blocks the edit.
    expect(allowed(admin, operator)).toEqual([]);
    expect(userActionDenial(admin, operator, "edit")).toMatch(/super admin/);
  });

  it("stops one admin acting on a peer, but lets the operator do it", () => {
    expect(allowed(admin, otherAdmin)).toEqual([]);
    expect(userActionDenial(admin, otherAdmin, "disable")).toMatch(/super admin/);
    expect(allowed(owner, otherAdmin)).toEqual(ALL);
  });

  it("blocks self-lockout without blocking a self-edit", () => {
    const self = { email: "admin@x.com", role: "admin" } as const;
    expect(allowed(admin, self)).toEqual([]); // peer-admin rule catches it first
    expect(allowed(owner, { email: "owner@x.com", role: "admin" })).toEqual([
      "invite",
      "edit",
      "enable",
    ]);
  });

  it("matches emails case- and whitespace-insensitively", () => {
    const shouty = { email: "  OWNER@X.com ", role: "admin" } as const;
    expect(userActionDenial(owner, shouty, "disable")).toMatch(/your own account/);
  });

  it("an admin API token is capped at admin, so it can never touch an admin", () => {
    expect(allowed(adminToken, otherAdmin)).toEqual([]);
    expect(allowed(adminToken, member)).toEqual(ALL);
  });
});

/**
 * The guest boundary (app-owned identity). `canUseDashboard` is the one place
 * where a mistake is a privilege escalation rather than a bug: a granted guest
 * reaching /admin would see every artifact the dashboard lists. The table is
 * exhaustive over {kind} x {isAdmin} x {email present} on purpose.
 */
describe("canUseDashboard with session kinds", () => {
  const base = { commonName: null, role: "member" as const };

  const cases: Array<[string, Identity, boolean]> = [
    ["member with email", { ...base, email: "dana@acme.com", isAdmin: false, kind: "member" }, true],
    ["member admin", { ...base, email: "admin@x.com", isAdmin: true, kind: "member" }, true],
    ["guest with email", { ...base, email: "dana@acme.com", isAdmin: false, kind: "guest" }, false],
    ["guest with no email", { ...base, email: null, isAdmin: false, kind: "guest" }, false],
    ["member with no email", { ...base, email: null, isAdmin: false, kind: "member" }, false],
    ["kind absent (Access-authenticated human)", { ...base, email: "dana@acme.com", isAdmin: false }, true],
  ];

  for (const [name, identity, expected] of cases) {
    it(`${name} -> ${expected}`, () => {
      expect(canUseDashboard(identity)).toBe(expected);
    });
  }

  it("a guest is refused even when isAdmin is somehow true", () => {
    // Defense in depth: isAdmin is config-derived and a guest session can never
    // set it, but the ordering must not depend on that being true forever.
    expect(
      canUseDashboard({ ...base, email: "admin@x.com", isAdmin: true, kind: "guest" })
    ).toBe(false);
  });
});
