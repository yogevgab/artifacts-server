import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { sitemapXml } from "../src/seo";

/**
 * One address per public page: http → https, the marketing pages on a sibling
 * host (mcp.rtfx.pro) → rtfx.pro, and trailing-slash / index.html variants →
 * the bare path. Everything else — sign-in, OAuth, /mcp, artifact addresses,
 * local and test origins — is left alone.
 */

const prod = () => ({
  ...(env as any),
  PUBLIC_BASE_URL: "https://rtfx.pro",
  CONTENT_HOSTNAMES: "a.rtfx.pro",
});
const ANON = { "X-Dev-Anonymous": "true" };
const get = (url: string, e: unknown = prod()) =>
  app.request(url, { redirect: "manual", headers: ANON }, e as any);

describe("canonical public URLs", () => {
  it("redirects plain http to https", async () => {
    const res = await get("http://rtfx.pro/pro?x=1");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://rtfx.pro/pro?x=1");
  });

  it("sends HSTS on https, without pinning other subdomains", async () => {
    const res = await get("https://rtfx.pro/pro");
    expect(res.status).toBe(200);
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
  });

  it("folds trailing-slash and /index.html variants into the bare page", async () => {
    const slash = await get("https://rtfx.pro/guide/");
    expect(slash.status).toBe(301);
    expect(slash.headers.get("Location")).toBe("/guide");
    const index = await get("https://rtfx.pro/index.html");
    expect(index.status).toBe(301);
    expect(index.headers.get("Location")).toBe("/");
  });

  it("moves marketing pages off the MCP host, but keeps sign-in, OAuth and /mcp there", async () => {
    for (const path of ["/", "/pro", "/team", "/llms.txt", "/sitemap.xml", "/share-claude-artifacts-privately"]) {
      const res = await get(`https://mcp.rtfx.pro${path}`);
      expect(res.status, path).toBe(301);
      expect(res.headers.get("Location"), path).toBe(`https://rtfx.pro${path}`);
    }
    for (const path of ["/login", "/signup", "/.well-known/oauth-authorization-server"]) {
      const res = await get(`https://mcp.rtfx.pro${path}`);
      expect(res.status, path).not.toBe(301);
    }
  });

  it("never redirects a local or test origin", async () => {
    const res = await get("http://localhost/pro");
    expect(res.status).toBe(200);
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("does not touch a trailing slash on anything that isn't a public page", async () => {
    const res = await get("https://rtfx.pro/acme/report/");
    expect(res.headers.get("Location") ?? "").not.toBe("/acme/report");
  });
});

describe("sitemap", () => {
  it("lists /signup with a lastmod on every entry, and not /login", () => {
    const xml = sitemapXml({ PUBLIC_BASE_URL: "https://rtfx.pro" });
    expect(xml).toContain("<loc>https://rtfx.pro/signup</loc>");
    expect(xml).not.toContain("<loc>https://rtfx.pro/login</loc>");
    const urls = xml.match(/<url>/g)!.length;
    expect(xml.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g)).toHaveLength(urls);
  });
});
