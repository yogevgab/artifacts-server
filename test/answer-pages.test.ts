import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { initDb, clearR2 } from "./fixtures";
import { ANSWER_META, PUBLIC_PAGES, llmsTxt, sitemapXml } from "../src/seo";
import { isManagementPath } from "../src/host";
import { isReservedAccountSlug } from "../src/account-slugs";
import { FAQS } from "../src/home-content";
import { llmsFullTxt } from "../src/llms-full";
import { htmlToText } from "../src/html-text";
import { GUIDE_IMAGES } from "../src/guide-images";
import type { Env } from "../src/env";

const LOCAL = "http://localhost";
const e = { ...env, PUBLIC_BASE_URL: LOCAL } as unknown as Env;
const get = (path: string, init?: RequestInit) => app.request(`${LOCAL}${path}`, init, e as any);

beforeEach(async () => {
  await initDb();
  await clearR2();
});

type Node = Record<string, any>;
function ld(html: string): Node[] {
  return [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(([, json]) => {
    expect(json).not.toContain("<");
    return JSON.parse(json!);
  });
}
const attr = (html: string, re: RegExp) => re.exec(html)?.[1] ?? "";

const B1 = { published: "2026-10-26", footer: true } as const;
// Batch 2 is linked from the hub and every answer page's "More answers", not the footer.
const B2 = { published: "2026-11-03", footer: false } as const;
// Batch 3 (2026-11-06): Claude how-tos, AI-tool pages, messaging-app pages. Hub-linked only.
const B3 = { published: "2026-11-06", footer: false } as const;
const PAGES = [
  { key: "share", meta: ANSWER_META.share, h1: "How to share a Claude artifact privately", faq: true, ...B1 },
  { key: "compare", meta: ANSWER_META.compare, h1: "Claude artifact sharing vs a private link", faq: false, ...B1 },
  { key: "views", meta: ANSWER_META.views, h1: "Can you see who viewed a Claude artifact?", faq: true, ...B1 },
  { key: "password", meta: ANSWER_META.password, h1: "Can you put a password on a Claude artifact?", faq: true, ...B1 },
  { key: "noAccount", meta: ANSWER_META.noAccount, h1: "Can someone open a Claude artifact without a Claude account?", faq: true, ...B2 },
  { key: "htmlFile", meta: ANSWER_META.htmlFile, h1: "How to share a Claude artifact's HTML file privately", faq: true, ...B2 },
  { key: "public", meta: ANSWER_META.public, h1: "Are Claude artifacts public?", faq: true, ...B2 },
  { key: "expiry", meta: ANSWER_META.expiry, h1: "Can a shared Claude artifact link expire?", faq: true, ...B2 },
  { key: "people", meta: ANSWER_META.people, h1: "How to share a Claude artifact with specific people", faq: true, ...B2 },
  { key: "stopSharing", meta: ANSWER_META.stopSharing, h1: "How to stop sharing a Claude artifact", faq: true, ...B2 },
  { key: "claudeCode", meta: ANSWER_META.claudeCode, h1: "How to share a Claude Code page privately", faq: true, ...B2 },
  { key: "updateLink", meta: ANSWER_META.updateLink, h1: "How to update a Claude artifact without changing the link", faq: true, ...B3 },
  { key: "revert", meta: ANSWER_META.revert, h1: "How to revert a Claude artifact to an earlier version", faq: true, ...B3 },
  { key: "outOfGoogle", meta: ANSWER_META.outOfGoogle, h1: "How to keep Claude artifacts out of Google", faq: true, ...B3 },
  { key: "chatgpt", meta: ANSWER_META.chatgpt, h1: "How to share ChatGPT-generated HTML privately", faq: true, ...B3 },
  { key: "cursor", meta: ANSWER_META.cursor, h1: "How to share Cursor-generated HTML privately", faq: true, ...B3 },
  { key: "vscode", meta: ANSWER_META.vscode, h1: "How to share GitHub Copilot HTML privately from VS Code", faq: true, ...B3 },
  { key: "devin", meta: ANSWER_META.devin, h1: "Use rtfx with Devin Desktop (formerly Windsurf)", faq: true, ...B3 },
  { key: "gemini", meta: ANSWER_META.gemini, h1: "How to share Gemini and Antigravity HTML privately", faq: true, ...B3 },
  { key: "grok", meta: ANSWER_META.grok, h1: "How to share Grok-generated HTML privately", faq: true, ...B3 },
  { key: "pi", meta: ANSWER_META.pi, h1: "How to share Pi coding agent HTML privately", faq: true, ...B3 },
  { key: "opencode", meta: ANSWER_META.opencode, h1: "How to share OpenCode HTML output privately", faq: true, ...B3 },
  { key: "hermes", meta: ANSWER_META.hermes, h1: "How to share Hermes Agent HTML privately", faq: true, ...B3 },
  { key: "slack", meta: ANSWER_META.slack, h1: "How to share an HTML file privately in Slack", faq: true, ...B3 },
  { key: "whatsapp", meta: ANSWER_META.whatsapp, h1: "How to share an HTML file privately on WhatsApp", faq: true, ...B3 },
  { key: "email", meta: ANSWER_META.email, h1: "How to share an HTML file privately by email or Gmail", faq: true, ...B3 },
  { key: "teams", meta: ANSWER_META.teams, h1: "How to share an HTML file privately in Microsoft Teams", faq: true, ...B3 },
  { key: "discord", meta: ANSWER_META.discord, h1: "How to share an HTML file privately on Discord", faq: true, ...B3 },
] as const;

describe.each(PAGES)("$meta.path", ({ meta, h1, faq, published, footer: inFooter }) => {
  it("renders 200 with the h1, a unique title <= 60 and description <= 155", async () => {
    const res = await get(meta.path);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<h1>${h1}</h1>`);
    expect((html.match(/<h1\b/g) ?? []).length).toBe(1);
    const title = attr(html, /<title>(.*?)<\/title>/);
    const desc = attr(html, /<meta name="description" content="([^"]*)">/).replace(/&#39;/g, "'");
    expect(desc).toBe(meta.description);
    expect(title.replace(/&#39;/g, "'")).toBe(meta.title);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(desc.length).toBeGreaterThan(60);
    expect(desc.length).toBeLessThanOrEqual(155);
    // brand collision: "rtfx" always appears with Claude and MCP / private link.
    // Batch 3 AI-tool and messaging pages name their own tool instead of Claude.
    if (published !== "2026-11-06") expect(`${title} ${desc}`).toMatch(/Claude/);
    expect(`${title} ${desc}`).toMatch(/rtfx/);
    expect(title).toMatch(/rtfx/);
    expect(html).not.toContain("noindex");
  });

  it("has canonical, OG and Twitter tags", async () => {
    const html = await (await get(meta.path)).text();
    expect(html).toContain(`<link rel="canonical" href="${LOCAL}${meta.path}">`);
    expect(html).toContain(`<meta property="og:url" content="${LOCAL}${meta.path}">`);
    expect(html).toContain(`<meta property="og:image" content="${LOCAL}/og.png">`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<meta property="og:title"');
    expect(html).toContain('<meta name="twitter:title"');
  });

  it("emits Article and BreadcrumbList JSON-LD with required properties", async () => {
    const html = await (await get(meta.path)).text();
    const blocks = ld(html);
    const article = blocks.find((b) => b["@type"] === "Article")!;
    expect(article.headline.length).toBeLessThanOrEqual(110);
    expect(article.description).toBeTruthy();
    expect(article.datePublished).toBe(published);
    expect(article.image).toEqual([`${LOCAL}/og.png`]);
    for (const who of [article.author, article.publisher]) {
      expect(who["@type"]).toBe("Organization");
      expect(who.name).toBe("rtfx.pro");
      expect(who.logo.url).toBe(`${LOCAL}/logo.png`);
    }
    const crumbs = blocks.find((b) => b["@type"] === "BreadcrumbList")!;
    expect(crumbs.itemListElement).toHaveLength(2);
    expect(crumbs.itemListElement[1].item).toBe(`${LOCAL}${meta.path}`);
    expect(blocks.some((b) => b["@type"] === "FAQPage")).toBe(faq);
  });

  it("is in the sitemap, llms.txt and llms-full.txt", async () => {
    expect(PUBLIC_PAGES.some((p) => p.path === meta.path)).toBe(true);
    expect(sitemapXml({ PUBLIC_BASE_URL: "https://rtfx.pro" })).toContain(`<loc>https://rtfx.pro${meta.path}</loc>`);
    expect(llmsTxt({ PUBLIC_BASE_URL: "https://rtfx.pro" })).toContain(`https://rtfx.pro${meta.path}`);
    const served = await (await get("/llms.txt")).text();
    expect(served).toContain(`${LOCAL}${meta.path}`);
    const full = llmsFullTxt({ PUBLIC_BASE_URL: "https://rtfx.pro" });
    expect(full).toContain(`## ${h1} (https://rtfx.pro${meta.path})`);
    // Inline links survive the HTML→markdown conversion (a stray rel= used to drop the URL).
    expect(full).toContain("](https://support.claude.com/en/articles/9547008-share-artifacts)");
  });

  it("is app-host only and a reserved workspace slug", () => {
    expect(isManagementPath(meta.path)).toBe(true);
    expect(isReservedAccountSlug(meta.path.slice(1))).toBe(true);
  });

  it("is linked from the footer (batch 1) or the hub (batch 2), and links to every other answer", async () => {
    const home = await (await get("/")).text();
    const footer = /<footer class="site">[\s\S]*?<\/footer>/.exec(home)![0];
    expect(footer).toContain(`href="${ANSWER_META.answers.path}"`);
    if (inFooter) expect(footer).toContain(`href="${meta.path}"`);
    const hub = await (await get(ANSWER_META.answers.path)).text();
    expect(hub).toContain(`href="${meta.path}"`);
    const html = await (await get(meta.path)).text();
    const more = /<nav class="more-answers"[\s\S]*?<\/nav>/.exec(html)![0];
    for (const other of PAGES) {
      if (other.meta.path !== meta.path) expect(more).toContain(`href="${other.meta.path}"`);
    }
    expect(more).not.toContain(`href="${meta.path}"`);
  });
});

describe("/answers hub", () => {
  it("renders an indexable ItemList of every answer page, in the sitemap and llms.txt", async () => {
    const res = await get(ANSWER_META.answers.path);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect((html.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(html).not.toContain("noindex");
    const title = attr(html, /<title>(.*?)<\/title>/).replace(/&#39;/g, "'");
    expect(title).toBe(ANSWER_META.answers.title);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(ANSWER_META.answers.description.length).toBeLessThanOrEqual(155);
    const list = ld(html).find((b) => b["@type"] === "ItemList")!;
    expect(list.itemListElement.map((i: Node) => i.url).sort()).toEqual(PAGES.map((p) => `${LOCAL}${p.meta.path}`).sort());
    expect(sitemapXml({ PUBLIC_BASE_URL: "https://rtfx.pro" })).toContain(`<loc>https://rtfx.pro/answers</loc>`);
    expect(llmsTxt({ PUBLIC_BASE_URL: "https://rtfx.pro" })).toContain("https://rtfx.pro/answers");
    expect(isManagementPath("/answers")).toBe(true);
    expect(isReservedAccountSlug("answers")).toBe(true);
  });
});

describe("batch-3 pages", () => {
  const B3_PAGES = PAGES.filter((x) => x.published === "2026-11-06");
  const GROUPS = {
    claude: ["updateLink", "revert", "outOfGoogle"],
    tools: ["chatgpt", "cursor", "vscode", "devin", "gemini", "grok", "pi", "opencode", "hermes"],
    channels: ["slack", "whatsapp", "email", "teams", "discord"],
  } as const;

  it("has 17 pages, each with at least 3 FAQs", async () => {
    expect(B3_PAGES).toHaveLength(17);
    for (const p of B3_PAGES) {
      const html = await (await get(p.meta.path)).text();
      const faq = ld(html).find((b) => b["@type"] === "FAQPage")!;
      expect(faq.mainEntity.length, p.meta.path).toBeGreaterThanOrEqual(3);
    }
  });

  it("groups the hub and every More answers list by category", async () => {
    const hub = await (await get(ANSWER_META.answers.path)).text();
    for (const heading of ["Claude artifacts", "AI tools", "Messaging apps"]) {
      expect(hub).toContain(`>${heading}</h2>`);
    }
    const page = await (await get(ANSWER_META.slack.path)).text();
    const more = /<nav class="more-answers"[\s\S]*?<\/nav>/.exec(page)![0];
    for (const heading of ["Claude artifacts", "AI tools", "Messaging apps"]) {
      expect(more).toContain(`<h3>${heading}</h3>`);
    }
    // Each category's pages sit under its own heading.
    const tools = more.slice(more.indexOf("<h3>AI tools</h3>"), more.indexOf("<h3>Messaging apps</h3>"));
    for (const k of GROUPS.tools) expect(tools).toContain(`href="${ANSWER_META[k].path}"`);
    for (const k of GROUPS.channels) expect(tools).not.toContain(`href="${ANSWER_META[k].path}"`);
  });

  it("never prints the robots meta value, a competitor, or a custom-domain claim", async () => {
    for (const p of B3_PAGES) {
      const html = (await (await get(p.meta.path)).text()).toLowerCase();
      expect(html, p.meta.path).not.toContain("noindex");
      expect(html, p.meta.path).not.toMatch(/custom domain|your own domain/);
    }
  });

  it("states the vendor doc each AI-tool page relies on", async () => {
    const SOURCES: Record<string, string> = {
      chatgpt: "https://developers.openai.com/api/docs/guides/custom-mcp-server",
      cursor: "https://cursor.com/docs/context/mcp",
      vscode: "https://code.visualstudio.com/docs/copilot/customization/mcp-servers",
      devin: "https://docs.devin.ai/desktop/cascade/mcp",
      gemini: "https://support.google.com/gemini/answer/17209137",
      grok: "https://docs.x.ai/grok/connectors",
      pi: "https://pi.dev/docs/latest/mcp",
      opencode: "https://opencode.ai/docs/mcp-servers",
      hermes: "https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp",
    };
    for (const [k, url] of Object.entries(SOURCES)) {
      const html = await (await get((ANSWER_META as any)[k].path)).text();
      expect(html, k).toContain(`href="${url}"`);
      expect(html, k).toContain(`mcp.rtfx.pro/mcp`);
    }
  });

  it("Devin Desktop mentions Windsurf; Gemini mentions Antigravity; Claude Code artifacts are said to keep their URL", async () => {
    expect(await (await get(ANSWER_META.devin.path)).text()).toContain("Windsurf");
    expect(await (await get(ANSWER_META.gemini.path)).text()).toContain("Antigravity");
    const upd = await (await get(ANSWER_META.updateLink.path)).text();
    expect(upd).toContain("publishes again to the same URL");
    expect(upd).toContain("https://code.claude.com/docs/en/artifacts");
  });

  it("llms-full.txt keeps config snippets as multi-line fenced code", () => {
    const full = llmsFullTxt({ PUBLIC_BASE_URL: "https://rtfx.pro" });
    expect(full).toContain('```\nmcp_servers:\n  rtfx:\n    url: "https://mcp.rtfx.pro/mcp"\n    auth: oauth\n```');
  });

  it("the Google page links Claude's help article and says it doesn't state indexing", async () => {
    const html = await (await get(ANSWER_META.outOfGoogle.path)).text();
    expect(html).toContain("https://support.claude.com/en/articles/9547008-share-artifacts");
    expect(html).toContain("doesn't say whether shared artifacts");
  });
});

describe("batch-2 pages cite their sources", () => {
  it("every batch-2 page links Anthropic's help article or Claude Code's docs", async () => {
    for (const p of PAGES.filter((x) => x.published === "2026-11-03")) {
      const html = await (await get(p.meta.path)).text();
      expect(html, p.meta.path).toMatch(
        /href="https:\/\/(support\.claude\.com\/en\/articles\/9547008-share-artifacts|code\.claude\.com\/docs\/en\/artifacts)"/
      );
    }
  });
});

describe("/share-claude-artifacts-privately content", () => {
  const path = ANSWER_META.share.path;

  it("answers in the first paragraph, then four numbered steps linking to the guide", async () => {
    const html = await (await get(path)).text();
    const lead = htmlToText(/<p class="lead">([\s\S]*?)<\/p>/.exec(html)![1]!);
    // Claude's current sharing model (help article "Share artifacts", 2026-11-02),
    // never the old "Publish = public to anyone with the link".
    expect(lead).toMatch(/start private/);
    expect(lead).toMatch(/Claude account/);
    expect(lead).not.toMatch(/public to anyone with the link/);
    expect(lead).toMatch(/private link/);
    const steps = html.match(/<li id="step-\d">/g) ?? [];
    expect(steps).toHaveLength(4);
    for (const anchor of ["connect", "publish", "share", "views"]) {
      expect(html).toContain(`href="/guide#${anchor}"`);
    }
  });

  it("reuses 2-3 guide screenshots that are sized, described and served", async () => {
    const html = await (await get(path)).text();
    const imgs = html.match(/<img\b[^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThanOrEqual(2);
    expect(imgs.length).toBeLessThanOrEqual(3);
    for (const img of imgs) {
      expect(img).toMatch(/width="\d+"/);
      expect(img).toMatch(/height="\d+"/);
      expect(img).toMatch(/alt="[^"]{10,}"/);
      const src = /src="([^"]+)"/.exec(img)![1]!;
      const name = /^\/guide\/([a-z0-9-]+)\.webp\?v=/.exec(src)![1]!;
      expect(GUIDE_IMAGES[name]).toBeTruthy();
      expect((await get(src)).status).toBe(200);
    }
  });

  it("FAQPage matches the visible FAQ question for question, answer for answer", async () => {
    const html = await (await get(path)).text();
    const faq = ld(html).find((b) => b["@type"] === "FAQPage")!;
    expect(faq.mainEntity).toHaveLength(5);
    const section = /<section id="faq"[\s\S]*?<\/section>/.exec(html)![0];
    const visible = htmlToText(section);
    for (const q of faq.mainEntity) {
      expect(q["@type"]).toBe("Question");
      expect(visible).toContain(htmlToText(q.name.replace(/'/g, "&#39;")));
      expect(visible).toContain(htmlToText(q.acceptedAnswer.text.replace(/'/g, "&#39;")));
    }
  });
});

describe("/claude-publish-vs-private-link content", () => {
  it("has a comparison table with both columns and a when-to-use section", async () => {
    const html = await (await get(ANSWER_META.compare.path)).text();
    const table = /<table class="cmp"[^>]*>[\s\S]*?<\/table>/.exec(html)![0];
    // Explicit roles keep the column headers announced when the narrow layout
    // sets display:block on the table parts.
    expect(table).toMatch(/<table class="cmp" role="table">/);
    expect(table).toContain('role="rowheader"');
    expect(table).toContain('role="cell"');
    expect(table).not.toContain("&nbsp;</th>");
    // Only what Claude's help article states about sharing — no inferred claims.
    expect(table).not.toContain("none needed");
    expect(table).toContain("Claude's own sharing");
    expect(table).toContain("rtfx private link");
    for (const row of ["Who can open it", "Sign-in for viewers", "Updating and versions", "Expiry and revoking", "Cost"]) {
      expect(table).toContain(row);
    }
    expect(table).toContain("$12/mo");
    expect(table).toContain("$40/mo");
    expect(html).toContain("When to use which");
    expect(html).toMatch(/Claude's own sharing is fine when/);
  });
});

describe("home FAQ cross-links", () => {
  it("links the two matching answers to the answer pages and keeps the JSON-LD answer text", async () => {
    const html = await (await get("/")).text();
    const section = /<section id="faq"[\s\S]*?<\/section>/.exec(html)![0];
    expect(section).toContain(`href="${ANSWER_META.share.path}"`);
    expect(section).toContain(`href="${ANSWER_META.compare.path}"`);
    expect(section).toContain("Read more");
    const withMore = FAQS.filter((f) => f.more).map((f) => f.more!.href);
    expect(withMore).toEqual([ANSWER_META.share.path, ANSWER_META.compare.path]);
    const full = llmsFullTxt({ PUBLIC_BASE_URL: "https://rtfx.pro" });
    expect(full).toContain(`Read more: https://rtfx.pro${ANSWER_META.share.path}`);
  });
});
