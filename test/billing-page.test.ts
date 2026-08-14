import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { strToU8 } from "fflate";
import { createAccount, ensurePersonalAccount, getAccount, upsertMember } from "../src/accounts";
import { setPlanOverride } from "../src/operator";
import { billingPage, type BillingPageInput } from "../src/billing-page";
import { workspaceBilling, type WorkspaceBilling } from "../src/plan-copy";
import { PLANS } from "../src/quota";
import { num, type PortalViewer } from "../src/portal";
import { as, clearR2, htmlForm, initDb, req, withToken } from "./fixtures";

/**
 * `/admin/billing` — the customer's own view of their plan.
 *
 * The tests that matter most here are the negative ones, because the failure
 * mode of a billing page is not a crash: it is a page that *reads* fine and is
 * quietly untrue. Three properties are pinned for that reason —
 *
 *  - a tier that cannot be bought self-serve never renders a checkout, even
 *    when a checkout URL for it exists (Team);
 *  - the three things this deployment cannot do (invoices, payment method,
 *    cancel) are named as gaps rather than rendered as controls;
 *  - an operator override shows BOTH what the workspace is entitled to and what
 *    it is billed for, instead of picking whichever is flattering.
 *
 * Everything asserts on `data-*` markers rather than copy, like the rest of the
 * portal suite, so wording stays free to improve.
 */

const SUPER = "admin@test.com"; // SUPER_ADMIN_EMAILS in vitest.config.ts
const ALICE = "alice@test.com";
const BOB = "bob@test.com";

const html = strToU8("<h1>hi</h1>");
const now = () => new Date().toISOString();

beforeEach(async () => {
  await initDb();
  await clearR2();
});

const page = async (path: string, init: RequestInit) => await (await req(path, init)).text();

/**
 * The markup of the one `.row` carrying `marker`, so an assertion about (say)
 * the Team row cannot be satisfied by the Pro row sitting next to it.
 */
const ROW = '<div class="row"';
function block(body: string, marker: string): string {
  const at = body.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  const from = body.lastIndexOf(ROW, at);
  const to = body.indexOf(ROW, at);
  return body.slice(from === -1 ? at : from, to === -1 ? body.length : to);
}

/** Alice's personal workspace plus a team one she owns, with Bob in it. */
async function twoWorkspaces(): Promise<{ personal: string; team: string }> {
  const personal = await ensurePersonalAccount(env as any, ALICE, now());
  const team = await createAccount(env as any, {
    name: "Acme",
    kind: "team",
    personalEmail: null,
    createdBy: ALICE,
    now: now(),
  });
  for (const [email, role] of [
    [ALICE, "owner"],
    [BOB, "member"],
  ] as const) {
    await upsertMember(env as any, {
      accountId: team.id,
      email,
      role,
      invitedBy: null,
      now: now(),
    });
  }
  return { personal: personal!.id, team: team.id };
}

const selecting = (accountId: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: {
    ...(init.headers as Record<string, string> | undefined),
    Cookie: `rtfx_account=${encodeURIComponent(accountId)}`,
  },
});

// --- the page renders the workspace it is acting in --------------------------

describe("/admin/billing states this workspace's plan, usage and limits", () => {
  it("names the active workspace, the viewer's role in it, and its status", async () => {
    await ensurePersonalAccount(env as any, ALICE, now());
    const body = await page("/admin/billing", as(ALICE));

    expect(body).toContain('data-section="billing"');
    expect(body).toContain('data-panel="billing-workspace"');
    expect(body).toContain('data-badge="workspace-role">Owner<');
    expect(body).toContain('data-badge="workspace-status">Active<');
    const account = await env.DB.prepare("SELECT id FROM accounts WHERE personal_email = ?")
      .bind(ALICE)
      .first<{ id: string }>();
    expect(body).toContain(`data-billing-workspace="${account!.id}"`);
  });

  it("counts real usage against the plan's real limits", async () => {
    await ensurePersonalAccount(env as any, ALICE, now());
    for (const slug of ["one", "two"]) {
      const res = await req(
        "/api/artifacts",
        as(ALICE, { method: "POST", body: htmlForm({ title: slug, slug }, "index.html", html) })
      );
      expect(res.status).toBe(200);
    }

    const body = await page("/admin/billing", as(ALICE));
    // Free is 10 artifacts / 100 MB / 1 seat — straight out of PLANS.
    expect(body).toContain(`data-usage-value="artifacts">2 / ${PLANS.free.maxArtifacts}<`);
    expect(body).toContain('data-usage="storage"');
    expect(body).toContain(`data-usage-value="seats">1 / ${PLANS.free.maxSeats}<`);
    expect(body).toContain('data-badge="effective-plan">Free<');
  });

  it("counts every member as a seat, and flags a workspace past the cap", async () => {
    const { team } = await twoWorkspaces();
    const body = await page("/admin/billing", as(ALICE, selecting(team)));
    // Two members on a Free team workspace: one seat, two people.
    expect(body).toContain(`data-usage-value="seats">2 / ${PLANS.free.maxSeats}<`);
    expect(body).toMatch(/data-usage="seats" data-usage-state="over"/);
  });

  it("reports this month's views when there is a count to report", async () => {
    await ensurePersonalAccount(env as any, ALICE, now());
    const body = await page("/admin/billing", as(ALICE));
    expect(body).toContain('data-usage="views"');
    expect(body).toContain(`data-usage-value="views">0 / ${num(PLANS.free.maxViewsPerMonth)}<`);
  });
});

// --- the switcher moves it ---------------------------------------------------

describe("switching workspace changes which workspace is billed", () => {
  it("follows the active workspace, not the person", async () => {
    const { personal, team } = await twoWorkspaces();

    const mine = await page("/admin/billing", as(ALICE));
    expect(mine).toContain(`data-billing-workspace="${personal}"`);
    expect(mine).not.toContain(`data-billing-workspace="${team}"`);

    const ours = await page("/admin/billing", as(ALICE, selecting(team)));
    expect(ours).toContain(`data-billing-workspace="${team}"`);
    expect(ours).not.toContain(`data-billing-workspace="${personal}"`);
  });

  it("shows each member their own role in the same workspace", async () => {
    const { team } = await twoWorkspaces();
    expect(await page("/admin/billing", as(ALICE, selecting(team)))).toContain(
      'data-badge="workspace-role">Owner<'
    );
    expect(await page("/admin/billing", as(BOB, selecting(team)))).toContain(
      'data-badge="workspace-role">Member<'
    );
  });
});

// --- operator overrides are stated, not hidden -------------------------------

describe("an operator override shows the effective plan AND the billed one", () => {
  it("says nothing about a billed plan when there is no override", async () => {
    await ensurePersonalAccount(env as any, ALICE, now());
    const body = await page("/admin/billing", as(ALICE));
    expect(body).toContain('data-badge="effective-plan">Free<');
    expect(body).not.toContain('data-setting="billed-plan"');
  });

  it("names both plans, and measures usage against the one actually in force", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, now());
    await setPlanOverride(env as any, account!, {
      plan: "team",
      expiresAt: "2099-01-01T00:00:00.000Z",
      note: "beta partner",
      actor: { email: SUPER, role: "super_admin" },
      now: now(),
    });

    const body = await page("/admin/billing", as(ALICE));
    // Entitlement first — that is what every limit on the page is measured from…
    expect(body).toContain('data-badge="effective-plan">Team<');
    expect(body).toContain(`data-usage-value="artifacts">0 / ${num(PLANS.team.maxArtifacts)}<`);
    // …and the subscription is stated beside it rather than quietly dropped.
    expect(body).toContain('data-setting="billed-plan"');
    expect(body).toContain('data-badge="billed-plan">Free<');
    expect(body).toContain("2099-01-01");
  });

  it("never shows the operator's private note to the customer", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, now());
    await setPlanOverride(env as any, account!, {
      plan: "pro",
      expiresAt: null,
      note: "comped while we fix their import",
      actor: { email: SUPER, role: "super_admin" },
      now: now(),
    });
    const body = await page("/admin/billing", as(ALICE));
    expect(body).toContain('data-badge="effective-plan">Pro<');
    expect(body).not.toContain("comped while we fix their import");
  });

  it("falls back to the billed plan once the override has expired", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, now());
    await setPlanOverride(env as any, account!, {
      plan: "team",
      expiresAt: "2000-01-01T00:00:00.000Z",
      note: null,
      actor: { email: SUPER, role: "super_admin" },
      now: now(),
    });
    const body = await page("/admin/billing", as(ALICE));
    expect(body).toContain('data-badge="effective-plan">Free<');
    expect(body).not.toContain('data-setting="billed-plan"');
  });
});

// --- what can actually be bought ---------------------------------------------

describe("only the tiers that are genuinely self-serve get a checkout", () => {
  const viewer: PortalViewer = {
    email: ALICE,
    isAdmin: false,
    role: "member",
    isTokenCaller: false,
    workspace: { id: "acct_1", name: "Acme", kind: "team", role: "owner", count: 1 },
  };

  const input = (billing: Partial<WorkspaceBilling> = {}): BillingPageInput => ({
    viewer,
    account: {
      id: "acct_1",
      name: "Acme",
      kind: "team",
      status: "active",
      plan: "free",
      personal_email: null,
      created_by: ALICE,
      created_at: now(),
      updated_at: now(),
    },
    role: "owner",
    billing: {
      plan: "free",
      limits: PLANS.free,
      usage: { artifacts: 0, storageBytes: 0 },
      warning: null,
      nextPlan: "pro",
      checkout: { pro: null, team: null },
      ...billing,
    },
    members: 1,
    views: null,
  });

  it("links Pro straight at the hosted checkout the deployment configured", () => {
    const body = billingPage(
      input({ checkout: { pro: "https://store.lemonsqueezy.com/checkout/buy/pro", team: null } })
    );
    expect(body).toContain('data-checkout="pro"');
    expect(body).toContain('href="https://store.lemonsqueezy.com/checkout/buy/pro"');
  });

  it("sends Team and Enterprise to /contact — even when a Team checkout URL exists", () => {
    // The Team variant is real and `checkoutUrl` builds a link for it. The page
    // must still not offer it: member invites send no mail yet, so a Team bought
    // unattended would strand everybody it added. See tierCta in plan-copy.ts.
    const body = billingPage(
      input({
        checkout: {
          pro: "https://store.lemonsqueezy.com/checkout/buy/pro",
          team: "https://store.lemonsqueezy.com/checkout/buy/team",
        },
      })
    );
    const teamRow = block(body, 'data-tier="team"');
    expect(teamRow).toContain('data-contact="team"');
    expect(teamRow).toContain('href="/contact?plan=team"');
    expect(teamRow).not.toContain("lemonsqueezy");
    expect(teamRow).not.toContain("data-checkout");

    const enterpriseRow = block(body, 'data-tier="enterprise"');
    expect(enterpriseRow).toContain('data-contact="enterprise"');
    expect(enterpriseRow).toContain('href="/contact?plan=enterprise"');
    expect(enterpriseRow).not.toContain("data-checkout");
    // Enterprise has no checkout anywhere in the page, at any price.
    expect(body).not.toContain("buy/enterprise");
  });

  it("says checkout isn't configured rather than rendering a dead Pro link", () => {
    const body = billingPage(input());
    expect(body).not.toContain('data-checkout="pro"');
    expect(body).toContain('data-checkout-unavailable="pro"');
  });

  it("marks the current tier instead of offering to sell it again", () => {
    const body = billingPage(
      input({
        plan: "pro",
        limits: PLANS.pro,
        nextPlan: "team",
        checkout: { pro: "https://store.lemonsqueezy.com/checkout/buy/pro", team: null },
      })
    );
    expect(body).toContain('data-tier-current="pro"');
    expect(body).toMatch(/data-tier="pro" data-tier-state="current"/);
    expect(body).not.toContain('data-checkout="pro"');
  });

  it("offers no self-serve downgrade to Free, because nothing here can cancel", () => {
    const body = billingPage(input({ plan: "pro", limits: PLANS.pro, nextPlan: "team" }));
    const freeRow = block(body, 'data-tier="free"');
    expect(freeRow).toContain('data-contact="free"');
    expect(freeRow).not.toContain("<button");
  });

  it("advertises each tier's limits out of PLANS, never hand-typed numbers", () => {
    const body = billingPage(input());
    expect(block(body, 'data-tier="team"')).toContain(
      num(PLANS.team.maxArtifacts)
    );
    expect(block(body, 'data-tier="pro"')).toContain(String(PLANS.pro.maxSeats));
  });
});

// --- honesty about what is not implemented -----------------------------------

describe("the page never implies subscription management it does not have", () => {
  it("names invoices, payment method and cancellation as gaps, with no controls", async () => {
    await ensurePersonalAccount(env as any, ALICE, now());
    const body = await page("/admin/billing", as(ALICE));

    for (const gap of ["invoices", "payment-method", "cancel"]) {
      const row = block(body, `data-unavailable="${gap}"`);
      expect(row, gap).toContain('data-badge="unavailable">Not self-serve yet<');
      // A gap is a sentence and a mailto-equivalent, never a button or a form
      // that would POST to a route nobody wrote.
      expect(row, gap).not.toContain("<button");
      expect(row, gap).not.toContain("<form");
      expect(row, gap).toContain(`data-contact-support="${gap}"`);
    }
  });

  it("links nowhere that looks like a billing portal", async () => {
    await ensurePersonalAccount(env as any, ALICE, now());
    const body = await page("/admin/billing", as(ALICE));
    const hrefs = [...body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    for (const href of hrefs) {
      expect(href).not.toMatch(/billing_portal|customer-portal|\/my-orders|manage-subscription/i);
    }
    // Nothing on the page POSTs a plan change either — no route exists for one.
    expect(body).not.toContain('action="/api/billing');
  });

  it("spells out that a downgrade deletes nothing and what it does block", async () => {
    await ensurePersonalAccount(env as any, ALICE, now());
    const body = await page("/admin/billing", as(ALICE));
    for (const policy of ["no-deletion", "publishes", "invites", "views", "retention"]) {
      expect(body, policy).toContain(`data-policy="${policy}"`);
    }
    // Free keeps a bounded version history, so the page must not claim otherwise.
    expect(block(body, 'data-policy="retention"')).toContain(String(PLANS.free.keepVersions));
  });
});

// --- who may open it ----------------------------------------------------------

describe("who the billing page is for", () => {
  it("refuses somebody signed out", async () => {
    const res = await req("/admin/billing", { headers: { "X-Dev-Anonymous": "true" } });
    expect(res.status).toBeGreaterThanOrEqual(302);
    expect(res.status).not.toBe(200);
  });

  it("404s an API token, and never offers it the section", async () => {
    await ensurePersonalAccount(env as any, ALICE, now());
    const minted = await req(
      "/api/tokens",
      as(ALICE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "cli" }),
      })
    );
    const { token } = await minted.json<{ token: string }>();

    const res = await req("/admin/billing", withToken(token));
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('data-panel="billing-change-plan"');
    // …and a token holding the portal never even sees the nav item.
    expect(await page("/admin", withToken(token))).not.toContain('data-nav="billing"');
    // Above all: no checkout link prefilled with its owner's address.
    expect(body).not.toContain("lemonsqueezy");
  });

  it("shows a plain member the page, without the operator's control-plane link", async () => {
    const { team } = await twoWorkspaces();
    const body = await page("/admin/billing", as(BOB, selecting(team)));
    expect(body).toContain('data-panel="billing-usage"');
    expect(body).not.toContain("data-operator-account");
    expect(body).not.toContain("/admin/platform/accounts/");
  });

  it("offers a super admin the control-plane link for the workspace they are in", async () => {
    const account = await ensurePersonalAccount(env as any, SUPER, now());
    const body = await page("/admin/billing", as(SUPER));
    expect(body).toContain(`data-operator-account="${account!.id}"`);
    expect(body).toContain(`href="/admin/platform/accounts/${account!.id}"`);
  });
});

// --- the source of the numbers ------------------------------------------------

describe("workspaceBilling reads entitlement, not the invoice", () => {
  it("reports the effective plan and its limits under a live override", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, now());
    await setPlanOverride(env as any, account!, {
      plan: "team",
      expiresAt: null,
      note: null,
      actor: { email: SUPER, role: "super_admin" },
      now: now(),
    });
    const fresh = await getAccount(env as any, account!.id);

    const billing = await workspaceBilling(env as any, fresh!, ALICE);
    expect(billing.plan).toBe("team");
    expect(billing.limits).toEqual(PLANS.team);
    // Team is the top tier, so a comped workspace is offered nothing further.
    expect(billing.nextPlan).toBeNull();
    expect(billing.override).toEqual({ billedPlan: "free", expiresAt: null });
  });

  it("carries no override field at all when the plan and the subscription agree", async () => {
    const account = await ensurePersonalAccount(env as any, ALICE, now());
    const billing = await workspaceBilling(env as any, account!, ALICE);
    expect(billing.plan).toBe("free");
    expect(billing.override).toBeUndefined();
  });
});
