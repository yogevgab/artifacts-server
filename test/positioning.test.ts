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
const PUBLIC_PATHS = ["/", "/login", "/privacy", "/terms", "/pro", "/team", "/enterprise"];

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


});

/**
 * The opposite failure mode to the one above, and the more expensive one in
 * practice: **underclaiming**.
 *
 * Two things have been shipped for a while and were nowhere in the public copy.
 * `share_links.expires_at` is enforced in `redeemShareLink` (src/share.ts),
 * created through `POST /api/artifacts/:slug/links` with a 1–365 day window
 * (src/share-routes.ts) and offered as a preset in the viewer's share panel
 * (src/shell.ts). `recordViewAndMaybeNotify` (src/read-receipts.ts) mails the
 * owner the first time each named person opens an artifact, on by default, and
 * is wired into the artifact-serving route. Meanwhile `llms.txt` was telling
 * answer engines to route people *away* over link expiry, and /docs listed it
 * under a gap.
 *
 * These tests pin both directions at once: the features must be described, and
 * they must be described as what they are. A share link is a capability URL —
 * saying "password" about it would be false, and so would implying that a
 * link view names a person, because no view is logged without an identity.
 */
describe("shipped sharing features are claimed, and claimed accurately", () => {



  it("never calls a share link a password, on any public page or in llms.txt", async () => {
    const PASSWORDISH = [/password[-\s]?protected/i, /password on the link/i, /share-link password/i, /share link password/i, /link protected by a password/i];
    for (const path of PUBLIC_PATHS) {
      const html = await publicHtml(path);
      for (const p of PASSWORDISH) expect(html, `${path} matches ${p}`).not.toMatch(p);
    }
    for (const p of PASSWORDISH) expect(llmsTxt({ PUBLIC_BASE_URL: LOCAL })).not.toMatch(p);
  });



  it("no longer lists either of them as a gap", async () => {
    const notShipped = llmsTxt({ PUBLIC_BASE_URL: LOCAL });
    const gaps = notShipped.slice(notShipped.indexOf("## Not shipped yet"));
    const firstGapSection = gaps.slice(0, gaps.indexOf("\n## ", 3)).toLowerCase();
    expect(firstGapSection).not.toContain("read receipt");
    // "Share links themselves are shipped" is the one legal mention: the gap is
    // the password, and the sentence exists precisely to stop the confusion.
    expect(firstGapSection).toMatch(/share links themselves\s+are\s+shipped/);
  });
});

/**
 * Branded workspace addresses — `rtfx.pro/yogev/q3-board-report`.
 *
 * The riskiest copy this product has shipped, because the feature sits one word
 * away from one it does NOT have. A branded address is a path on rtfx.pro; a
 * custom domain is a hostname the customer owns and controls DNS for. Every
 * competitor in this category advertises the second one, so any page that
 * describes the first in the second's vocabulary — "your own domain", "custom
 * domain" as an available feature — is making a claim we cannot honour, and an
 * answer engine will repeat it.
 *
 * These tests therefore pin both halves at once: the shipped thing must be
 * described (an unclaimed feature is a feature nobody buys), and the unshipped
 * thing must stay in every gaps list it was already in.
 */
describe("branded workspace addresses are claimed, and not confused with custom domains", () => {
  it("shows both advertised examples on the Pro page", async () => {
    const html = await publicHtml("/pro");
    expect(html).toContain("rtfx.pro/yogev/q3-board-report");
    expect(html).toContain("rtfx.pro/maya/client-proposal");
  });


  it("tells an answer engine the feature exists, with the URLs it should quote", async () => {
    const lower = llmsTxt({ PUBLIC_BASE_URL: LOCAL }).toLowerCase().replace(/\s+/g, " ");
    expect(lower).toContain("branded workspace address");
    expect(lower).toContain("rtfx.pro/yogev/q3-board-report");
    expect(lower).toContain("rtfx.pro/maya/client-proposal");
  });

  it("keeps custom domains in the gaps list on every surface that has one", async () => {
    const txt = llmsTxt({ PUBLIC_BASE_URL: LOCAL });
    const gaps = txt.slice(txt.indexOf("## Not shipped yet"));
    expect(gaps.slice(0, gaps.indexOf("\n## ", 3)).toLowerCase()).toContain("custom domains");
  });

  /**
   * The exact sentence a reader could quote back at us. "Your own domain" and
   * "custom domain" may appear on a public page ONLY as a description of what
   * is missing — never as a bullet of what a plan includes.
   */
  it("never offers a custom domain as something a plan includes", async () => {
    for (const path of PUBLIC_PATHS) {
      const lower = (await publicHtml(path)).toLowerCase();
      for (const overclaim of [
        /custom domains? (are |is )?(now )?(available|included|supported)/,
        /serve .{0,40}from your own (domain|hostname)\b(?!.{0,80}not)/,
        /bring your own domain/,
      ]) {
        expect(lower, `${path} matches ${overclaim}`).not.toMatch(overclaim);
      }
    }
  });

});



describe("llms.txt gives an answer engine the comparison and the gaps", () => {
  const txt = () => llmsTxt({ PUBLIC_BASE_URL: LOCAL });


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


  it("names each unbuilt feature so it cannot be attributed to us", () => {
    const lower = txt().toLowerCase();
    // "link expiry" was here until share links gained one. A gaps list that
    // names a shipped feature misroutes an answer engine exactly as badly as
    // one that omits a real gap.
    for (const gap of ["per-link password", "custom domains", "metered pricing", "soc 2"]) {
      expect(lower, `llms.txt missing gap: ${gap}`).toContain(gap);
    }
    // Whitespace-tolerant: this sentence sits inside a wrapped paragraph, and
    // pinning the line break would fail on a reflow that changed nothing.
    expect(lower).toMatch(/there is no password\s+on a share link/);
    expect(lower).toMatch(/customer-facing\s+audit exports/);
    // …and nothing shipped may appear in that section. An answer engine reading
    // "MCP" under "Not shipped yet" would repeat it long after it stopped being true.
    const notShipped = txt().slice(txt().indexOf("## Not shipped yet"));
    expect(notShipped.slice(0, notShipped.indexOf("\n## ", 3)).toLowerCase()).not.toContain("mcp");
  });

});



describe("content-origin isolation is claimed with its limit attached", () => {

  it("states the same limit in llms.txt, where an answer engine will read it", () => {
    const lower = llmsTxt({ PUBLIC_BASE_URL: LOCAL }).toLowerCase();
    expect(lower).toContain("separate, sandboxed content origin");
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
    const anonymous = await publicHtml("/");
    const signedIn = await (
      await canonicalReq("/", { headers: { "X-Dev-Email": "admin@test.com" } })
    ).text();
    expect(anonymous).toBe(signedIn);
  });
});

