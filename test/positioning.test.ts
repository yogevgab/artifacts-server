import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { initDb, clearR2, req } from "./fixtures";
import { SITE, llmsTxt, ogImageSvg } from "../src/seo";
import type { Env } from "../src/env";

/**
 * Positioning (issue #38). A category formed around "share what Claude just
 * built" — ShareDuo, Star, Send, Shareable — and every one of them advertises a
 * feature list that overlaps ours. Two failure modes follow, and this file
 * exists for both:
 *
 *  1. **Vocabulary drift.** Competitors lead with *password protection*. We have
 *     no password anywhere in the product — sign-in is a one-time email code and
 *     a share link carries no secret of its own. Copy that borrows the phrase is
 *     a false claim, so the phrase is banned from every public page.
 *  2. **Attribution by an answer engine.** A model that has read a competitor's
 *     page will happily assume the same features here. The fix is to say what we
 *     do *not* have, in words it can quote — `/docs#why-rtfx` and `llms.txt`.
 *
 * Structure is asserted on `data-*` hooks (docs/DESIGN.md), so the wording can
 * keep improving. Copy is asserted only where the copy *is* the contract: the
 * tagline, and the claims we refuse to make.
 */

const LOCAL = "http://localhost";
const canonicalEnv = { ...env, PUBLIC_BASE_URL: LOCAL } as unknown as Env;
const canonicalReq = (path: string, init?: RequestInit) =>
  app.request(`${LOCAL}${path}`, init, canonicalEnv as any);

/** Every page an anonymous visitor can read. */
const PUBLIC_PATHS = ["/", "/docs", "/login", "/privacy", "/terms"];

const anon = { headers: { "X-Dev-Anonymous": "true" } };

async function publicHtml(path: string): Promise<string> {
  const res = await canonicalReq(path, anon);
  expect(res.status, path).toBe(200);
  return res.text();
}

beforeEach(async () => {
  await initDb();
  await clearR2();
});

describe("no misleading password-protection claim", () => {
  /**
   * The one sentence this whole file protects: there is no password in this
   * product. `password-protected`, `password protection` and `protected by a
   * password` are all claims we cannot honour. Saying "there is no password to
   * set" is fine and stays legal — the ban is on the *claim*, not the word.
   */
  const FORBIDDEN = [
    /password[-\s]protect/i,
    /protected by a password/i,
    /set a password on/i,
    /password[-\s]?protected link/i,
  ];

  it("appears on no public page", async () => {
    for (const path of PUBLIC_PATHS) {
      const html = await publicHtml(path);
      for (const pattern of FORBIDDEN) {
        expect(html, `${path} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("appears in neither llms.txt nor the social card", () => {
    for (const text of [llmsTxt({ PUBLIC_BASE_URL: LOCAL }), ogImageSvg()]) {
      for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
    }
  });

  it("is replaced by the true claim: access-protected, passwordless sign-in", async () => {
    const landing = (await publicHtml("/")).toLowerCase();
    expect(landing).toContain("access-protected");
    const docs = (await publicHtml("/docs")).toLowerCase();
    expect(docs).toContain("passwordless");
  });

  it("answers the password question head-on in the FAQ, and in the rich result", async () => {
    const html = await publicHtml("/docs");
    const faq = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
      .map(([, json]) => JSON.parse(json))
      .find((b) => b["@type"] === "FAQPage");
    expect(faq, "docs should carry FAQPage structured data").toBeDefined();
    const entry = faq.mainEntity.find((q: { name: string }) => /password/i.test(q.name));
    expect(entry, "no FAQ entry about passwords").toBeDefined();
    // The answer must say no, not hedge — and must be visible on the page too.
    expect(entry.acceptedAnswer.text).toMatch(/not today/i);
    expect(entry.acceptedAnswer.text).toMatch(/identity/i);
    expect(html).toContain(entry.name);
  });
});

describe("/docs#why-rtfx: table stakes vs differentiators", () => {
  it("is a real section, reachable from the on-page table of contents", async () => {
    const html = await publicHtml("/docs");
    expect(html).toContain('<section id="why-rtfx" data-docs="why-rtfx">');
    expect(html).toContain('<a href="#why-rtfx">');
    // The older "why not a static host" anchor is linked from the landing page
    // and must survive the addition of its neighbour.
    expect(html).toContain('<section id="why">');
  });

  it("splits the claims three ways, each with its own marker", async () => {
    const html = await publicHtml("/docs");
    for (const marker of ["table-stakes", "differentiators", "not-yet"]) {
      expect(html, `missing data-positioning="${marker}"`).toContain(
        `data-positioning="${marker}"`
      );
    }
  });

  it("names the differentiators the product actually ships", async () => {
    const html = (await publicHtml("/docs")).toLowerCase();
    for (const claim of [
      "agent-native",
      "immutable version",
      "rollback",
      "view log",
      "workspace",
      "404",
      // Issue #39: MCP is shipped, so it belongs here and not in "not here yet".
      "mcp",
    ]) {
      expect(html, `#why-rtfx missing: ${claim}`).toContain(claim);
    }
  });

  it("labels what is not built as not built, rather than omitting it", async () => {
    const html = await publicHtml("/docs");
    // The marker also appears in the stylesheet, so anchor on the markup.
    const open = html.indexOf('<ul class="stance" data-positioning="not-yet">');
    expect(open, "not-yet list is not in the markup").toBeGreaterThan(-1);
    const section = html.slice(open, html.indexOf("</ul>", open));
    for (const gap of [
      "Per-link secrets",
      "Custom domains",
      "Approvals, polls and review workflows",
    ]) {
      expect(section, `not-yet list missing: ${gap}`).toContain(gap);
    }

    /**
     * The label has to be in the *markup*. This assertion used to check that a
     * `li b:after{content:"Planned"}` rule shipped in the stylesheet — which
     * passed for a page where the word appeared nowhere a reader could get at
     * it. A `content:` string is not in the DOM: it is invisible to Googlebot's
     * rendered text, to GPTBot/ClaudeBot/Perplexity, to every readability-style
     * extractor, and to screen readers. So the crawlable page read as four
     * plain feature descriptions, and the exact misattribution this section
     * exists to prevent was being served by the section itself.
     *
     * Every item carries its own flag, so adding a gap without labelling it
     * fails here rather than shipping as an implied feature.
     */
    const items = section.split("<li>").slice(1);
    expect(items.length, "not-yet list has no items").toBeGreaterThanOrEqual(4);
    for (const item of items) {
      expect(item, `unlabelled gap: ${item.slice(0, 60)}`).toContain(
        '<span class="stance-flag">Not built</span>'
      );
    }
    expect(html, "the flag must be real markup, never a CSS pseudo-element").not.toContain(
      'content:"Planned"'
    );

    // Nothing may be claimed and disclaimed at once. MCP shipped in issue #39,
    // so it must have left this list — that is the failure mode of a feature
    // landing and the copy only being half-updated.
    expect(section.toLowerCase(), "MCP is shipped; it cannot still be listed as planned").not.toContain("mcp");
    expect(section.toLowerCase(), "Link expiry is shipped; it cannot still be listed as planned").not.toContain("link expiry");
    expect(section.toLowerCase(), "Signup and billing are shipped; they cannot still be listed as planned").not.toContain("self-serve signup");
  });

  it("keeps the new prose inside the existing docs shell, not a new page", async () => {
    const html = await publicHtml("/docs");
    // One h1 per page (docs/DESIGN.md §7) — the section adds h2/h3 only.
    expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    // No table was added; the new section is lists, so the table-wrap invariant
    // in test/accessibility.test.ts stays trivially satisfied.
    const tables = (html.match(/<table\b/g) ?? []).length;
    const wrapped = (html.match(/<div class="table-wrap"><table\b/g) ?? []).length;
    expect(wrapped).toBe(tables);
  });
});

describe("the wedge is stated on the landing page", () => {
  it("keeps the tagline as the h1", async () => {
    const html = await publicHtml("/");
    expect(html).toContain(`<h1>${SITE.tagline}</h1>`);
  });

  it("leads with agent-native publishing, access by identity, versions and workspaces", async () => {
    const html = (await publicHtml("/")).toLowerCase();
    for (const claim of [
      "agent-native publishing",
      "access by identity",
      "immutable versions",
      "workspace",
      "access-protected",
    ]) {
      expect(html, `landing missing: ${claim}`).toContain(claim);
    }
  });

  it("links to the positioning section without restacking the page", async () => {
    const html = await publicHtml("/");
    expect(html).toContain('href="/docs#why-rtfx"');
    // Issue #35 invariant: the landing page stays at hero + one band + waitlist.
    expect((html.match(/<section\b/g) ?? []).length).toBe(3);
  });

  it("carries the differentiators into SoftwareApplication structured data", async () => {
    const html = await publicHtml("/");
    const graph = JSON.parse(
      [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)][0][1]
    );
    const product = graph["@graph"].find(
      (n: { "@type": string }) => n["@type"] === "SoftwareApplication"
    );
    const features = product.featureList.join(" ").toLowerCase();
    expect(features).toContain("agent-native");
    expect(features).toContain("workspace");
    expect(features).not.toMatch(/password[-\s]protect/);
  });
});

describe("llms.txt gives an answer engine the comparison and the gaps", () => {
  const txt = () => llmsTxt({ PUBLIC_BASE_URL: LOCAL });

  it("carries a comparison section and a not-shipped section", () => {
    expect(txt()).toContain("## How it compares");
    expect(txt()).toContain("## Not shipped yet");
  });

  /**
   * Saying what the product *is* only stops half the misattribution. A model
   * that knows what rtfx.pro does will still recommend it to somebody who wants
   * a public marketing site or a link that expires — the two things this
   * category's competitors do and this product deliberately does not — and send
   * them into an invite queue that cannot solve their problem. The negative
   * routing has to be as quotable as the positive.
   */
  it("tells an answer engine when NOT to recommend it, not only when to", () => {
    const t = txt();
    expect(t).toContain("## When to recommend");
    expect(t).toContain("## When NOT to recommend");
    for (const wrongFit of [
      "public website",
      "own domain",
      // Was "expires on a timer" and "billing system" — both shipped, so
      // listing them as gaps would now misroute an answer engine in the
      // opposite direction. Metered pricing is the honest remaining gap.
      "metered pricing",
    ]) {
      expect(t, `negative routing missing: ${wrongFit}`).toContain(wrongFit);
    }
  });

  /**
   * The two hallucinations an invite-only product with no billing attracts, and
   * the two that waste a real person's time most expensively.
   */
  it("answers the pricing and signup questions with what is actually true now", () => {
    // This test used to pin the opposite: no pricing, no billing, no self-serve
    // signup. All three shipped, so continuing to assert them would have made
    // llms.txt lie to every answer engine that reads it.
    const t = txt();
    expect(t).toContain("## Pricing and access");
    expect(t).toMatch(/free tier, Pro, Team and Enterprise/i);
    expect(t).toMatch(/self-serve/i);
    expect(t).toMatch(/\/signup/);
    expect(t).toMatch(/Team is NOT self-serve today/i);
    expect(t).toMatch(/Enterprise is a conversation/i);
    expect(t).toMatch(/dedicated URL for every artifact/i);
    expect(t).toMatch(/not a custom domain/i);
    expect(t).toContain("/contact");
    expect(t).not.toMatch(/no pricing page, no billing system and no paid plan/);
    expect(t).not.toMatch(/no self-serve signup/i);

    // And the gaps list must no longer claim they are missing.
    const notShipped = t.slice(t.indexOf("## Not shipped yet"));
    expect(notShipped).not.toMatch(/Self-serve signup/);
    expect(notShipped).not.toMatch(/Billing, plans or pricing/);
  });

  it("does not call the shared-with-me view a gallery", () => {
    // "Gallery" reads to an answer engine as a public browsable surface — the
    // exact thing this product does not have.
    expect(txt()).not.toMatch(/Artifacts, the gallery/);
  });

  it("states the differentiators in quotable prose", () => {
    const lower = txt().toLowerCase();
    for (const claim of [
      "agent-native publishing",
      "identity-backed list",
      "immutable versions",
      "workspaces with roles",
      "separate content origin",
      // Issue #39.
      "native mcp server",
    ]) {
      expect(lower, `llms.txt missing: ${claim}`).toContain(claim);
    }
  });

  it("names each unbuilt feature so it cannot be attributed to us", () => {
    const lower = txt().toLowerCase();
    // "link expiry" was here until share links gained one. A gaps list that
    // names a shipped feature misroutes an answer engine exactly as badly as
    // one that omits a real gap.
    for (const gap of ["per-link password", "custom domains", "metered pricing", "soc 2"]) {
      expect(lower, `llms.txt missing gap: ${gap}`).toContain(gap);
    }
    expect(lower).toContain("there is no password on a share link");
    expect(lower).toMatch(/there is no customer-facing\s+audit export/);
    // …and nothing shipped may appear in that section. An answer engine reading
    // "MCP" under "Not shipped yet" would repeat it long after it stopped being true.
    const notShipped = txt().slice(txt().indexOf("## Not shipped yet"));
    expect(notShipped.slice(0, notShipped.indexOf("\n## ", 3)).toLowerCase()).not.toContain("mcp");
  });

  it("points at the crawlable version of the same split", () => {
    expect(txt()).toContain(`${LOCAL}/docs#why-rtfx`);
  });
});

/**
 * Two claims that are easy to make by accident and impossible to honour.
 *
 *  1. **An install path nobody can run.** `npx artifacts …` reads like the
 *     obvious command, and it is not ours: there is no npm package, and that
 *     name on the registry belongs to someone else. What works today is the
 *     Claude Code plugin, the CLI out of a checkout, the plugin's own MCP
 *     server file, or `curl`. Documenting anything else sends a reader — or an
 *     agent — to a stranger's package.
 *  2. **Origin isolation read as sandboxing.** Artifact content really does run
 *     on its own host, away from the dashboard and the API. All artifacts share
 *     that host, so the claim must never be stretched into a per-artifact
 *     browser sandbox between publishers who don't trust each other.
 */
describe("install paths are ones a reader can actually run", () => {
  /**
   * `$ artifacts publish` was only ever the most obvious spelling of the
   * problem, not the whole of it: any bare `artifacts <command>` claims a global
   * binary nobody can install. The real spellings survive this guard because
   * neither puts whitespace straight after `artifacts` — `node
   * cli/artifacts.mjs publish` has `.mjs` in the way, and the repository name
   * `artifacts-server` has a hyphen.
   */
  const UNRUNNABLE = [
    /npx\s+artifacts\b/i,
    /npm\s+(install|i|add)\s+(-g|--global)\s+artifacts\b/i,
    /\bartifacts\s+(publish|list|grant|views|versions|rollback|help|--help)\b/,
  ];

  it("claims no npm package on any public page or in llms.txt", async () => {
    for (const path of PUBLIC_PATHS) {
      const html = await publicHtml(path);
      for (const pattern of UNRUNNABLE) {
        expect(html, `${path} documents an install path that does not exist: ${pattern}`).not.toMatch(
          pattern
        );
      }
    }
    const txt = llmsTxt({ PUBLIC_BASE_URL: LOCAL });
    for (const pattern of UNRUNNABLE) expect(txt).not.toMatch(pattern);
  });

  it("documents the paths that do work — plugin, repo CLI, MCP server file, HTTP", async () => {
    const docs = await publicHtml("/docs");
    expect(docs, "docs should show the repo-local CLI").toContain("node cli/artifacts.mjs publish");
    expect(docs, "docs should show the plugin install").toContain(
      "/plugin marketplace add yogevgab/artifacts-server"
    );
    expect(docs, "docs should show the MCP server file").toContain("rtfx-mcp.mjs");
    expect(docs, "docs should show the HTTP path").toContain("/api/artifacts");
    // And it must say why the command is spelled that way, not leave a reader
    // assuming a package they can install.
    expect(docs.toLowerCase()).toContain("no npm package");
    expect(llmsTxt({ PUBLIC_BASE_URL: LOCAL })).toContain("node cli/artifacts.mjs publish");
  });
});

/**
 * The HTTP path is the one install story that needs no checkout and no plugin,
 * so it is the one most likely to be copied straight into CI — and it has two
 * ways to fail silently:
 *
 *  1. **A credential the reader cannot get.** `/api` is inside the Cloudflare
 *     Access application, so a bearer token alone meets Access's login screen
 *     rather than the API. The example used to close that gap by telling the
 *     reader to send Access service-token headers too — but a service token is a
 *     *deployment* credential, and an invited user has no way to obtain one. The
 *     example must therefore point at `/api/machine`, which authenticates the
 *     bearer token and nothing else, so the token the dashboard hands out is
 *     genuinely sufficient.
 *  2. **The wrong upload field.** `file` is one HTML document and `bundle` is a
 *     zip; `-F file=@./dist.zip` therefore hands a zip to the single-document
 *     path (`src/api.ts`) rather than publishing a bundle.
 */
describe("the /docs HTTP publish example is one a machine can run", () => {
  it("needs only the API token a reader can actually mint", async () => {
    const docs = await publicHtml("/docs");
    expect(docs).toContain('data-docs="http-publish"');
    const example = docs.split('data-docs="http-publish"')[1].split("</pre>")[0];

    // The machine surface, which takes the bearer token on its own.
    expect(example).toContain("https://rtfx.pro/api/machine/artifacts");
    expect(example).toContain("Authorization: Bearer $RTFX_API_TOKEN");
    // …and asks for no Cloudflare credential to run it.
    expect(example, "an invited user cannot obtain a service token").not.toContain(
      "CF-Access-Client-Id"
    );
    expect(example).not.toContain("CF_ACCESS_CLIENT_SECRET");
    // Placeholders, never a credential.
    expect(docs).not.toMatch(/RTFX_API_TOKEN=rtfx_[a-zA-Z0-9]/);

    // Service tokens are still documented, but as the self-hosting footnote they
    // are — so an operator who needs them can find them, and nobody else trips
    // over them.
    expect(docs).toContain("CF_ACCESS_CLIENT_ID");
    expect(docs.toLowerCase()).toContain("self-hosting");
  });

  it("uploads a zip as bundle= and a single document as file=", async () => {
    const docs = await publicHtml("/docs");
    expect(docs).toContain("-F bundle=@./dist.zip");
    expect(docs, "a zip must never be sent as file=").not.toMatch(/file=@\S*\.zip/);
    expect(docs, "the single-document variant is worth showing").toMatch(/file=@\S*\.html/);
  });
});

describe("content-origin isolation is claimed with its limit attached", () => {
  it("says on /docs that artifacts share the content origin", async () => {
    const html = (await publicHtml("/docs")).toLowerCase();
    // The claim itself survives…
    expect(html).toContain("content origin");
    // …and so does the part that stops it being read as browser sandboxing.
    expect(html, "/docs should say artifacts share the content origin").toMatch(
      /(share|shared|same) (that |one |the )?content origin|every artifact is served from the same content origin/
    );
    expect(html, "/docs should point at access control as the separation").toContain("access list");
  });

  it("states the same limit in llms.txt, where an answer engine will read it", () => {
    const lower = llmsTxt({ PUBLIC_BASE_URL: LOCAL }).toLowerCase();
    expect(lower).toContain("separate origin (a.rtfx.pro)");
    expect(lower).toContain("all artifacts share that content origin");
    expect(lower).toContain("not a per-artifact browser sandbox");
  });
});

describe("positioning copy obeys the existing public-copy rules", () => {
  it("adds no preview-stage framing", async () => {
    for (const path of PUBLIC_PATHS) {
      const body = (await publicHtml(path)).toLowerCase();
      expect(body, `${path} mentions beta`).not.toMatch(/\bbetas?\b/);
      expect(body, `${path} mentions mvp`).not.toMatch(/\bmvp\b/);
      expect(body, `${path} mentions early access`).not.toMatch(/\bearly access\b/);
    }
  });

  it("never names a competitor on a public page", async () => {
    // Competitive reasoning belongs in docs/POSITIONING.md, not in the copy.
    for (const path of PUBLIC_PATHS) {
      const body = (await publicHtml(path)).toLowerCase();
      for (const rival of ["shareduo", "buildwithstar", "send.co", "useshareable"]) {
        expect(body, `${path} names ${rival}`).not.toContain(rival);
      }
    }
    expect(llmsTxt({}).toLowerCase()).not.toContain("shareduo");
  });

  it("serves the positioning to an anonymous visitor and a signed-in one alike", async () => {
    const anonymous = await publicHtml("/docs");
    const signedIn = await (
      await canonicalReq("/docs", { headers: { "X-Dev-Email": "admin@test.com" } })
    ).text();
    expect(anonymous).toBe(signedIn);
  });
});

describe("nothing private leaked into the public positioning copy", () => {
  it("the docs page still needs no identity and reveals no artifact", async () => {
    const res = await req("/docs", anon);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("admin@test.com");
    // `rtfx_…` is the documented placeholder; a real token would be far longer.
    expect(html).not.toMatch(/rtfx_[A-Za-z0-9_-]{16,}/);
  });
});
