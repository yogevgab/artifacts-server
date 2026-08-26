import { describe, it, expect, beforeEach } from "vitest";
import { initDb, clearR2, req, as } from "./fixtures";
import { MARK_PATH, MARK_BLUE, siteHeader, siteFooter } from "../src/pages";
import { ogImageSvg } from "../src/seo";

/**
 * One product, one mark, one shell (issue #35).
 *
 * Before this, five surfaces drew five different pieces of chrome: the landing
 * page and the docs page each had their own copy of a header with a gradient
 * dot for a logo, the dashboard had a text wordmark, the gallery had a bare
 * `<h1>Artifacts</h1>`, and the social card had a third mark again. A person
 * moving between them had no way to tell it was one product.
 *
 * These tests are about that continuity, so they assert on the shared markers —
 * the lockup, the mark's own geometry, the chrome — rather than on copy, which
 * is expected to keep changing.
 */

const SUPER = "admin@test.com";
const ANON = { headers: { "X-Dev-Anonymous": "true" } };

beforeEach(async () => {
  await initDb();
  await clearR2();
});

const html = async (path: string, init?: RequestInit) => await (await req(path, init)).text();

/** Every surface a person can reach, public and signed-in. */
const PUBLIC_PAGES = ["/", "/docs", "/login"];
const APP_PAGES = ["/admin", "/admin/artifacts", "/admin/gallery", "/admin/settings"];

describe("the rtfx mark is the same mark everywhere", () => {
  it("uses a wordmark-only lockup on every public page", async () => {
    for (const path of PUBLIC_PAGES) {
      const body = await html(path, ANON);
      expect(body, path).toContain("data-brand-lockup");
      expect(body, path).toContain("rtfx<span>.pro</span>");
    }
  });

  it("uses the same wordmark-only lockup on every dashboard section", async () => {
    for (const path of APP_PAGES) {
      const body = await html(path, as(SUPER));
      expect(body, path).toContain("data-brand-lockup");
      expect(body, path).toContain("rtfx<span>.pro</span>");
    }
  });

  it("appears on the 404 an unauthorized or missing artifact gets", async () => {
    const body = await html("/no-such-artifact/");
    expect(body).toContain("data-brand-lockup");
    expect(body).toContain("rtfx<span>.pro</span>");
  });

  it("is redrawn — not reinvented — on the social card", () => {
    const svg = ogImageSvg();
    expect(svg).toContain(MARK_PATH);
    expect(svg).toContain(MARK_BLUE);
    // The old card's stand-in was a plain gradient circle with no relation to
    // the favicon. If that ever comes back, this fails.
    expect(svg).not.toContain('<circle cx="98" cy="92"');
  });

  it("is the same shape the favicon draws, so the tab agrees with the page", async () => {
    const body = await html("/", ANON);
    const favicon = /<link rel="icon" href="([^"]+)">/.exec(body)?.[1] ?? "";
    expect(decodeURIComponent(favicon)).toContain(MARK_PATH);
    expect(decodeURIComponent(favicon).toLowerCase()).toContain(MARK_BLUE.slice(1));
  });
});

describe("public pages share one header and one footer", () => {
  it("renders the same primary nav and footer markup on all three", async () => {
    for (const path of PUBLIC_PAGES) {
      const body = await html(path, ANON);
      expect(body, path).toContain('<nav class="nav" aria-label="Primary">');
      expect(body, path).toContain('<footer class="site">');
      expect(body, path).toContain('<nav aria-label="Footer">');
      // Same destinations, in the same order, wherever you are.
      expect(body, path).toContain('href="/docs#use-cases"');
      expect(body, path).toContain('data-cta="signup"');
      expect(body, path).toContain('href="/llms.txt"');
    }
  });

  it("drops only the link to the page you are already on", async () => {
    expect(siteHeader("home")).not.toContain('data-nav="home"');
    expect(siteHeader("docs")).not.toContain('data-cta="docs"');
    // Offering "Sign in →" on the sign-in page is chrome pointing at itself.
    expect(siteHeader("login")).not.toContain('data-cta="sign-in"');
    expect(siteHeader("login")).toContain('data-nav="home"');
  });

  it("keeps the footer identical on every public page", async () => {
    const footer = siteFooter();
    for (const path of PUBLIC_PAGES) {
      expect(await html(path, ANON), path).toContain(footer);
    }
  });

  it("hides only the orientation links on a narrow screen, never the next step", async () => {
    const body = await html("/", ANON);
    expect(body).toContain('.nav a[data-nav="use-cases"],.nav a[data-nav="home"]{display:none}');
    expect(body).not.toMatch(/\.nav a\[data-cta="signup"\][^{]*\{display:none/);
  });
});

describe("the landing page leads with one idea", () => {
  it("keeps the Claude tagline above the fold while the h1 states the promise plainly", async () => {
    const body = await html("/", ANON);
    expect(body).toContain("<h1>Turn Claude's work into a private link you can send.</h1>");
    expect(body).toContain("Claude creates. We share.");
    expect(body.match(/<h1[ >]/g) ?? []).toHaveLength(1);
  });

  /**
   * The three-step path is the whole point of the rewrite: somebody who has
   * never opened a terminal has to be able to read what happens to their work
   * before the page shows them a command. Structure is pinned on the markup so
   * the wording can keep improving; what cannot vanish is that there are three
   * of them and that they come before the install cards.
   */
  it("explains the round trip in three plain steps before it shows a command", async () => {
    const body = await html("/", ANON);
    const steps = body.slice(body.indexOf('class="steps"'), body.indexOf('class="installs"'));
    expect((steps.match(/<div class="step">/g) ?? []).length).toBe(3);
    expect(steps).not.toContain("<pre");
    expect(body.indexOf('class="steps"')).toBeLessThan(body.indexOf('class="installs"'));
  });

  /**
   * "Can I add this to the Claude I already use?" decides the visit, and the
   * answer used to be nine sections down. Both install cards carry the literal
   * first step — a download link, or the real slash commands — because a card
   * that paraphrases an install is one a reader cannot follow.
   */
  it("offers both install paths near the top, each with its real first step", async () => {
    const body = await html("/", ANON);
    const desktop = body.slice(
      body.indexOf('data-install="claude-desktop"'),
      body.indexOf('data-install="claude-code"')
    );
    expect(desktop).toContain("rtfx.dxt");
    expect(desktop).toContain("releases/download/");
    expect(desktop.toLowerCase()).toContain("claude desktop");

    const code = body.slice(body.indexOf('data-install="claude-code"'));
    expect(code).toContain("/plugin marketplace add yogevgab/artifacts-server");
    expect(code).toContain("/plugin install rtfx@rtfx");
    expect(code).toContain("/rtfx:login");
    expect(code).toContain("/rtfx:publish");

    // Both sit above the connector grid, the pricing table and the final CTA.
    expect(body.indexOf('class="installs"')).toBeLessThan(body.indexOf('data-landing="connectors"'));
    expect(body.indexOf('class="installs"')).toBeLessThan(body.indexOf('id="pricing"'));
  });

  /**
   * The non-developer examples. Without them the page argues its case entirely
   * in build outputs and terminal sessions, which is a description of one of the
   * four connectors rather than of the product.
   */
  it("shows what a non-developer would send, not only a build output", async () => {
    const body = (await html("/", ANON)).toLowerCase();
    for (const example of ["client", "pdf", "report", "demo"]) {
      expect(body, `landing missing a plain example: ${example}`).toContain(example);
    }
    // And the update story, which is the reason to use a link at all.
    expect(body).toContain("update it without resending");
  });

  it("promises secure, access-protected sharing rather than a feature list", async () => {
    const body = (await html("/", ANON)).toLowerCase();
    expect(body).toContain("access-protected");
    expect(body).toContain("secure");
  });

  it("is materially less stacked than the seven-section page it replaces", async () => {
    const body = await html("/", ANON);
    const sections = (body.match(/<section[ >]/g) ?? []).length;
    expect(sections).toBeLessThanOrEqual(3);
  });

  it("moved the long-form copy to /docs instead of deleting it", async () => {
    const landing = await html("/", ANON);
    const docs = await html("/docs", ANON);

    // Gone from the landing page…
    expect(landing).not.toContain('<table class="compare"');
    expect(landing).not.toContain('id="use-cases"');
    expect(landing).not.toContain("Client-ready links that stay off the open web");

    // …and still crawlable, on the page somebody goes to for detail.
    expect(docs).toContain('id="use-cases"');
    expect(docs).toContain('id="why"');
    expect(docs).toContain('<table class="compare"');
    expect(docs).toContain("Client-ready links that stay off the open web");
    expect(docs).toContain("Ship an agent's output without a pipeline");
  });

  it("uses valid links for the hero CTAs, not nested interactive controls", async () => {
    const body = await html("/", ANON);
    expect(body).toContain('<a class="link-button" href="/signup" data-cta="signup">Start free</a>');
    expect(body).toContain('<a class="ghost link-button" href="/docs" data-cta="docs">See how it works</a>');
    expect(body).not.toMatch(/<a[^>]*>\s*<button/i);
  });

  it("links to what it no longer says, so nothing is orphaned", async () => {
    const body = await html("/", ANON);
    for (const href of ["/docs#use-cases", "/docs#why", "/docs#agents", "/docs#faq"]) {
      expect(body, href).toContain(`href="${href}"`);
    }
  });

  it("keeps every SEO marker the simplification could have cost it", async () => {
    const body = await html("/", ANON);
    expect(body).toMatch(/<meta name="description" content="[^"]{80,}">/);
    expect(body).toContain('<meta property="og:image"');
    expect(body).toContain('application/ld+json');
    // The product's own keywords still appear in crawlable prose, not only in
    // structured data.
    const text = body.toLowerCase();
    for (const term of ["version", "access", "claude", "view log", "artifact"]) {
      expect(text, term).toContain(term);
    }
  });

  it("still carries the final conversion section the whole funnel depends on", async () => {
    const body = await html("/", ANON);
    expect(body).toContain('id="waitlist"');
    expect(body).toContain('data-cta="signup-final"');
  });

  /**
   * What stood above the fold was a fake screenshot: a rounded window with
   * macOS traffic-light dots and grey bars standing in for text, carrying an
   * `aria-label` that asserted specific facts ("version 4, shared with three
   * people") about content that did not exist. For a product whose entire
   * posture is that it does not overclaim, that was the one element on the site
   * that was not truthful in kind — and it was the most prominent one.
   *
   * It is now the real round trip, rendered as HTML: the actual publish command
   * and the state that exists the moment it returns.
   */
  it("shows a real round trip above the fold, not a picture of one", async () => {
    const body = await html("/", ANON);
    expect(body).toContain('data-landing="publish"');
    // The command has to be the one that actually works — see docs/CLAUDE_CODE.md.
    expect(body).toContain("/rtfx:publish");
    // …and the page must state the claim the whole access model rests on.
    expect(body).toMatch(/404/);
  });

  it("no longer ships the fake-screenshot chrome", async () => {
    const body = await html("/", ANON);
    for (const remnant of ["shot-dot", "shot-line", "product-shot"]) {
      expect(body, `fake screenshot remnant: ${remnant}`).not.toContain(remnant);
    }
    // The lying accessible name in particular must never come back.
    expect(body).not.toContain("Preview of the rtfx.pro dashboard");
  });

  /**
   * An invite-only product asks a stranger to trust it before it will let them
   * in. A public, MIT-licensed repository and a written security model are the
   * strongest answer available to "what am I being asked to trust?", and they
   * cost nothing — but only if the pages a signed-out visitor can reach
   * actually link to them.
   */
  it("points every public page at the source and the security model", async () => {
    for (const path of PUBLIC_PAGES) {
      const body = await html(path, ANON);
      expect(body, path).toContain('data-nav="source"');
      expect(body, path).toContain('data-nav="security"');
      expect(body, path).toContain("github.com/yogevgab/artifacts-server");
    }
  });
});

describe("the docs page absorbed the material without losing its own", () => {
  it("lists the new sections in its table of contents", async () => {
    const body = await html("/docs", ANON);
    expect(body).toContain('href="#use-cases"');
    expect(body).toContain('href="#why"');
  });

  /**
   * /docs used to open on "What rtfx.pro is" — four paragraphs of model before a
   * single runnable line. That is the right opening for somebody evaluating the
   * architecture and the wrong one for the larger group arriving from the
   * homepage having already decided. The quickstart is first now, and the
   * architecture is one screen down rather than deleted.
   */
  it("opens on a quickstart rather than an architecture essay", async () => {
    const body = await html("/docs", ANON);
    expect(body).toContain('<section id="start" data-docs="start">');
    expect(body).toContain('<a href="#start">');
    expect(body.indexOf('id="start"')).toBeLessThan(body.indexOf('id="overview"'));

    const start = body.slice(body.indexOf('id="start"'), body.indexOf('id="overview"'));
    // Both setups, each runnable from what is on the page.
    expect(start).toContain("rtfx.dxt");
    expect(start).toContain("/plugin marketplace add yogevgab/artifacts-server");
    expect(start).toContain("/rtfx:login");
    // …and what to actually say once connected.
    expect(start.toLowerCase()).toContain("publish this page as a private link");
  });

  /**
   * The one thing the quickstart must not do to earn its brevity: imply the
   * hosted endpoint is a third local install. It publishes bytes sent in the
   * call, and the section that mentions it has to say so where it mentions it.
   */
  it("keeps the hosted-endpoint caveat attached in the quickstart itself", async () => {
    const body = await html("/docs", ANON);
    const start = body.slice(body.indexOf('id="start"'), body.indexOf('id="overview"'));
    expect(start.toLowerCase()).toContain("content sent inside the tool call");
    expect(start.toLowerCase()).toMatch(/cannot reach your filesystem|not a path|never reads/);
  });

  it("keeps its FAQ structured data answering from visible prose", async () => {
    const body = await html("/docs", ANON);
    const faq = [...body.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
      .map(([, json]) => JSON.parse(json))
      .find((b) => b["@type"] === "FAQPage");
    expect(faq).toBeDefined();
    for (const entry of faq.mainEntity) expect(body).toContain(entry.name);
  });
});
