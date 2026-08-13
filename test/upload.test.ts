import { describe, it, expect } from "vitest";
import { zipSync, strToU8, strFromU8 } from "fflate";
import { processZip, singleHtml, UploadError, type ZipLimits } from "../src/upload";

const TINY_LIMITS: ZipLimits = { maxEntries: 3, maxFileBytes: 1024, maxTotalBytes: 2048 };

/**
 * Rewrite the declared "uncompressed size" field (in both the local file
 * header and the central directory record) for `filename` inside a zip
 * produced by `zipSync`, without touching the compressed data stream itself.
 * Simulates an attacker who lies about an entry's original size — the actual
 * bytes fflate inflates are unaffected by this forgery.
 */
function forgeDeclaredSize(zip: Uint8Array, filename: string, declaredSize: number): Uint8Array {
  const out = new Uint8Array(zip);
  const view = new DataView(out.buffer);
  const nameBytes = strToU8(filename);

  const matchesNameAt = (nameOffset: number) => {
    if (nameOffset + nameBytes.length > out.length) return false;
    for (let i = 0; i < nameBytes.length; i++) {
      if (out[nameOffset + i] !== nameBytes[i]) return false;
    }
    return true;
  };

  let patched = 0;
  for (let i = 0; i < out.length - 4; i++) {
    const sig = view.getUint32(i, true);
    if (sig === 0x04034b50) {
      // Local file header: filename length @ +26, filename @ +30, uncompressed size @ +22.
      const fnLen = view.getUint16(i + 26, true);
      if (matchesNameAt(i + 30) && strFromU8(out.subarray(i + 30, i + 30 + fnLen)) === filename) {
        view.setUint32(i + 22, declaredSize, true);
        patched++;
      }
    } else if (sig === 0x02014b50) {
      // Central directory header: filename length @ +28, filename @ +46, uncompressed size @ +24.
      const fnLen = view.getUint16(i + 28, true);
      if (matchesNameAt(i + 46) && strFromU8(out.subarray(i + 46, i + 46 + fnLen)) === filename) {
        view.setUint32(i + 24, declaredSize, true);
        patched++;
      }
    }
  }
  if (patched < 2) throw new Error(`expected to patch both zip headers for "${filename}", patched ${patched}`);
  return out;
}

describe("singleHtml", () => {
  it("wraps bytes as index.html", () => {
    const r = singleHtml(strToU8("<h1>hi</h1>"));
    expect(r.type).toBe("single");
    expect(r.entry).toBe("index.html");
    expect(r.files).toHaveLength(1);
    expect(r.files[0].path).toBe("index.html");
  });
});

describe("processZip", () => {
  it("returns all files with index.html at root", () => {
    const zip = zipSync({
      "index.html": strToU8("<h1>hi</h1>"),
      "style.css": strToU8("body{}"),
    });
    const r = processZip(zip);
    expect(r.type).toBe("bundle");
    expect(r.files.map((f) => f.path).sort()).toEqual(["index.html", "style.css"]);
  });

  it("strips a common top-level directory", () => {
    const zip = zipSync({
      "site/index.html": strToU8("x"),
      "site/app.js": strToU8("y"),
    });
    const r = processZip(zip);
    expect(r.files.map((f) => f.path).sort()).toEqual(["app.js", "index.html"]);
  });

  it("throws when no index.html", () => {
    const zip = zipSync({ "readme.txt": strToU8("nope") });
    expect(() => processZip(zip)).toThrow(UploadError);
  });

  it("ignores directory entries, __MACOSX, and hidden dot dirs/files", () => {
    const zip = zipSync({
      "index.html": strToU8("<h1>hi</h1>"),
      "assets/": new Uint8Array(0),
      "__MACOSX/index.html": strToU8("junk"),
      "assets/.git/config": strToU8("junk"),
      ".env": strToU8("SECRET=1"),
      ".DS_Store": strToU8("junk"),
    });
    const r = processZip(zip);
    expect(r.files.map((f) => f.path).sort()).toEqual(["index.html"]);
  });

  describe("path traversal / unsafe path abuse", () => {
    it("rejects a parent-directory traversal entry", () => {
      const zip = zipSync({
        "index.html": strToU8("hi"),
        "../evil.html": strToU8("evil"),
      });
      expect(() => processZip(zip)).toThrow(UploadError);
    });

    it("rejects a nested traversal entry", () => {
      const zip = zipSync({
        "index.html": strToU8("hi"),
        "assets/../../evil.html": strToU8("evil"),
      });
      expect(() => processZip(zip)).toThrow(UploadError);
    });

    it("rejects an absolute POSIX path", () => {
      const zip = zipSync({
        "index.html": strToU8("hi"),
        "/etc/passwd": strToU8("evil"),
      });
      expect(() => processZip(zip)).toThrow(UploadError);
    });

    it("rejects a Windows-style absolute path", () => {
      const zip = zipSync({
        "index.html": strToU8("hi"),
        "C:/evil.html": strToU8("evil"),
      });
      expect(() => processZip(zip)).toThrow(UploadError);
    });

    it("rejects a path containing backslashes", () => {
      const zip = zipSync({
        "index.html": strToU8("hi"),
        "assets\\evil.html": strToU8("evil"),
      });
      expect(() => processZip(zip)).toThrow(UploadError);
    });

    it("rejects a path with control characters", () => {
      const zip = zipSync({
        "index.html": strToU8("hi"),
        "assets/evil\x00.html": strToU8("evil"),
      });
      expect(() => processZip(zip)).toThrow(UploadError);
    });

    it("rejects a path longer than the R2 key budget", () => {
      const longName = "a".repeat(1000) + ".html";
      const zip = zipSync({
        "index.html": strToU8("hi"),
        [longName]: strToU8("evil"),
      });
      expect(() => processZip(zip)).toThrow(UploadError);
    });
  });

  describe("duplicate normalized path abuse", () => {
    it("rejects entries that normalize to the same path", () => {
      const zip = zipSync({
        "index.html": strToU8("hi"),
        "./index.html": strToU8("hi again"),
      });
      expect(() => processZip(zip)).toThrow(UploadError);
    });

    it("rejects entries with redundant slashes that collide after normalization", () => {
      const zip = zipSync({
        "index.html": strToU8("hi"),
        "assets/app.js": strToU8("a"),
        "assets//app.js": strToU8("b"),
      });
      expect(() => processZip(zip)).toThrow(UploadError);
    });
  });

  describe("zip bomb / resource limits", () => {
    it("rejects an archive with too many entries", () => {
      const entries: Record<string, Uint8Array> = { "index.html": strToU8("hi") };
      for (let i = 0; i < TINY_LIMITS.maxEntries + 5; i++) {
        entries[`file${i}.txt`] = strToU8("x");
      }
      const zip = zipSync(entries);
      expect(() => processZip(zip, TINY_LIMITS)).toThrow(UploadError);
    });

    it("rejects a single file over the per-file decompressed size limit", () => {
      const zip = zipSync({
        "index.html": strToU8("hi"),
        "big.txt": new Uint8Array(TINY_LIMITS.maxFileBytes + 1),
      });
      expect(() => processZip(zip, TINY_LIMITS)).toThrow(UploadError);
    });

    it("rejects an archive whose total decompressed size exceeds the budget", () => {
      const zip = zipSync({
        "index.html": strToU8("hi"),
        "a.bin": new Uint8Array(900),
        "b.bin": new Uint8Array(900),
        "c.bin": new Uint8Array(900),
      });
      expect(() => processZip(zip, { ...TINY_LIMITS, maxEntries: 10 })).toThrow(UploadError);
    });

    it("rejects a small archive whose declared decompressed size exceeds the budget (zip-bomb pattern)", () => {
      // An all-zero buffer compresses to a tiny archive but would allocate
      // well beyond the budget if actually inflated.
      const bomb = new Uint8Array(TINY_LIMITS.maxTotalBytes * 4);
      const zip = zipSync({ "index.html": strToU8("hi"), "bomb.bin": bomb }, { level: 9 });
      expect(() => processZip(zip, TINY_LIMITS)).toThrow(UploadError);
    });

    it("rejects a bomb even when the zip's own header lies about a small declared size (forged-size PoC)", () => {
      // Same zip-bomb payload as above, but this time the attacker also
      // patches the local + central directory headers to declare a tiny
      // uncompressed size (well under the budget) for the bomb entry. Since
      // fflate's central-directory `originalSize` is attacker-controlled and
      // forgeable, a naive implementation that trusts it for the size check
      // would let this through and then fully inflate the real (huge)
      // payload anyway. The fix must reject based on actual decompressed
      // bytes as they stream out, regardless of what the header claims.
      const bomb = new Uint8Array(TINY_LIMITS.maxTotalBytes * 4);
      const zip = zipSync({ "index.html": strToU8("hi"), "bomb.bin": bomb }, { level: 9 });
      const forged = forgeDeclaredSize(zip, "bomb.bin", 10);
      expect(() => processZip(forged, TINY_LIMITS)).toThrow(UploadError);
    });
  });
});
