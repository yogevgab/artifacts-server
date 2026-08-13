import { unzlibSync } from "fflate";

/**
 * A PNG decoder small enough to read in one sitting, so a test can assert on
 * pixels instead of on byte counts.
 *
 * It exists for `test/brand-raster.test.ts`: the social card and the logo are
 * checked into `src/seo.ts` as base64, and the only way to prove those bytes are
 * the *current* artwork rather than a previous render is to look at what they
 * draw. `fflate` is already a runtime dependency (the CLI zips with it), so the
 * inflate half costs nothing.
 *
 * Handles exactly what `scripts/generate-brand-rasters.mjs` emits: 8-bit,
 * non-interlaced, truecolour with or without alpha. Anything else throws rather
 * than guessing.
 */

export interface DecodedPng {
  width: number;
  height: number;
  /** `[r, g, b, a]` at a pixel; alpha is 255 for an image with no alpha channel. */
  pixel(x: number, y: number): [number, number, number, number];
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error("not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let header: DataView | undefined;
  const idat: Uint8Array[] = [];
  for (let off = 8; off + 8 <= bytes.length; ) {
    const length = view.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const data = bytes.subarray(off + 8, off + 8 + length);
    if (type === "IHDR") header = new DataView(data.buffer, data.byteOffset, data.byteLength);
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + length;
  }
  if (!header) throw new Error("PNG has no IHDR");

  const width = header.getUint32(0);
  const height = header.getUint32(4);
  const depth = header.getUint8(8);
  const colorType = header.getUint8(9);
  const interlace = header.getUint8(12);
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported colour type ${colorType}`);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;

  const joined = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of idat) {
    joined.set(part, at);
    at += part.length;
  }
  const raw = unzlibSync(joined);

  // Undo the per-scanline filter (PNG spec §9.2) into a flat pixel buffer.
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? pixels[rowStart + x - bpp] : 0;
      const b = y > 0 ? pixels[prevStart + x] : 0;
      const c = y > 0 && x >= bpp ? pixels[prevStart + x - bpp] : 0;
      let add: number;
      switch (filter) {
        case 0: add = 0; break;
        case 1: add = a; break;
        case 2: add = b; break;
        case 3: add = (a + b) >> 1; break;
        case 4: add = paeth(a, b, c); break;
        default: throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      pixels[rowStart + x] = (line[x] + add) & 0xff;
    }
  }

  return {
    width,
    height,
    pixel(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) {
        throw new Error(`pixel (${x}, ${y}) is outside a ${width}×${height} image`);
      }
      const at = y * stride + x * bpp;
      return [pixels[at], pixels[at + 1], pixels[at + 2], bpp === 4 ? pixels[at + 3] : 255];
    },
  };
}

/** `#0a84ff` → `[10, 132, 255]`. */
export function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
