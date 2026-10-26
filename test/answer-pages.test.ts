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

const PAGES = [
  { key: "share", meta: ANSWER_META.share, h1: "How to share a Claude artifact privately", faq: true },
  { key: "compare", meta: ANSWER_META.compare, h1: "Claude Publish vs a private link", faq: false },
] as const;

describe.each(PAGES)("$meta.path", ({ meta, h1, faq }) => {
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
    expect(`${title} ${desc}`).toMatch(/Claude/);
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
    expect(article.datePublished).toBe("2026-10-26");
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
  });

  it("is app-host only and a reserved workspace slug", () => {
    expect(isManagementPath(meta.path)).toBe(true);
    expect(isReservedAccountSlug(meta.path.slice(1))).toBe(true);
  });

  it("is linked from the footer of the home page", async () => {
    const home = await (await get("/")).text();
    const footer = /<footer class="site">[\s\S]*?<\/footer>/.exec(home)![0];
    expect(footer).toContain(`href="${meta.path}"`);
  });
});

describe("/share-claude-artifacts-privately content", () => {
  const path = ANSWER_META.share.path;

  it("answers in the first paragraph, then four numbered steps linking to the guide", async () => {
    const html = await (await get(path)).text();
    const lead = htmlToText(/<p class="lead">([\s\S]*?)<\/p>/.exec(html)![1]!);
    expect(lead).toMatch(/Free, Pro and Max/);
    expect(lead).toMatch(/public to anyone with the link/);
    expect(lead).toMatch(/Team and Enterprise/);
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
    expect(faq.mainEntity).toHaveLength(3);
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
    const table = /<table class="cmp">[\s\S]*?<\/table>/.exec(html)![0];
    expect(table).toContain("Claude's built-in Publish");
    expect(table).toContain("rtfx private link");
    for (const row of ["Who can open it", "Sign-in for viewers", "Updating and versions", "Expiry and revoking", "Cost"]) {
      expect(table).toContain(row);
    }
    expect(table).toContain("$12/mo");
    expect(table).toContain("$40/mo");
    expect(html).toContain("When to use which");
    expect(html).toMatch(/Claude Publish is fine when/);
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
