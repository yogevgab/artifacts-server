import { describe, it, expect, beforeEach } from "vitest";
import { singlePdf, sniffKind, UploadError } from "../src/upload";
import { initDb, clearR2, req, as } from "./fixtures";

const OWNER = "admin@test.com";

/** The first bytes of any real PDF. */
const PDF_HEADER = new TextEncoder().encode("%PDF-1.7\n");
const pdfBytes = (extra = "body") =>
  new Uint8Array([...PDF_HEADER, ...new TextEncoder().encode(extra)]);

describe("sniffKind", () => {
  it("recognises a PDF by its magic bytes, not its filename", () => {
    expect(sniffKind("anything.txt", pdfBytes())).toBe("pdf");
  });

  it("does not trust a .pdf name over the bytes", () => {
    const html = new TextEncoder().encode("<html><body>not a pdf</body></html>");
    expect(sniffKind("evil.pdf", html)).not.toBe("pdf");
  });

  it("recognises html", () => {
    expect(sniffKind("index.html", new TextEncoder().encode("<h1>x</h1>"))).toBe("html");
  });
});

describe("singlePdf", () => {
  it("stores the document under its own entry name", () => {
    const up = singlePdf(pdfBytes());
    expect(up.type).toBe("pdf");
    expect(up.entry).toBe("document.pdf");
    expect(up.files[0].path).toBe("document.pdf");
  });

  it("refuses bytes that are not a PDF", () => {
    expect(() => singlePdf(new TextEncoder().encode("<h1>nope</h1>"))).toThrow(UploadError);
  });
});

describe("publishing a PDF", () => {
  beforeEach(async () => {
    await initDb();
    await clearR2();
  });

  async function publishPdf(slug = "deck") {
    const body = new FormData();
    body.set("slug", slug);
    body.set("title", "Deck");
    body.set("visibility", "everyone");
    body.set("file", new File([pdfBytes()], "deck.pdf", { type: "application/pdf" }));
    return req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
  }

  it("accepts a PDF upload", async () => {
    const res = await publishPdf();
    expect(res.status).toBeLessThan(300);
  });

  it("serves it with the right content type", async () => {
    await publishPdf();
    const res = await req("/deck/document.pdf?raw=1", as(OWNER));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
  });

  it("never injects the scroll reporter into a PDF", async () => {
    await publishPdf();
    const res = await req("/deck/document.pdf?raw=1", as(OWNER));
    const body = new Uint8Array(await res.arrayBuffer());
    // Byte-for-byte what was uploaded: HTMLRewriter must not touch binaries.
    expect(new TextDecoder().decode(body.slice(0, 5))).toBe("%PDF-");
    expect(new TextDecoder().decode(body)).not.toContain("rtfx:scroll");
  });

  it("shows the PDF in the shell rather than downloading it", async () => {
    await publishPdf();
    const res = await req("/deck/", {
      ...as(OWNER),
      headers: { ...(as(OWNER).headers as Record<string, string>), "Sec-Fetch-Dest": "document" },
    });
    const html = await res.text();
    expect(html).toContain("<iframe");
    expect(html).toContain("document.pdf");
  });
});

describe("the frame sandbox is chosen per content type", () => {
  async function publish(slug: string, file: File) {
    const body = new FormData();
    body.set("slug", slug);
    body.set("title", slug);
    body.set("visibility", "everyone");
    body.set("file", file);
    await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
  }
  const nav = (slug: string) =>
    req(`/${slug}/`, {
      ...as(OWNER),
      headers: { ...(as(OWNER).headers as Record<string, string>), "Sec-Fetch-Dest": "document" },
    });

  beforeEach(async () => {
    await initDb();
    await clearR2();
  });

  /**
   * The dangerous pairing is allow-same-origin WITH allow-scripts: together they
   * let framed content remove its own sandbox. HTML needs scripts, so it must
   * not get same-origin. A PDF needs no scripts at all, so it can have
   * same-origin safely — and it must, or Chrome silently refuses to instantiate
   * its PDF viewer and shows a broken-document icon with no console error.
   */
  it("HTML gets scripts but never same-origin", async () => {
    await publish("site", new File(["<h1>hi</h1>"], "index.html", { type: "text/html" }));
    const tag = /<iframe[^>]*>/.exec(await (await nav("site")).text())?.[0] ?? "";
    expect(tag).toContain("allow-scripts");
    expect(tag).not.toContain("allow-same-origin");
  });

  it("PDF gets no sandbox at all — Chrome refuses its viewer under any flags", async () => {
    await publish("doc", new File([pdfBytes()], "doc.pdf", { type: "application/pdf" }));
    const tag = /<iframe[^>]*>/.exec(await (await nav("doc")).text())?.[0] ?? "";
    expect(tag).not.toContain("sandbox=");
  });

  it("serves a PDF as application/pdf with nosniff — the guard that makes that safe", async () => {
    await publish("doc", new File([pdfBytes()], "doc.pdf", { type: "application/pdf" }));
    const res = await req("/doc/document.pdf?raw=1", as(OWNER));
    expect(res.headers.get("content-type")).toContain("application/pdf");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses HTML disguised as a PDF, which is the other half of that guard", async () => {
    const body = new FormData();
    body.set("slug", "fake");
    body.set("title", "fake");
    body.set("visibility", "everyone");
    body.set("file", new File(["<html><script>alert(1)</script></html>"], "evil.pdf", { type: "application/pdf" }));
    await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
    // Stored as HTML, so it keeps the strict sandbox rather than losing it.
    const tag = /<iframe[^>]*>/.exec(await (await nav("fake")).text())?.[0] ?? "";
    expect(tag).toContain("sandbox=");
    expect(tag).not.toContain("allow-same-origin");
  });
});
