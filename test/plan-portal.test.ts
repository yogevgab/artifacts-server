import { describe, it, expect } from "vitest";
import { settingsPage, overviewPage, type OverviewInput } from "../src/admin";
import type { PortalViewer } from "../src/portal";
import type { WorkspaceBilling } from "../src/plan-copy";
import { PLANS } from "../src/quota";

/**
 * Settings' workspace-plan row and Overview's near-limit banner (issue:
 * free-to-paid path). Both read `PortalViewer.workspace.billing`, which the
 * request layer (src/index.ts, not owned here) is expected to populate with
 * `workspaceBilling()` from src/plan-copy.ts — see that file's tests for the
 * D1/checkout-URL behavior. These tests exercise the rendering logic directly
 * against a hand-built `PortalViewer`, the same pattern test/posthog.test.ts
 * uses for settingsPage.
 */

const baseViewer: PortalViewer = {
  email: "owner@test.com",
  isAdmin: false,
  role: "member",
  isTokenCaller: false,
  workspace: {
    id: "acct_1",
    name: "owner@test.com",
    kind: "personal",
    role: "owner",
    count: 1,
  },
};

function billing(overrides: Partial<WorkspaceBilling> = {}): WorkspaceBilling {
  return {
    plan: "free",
    limits: PLANS.free,
    usage: { artifacts: 0, storageBytes: 0 },
    warning: null,
    nextPlan: "pro",
    checkout: { pro: null, team: null },
    ...overrides,
  };
}

const overviewInput = (viewer: PortalViewer): OverviewInput => ({
  viewer,
  rows: [],
  grants: new Map(),
  versions: new Map(),
  views: { counts: new Map(), recent: new Map() },
  tokens: null,
  users: null,
});

describe("Settings: workspace-plan row", () => {
  it("falls back to a plain 'Free' badge with no usage line when billing hasn't been computed", () => {
    const html = settingsPage(baseViewer);
    expect(html).toContain('data-setting="workspace-plan"');
    expect(html).toMatch(/data-badge="workspace-plan">Free</);
    expect(html).not.toContain("data-upgrade-link");
    expect(html).not.toContain("Beta");
  });

  it("shows the plan label and real usage numbers against the plan's limits", () => {
    const viewer = {
      ...baseViewer,
      workspace: { ...baseViewer.workspace!, billing: billing({ usage: { artifacts: 6, storageBytes: 41 * 1024 * 1024 } }) },
    };
    const html = settingsPage(viewer);
    expect(html).toMatch(/6 of 10 artifacts/);
    expect(html).toMatch(/41\.0 MB of 100\.0 MB/);
  });

  it("links to checkout for the next plan up when a checkout URL is available", () => {
    const viewer = {
      ...baseViewer,
      workspace: {
        ...baseViewer.workspace!,
        billing: billing({ checkout: { pro: "https://store.lemonsqueezy.com/checkout/buy/v1", team: null } }),
      },
    };
    const html = settingsPage(viewer);
    expect(html).toContain('data-upgrade-link="pro"');
    expect(html).toContain('href="https://store.lemonsqueezy.com/checkout/buy/v1"');
    expect(html).toContain("Upgrade to Pro");
    expect(html).toContain("$12/mo");
  });

  it("says upgrade isn't configured, rather than showing a dead link, when checkoutUrl returned null", () => {
    const viewer = {
      ...baseViewer,
      workspace: { ...baseViewer.workspace!, billing: billing({ checkout: { pro: null, team: null } }) },
    };
    const html = settingsPage(viewer);
    expect(html).not.toContain("data-upgrade-link");
    expect(html).toContain("Upgrade not configured on this deployment.");
  });

  it("shows no upgrade control for a workspace already on the top plan", () => {
    const viewer = {
      ...baseViewer,
      workspace: {
        ...baseViewer.workspace!,
        billing: billing({
          plan: "team",
          limits: PLANS.team,
          nextPlan: null,
          checkout: { pro: null, team: null },
        }),
      },
    };
    const html = settingsPage(viewer);
    expect(html).toMatch(/data-badge="workspace-plan">Team</);
    expect(html).not.toContain("data-upgrade-link");
    expect(html).not.toContain("Upgrade not configured");
  });

  it("never constructs a checkout link by hand — every href comes straight from billing.checkout", () => {
    const viewer = {
      ...baseViewer,
      workspace: {
        ...baseViewer.workspace!,
        billing: billing({ checkout: { pro: "https://store.lemonsqueezy.com/checkout/buy/pro-variant", team: null } }),
      },
    };
    const html = settingsPage(viewer);
    // No hand-rolled lemonsqueezy URL construction anywhere else in the row.
    const row = html.slice(html.indexOf('data-setting="workspace-plan"'));
    const hrefs = [...row.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    for (const href of hrefs) {
      if (href.includes("lemonsqueezy")) expect(href).toBe("https://store.lemonsqueezy.com/checkout/buy/pro-variant");
    }
  });
});

describe("Overview: near-limit banner", () => {
  it("shows nothing when billing hasn't been computed", () => {
    const html = overviewPage(overviewInput(baseViewer));
    expect(html).not.toContain('data-banner="usage-warning"');
  });

  it("shows nothing when usage is well under both limits", () => {
    const viewer = { ...baseViewer, workspace: { ...baseViewer.workspace!, billing: billing() } };
    const html = overviewPage(overviewInput(viewer));
    expect(html).not.toContain('data-banner="usage-warning"');
  });

  it("appears at >=80% of the artifact limit, states the fact, and links to checkout", () => {
    const viewer = {
      ...baseViewer,
      workspace: {
        ...baseViewer.workspace!,
        billing: billing({
          usage: { artifacts: 8, storageBytes: 0 },
          warning: { limit: "artifacts", ratio: 0.8, current: 8, max: 10 },
          checkout: { pro: "https://store.lemonsqueezy.com/checkout/buy/pro-variant", team: null },
        }),
      },
    };
    const html = overviewPage(overviewInput(viewer));
    expect(html).toContain('data-banner="usage-warning"');
    expect(html).toContain("80%");
    expect(html).toContain("8 of 10");
    expect(html).toContain('href="https://store.lemonsqueezy.com/checkout/buy/pro-variant"');
    expect(html).toContain('data-upgrade-link="pro"');
  });

  it("appears for storage too, formatted in bytes rather than a raw count", () => {
    const viewer = {
      ...baseViewer,
      workspace: {
        ...baseViewer.workspace!,
        billing: billing({
          usage: { artifacts: 0, storageBytes: 85 * 1024 * 1024 },
          warning: { limit: "storage", ratio: 0.85, current: 85 * 1024 * 1024, max: 100 * 1024 * 1024 },
        }),
      },
    };
    const html = overviewPage(overviewInput(viewer));
    expect(html).toContain('data-banner="usage-warning"');
    expect(html).toMatch(/85\.0 MB of 100\.0 MB/);
  });

  it("says upgrading isn't configured rather than a dead link when checkoutUrl is null", () => {
    const viewer = {
      ...baseViewer,
      workspace: {
        ...baseViewer.workspace!,
        billing: billing({
          usage: { artifacts: 9, storageBytes: 0 },
          warning: { limit: "artifacts", ratio: 0.9, current: 9, max: 10 },
          checkout: { pro: null, team: null },
        }),
      },
    };
    const html = overviewPage(overviewInput(viewer));
    expect(html).toContain('data-banner="usage-warning"');
    expect(html).not.toContain("data-upgrade-link");
    expect(html).toContain("isn't configured on this deployment yet.");
  });

  it("stays silent for a team-plan workspace near its limit — there is nowhere left to upgrade to", () => {
    const viewer = {
      ...baseViewer,
      workspace: {
        ...baseViewer.workspace!,
        billing: billing({
          plan: "team",
          limits: PLANS.team,
          usage: { artifacts: 9000, storageBytes: 0 },
          warning: { limit: "artifacts", ratio: 0.9, current: 9000, max: 10000 },
          nextPlan: null,
        }),
      },
    };
    const html = overviewPage(overviewInput(viewer));
    expect(html).not.toContain('data-banner="usage-warning"');
  });

  it("never colour-signals alone — the sentence states the percentage and the numbers in text", () => {
    const viewer = {
      ...baseViewer,
      workspace: {
        ...baseViewer.workspace!,
        billing: billing({
          usage: { artifacts: 8, storageBytes: 0 },
          warning: { limit: "artifacts", ratio: 0.8, current: 8, max: 10 },
        }),
      },
    };
    const html = overviewPage(overviewInput(viewer));
    const banner = html.slice(html.indexOf('data-banner="usage-warning"'), html.indexOf('data-banner="usage-warning"') + 400);
    // The plain text (not just markup/attrs) carries the percentage and counts.
    const text = banner.replace(/<[^>]+>/g, " ");
    expect(text).toMatch(/80%/);
    expect(text).toMatch(/8 of 10/);
  });
});
