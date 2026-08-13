import { describe, it, expect } from "vitest";
import { req } from "./fixtures";
import { decodePng, hexRgb, type DecodedPng } from "./png";
import { MARK_BLUE } from "../src/pages";
import {
  LOGO_PNG_SIZE,
  LOGO_SVG_SHA256,
  OG_IMAGE_SVG_SHA256,
  logoSvg,
  ogImageSvg,
} from "../src/seo";

/**
 * The two checked-in rasters must be the artwork the code draws today.
 *
 * `/og.png` is what every unfurl, `og:image` and `twitter:image` actually shows,
 * and it is a base64 blob in `src/seo.ts` rather than something rendered on
 * demand — a Worker has no image encoder. So the SVG next to it was redesigned
 * (new mark treatment, new lockup position, new copy) and the blob went on
 * serving the old design to every share, with a green suite the whole time. The
 * existing test asserted a PNG signature, which the stale bytes had.
 *
 * Two independent checks close that, and they fail for different reasons:
 *
 *  1. **The source digest.** `OG_IMAGE_SVG_SHA256` / `LOGO_SVG_SHA256` are the
 *     SHA-256 of the exact SVG string each PNG was rendered from. Change the
 *     artwork or a word of the copy inside it and the digest no longer matches,
 *     whatever the pixels happen to look like. This is the check the redesign
 *     would have tripped.
 *  2. **The pixels.** The PNGs are decoded and the mark's tile is read at the
 *     coordinates the *current* SVG places it at — including a point that is
 *     inside today's tile and was outside the old one, and a point that is white
 *     only because `MARK_PATH` is filled rather than stroked. A digest can be
 *     pasted in without re-rendering; these cannot.
 *
 * Both are cleared the same way: `node scripts/generate-brand-rasters.mjs`.
 */

const REGENERATE = "run `node scripts/generate-brand-rasters.mjs`";

const png = async (path: string): Promise<{ res: Response; image: DecodedPng }> => {
  const res = await req(path);
  expect(res.status, path).toBe(200);
  return { res, image: decodePng(new Uint8Array(await res.arrayBuffer())) };
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Exact-match a pixel, with a little room for the renderer's colour handling. */
function expectColor(actual: readonly number[], expected: readonly number[], where: string) {
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs(actual[i] - expected[i]), `${where}: got rgba(${actual.join(", ")})`).toBeLessThanOrEqual(2);
  }
}

const BLUE = hexRgb(MARK_BLUE);
const WHITE = [255, 255, 255];

/**
 * Where the mark's own 32×32 grid lands in the social card, read off the SVG
 * rather than hardcoded — so moving the lockup moves these samples with it, and
 * a raster rendered before the move fails.
 */
function cardMarkGrid(): (gx: number, gy: number) => [number, number] {
  const m = /<svg x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" viewBox="0 0 32 32">/.exec(
    ogImageSvg()
  );
  expect(m, "ogImageSvg() no longer nests the mark as a 32×32 <svg>").not.toBeNull();
  const [x, y, size] = [Number(m![1]), Number(m![2]), Number(m![3])];
  return (gx, gy) => [Math.round(x + (gx * size) / 32), Math.round(y + (gy * size) / 32)];
}

/** The same mapping for the logo, which *is* the mark and nothing else. */
const logoGrid = (gx: number, gy: number): [number, number] => [
  Math.round((gx * LOGO_PNG_SIZE) / 32),
  Math.round((gy * LOGO_PNG_SIZE) / 32),
];

describe("the checked-in rasters are the current artwork", () => {
  it("was rendered from the social card the code serves today", async () => {
    expect(OG_IMAGE_SVG_SHA256, `OG_IMAGE_SVG_SHA256 is unset — ${REGENERATE}`).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await sha256Hex(ogImageSvg()),
      `ogImageSvg() changed since /og.png was rendered — ${REGENERATE}`
    ).toBe(OG_IMAGE_SVG_SHA256);
  });

  it("was rendered from the logo the code serves today", async () => {
    expect(LOGO_SVG_SHA256, `LOGO_SVG_SHA256 is unset — ${REGENERATE}`).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await sha256Hex(logoSvg(LOGO_PNG_SIZE)),
      `logoSvg() changed since /logo.png was rendered — ${REGENERATE}`
    ).toBe(LOGO_SVG_SHA256);
  });

  it("serves the card at the 1200×630 every social platform expects", async () => {
    const { res, image } = await png("/og.png");
    expect(res.headers.get("Content-Type")).toContain("image/png");
    expect(image.width).toBe(1200);
    expect(image.height).toBe(630);
  });

  it("draws the rtfx tile on the card where the current SVG puts it", async () => {
    const { image } = await png("/og.png");
    const at = cardMarkGrid();

    // Inside the tile, above and below the glyph. The lower sample is the one
    // that pins the lockup's position and size: the previous card's tile ended
    // well above it, so a stale raster reads background here.
    expectColor(image.pixel(...at(16, 4)), BLUE, "tile above the mark");
    expectColor(image.pixel(...at(16, 30)), BLUE, "tile below the mark");
    expectColor(image.pixel(...at(4, 20)), BLUE, "tile left of the mark");

    // Inside the glyph. White only because MARK_PATH is filled; when the card
    // drew it as a 2.5-wide white outline this point was the blue gap between
    // the two strokes.
    expectColor(image.pixel(...at(16, 12)), WHITE, "the mark itself");

    // Outside the tile: the card's own dark background, never the mark's blue.
    const outside = image.pixel(...at(16, 36));
    expect(outside[0] + outside[1] + outside[2], "below the tile should be the dark card background").toBeLessThan(120);
  });
});

describe("the square logo", () => {
  it("is served at /logo.png as a square PNG, with the same nosniff guard as the card", async () => {
    const { res, image } = await png("/logo.png");
    expect(res.headers.get("Content-Type")).toContain("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(image.width).toBe(LOGO_PNG_SIZE);
    expect(image.height).toBe(LOGO_PNG_SIZE);
    expect(image.width).toBe(image.height);
  });

  it("is the mark and nothing else — the same tile, full bleed", async () => {
    const { image } = await png("/logo.png");
    expectColor(image.pixel(...logoGrid(16, 4)), BLUE, "tile above the mark");
    expectColor(image.pixel(...logoGrid(16, 30)), BLUE, "tile below the mark");
    expectColor(image.pixel(...logoGrid(16, 12)), WHITE, "the mark itself");
    // Transparent outside the rounded corner, so it sits on a light or a dark
    // panel equally well.
    expect(image.pixel(...logoGrid(1, 1))[3], "the corner outside the tile radius").toBe(0);
  });

  it("is reachable without an identity, like the rest of the crawler-facing files", async () => {
    const res = await req("/logo.png", { headers: { "X-Dev-Anonymous": "true" } });
    expect(res.status).toBe(200);
  });
});
