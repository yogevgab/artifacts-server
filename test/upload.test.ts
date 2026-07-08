import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { processZip, singleHtml, UploadError } from "../src/upload";

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
});
