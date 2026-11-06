import { beforeEach, describe, expect, it } from "vitest";
import { initDb, clearR2, req } from "./fixtures";
import { isReservedAccountSlug } from "../src/account-slugs";
import { isManagementPath } from "../src/host";
import { GUIDE_IMAGES } from "../src/guide-images";
import { MEDIA } from "../src/media";

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
    expect(html).toContain("<title>rtfx.pro guide: private links for Claude (MCP)</title>");
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
    // The 12 /guide screenshots plus the 6 on the ChatGPT answer page.
    expect(Object.keys(GUIDE_IMAGES).filter((k) => !k.startsWith("chatgpt-")).length).toBe(12);
    expect(Object.keys(GUIDE_IMAGES).filter((k) => k.startsWith("chatgpt-")).length).toBe(6);
    for (const bad of ["/guide/nope.webp", "/guide/01-add-custom-connector.png", "/guide/__proto__.webp"]) {
      expect((await req(bad, ANON)).status, bad).toBe(404);
    }
  });

  it("serves every screenshot on the ChatGPT answer page, with alt text and a caption", async () => {
    const html = await (await req("/share-chatgpt-html-privately", ANON)).text();
    const imgs = [...html.matchAll(/<figure class="shot"><img([^>]*)><figcaption>([^<]+)<\/figcaption><\/figure>/g)];
    expect(imgs.length).toBe(6);
    for (const [, attrs, caption] of imgs) {
      const src = /src="([^"]+)"/.exec(attrs!)![1]!;
      expect(src).toMatch(/^\/guide\/chatgpt-\d\d-[a-z-]+\.webp\?v=[0-9a-f]{8}$/);
      expect(attrs).toMatch(/alt="[^"]{10,}"/);
      expect(attrs).toMatch(/width="\d+" height="\d+"/);
      expect(caption!.length).toBeGreaterThan(10);
      const res = await req(src, ANON);
      expect(res.status, src).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/webp");
    }
    // The screenshots must not show a real person's address.
    expect(html).not.toMatch(/@gmail\.com/);
  });

  it("embeds the ChatGPT walkthrough video with VideoObject data, served from the /media allowlist", async () => {
    const html = await (await req("/share-chatgpt-html-privately", ANON)).text();
    expect(html).toMatch(/<figure class="walk"><video controls playsinline preload="none" width="1280" height="720"/);
    expect(html).toContain('poster="/media/rtfx-chatgpt-guide-poster.jpg?v=');
    expect(html).toContain('<source src="/media/rtfx-chatgpt-guide.mp4?v=');
    expect(html).toMatch(/<track kind="captions" src="\/media\/rtfx-chatgpt-guide\.vtt\?v=[^"]+" srclang="en" label="English">/);
    const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .flatMap((m) => {
        const j = JSON.parse(m[1]!);
        return Array.isArray(j) ? j : j["@graph"] ?? [j];
      });
    const video = ld.find((n: any) => n["@type"] === "VideoObject");
    expect(video).toMatchObject({
      "@id": "https://rtfx.pro/share-chatgpt-html-privately#video",
      duration: "PT30S",
      encodingFormat: "video/mp4",
    });
    expect(video.contentUrl).toMatch(/^https:\/\/rtfx\.pro\/media\/rtfx-chatgpt-guide\.mp4\?v=/);
    expect(video.uploadDate).toMatch(/T00:00:00\+00:00$/);
    expect(Object.keys(MEDIA)).toEqual(expect.arrayContaining(["rtfx-chatgpt-guide.mp4", "rtfx-chatgpt-guide-poster.jpg"]));
    // Other answer pages carry no video.
    expect(await (await req("/share-cursor-html-privately", ANON)).text()).not.toContain("<video");
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
