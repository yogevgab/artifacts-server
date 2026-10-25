import { describe, it, expect, beforeEach } from "vitest";
import { initDb, clearR2, req } from "./fixtures";
import { PUBLIC_PAGES, llmsTxt, sitemapXml } from "../src/seo";

/**
 * The public site is one page (`/`): intro, a connect/publish/share/delete
 * walkthrough and pricing. `/docs` redirects to it, and no public surface may
 * link to a page that no longer exists.
 */
const ANON = { headers: { "X-Dev-Anonymous": "true" } };
const MCP = "https://mcp.rtfx.pro/mcp";
const PAGES = ["/", "/login", "/privacy", "/terms", "/pro", "/team", "/enterprise", "/contact"];

beforeEach(async () => {
  await initDb();
  await clearR2();
});

describe("/docs", () => {
  it("301s to the landing page", async () => {
    const res = await req("/docs", ANON);
    expect(res.status).toBe(301);
    expect(new URL(res.headers.get("Location")!, "http://localhost").pathname).toBe("/");
  });

  it("is gone from the sitemap, llms.txt and every public page's links", async () => {
    expect(sitemapXml({})).not.toContain("/docs");
    expect(PUBLIC_PAGES.some((p) => p.path === "/docs")).toBe(false);
    expect(llmsTxt({})).not.toContain("/docs");
    for (const path of PAGES) {
      const body = await (await req(path, ANON)).text();
      expect(body, path).not.toMatch(/href="\/docs/);
    }
  });
});

describe("the landing page", () => {
  it("has the walkthrough sections, with the old docs anchors landing on the connect step", async () => {
    const body = await (await req("/", ANON)).text();
    for (const id of ["start", "agents", "publish", "share", "delete", "pricing"]) {
      expect(body, id).toContain(`id="${id}"`);
    }
    expect(body).toContain("1. Add rtfx to Claude");
    expect(body).toContain("4. Delete");
  });

  it("shows the MCP URL with a working copy button and no inline HTML injection", async () => {
    const body = await (await req("/", ANON)).text();
    expect(body).toContain(`<code id="mcp-url">${MCP}</code>`);
    expect(body).toContain(`data-copy="${MCP}"`);
    expect(body).toContain(`claude mcp add --transport http rtfx ${MCP}`);
    expect(body).toContain(`{"mcpServers":{"rtfx":{"url":"${MCP}"}}}`);
    expect(body).not.toContain("innerHTML");
  });

  it("does not feature the plugin, the .dxt, the CLI, Hermes or the HTTP API", async () => {
    const body = (await (await req("/", ANON)).text()).toLowerCase();
    for (const word of [".dxt", "/plugin", "hermes", "cli/artifacts", "/api/machine"]) {
      expect(body, word).not.toContain(word);
    }
  });

  it("keeps the header nav to How it works, Pricing and sign-in", async () => {
    const body = await (await req("/", ANON)).text();
    expect(body).toContain('<a href="/#start" data-nav="how">How it works</a>');
    expect(body).toContain('<a href="/#pricing" data-nav="pricing">Pricing</a>');
    expect(body).not.toContain('data-nav="use-cases"');
  });
});

describe("llms.txt", () => {
  it("states the endpoint, the claude.ai steps and the delete confirmation", () => {
    const txt = llmsTxt({});
    expect(txt).toContain(MCP);
    expect(txt).toContain("Add custom connector");
    expect(txt).toContain("rtfx:manage");
    expect(txt).toContain("confirm_slug");
  });

  it("says the hosted endpoint publishes content, not paths", () => {
    expect(llmsTxt({}).toLowerCase()).toMatch(/cannot read a path/);
  });
});
