import { describe, it, expect, beforeEach } from "vitest";
import { initDb, clearR2, req, as } from "./fixtures";
import { brandLockup, brandMark, MARK_PATH, MARK_BLUE } from "../src/pages";

/**
 * The sign-in surface (issue #24, re-branded in issue #37).
 *
 * `/login` is the one page a person meets *before* they are anybody, and it is
 * immediately followed by a screen this app does not own: Cloudflare Access
 * hosts the one-time-code prompt itself. So this page carries the whole brand
 * burden for the handoff — it has to look like the product they are signing in
 * to, and it has to say plainly what is about to happen, or the Access screen
 * reads as an unrelated third party asking for their email.
 *
 * What the Worker cannot style (the Access OTP screen) is a Zero Trust branding
 * setting instead — see docs/DEPLOY_RTFX.md §5d.
 */

const SUPER = "admin@test.com";
const ANON = { headers: { "X-Dev-Anonymous": "true" } };

beforeEach(async () => {
  await initDb();
  await clearR2();
});

const login = async (init?: RequestInit) => {
  const res = await req("/login", init);
  return { status: res.status, html: await res.text() };
};

describe("brand mark", () => {
  it("is inline SVG, so the sign-in page never waits on a network request", () => {
    expect(brandMark()).toContain("<svg");
    expect(brandMark()).not.toContain("<img");
  });

  it("is decorative to a screen reader — the wordmark next to it carries the name", () => {
    expect(brandMark()).toContain('aria-hidden="true"');
  });

  it("draws the same mark as the favicon, so the tab and the page agree", () => {
    // Assert against the exported constants, the way test/brand.test.ts does.
    // Hard-coding the path and the hex here meant that refining the mark broke
    // this test without anything actually having drifted — the invariant is
    // "one shape, one blue, everywhere", not "this particular shape forever".
    expect(brandMark()).toContain(MARK_PATH);
    expect(brandMark().toLowerCase()).toContain(MARK_BLUE.slice(1).toLowerCase());
  });

  it("renders the product as a wordmark-only lockup", () => {
    expect(brandLockup()).toContain("rtfx<span>.pro</span>");
    expect(brandLockup()).not.toContain("<svg");
  });
});

describe("signed-out sign-in page", () => {
  it("leads with the rtfx.pro wordmark, not the old mark", async () => {
    const { status, html } = await login(ANON);
    expect(status).toBe(200);
    expect(html).toContain("data-brand-lockup");
    expect(html).toContain("rtfx<span>.pro</span>");
  });

  it("uses the same wordmark treatment as the dashboard header", async () => {
    const { html } = await login(ANON);
    expect(html).toContain("rtfx<span>.pro</span>");
  });

  it("says a code is coming, where from, and that there is no password", async () => {
    const { html } = await login(ANON);
    expect(html).toMatch(/one-time code/i);
    expect(html).toMatch(/no password/i);
  });

  it("warns that the next screen is Cloudflare's, so it doesn't read as a phish", async () => {
    const { html } = await login(ANON);
    expect(html).toMatch(/Cloudflare/);
    expect(html).toMatch(/next screen|takes you to|hands you (over )?to/i);
  });

  it("still hands off to /admin, which is what triggers the code", async () => {
    const { html } = await login(ANON);
    expect(html).toContain('href="/admin" data-cta="sign-in"');
  });

  it("still offers the way in for somebody without an invitation", async () => {
    const { html } = await login(ANON);
    expect(html).toContain('data-cta="request-access"');
  });

  it("sets expectations about the code itself rather than leaving people waiting", async () => {
    const { html } = await login(ANON);
    expect(html).toMatch(/spam|junk/i);
    expect(html).toContain("data-otp-help");
  });
});

describe("the other two sign-in states are the same page", () => {
  it("brands the signed-in state", async () => {
    const { status, html } = await login(as(SUPER));
    expect(status).toBe(200);
    expect(html).toContain("data-brand-lockup");
    expect(html).toContain(`data-state="signed-in"`);
    expect(html).toContain(SUPER);
  });

  it("brands the paused state, and still explains rather than forbids", async () => {
    const paused = "paused@beta.com";
    await req("/api/users", as(SUPER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: paused }),
    }));
    await req(`/api/users/${encodeURIComponent(paused)}/disable`, as(SUPER, { method: "POST" }));

    const res = await req("/login", as(paused));
    const html = await res.text();
    expect(res.status).toBe(403);
    expect(html).toContain("data-brand-lockup");
    expect(html).toContain(`data-state="paused"`);
    expect(html).toMatch(/Nothing has been deleted/);
  });

  it("keeps a signed-in person's page out of search results", async () => {
    const { html } = await login(as(SUPER));
    expect(html).toContain(`<meta name="robots" content="noindex,nofollow">`);
  });

  it("offers a real Cloudflare Access logout link", async () => {
    const { html } = await login(as(SUPER));
    expect(html).toContain('href="/logout" data-cta="logout"');
  });

  it("keeps the public sign-out page indexable, because it explains how to get in", async () => {
    const { html } = await login(ANON);
    expect(html).toContain("index,follow");
  });
});
