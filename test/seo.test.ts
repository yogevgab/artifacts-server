import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { strToU8 } from "fflate";
import app from "../src/index";
import { initDb, clearR2, req, as, htmlForm } from "./fixtures";
import {
  SITE,
  PUBLIC_PAGES,
  siteOrigin,
  canonicalUrl,
  isCanonicalHost,
  robotsTxt,
  sitemapXml,
  llmsTxt,
} from "../src/seo";
import type { Env } from "../src/env";

/**
 * Public-web surface (issue #29): SEO fundamentals, AI-crawler readiness, and
 * the invariant underneath both — only the three public product pages are
 * crawlable, and everything that needs an identity stays out of every index.
 *
 * Tests below run against `http://localhost` (what `app.request` synthesizes),
 * so they pin `PUBLIC_BASE_URL` when they need the canonical-host branch, and
 * get the non-canonical branch for free otherwise.
 */

const LOCAL = "http://localhost";
/** The app as it behaves on its canonical public origin. */
const canonicalEnv = { ...env, PUBLIC_BASE_URL: LOCAL } as unknown as Env;
const canonicalReq = (path: string, init?: RequestInit) =>
  app.request(`${LOCAL}${path}`, init, canonicalEnv as any);

const CONTENT_HOST = "content.test.local";
const contentEnv = { ...env, CONTENT_HOSTNAMES: CONTENT_HOST, PUBLIC_BASE_URL: LOCAL } as unknown as Env;
const contentReq = (path: string, init?: RequestInit) =>
  app.request(`https://${CONTENT_HOST}${path}`, init, contentEnv as any);

beforeEach(async () => {
  await initDb();
  await clearR2();
});

describe("canonical origin", () => {
  it("defaults to the production origin and honours PUBLIC_BASE_URL", () => {
    expect(siteOrigin({})).toBe(SITE.origin);
    expect(siteOrigin({ PUBLIC_BASE_URL: "https://staging.example.com" })).toBe(
      "https://staging.example.com"
    );
  });

  it("strips trailing slashes so canonical URLs never double up", () => {
    expect(siteOrigin({ PUBLIC_BASE_URL: "https://x.test//" })).toBe("https://x.test");
    expect(canonicalUrl({ PUBLIC_BASE_URL: "https://x.test/" }, "/docs")).toBe(
      "https://x.test/docs"
    );
    expect(canonicalUrl({}, "docs")).toBe(`${SITE.origin}/docs`);
  });

  it("recognises only the canonical hostname", () => {
    const e = { PUBLIC_BASE_URL: "https://rtfx.pro" };
    expect(isCanonicalHost(e, "https://rtfx.pro/docs")).toBe(true);
    expect(isCanonicalHost(e, "https://RTFX.PRO/")).toBe(true);
    expect(isCanonicalHost(e, "https://artifacts.workers.dev/")).toBe(false);
    expect(isCanonicalHost(e, "https://a.rtfx.pro/x/")).toBe(false);
  });
});

describe("robots.txt", () => {
  it("lets crawlers read the product pages and keeps them out of gated ones", () => {
    const txt = robotsTxt({ PUBLIC_BASE_URL: "https://rtfx.pro" }, "public");
    expect(txt).toContain("User-agent: *");
    expect(txt).toContain("Sitemap: https://rtfx.pro/sitemap.xml");
    expect(txt).toContain("llms.txt");
    for (const gated of ["/admin", "/api/", "/gallery", "/v/", "/whoami"]) {
      expect(txt).toContain(`Disallow: ${gated}`);
    }
    expect(txt).not.toMatch(/^Disallow: \/$/m);
  });

  it("closes the artifact content origin and any non-canonical host entirely", () => {
    for (const audience of ["content", "non-canonical"] as const) {
      const txt = robotsTxt({}, audience);
      expect(txt).toMatch(/^Disallow: \/$/m);
      expect(txt).not.toContain("Sitemap:");
    }
  });

  it("is served as text/plain on the canonical app host", async () => {
    const res = await canonicalReq("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const txt = await res.text();
    expect(txt).toContain(`Sitemap: ${LOCAL}/sitemap.xml`);
    expect(txt).toContain("Disallow: /admin");
  });

  it("tells a preview/staging host not to compete with production", async () => {
    // Default PUBLIC_BASE_URL is rtfx.pro, so localhost is a non-canonical host.
    const txt = await (await req("/robots.txt")).text();
    expect(txt).toMatch(/^Disallow: \/$/m);
    expect(txt).toContain(SITE.origin);
  });

  it("is answered by the content origin itself, disallowing everything", async () => {
    const res = await contentReq("/robots.txt");
    expect(res.status).toBe(200);
    const txt = await res.text();
    expect(txt).toMatch(/^Disallow: \/$/m);
    expect(txt).toContain("access-controlled");
  });
});

describe("sitemap.xml", () => {
  it("lists every public page as an absolute canonical URL, and nothing else", () => {
    const xml = sitemapXml({ PUBLIC_BASE_URL: "https://rtfx.pro" });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    for (const page of PUBLIC_PAGES) {
      expect(xml).toContain(`<loc>https://rtfx.pro${page.path === "/" ? "/" : page.path}</loc>`);
    }
    expect(xml.match(/<loc>/g)).toHaveLength(PUBLIC_PAGES.length);
    for (const gated of ["/admin", "/gallery", "/api", "/whoami"]) {
      expect(xml).not.toContain(`<loc>https://rtfx.pro${gated}`);
    }
  });

  it("is served as XML", async () => {
    const res = await canonicalReq("/sitemap.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/xml");
    expect(await res.text()).toContain(`<loc>${LOCAL}/docs</loc>`);
  });
});

describe("llms.txt", () => {
  it("follows the llmstxt.org shape: title, summary, sections, links", () => {
    const txt = llmsTxt({ PUBLIC_BASE_URL: "https://rtfx.pro" });
    expect(txt.startsWith(`# ${SITE.name}`)).toBe(true);
    expect(txt).toMatch(/^> /m);
    for (const heading of ["## What it is", "## Who it is for", "## How publishing works"]) {
      expect(txt).toContain(heading);
    }
    for (const page of PUBLIC_PAGES) {
      expect(txt).toContain(`https://rtfx.pro${page.path === "/" ? "/" : page.path}`);
    }
  });

  it("describes the access model and says what is deliberately not crawlable", () => {
    const txt = llmsTxt({}).toLowerCase();
    expect(txt).toContain("private by default");
    expect(txt).toContain("cloudflare access");
    expect(txt).toContain("claude code");
    expect(txt).toContain("hermes");
    expect(txt).toContain("not indexed");
  });

  it("is served as text/plain to anyone", async () => {
    const res = await req("/llms.txt", { headers: { "X-Dev-Anonymous": "true" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toContain("# rtfx.pro");
  });
});

describe("social card", () => {
  it("serves an SVG card at /og.svg", async () => {
    const res = await req("/og.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
    const svg = await res.text();
    expect(svg).toContain("<svg");
    expect(svg).toContain('width="1200"');
    expect(svg).toContain("rtfx.pro");
  });
});

describe("public page metadata", () => {
  it("the landing page carries title, description, canonical, OG and Twitter tags", async () => {
    const html = await (await canonicalReq("/")).text();
    expect(html).toContain("<title>rtfx.pro — private hosting for AI-built pages and artifacts</title>");
    expect(html).toMatch(/<meta name="description" content="[^"]{80,}">/);
    expect(html).toContain(`<link rel="canonical" href="${LOCAL}/">`);
    expect(html).toContain('<meta name="robots" content="index,follow,max-image-preview:large">');
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain(`<meta property="og:url" content="${LOCAL}/">`);
    expect(html).toContain(`<meta property="og:image" content="${LOCAL}/og.svg">`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toMatch(/<meta name="twitter:description" content="[^"]+">/);
  });

  it("the landing page describes the product with structured data", async () => {
    const html = await (await canonicalReq("/")).text();
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];
    expect(blocks.length).toBeGreaterThan(0);
    const graph = JSON.parse(blocks[0][1]);
    const types = graph["@graph"].map((n: { "@type": string }) => n["@type"]);
    expect(types).toContain("Organization");
    expect(types).toContain("WebSite");
    expect(types).toContain("SoftwareApplication");
    const productNode = graph["@graph"].find(
      (n: { "@type": string }) => n["@type"] === "SoftwareApplication"
    );
    expect(productNode.url).toBe(`${LOCAL}/`);
    expect(productNode.featureList.length).toBeGreaterThan(2);
  });

  it("the docs page keeps the API-token snippet inside a balanced code element", async () => {
    const html = await (await canonicalReq("/docs")).text();
    expect(html).toContain("<code>Authorization: Bearer &lt;token&gt;</code>");
    expect(html).not.toContain("&lt;to...de>");
  });

  it("escapes < inside JSON-LD so it can never close the script early", async () => {
    const html = await (await canonicalReq("/")).text();
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];
    for (const [, json] of blocks) expect(json).not.toContain("<");
  });

  it("the docs page is public, crawlable, and carries FAQ structured data", async () => {
    const res = await canonicalReq("/docs", { headers: { "X-Dev-Anonymous": "true" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<link rel="canonical" href="${LOCAL}/docs">`);
    expect(html).toContain('<meta name="robots" content="index,follow,max-image-preview:large">');
    const faq = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
      .map(([, json]) => JSON.parse(json))
      .find((b) => b["@type"] === "FAQPage");
    expect(faq).toBeDefined();
    expect(faq.mainEntity.length).toBeGreaterThanOrEqual(4);
    // Every answer offered to a rich result is also visible on the page itself.
    for (const entry of faq.mainEntity) expect(html).toContain(entry.name);
  });

  it("the docs page covers publishing, agents, access control and the API", async () => {
    const html = (await (await req("/docs")).text()).toLowerCase();
    for (const topic of [
      "claude code",
      "hermes",
      "api token",
      "access",
      "version",
      "view log",
      "private by default",
    ]) {
      expect(html, `docs missing: ${topic}`).toContain(topic);
    }
  });

  it("the signed-out sign-in page is public and indexable", async () => {
    const res = await canonicalReq("/login", { headers: { "X-Dev-Anonymous": "true" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<link rel="canonical" href="${LOCAL}/login">`);
    expect(html).toContain('<meta name="robots" content="index,follow,max-image-preview:large">');
  });
});

describe("private surfaces stay out of every index", () => {
  it("signed-in and gated pages are noindex", async () => {
    const pages = [
      await req("/login", as("admin@test.com")),
      await req("/admin/gallery", as("admin@test.com")),
      await req("/admin", as("admin@test.com")),
      await req("/does-not-exist/"),
    ];
    for (const res of pages) {
      const html = await res.text();
      expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
      expect(html).not.toContain('rel="canonical"');
    }
  });

  it("artifact responses carry X-Robots-Tag: noindex", async () => {
    await req("/api/artifacts", {
      method: "POST",
      body: htmlForm({ title: "Report", slug: "report" }, "x.html", strToU8("<h1>report</h1>")),
    });
    const res = await req("/report/", as("admin@test.com"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
  });
});

describe("crawler surface on the content origin", () => {
  it("serves no product page, sitemap or llms.txt there", async () => {
    for (const path of ["/", "/docs", "/sitemap.xml", "/llms.txt", "/og.svg", "/login"]) {
      const res = await contentReq(path);
      expect(res.status, `${path} should not exist on the content host`).toBe(404);
    }
  });

  // Non-management paths on the app host redirect to the content host (that is
  // how artifact URLs move across origins). robots.txt must be exempt, or the
  // app host would answer a crawler with a 302 to a different origin's policy.
  it("the app host answers robots.txt itself instead of redirecting", async () => {
    const res = await app.request("https://app.test.local/robots.txt", {}, contentEnv as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.text()).toContain("User-agent: *");
  });
});

describe("public pages need no identity", () => {
  it("returns 200 and identical bytes for an anonymous visitor", async () => {
    for (const path of ["/", "/docs", "/login", "/robots.txt", "/sitemap.xml", "/llms.txt"]) {
      const anon = await canonicalReq(path, { headers: { "X-Dev-Anonymous": "true" } });
      const signedIn = await canonicalReq(path, as("admin@test.com"));
      expect(anon.status, path).toBe(200);
      // /login is the one public page that reacts to identity — by design.
      if (path !== "/login") expect(await anon.text(), path).toBe(await signedIn.text());
    }
  });
});
