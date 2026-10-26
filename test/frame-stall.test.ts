import { beforeEach, describe, expect, it, vi } from "vitest";
import { initDb, clearR2, req, as, openViewer } from "./fixtures";
import { isManagementPath } from "../src/host";

const OWNER = "owner@rtfx.pro";

async function publish(slug: string, file: File) {
  const body = new FormData();
  body.set("slug", slug);
  body.set("title", slug);
  body.set("visibility", "everyone");
  body.set("file", file);
  const res = await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
  expect(res.status).toBeLessThan(300);
}

beforeEach(async () => {
  await initDb();
  await clearR2();
});

/**
 * 2026-10-26: Dorai's Chrome never requested the a.rtfx.pro frame, eight times
 * running, and she saw only the browser's own error page with nothing from us.
 * An HTML artifact now says "I loaded"; when it never does, the viewer shows a
 * dismissible "Is this page blank?" banner and logs one beacon.
 */
describe("frame-stall", () => {
  it("framed HTML announces itself to the viewer", async () => {
    await publish("demo", new File(["<html><head></head><body><h1>hi</h1></body></html>"], "index.html", { type: "text/html" }));
    const html = await (await req("/demo/?raw=1", as(OWNER))).text();
    expect(html).toContain("rtfx:ready");
    expect(html).toContain("<h1>hi</h1>");
  });

  it("announces before the page's own scripts, so a slow script cannot look like a stall", async () => {
    await publish("slow", new File([
      '<html><head><script src="https://slow.example/blocking.js"></script></head><body><p>x</p></body></html>',
    ], "index.html", { type: "text/html" }));
    const html = await (await req("/slow/?raw=1", as(OWNER))).text();
    expect(html.indexOf("rtfx:ready")).toBeGreaterThan(-1);
    expect(html.indexOf("rtfx:ready")).toBeLessThan(html.indexOf("slow.example"));
  });

  it("announces from a fragment with neither <head> nor <body>", async () => {
    await publish("frag", new File(["<h1>Just a fragment</h1>"], "index.html", { type: "text/html" }));
    const html = await (await req("/frag/?raw=1", as(OWNER))).text();
    expect(html).toContain("<h1>Just a fragment</h1>");
    expect(html.match(/rtfx:ready/g)).toHaveLength(1);
  });

  it("refuses an oversized beacon without reading it", async () => {
    const res = await req("/_frame-stall", {
      method: "POST",
      headers: { "Content-Length": "5000" },
      body: "x".repeat(5000),
    });
    expect(res.status).toBe(413);
  });

  it("the viewer expects the announcement for an HTML artifact and carries the hidden banner", async () => {
    await publish("demo", new File(["<html><body>hi</body></html>"], "index.html", { type: "text/html" }));
    const html = await (await openViewer("demo", OWNER)).text();
    const frame = /<iframe class="frame"[^>]*>/.exec(html)?.[0] ?? "";
    expect(frame).toContain("data-expect-ready");
    expect(html).toMatch(/<div class="stall" data-stall role="status" hidden>/);
    expect(html).toContain("Is this page blank?");
    expect(html).toContain("/_frame-stall");
  });

  it("does not expect it from content that never runs our script (a PDF)", async () => {
    const pdf = new Uint8Array([...new TextEncoder().encode("%PDF-1.7\nbody")]);
    await publish("deck", new File([pdf], "deck.pdf", { type: "application/pdf" }));
    const html = await (await openViewer("deck", OWNER)).text();
    const frame = /<iframe class="frame"[^>]*>/.exec(html)?.[0] ?? "";
    expect(frame).not.toContain("data-expect-ready");
  });

  it("the beacon logs one line and returns 204, keeping only a slug-shaped slug", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ok = await req("/_frame-stall", { method: "POST", body: JSON.stringify({ slug: "portfolio" }) });
    expect(ok.status).toBe(204);
    const bad = await req("/_frame-stall", { method: "POST", body: JSON.stringify({ slug: "<script>" }) });
    expect(bad.status).toBe(204);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("frame_stall"));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).slug).toBe("portfolio");
    expect(JSON.parse(lines[1]!).slug).toBe("");
    log.mockRestore();
  });

  it("is an app-host path (never served from the content host)", () => {
    expect(isManagementPath("/_frame-stall")).toBe(true);
  });
});
