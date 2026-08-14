import { beforeEach, describe, expect, it } from "vitest";
import { initDb, clearR2, req } from "./fixtures";
import { PLANS } from "../src/quota";

/**
 * The landing page's pricing section (issue: free-to-paid path, §1). Three
 * tiers plus Enterprise, built from the real numbers in `PLANS` where a tier is
 * actually enforced — this asserts the numbers
 * that reach the page actually match src/quota.ts, not a hand-typed copy of
 * them that could drift.
 */

const ANON = { headers: { "X-Dev-Anonymous": "true" } };

beforeEach(async () => {
  await initDb();
  await clearR2();
});

async function landing(): Promise<string> {
  const res = await req("/", ANON);
  expect(res.status).toBe(200);
  return res.text();
}

describe("pricing section", () => {
  it("is reachable at #pricing without adding a new top-level section", async () => {
    const html = await landing();
    expect(html).toContain('id="pricing"');
    // Issue #35 invariant (test/positioning.test.ts): the page stays at
    // hero + one band + waitlist. Pricing lives inside the product band as a
    // <div>, not a fourth <section>.
    expect((html.match(/<section\b/g) ?? []).length).toBe(3);
  });

  it("names every public tier", async () => {
    const html = await landing();
    for (const tier of ["free", "pro", "team", "enterprise"]) {
      expect(html, `missing tier ${tier}`).toContain(`data-tier="${tier}"`);
    }
  });

  it("shows the real limits from PLANS, not invented numbers", async () => {
    const html = await landing();
    expect(html).toContain(`${PLANS.free.maxArtifacts} artifacts`);
    expect(html).toContain(`${PLANS.pro.maxArtifacts} artifacts`);
    // num() adds thousands separators for team's 10,000.
    expect(html).toContain("10,000 artifacts");
    expect(html).toMatch(/100\.0\s*MB storage/);
    expect(html).toMatch(/5\.0\s*GB storage/);
    expect(html).toMatch(/50\.0\s*GB storage/);
  });

  it("shows the real prices", async () => {
    const html = await landing();
    expect(html).toContain("Free");
    expect(html).toContain("$12");
    expect(html).toContain("$40");
  });

  it("states version retention honestly for each plan", async () => {
    const html = await landing();
    expect(html).toContain(`Keeps the last ${PLANS.free.keepVersions} versions`);
    expect(html).toContain("Full version history");
  });

  it("points only self-serve tiers at signup and contact tiers at a real talk-to-us route", async () => {
    // Free and Pro can be completed by the buyer. Team/Enterprise need human
    // setup until team invites, operator provisioning and enterprise asks are
    // real self-serve flows; the CTA must say that instead of pretending.
    const html = await landing();
    for (const plan of ["free", "pro"]) {
      const card = html.slice(html.indexOf(`data-tier="${plan}"`));
      const cta = card.slice(0, card.indexOf("</div>"));
      expect(cta, plan).toContain('href="/signup"');
      expect(cta, plan).toContain('data-cta-kind="self-serve"');
      expect(cta, plan).not.toContain("#waitlist");
      expect(cta, plan).not.toContain("lemonsqueezy");
    }
    for (const plan of ["team", "enterprise"]) {
      const card = html.slice(html.indexOf(`data-tier="${plan}"`));
      const cta = card.slice(0, card.indexOf("</div>"));
      expect(cta, plan).toContain(`href="/contact?plan=${plan}"`);
      expect(cta, plan).toContain('data-cta-kind="contact"');
      expect(cta, plan).toContain("Talk to us");
      expect(cta, plan).not.toContain("#waitlist");
      expect(cta, plan).not.toContain("lemonsqueezy");
    }
  });

  it("links each paid/contact tier to a dedicated plan page", async () => {
    const html = await landing();
    for (const plan of ["pro", "team", "enterprise"]) {
      expect(html, `missing plan page for ${plan}`).toContain(`href="/${plan}"`);
      expect(html, `missing tier page marker for ${plan}`).toContain(`data-tier-page="${plan}"`);
    }
  });

  it("adds no preview-stage framing and no self-serve claim it can't back", async () => {
    const html = await landing();
    const lower = html.toLowerCase();
    expect(lower).not.toMatch(/\bbetas?\b/);
    expect(lower).not.toMatch(/\bmvp\b/);
    expect(lower).not.toMatch(/\bearly access\b/);
  });

  it("no longer claims there is no billing, now that plans exist", async () => {
    const html = await landing();
    expect(html).not.toMatch(/there is no billing/i);
  });
});
