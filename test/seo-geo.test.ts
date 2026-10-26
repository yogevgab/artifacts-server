import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { initDb, clearR2 } from "./fixtures";
import { SITE, PUBLIC_PAGES, llmsTxt, robotsTxt, APPLE_TOUCH_SIZE, appleTouchIconSvg, APPLE_TOUCH_SVG_SHA256 } from "../src/seo";
import { FAQS, VIDEO } from "../src/home-content";
import { llmsFullTxt } from "../src/llms-full";
import { guideSteps } from "../src/guide";
import { PLAN_PRICE } from "../src/plan-copy";
import { htmlToText } from "../src/html-text";
import type { Env } from "../src/env";

/**
 * SEO + GEO pass: per-page titles/descriptions, structured data that parses and
 * matches the visible page, the FAQ, llms-full.txt, icons and IndexNow.
 */
const LOCAL = "http://localhost";
const KEY = "abcd1234efgh5678";
const e = { ...env, PUBLIC_BASE_URL: LOCAL, INDEXNOW_KEY: KEY } as unknown as Env;
const get = (path: string, init?: RequestInit, en: Env = e) => app.request(`${LOCAL}${path}`, init, en as any);

beforeEach(async () => {
  await initDb();
  await clearR2();
});

type Node = Record<string, any>;
function ld(html: string): Node[] {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];
  return blocks.map(([, json]) => {
    expect(json).not.toContain("<");
    return JSON.parse(json);
  });
}
const flat = (blocks: Node[]) => blocks.flatMap((b) => (b["@graph"] ? b["@graph"] : [b]));
const types = (html: string) => flat(ld(html)).map((n) => n["@type"]);
const meta = (html: string, re: RegExp) => re.exec(html)?.[1] ?? "";
const title = (html: string) => meta(html, /<title>(.*?)<\/title>/);
const desc = (html: string) => meta(html, /<meta name="description" content="([^"]*)">/);
const MCP = "https://mcp.rtfx.pro/mcp";

describe("per-page metadata", () => {
  const pages = ["/", "/guide", "/pro", "/team", "/enterprise", "/signup", "/login"];
  for (const path of pages) {
    it(`${path}: title <= 60, description 80-155, brand paired with Claude`, async () => {
      const html = await (await get(path, { headers: { "X-Dev-Anonymous": "true" } })).text();
      const t = title(html).replace(/&amp;/g, "&");
      const d = desc(html);
      expect(t.length, t).toBeLessThanOrEqual(60);
      expect(d.length, d).toBeGreaterThanOrEqual(80);
      expect(d.length, d).toBeLessThanOrEqual(155);
      expect(t + d).toMatch(/Claude/);
      expect(html).toContain(`<meta property="og:title" content="${t}">`);
      expect(html).toContain(`<meta name="twitter:title" content="${t}">`);
      expect(html).not.toContain("Claude creates. We share.");
      expect(html).not.toMatch(/Works with Claude Desktop and Claude Code/);
    });
  }

  it("home description mentions MCP, Claude, private link, share and who viewed", async () => {
    const d = desc(await (await get("/")).text());
    for (const w of [/MCP/, /Claude/, /private link/, /share/, /who viewed/]) expect(d).toMatch(w);
  });

  it("/signup has its own description and canonical", async () => {
    const signup = await (await get("/signup", { headers: { "X-Dev-Anonymous": "true" } })).text();
    const login = await (await get("/login", { headers: { "X-Dev-Anonymous": "true" } })).text();
    expect(desc(signup)).not.toBe(desc(login));
    expect(signup).toContain(`<link rel="canonical" href="${LOCAL}/signup">`);
  });

  it("titles of PUBLIC_PAGES for / and /guide match the rendered <title>", async () => {
    const home = await (await get("/")).text();
    const guide = await (await get("/guide")).text();
    expect(title(home)).toBe(PUBLIC_PAGES.find((p) => p.path === "/")!.title);
    expect(title(guide)).toBe(PUBLIC_PAGES.find((p) => p.path === "/guide")!.title);
  });
});

describe("structured data per page", () => {
  it("/ has Organization, WebSite, SoftwareApplication, VideoObject and FAQPage", async () => {
    const html = await (await get("/")).text();
    const t = types(html);
    for (const x of ["Organization", "WebSite", "SoftwareApplication", "VideoObject", "FAQPage"]) {
      expect(t).toContain(x);
    }
    const nodes = flat(ld(html));
    const app = nodes.find((n) => n["@type"] === "SoftwareApplication")!;
    expect(app.applicationCategory).toBe("DeveloperApplication");
    expect(app.operatingSystem).toBe("Web");
    expect(app.offers.price).toBe("0");
    expect(app.featureList.length).toBeGreaterThanOrEqual(5);
    const video = nodes.find((n) => n["@type"] === "VideoObject")!;
    expect(video.thumbnailUrl).toBe(`${LOCAL}/media/${VIDEO.poster}?v=1`);
    expect(video.contentUrl).toBe(`${LOCAL}/media/${VIDEO.file}?v=1`);
    expect(video.uploadDate).toBe("2026-10-26");
    expect(video.duration).toBe("PT55S");
    expect(video.name && video.description).toBeTruthy();
  });

  it("FAQPage matches the visible FAQ question for question, answer for answer", async () => {
    const html = await (await get("/")).text();
    const faq = flat(ld(html)).find((n) => n["@type"] === "FAQPage")!;
    expect(faq.mainEntity).toHaveLength(FAQS.length);
    expect(FAQS.length).toBeGreaterThanOrEqual(5);
    expect(FAQS.length).toBeLessThanOrEqual(7);
    const section = /<section id="faq"[\s\S]*?<\/section>/.exec(html)![0];
    const visible = htmlToText(section);
    for (const q of faq.mainEntity) {
      expect(q["@type"]).toBe("Question");
      expect(visible).toContain(htmlToText(q.name.replace(/'/g, "&#39;")));
      expect(visible).toContain(htmlToText(q.acceptedAnswer.text.replace(/'/g, "&#39;")));
    }
  });

  it("the FAQ section sits after Delete and before pricing", async () => {
    const html = await (await get("/")).text();
    const i = (s: string) => html.indexOf(s);
    expect(i('id="delete"')).toBeLessThan(i('id="faq"'));
    expect(i('id="faq"')).toBeLessThan(i('id="pricing"'));
    expect((html.match(/id="faq"/g) ?? []).length).toBe(1);
  });

  it("/guide has HowTo (12 ordered steps with absolute images), VideoObject and BreadcrumbList", async () => {
    const html = await (await get("/guide")).text();
    const nodes = flat(ld(html));
    expect(nodes.map((n) => n["@type"]).sort()).toEqual(["BreadcrumbList", "HowTo", "VideoObject"]);
    const howto = nodes.find((n) => n["@type"] === "HowTo")!;
    expect(howto.totalTime).toBe("PT3M");
    expect(howto.step).toHaveLength(12);
    howto.step.forEach((s: Node, i: number) => {
      expect(s.position).toBe(i + 1);
      expect(s.name && s.text).toBeTruthy();
      expect(s.url).toBe(`${LOCAL}/guide#step-${i + 1}`);
      expect(s.image.url).toMatch(new RegExp(`^${LOCAL}/guide/[a-z0-9-]+\\.webp\\?v=`));
      expect(html).toContain(`id="step-${i + 1}"`);
      expect(html).toContain(s.image.url.replace(LOCAL, ""));
    });
    expect(guideSteps()).toHaveLength(12);
  });

  it("/pro and /team carry BreadcrumbList + Product/Offer with the price the page shows", async () => {
    for (const tier of ["pro", "team"] as const) {
      const html = await (await get(`/${tier}`)).text();
      const nodes = flat(ld(html));
      expect(nodes.map((n) => n["@type"]).sort()).toEqual(["BreadcrumbList", "Product"]);
      const offer = nodes.find((n) => n["@type"] === "Product")!.offers;
      expect(offer.price).toBe(String(PLAN_PRICE[tier]));
      expect(offer.priceCurrency).toBe("USD");
      expect(html).toContain(`$${PLAN_PRICE[tier]}/mo`);
      expect(offer.url).toBe(`${LOCAL}/${tier}`);
    }
  });

  it("/enterprise states no price, so it has only a BreadcrumbList", async () => {
    const html = await (await get("/enterprise")).text();
    expect(types(html)).toEqual(["BreadcrumbList"]);
  });
});

describe("llms.txt and llms-full.txt", () => {
  it("llms.txt leads with the MCP story and links the new files", () => {
    const txt = llmsTxt({ PUBLIC_BASE_URL: "https://rtfx.pro" });
    const top = txt.slice(0, 2500);
    for (const w of [MCP, "claude mcp add --transport http rtfx", "publish", "share", "delete", "see who opened it", "Claude"]) {
      expect(top).toContain(w);
    }
    expect(txt).toContain("https://rtfx.pro/llms-full.txt");
    expect(txt).toContain("https://rtfx.pro/guide");
    expect(txt).toContain("https://rtfx.pro/#faq");
    for (const p of ["/pro", "/team", "/enterprise"]) expect(txt).toContain(`https://rtfx.pro${p}`);
  });

  it("robots.txt mentions llms-full.txt and blocks neither the pages nor the poster", () => {
    const txt = robotsTxt({ PUBLIC_BASE_URL: "https://rtfx.pro" }, "public");
    expect(txt).toContain("llms-full.txt");
    for (const p of ["/", "/guide", "/media/"]) {
      expect(txt).not.toMatch(new RegExp(`^Disallow: ${p}(\\s|$)`, "m"));
    }
    expect(txt).not.toMatch(/^User-agent: (Googlebot|Bingbot)/m);
  });

  it("llms-full.txt is served as text and carries the FAQ, guide steps and pricing from the page data", async () => {
    const res = await get("/llms-full.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const txt = await res.text();
    for (const f of FAQS) {
      expect(txt).toContain(f.q);
      expect(txt).toContain(f.a);
    }
    for (const s of guideSteps()) expect(txt).toContain(s.name);
    expect(txt).toContain(MCP);
    expect(txt).toContain("$12/mo");
    expect(txt).toContain("$40/mo");
    expect(txt).toContain(llmsFullTxt({ PUBLIC_BASE_URL: LOCAL }));
    expect(txt).not.toMatch(/\bbetas?\b/i);
  });

  it("is not served on the content origin", async () => {
    const ce = { ...e, CONTENT_HOSTNAMES: "content.test.local" } as unknown as Env;
    for (const p of ["/llms-full.txt", "/favicon.ico", "/apple-touch-icon.png", "/icon.svg", "/icon.png", `/${KEY}.txt`]) {
      const res = await app.request(`https://content.test.local${p}`, {}, ce as any);
      expect(res.status, p).toBe(404);
    }
  });
});

describe("icons", () => {
  it("serves /favicon.ico as an ICO holding PNGs, with a long cache", async () => {
    const res = await get("/favicon.ico");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^image\/(x-icon|vnd\.microsoft\.icon)/);
    expect(res.headers.get("Cache-Control")).toMatch(/max-age=\d{6,}/);
    const b = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(b.slice(0, 4))).toEqual([0, 0, 1, 0]);
    expect(b[4]).toBe(3);
    const off = b[6 + 12] | (b[6 + 13] << 8);
    expect(Array.from(b.slice(off, off + 4))).toEqual([137, 80, 78, 71]);
  });

  it("serves a 180x180 /apple-touch-icon.png", async () => {
    const res = await get("/apple-touch-icon.png");
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toMatch(/max-age=\d{6,}/);
    const b = new DataView(await res.arrayBuffer());
    expect(b.getUint32(16)).toBe(APPLE_TOUCH_SIZE);
    expect(b.getUint32(20)).toBe(APPLE_TOUCH_SIZE);
  });

  it("apple-touch PNG was rendered from the current artwork", async () => {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(appleTouchIconSvg()));
    const hex = [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(hex, "run `node scripts/generate-brand-rasters.mjs --icons-only`").toBe(APPLE_TOUCH_SVG_SHA256);
  });

  it("serves /icon.svg and a 512x512 /icon.png for directories", async () => {
    const svg = await get("/icon.svg");
    expect(svg.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(svg.headers.get("Cache-Control")).toMatch(/max-age=\d{6,}/);
    expect(await svg.text()).toContain("<svg");
    const png = await get("/icon.png");
    expect(png.headers.get("Content-Type")).toBe("image/png");
    const v = new DataView(await png.arrayBuffer());
    expect(v.getUint32(16)).toBe(512);
    expect(v.getUint32(20)).toBe(512);
  });

  it("the layout links the .ico, the SVG and the apple-touch icon", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="any">');
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
  });
});

describe("IndexNow key file", () => {
  it("answers with the key when INDEXNOW_KEY is set", async () => {
    const res = await get(`/${KEY}.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(KEY);
  });

  it("404s for a wrong key, and for everything when unset", async () => {
    expect((await get("/wrongkey12345678.txt")).status).toBe(404);
    const unset = { ...env, PUBLIC_BASE_URL: LOCAL } as unknown as Env;
    expect((await get(`/${KEY}.txt`, undefined, unset)).status).toBe(404);
  });

  it("the ping script builds the documented body", async () => {
    // @ts-expect-error plain .mjs without types
    const m = await import("../scripts/indexnow-ping.mjs");
    expect(m.sitemapUrls("<urlset><url><loc>https://rtfx.pro/</loc></url><url><loc>https://rtfx.pro/guide</loc></url></urlset>")).toEqual([
      "https://rtfx.pro/",
      "https://rtfx.pro/guide",
    ]);
    expect(m.indexNowBody("https://rtfx.pro", KEY, ["https://rtfx.pro/"])).toEqual({
      host: "rtfx.pro",
      key: KEY,
      keyLocation: `https://rtfx.pro/${KEY}.txt`,
      urlList: ["https://rtfx.pro/"],
    });
  });
});

describe("site constants", () => {
  it("description stays within a result snippet", () => {
    expect(SITE.description.length).toBeLessThanOrEqual(155);
    expect(SITE.homeTitle.length).toBeLessThanOrEqual(60);
    expect(SITE.guideTitle.length).toBeLessThanOrEqual(60);
  });
});
