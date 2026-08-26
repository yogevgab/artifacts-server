import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { initDb, clearR2 } from "./fixtures";
import { llmsTxt } from "../src/seo";
import type { Env } from "../src/env";

/**
 * The connector surface on the public site.
 *
 * The plugin, the local MCP server and the OAuth-authorized hosted endpoint are
 * the part of this product a person meets first, and the homepage did not say so
 * — it showed `/rtfx:publish` and nothing about how a session gets connected in
 * the first place. Two failure modes follow, and this file exists for both:
 *
 *  1. **Silent disappearance.** Connector copy is the kind that gets edited out
 *     during a redesign, because each card looks like a detail rather than the
 *     headline. Structure is asserted on `data-*` hooks (docs/DESIGN.md) so the
 *     wording can keep improving while the surface cannot quietly vanish.
 *  2. **Overclaiming the hosted endpoint.** `mcp.rtfx.pro` can publish content
 *     supplied inside the MCP call, but not a local filesystem path. Copy that
 *     implies the cloud endpoint can read a user's folder is the expensive false
 *     claim here, because it would be discovered by a customer mid-session. The
 *     tests below pin the distinction everywhere public copy names the endpoint.
 */

const LOCAL = "http://localhost";
const canonicalEnv = { ...env, PUBLIC_BASE_URL: LOCAL } as unknown as Env;
const anon = { headers: { "X-Dev-Anonymous": "true" } };

async function publicHtml(path: string): Promise<string> {
  const res = await app.request(`${LOCAL}${path}`, anon, canonicalEnv as any);
  expect(res.status, path).toBe(200);
  return res.text();
}

const txt = () => llmsTxt({ PUBLIC_BASE_URL: LOCAL });

beforeEach(async () => {
  await initDb();
  await clearR2();
});

describe("the homepage leads with the connectors", () => {
  it("carries a connector band with a card per surface", async () => {
    const html = await publicHtml("/");
    expect(html).toContain('data-landing="connectors"');
    for (const key of ["claude-code-plugin", "local-mcp", "remote-mcp", "api-cli-hermes"]) {
      expect(html, `homepage missing connector card: ${key}`).toContain(
        `data-connector="${key}"`
      );
    }
  });

  /**
   * The commands are the point. A connector a reader cannot see the first line
   * of is indistinguishable from a promise, and each of these is the literal
   * command from docs/CLAUDE_CODE.md and docs/REMOTE_MCP_OAUTH.md.
   */
  it("shows the real first line of each connector, not a description of one", async () => {
    const html = await publicHtml("/");
    for (const command of [
      "/rtfx:login",
      "/rtfx:publish",
      "claude mcp add --transport http rtfx",
      "https://mcp.rtfx.pro/mcp",
      "claude mcp login rtfx",
      "/api/machine/artifacts",
    ]) {
      expect(html, `homepage missing: ${command}`).toContain(command);
    }
  });

  it("says the plugin sign-in replaces copying a token", async () => {
    const html = (await publicHtml("/")).toLowerCase();
    expect(html).toContain("browser sign-in");
    expect(html).toMatch(/no token to (copy|paste)|no token to copy, paste/);
  });

  /**
   * The label is real markup, never a CSS `content:` string — the same rule
   * `.stance-flag` on /docs follows. A pseudo-element is invisible to
   * Googlebot's rendered text, to GPTBot/ClaudeBot, to every readability-style
   * extractor and to a screen reader, which is precisely the set of readers this
   * distinction is written for.
   */
  it("labels each card with whether it publishes, in markup a crawler can read", async () => {
    const html = await publicHtml("/");
    const cards = html.split('<div class="conn" data-connector=').slice(1);
    expect(cards.length, "no connector cards in the markup").toBe(4);
    for (const card of cards) {
      expect(card, `unlabelled connector: ${card.slice(0, 40)}`).toMatch(
        /<span class="conn-tag">[^<]+<\/span>/
      );
    }
    const remote = cards.find((c) => c.startsWith('"remote-mcp"'))!;
    expect(remote).toContain('<span class="conn-tag">Publishes content</span>');
    expect(remote.toLowerCase()).toContain("content sent inside the tool call");
    expect(remote.toLowerCase()).toContain("never");
    expect(remote.toLowerCase()).toContain("filesystem path");
  });

  it("adds the band without restacking the page into more sections", async () => {
    const html = await publicHtml("/");
    // Issue #35 invariant: hero + one band + waitlist. The connector band lives
    // inside the product section, the way the pricing table does.
    expect((html.match(/<section\b/g) ?? []).length).toBe(3);
    expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
  });

  it("carries the connectors into SoftwareApplication structured data", async () => {
    const html = await publicHtml("/");
    const graph = JSON.parse(
      [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)][0][1]
    );
    const features = graph["@graph"]
      .find((n: { "@type": string }) => n["@type"] === "SoftwareApplication")
      .featureList.join(" ")
      .toLowerCase();
    expect(features).toContain("oauth");
    expect(features).toContain("mcp");
  });
});

describe("/docs compares the connectors honestly", () => {
  it("has a connector table with a row per surface", async () => {
    const html = await publicHtml("/docs");
    expect(html).toContain('data-docs="connectors"');
    for (const key of ["claude-code-plugin", "local-mcp", "remote-mcp", "api-cli-hermes"]) {
      expect(html, `/docs connector table missing row: ${key}`).toContain(
        `data-connector="${key}"`
      );
    }
    // …inside a scroll box, like every other table on the page.
    const tables = (html.match(/<table\b/g) ?? []).length;
    const wrapped = (html.match(/<div class="table-wrap"><table\b/g) ?? []).length;
    expect(wrapped).toBe(tables);
  });

  it("documents the remote endpoint's setup and content-publish tool", async () => {
    const html = await publicHtml("/docs");
    expect(html).toContain('data-docs="remote-mcp"');
    const example = html.split('data-docs="remote-mcp"')[1].split("</pre>")[0];
    expect(example).toContain("claude mcp add --transport http rtfx https://mcp.rtfx.pro/mcp");
    expect(example).toContain("claude mcp login rtfx");
    expect(example).toContain("publish");
    expect(example).toContain("doctor");
  });

  it("answers the remote-publishing question in the FAQ, and in the rich result", async () => {
    const html = await publicHtml("/docs");
    const faq = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
      .map(([, json]) => JSON.parse(json))
      .find((b) => b["@type"] === "FAQPage");
    const entry = faq.mainEntity.find((q: { name: string }) => /mcp\.rtfx\.pro/i.test(q.name));
    expect(entry, "no FAQ entry about the remote endpoint").toBeDefined();
    expect(entry.acceptedAnswer.text).toMatch(/^Yes,/);
    expect(entry.acceptedAnswer.text).toMatch(/content/i);
    expect(entry.acceptedAnswer.text).toMatch(/path/i);
    // The answer must be on the page, not only in the structured data.
    expect(html).toContain(entry.name);
  });
});

/**
 * The one claim that must never appear anywhere: hosted MCP as a cloud-side
 * path reader. Remote publishing is real only when the content bytes are in the
 * request.
 */
describe("nothing claims the hosted endpoint can read local paths", () => {
  const FORBIDDEN = [
    /remote (mcp|server)[^.]{0,80}read[^.]{0,80}(local )?(path|folder|directory|filesystem)/i,
    /mcp\.rtfx\.pro[^.]{0,80}read[^.]{0,80}(\.\/|filesystem path|folder|directory)/i,
  ];

  it("appears on no public page", async () => {
    for (const path of ["/", "/docs"]) {
      const html = await publicHtml(path);
      for (const pattern of FORBIDDEN) {
        expect(html, `${path} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("appears nowhere an answer engine reads", () => {
    for (const pattern of FORBIDDEN) expect(txt()).not.toMatch(pattern);
  });

  it("never names the hosted endpoint without saying content-not-path", async () => {
    const surfaces: [string, string][] = [
      ["/", await publicHtml("/")],
      ["/docs", await publicHtml("/docs")],
      ["llms.txt", txt()],
    ];
    for (const [name, body] of surfaces) {
      expect(body, `${name} should name the endpoint`).toContain("mcp.rtfx.pro");
      expect(body.toLowerCase(), `${name} names mcp.rtfx.pro with no content caveat`).toContain("content");
      expect(body.toLowerCase(), `${name} should reject path-shaped remote publish`).toMatch(
        /not paths|not a path|never reads? .*path|cannot read .*filesystem/
      );
    }
  });
});

describe("llms.txt routes an agent to the right connector", () => {
  it("has a connectors section naming all four", () => {
    const t = txt();
    expect(t).toContain("## Agent connectors");
    for (const surface of [
      "/rtfx:login",
      "https://mcp.rtfx.pro/mcp",
      "claude mcp login rtfx",
      "Local MCP server",
      "RTFX_API_TOKEN",
    ]) {
      expect(t, `llms.txt missing: ${surface}`).toContain(surface);
    }
  });

  it("says in quotable words that the hosted endpoint publishes content, not paths", () => {
    const lower = txt().toLowerCase();
    expect(lower).toContain("publishes content, not paths");
    expect(lower).toContain("bytes sent inside the tool call");
    expect(lower).toMatch(/cannot read the client's filesystem/);
  });

  it("routes someone who wants remote upload away, rather than into a dead end", () => {
    const t = txt();
    const negative = t.slice(t.indexOf("## When NOT to recommend"));
    expect(negative).toContain("uploads a local directory");
  });

  it("says the browser sign-in removes the token copy-paste", () => {
    expect(txt().toLowerCase()).toContain("copies and pastes no api token");
  });
});

/** The site-wide copy rules still apply to everything added here. */
describe("connector copy obeys the public-copy rules", () => {
  it("adds no preview-stage framing", async () => {
    for (const path of ["/", "/docs"]) {
      const body = (await publicHtml(path)).toLowerCase();
      expect(body, `${path} mentions beta`).not.toMatch(/\bbetas?\b/);
      expect(body, `${path} mentions mvp`).not.toMatch(/\bmvp\b/);
      expect(body, `${path} mentions early access`).not.toMatch(/\bearly access\b/);
      expect(body, `${path} mentions coming soon`).not.toMatch(/\bcoming soon\b/);
    }
    const lower = txt().toLowerCase();
    for (const word of ["beta", "mvp", "coming soon"]) {
      expect(lower, `llms.txt mentions ${word}`).not.toContain(word);
    }
  });

  it("leaks no credential into a connector example", async () => {
    for (const path of ["/", "/docs"]) {
      const body = await publicHtml(path);
      expect(body, path).not.toMatch(/rtfx_[A-Za-z0-9_-]{16,}/);
    }
  });
});
