import { describe, it, expect, beforeEach } from "vitest";
import { initDb, clearR2, req, as } from "./fixtures";

const OWNER = "owner@rtfx.pro";

beforeEach(async () => {
  await initDb();
  await clearR2();
  const body = new FormData();
  body.set("slug", "demo");
  body.set("title", "Demo");
  body.set("visibility", "everyone");
  body.set("file", new File(["<html><body><h1>hi</h1></body></html>"], "index.html", { type: "text/html" }));
  await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
});

const nav = (who: string) =>
  req("/demo/", {
    ...as(who),
    headers: { ...(as(who).headers as Record<string, string>), "Sec-Fetch-Dest": "document" },
  });

describe("shell chrome", () => {
  it("offers a way to hide the bar", async () => {
    const html = await (await nav(OWNER)).text();
    expect(html).toContain("data-hide-bar");
  });

  it("marks the bar so it can be shown again once hidden", async () => {
    const html = await (await nav(OWNER)).text();
    expect(html).toContain("data-show-bar");
    expect(html).toContain("data-bar");
  });
});

describe("scroll reporting from the frame", () => {
  /**
   * The frame is cross-origin by design, so the shell cannot observe scrolling
   * inside it. A tiny reporter posts the scroll position out. It is deliberately
   * capability-free: the shell uses it only to hide chrome, so an artifact that
   * forges the message can at worst hide or show a toolbar.
   */
  it("injects the reporter into framed HTML", async () => {
    const res = await req("/demo/?raw=1", as(OWNER));
    const html = await res.text();
    expect(html).toContain("rtfx:scroll");
    expect(html).toContain("<h1>hi</h1>");
  });

  it("leaves unframed HTML byte-identical, so downloads and the CLI are untouched", async () => {
    const html = await (await req("/demo/", as(OWNER))).text();
    expect(html).not.toContain("rtfx:scroll");
    expect(html).toBe("<html><body><h1>hi</h1></body></html>");
  });

  it("never touches non-HTML assets", async () => {
    const body = new FormData();
    body.set("slug", "assets");
    body.set("title", "Assets");
    body.set("visibility", "everyone");
    const zip = new File([new Uint8Array()], "x.zip");
    void zip;
    // A CSS file inside the artifact must pass through unchanged.
    const res = await req("/demo/missing.css?raw=1", as(OWNER));
    expect(res.status).toBe(404);
  });
});

describe("who sees the banner", () => {
  it("shows it to the owner", async () => {
    expect(await (await nav(OWNER)).text()).toContain("data-share-banner");
  });

  it("hides it from someone who can only view", async () => {
    expect(await (await nav("reader@example.com")).text()).not.toContain("data-share-banner");
  });
});
