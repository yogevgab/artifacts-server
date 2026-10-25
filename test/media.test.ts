import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { initDb, clearR2, req } from "./fixtures";
import { isReservedAccountSlug } from "../src/account-slugs";
import { isManagementPath } from "../src/host";

const ANON = { headers: { "X-Dev-Anonymous": "true" } };
const BYTES = new Uint8Array(1000).map((_, i) => i % 251);

beforeEach(async () => {
  await initDb();
  await clearR2();
});

describe("/media", () => {
  it("serves an allowlisted file from R2 under _site/, with byte ranges", async () => {
    await env.FILES.put("_site/rtfx-guide.mp4", BYTES);
    const full = await req("/media/rtfx-guide.mp4", ANON);
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe("video/mp4");
    expect(full.headers.get("Accept-Ranges")).toBe("bytes");
    expect(full.headers.get("Cache-Control")).toContain("public");
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(BYTES);

    const part = await req("/media/rtfx-guide.mp4", { headers: { ...ANON.headers, Range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 100-199/1000");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(BYTES.slice(100, 200));
  });

  it("404s names outside the allowlist, even if the object exists", async () => {
    await env.FILES.put("_site/other.mp4", BYTES);
    for (const name of ["other.mp4", "__proto__", "constructor", "..%2Fx"]) {
      expect((await req(`/media/${name}`, ANON)).status).toBe(404);
    }
  });

  it("404s an allowlisted name that was never uploaded", async () => {
    expect((await req("/media/rtfx-guide.mp4", ANON)).status).toBe(404);
  });

  it("embeds the video on the home page and on /guide, without autoplay", async () => {
    for (const path of ["/", "/guide"]) {
      const html = await (await req(path, ANON)).text();
      expect(html).toMatch(/<video[^>]*preload="none"/);
      expect(html).not.toMatch(/<video[^>]*autoplay/);
      expect(html).toContain('src="/media/rtfx-guide.mp4?v=');
      expect(html).toContain('poster="/media/rtfx-guide-poster.jpg?v=');
    }
  });

  it("is app-host only and an unclaimable workspace slug", () => {
    expect(isManagementPath("/media/rtfx-guide.mp4")).toBe(true);
    expect(isReservedAccountSlug("media")).toBe(true);
  });
});
