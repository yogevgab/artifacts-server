#!/usr/bin/env node
/**
 * Regenerate the two checked-in brand rasters in `src/seo.ts` from the SVG
 * sources in the same file:
 *
 *   ogImageSvg()  →  OG_IMAGE_PNG_BASE64   (1200×630 social card, served at /og.png)
 *   logoSvg()     →  LOGO_PNG_BASE64       (512×512 square mark,  served at /logo.png)
 *
 * Run it after ANY change to `ogImageSvg()`, `logoSvg()`, `MARK_PATH`,
 * `MARK_BLUE`, `SITE.name` or `SITE.tagline`:
 *
 *     node scripts/generate-brand-rasters.mjs
 *
 * Then run `npm test` — `test/brand-raster.test.ts` decodes both PNGs and fails
 * if they no longer match the SVG sources, which is exactly the drift this
 * script exists to clear. (The card shipped a full redesign's worth of stale
 * pixels once because there was neither a script nor a test.)
 *
 * Two deliberate choices:
 *
 *  - **Headless Chrome does the rasterizing.** It is the only SVG renderer that
 *    is already on a macOS dev box, and it is the same engine that will render
 *    `/og.svg`, so the PNG and the SVG cannot disagree about text layout. Pass
 *    `--chrome=/path/to/binary` (or set CHROME_PATH) elsewhere.
 *  - **esbuild reads the TypeScript.** The SVG lives in `src/seo.ts`, and
 *    esbuild is already installed (wrangler depends on it), so the script reads
 *    the real source rather than a second copy of the artwork that could drift
 *    in its own right.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unzlibSync, zlibSync } from "fflate";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEO_TS = path.join(ROOT, "src", "seo.ts");

/** Chrome, in the order worth trying. */
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function findChrome(argv) {
  const flag = argv.find((a) => a.startsWith("--chrome="));
  const explicit = flag ? flag.slice("--chrome=".length) : process.env.CHROME_PATH;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`No Chrome binary at ${explicit}`);
    return explicit;
  }
  const found = CHROME_CANDIDATES.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      "No Chrome/Chromium found. Pass --chrome=/path/to/chrome or set CHROME_PATH.\n" +
        `Looked in:\n  ${CHROME_CANDIDATES.join("\n  ")}`
    );
  }
  return found;
}

/**
 * Load `src/seo.ts` as a real module, so the artwork this script rasterizes is
 * the artwork the Worker serves — not a transcription of it.
 */
async function loadSeoModule() {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    throw new Error(
      "esbuild is not installed. It normally arrives with wrangler — run `npm install` first."
    );
  }
  const built = await esbuild.build({
    entryPoints: [SEO_TS],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  const js = built.outputFiles[0].text;
  const url = `data:text/javascript;base64,${Buffer.from(js, "utf8").toString("base64")}`;
  return import(url);
}

/**
 * Rasterize one SVG string at an exact pixel size.
 *
 * The SVG is wrapped in a zero-margin document sized to the viewport rather than
 * loaded directly: Chrome's standalone image viewer centres and scales an SVG,
 * which would silently letterbox the card.
 */
async function rasterize(chrome, svg, width, height, workDir, name) {
  const page = path.join(workDir, `${name}.html`);
  const out = path.join(workDir, `${name}.png`);
  await writeFile(
    page,
    `<!doctype html><meta charset="utf-8">` +
      `<style>html,body{margin:0;padding:0;background:transparent}` +
      `svg{display:block;width:${width}px;height:${height}px}</style>` +
      svg,
    "utf8"
  );
  await run(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--default-background-color=00000000",
    `--window-size=${width},${height}`,
    `--screenshot=${out}`,
    `file://${page}`,
  ]);
  const png = await readFile(out);
  assertPngSize(png, width, height, name);
  return recompress(png);
}

// --- PNG recompression -------------------------------------------------------
// Chrome's screenshot encoder optimizes for speed: it writes every scanline with
// one filter and deflates at a low level, which cost 260 kB for a card that
// re-encodes losslessly to well under a third of that. These bytes are inlined
// in the Worker bundle as base64, so the difference is bundle size on every
// deploy — worth the ~60 lines. Pixels are unchanged; `verifyIdentical` proves
// it on every run.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Chunks in order, as `{ type, data }`. */
function readChunks(png) {
  const chunks = [];
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    chunks.push({ type: png.toString("ascii", off + 4, off + 8), data: png.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return chunks;
}

/** Raw (unfiltered) pixel bytes of a truecolour 8-bit PNG, plus its shape. */
function decode(png) {
  const chunks = readChunks(png);
  const ihdr = chunks.find((c) => c.type === "IHDR").data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colorType = ihdr[9];
  if (depth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG: depth ${depth}, colour type ${colorType}`);
  }
  if (ihdr[12] !== 0) throw new Error("Interlaced PNG is not supported");
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = Buffer.from(
    unzlibSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)))
  );
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? Buffer.alloc(stride) : out.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) add = paeth(a, b, c);
      else if (filter !== 0) throw new Error(`Unknown PNG filter ${filter}`);
      cur[x] = (line[x] + add) & 0xff;
    }
  }
  return { width, height, bpp, pixels: out };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Re-encode with per-scanline adaptive filtering and maximum deflate. */
function encode({ width, height, bpp, pixels }) {
  const stride = width * bpp;
  const filtered = Buffer.alloc(height * (stride + 1));
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? Buffer.alloc(stride) : pixels.subarray((y - 1) * stride, y * stride);
    let bestType = 0;
    let bestScore = Infinity;
    let best = null;
    for (let type = 0; type <= 4; type++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        const sub = type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : type === 4 ? paeth(a, b, c) : 0;
        const v = (cur[x] - sub) & 0xff;
        candidate[x] = v;
        // The reference heuristic: sum of absolute values as signed bytes.
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best = Buffer.from(candidate);
      }
    }
    filtered[y * (stride + 1)] = bestType;
    best.copy(filtered, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = bpp === 4 ? 6 : 2;
  const idat = Buffer.from(zlibSync(filtered, { level: 9, mem: 12 }));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function recompress(png) {
  const original = decode(png);
  const smaller = encode(original);
  const roundTripped = decode(smaller);
  if (!original.pixels.equals(roundTripped.pixels)) {
    throw new Error("Recompression changed pixels — refusing to write");
  }
  return smaller.length < png.length ? smaller : png;
}

/** Fail loudly rather than commit a mis-sized card. */
function assertPngSize(png, width, height, name) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((b, i) => png[i] === b)) throw new Error(`${name}: not a PNG`);
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  if (w !== width || h !== height) {
    throw new Error(`${name}: rendered ${w}×${h}, expected ${width}×${height}`);
  }
}

/** SHA-256 of a UTF-8 string, hex. Matches what the test computes with WebCrypto. */
function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Rewrite one `export const NAME = "…";` line in place. */
function replaceConstant(source, name, base64) {
  const pattern = new RegExp(`(export const ${name} = ")[^"]*(";)`);
  if (!pattern.test(source)) throw new Error(`Could not find \`export const ${name}\` in src/seo.ts`);
  return source.replace(pattern, `$1${base64}$2`);
}

async function main() {
  const chrome = findChrome(process.argv.slice(2));
  const seo = await loadSeoModule();
  const workDir = await mkdtemp(path.join(tmpdir(), "rtfx-rasters-"));
  try {
    const size = seo.LOGO_PNG_SIZE;
    const cardSvg = seo.ogImageSvg();
    const logoSvg = seo.logoSvg(size);
    const card = await rasterize(chrome, cardSvg, 1200, 630, workDir, "og");
    const logo = await rasterize(chrome, logoSvg, size, size, workDir, "logo");

    let source = await readFile(SEO_TS, "utf8");
    source = replaceConstant(source, "OG_IMAGE_PNG_BASE64", card.toString("base64"));
    source = replaceConstant(source, "LOGO_PNG_BASE64", logo.toString("base64"));
    // The digests are what make a *later* edit to the artwork fail the suite
    // instead of silently shipping the previous render.
    source = replaceConstant(source, "OG_IMAGE_SVG_SHA256", sha256Hex(cardSvg));
    source = replaceConstant(source, "LOGO_SVG_SHA256", sha256Hex(logoSvg));
    await writeFile(SEO_TS, source, "utf8");

    console.log(`Rasterized with ${chrome}`);
    console.log(`  OG_IMAGE_PNG_BASE64  1200×630  ${card.length} bytes`);
    console.log(`  LOGO_PNG_BASE64      ${size}×${size}    ${logo.length} bytes`);
    console.log("Wrote src/seo.ts — now run `npm test`.");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
