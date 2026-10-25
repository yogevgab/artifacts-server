import { beforeEach, describe, expect, it } from "vitest";
import { initDb, clearR2, req } from "./fixtures";
import { isReservedAccountSlug } from "../src/account-slugs";
import { isManagementPath } from "../src/host";
import { GUIDE_IMAGES } from "../src/guide-images";

const ANON = { headers: { "X-Dev-Anonymous": "true" } };

beforeEach(async () => {
  await initDb();
  await clearR2();
});

async function guide(): Promise<string> {
  const res = await req("/guide", ANON);
  expect(res.status).toBe(200);
  return res.text();
}

describe("/guide", () => {
  it("renders the h1, canonical and 12 sized, described images", async () => {
    const html = await guide();
    expect(html).toContain("Add rtfx to Claude, publish, share, and see who opened it");
    expect(html).toContain("<title>Step-by-step guide · rtfx.pro</title>");
    expect(html).toMatch(/<link rel="canonical" href="[^"]+\/guide">/);
    expect(html).not.toContain("noindex");
    const imgs = html.match(/<img\b[^>]*>/g) ?? [];
    expect(imgs.length).toBe(12);
    for (const img of imgs) {
      expect(img).toMatch(/width="\d+"/);
      expect(img).toMatch(/height="\d+"/);
      expect(img).toMatch(/alt="[^"]{10,}"/);
    }
    for (const id of ["connect", "publish", "share", "views"]) expect(html).toContain(`id="${id}"`);
  });

  it("serves every image as immutable webp, and 404s unknown names", async () => {
    const html = await guide();
    const urls = [...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]!);
    expect(urls.length).toBe(12);
    for (const url of urls) {
      const res = await req(url, ANON);
      expect(res.status, url).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/webp");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    }
    expect(Object.keys(GUIDE_IMAGES).length).toBe(12);
    for (const bad of ["/guide/nope.webp", "/guide/01-add-custom-connector.png", "/guide/__proto__.webp"]) {
      expect((await req(bad, ANON)).status, bad).toBe(404);
    }
  });

  it("is linked from the home page, the nav and the sitemap", async () => {
    const home = await (await req("/", ANON)).text();
    expect(home).toContain('href="/guide"');
    expect(home).toContain("See every step with screenshots");
    expect(home).toMatch(/<nav class="nav"[\s\S]*data-nav="guide"[\s\S]*<\/nav>/);
    const map = await (await req("/sitemap.xml", ANON)).text();
    expect(map).toContain("/guide</loc>");
    const llms = await (await req("/llms.txt", ANON)).text();
    expect(llms).toContain("/guide");
  });

  it("is app-host only and an unclaimable workspace slug", () => {
    expect(isManagementPath("/guide")).toBe(true);
    expect(isManagementPath("/guide/01-add-custom-connector.webp")).toBe(true);
    expect(isReservedAccountSlug("guide")).toBe(true);
  });
});
