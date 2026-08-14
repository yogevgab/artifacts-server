import { describe, it, expect, beforeEach } from "vitest";
import { initDb, clearR2, req, as } from "./fixtures";

const OWNER = "owner@rtfx.pro";
const OTHER = "someone-else@example.com";

beforeEach(async () => {
  await initDb();
  await clearR2();
});

/** Publish a one-file artifact owned by OWNER, visible to everyone signed in. */
async function publish(slug = "demo") {
  const body = new FormData();
  body.set("slug", slug);
  body.set("title", "Demo");
  body.set("visibility", "everyone");
  body.set("file", new File(["<h1>hello</h1>"], "index.html", { type: "text/html" }));
  const res = await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
  expect(res.status).toBeLessThan(300);
}

const navigate = (path: string, who: string) =>
  req(path, {
    ...as(who),
    headers: { ...(as(who).headers as Record<string, string>), "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" },
  });

describe("viewer shell", () => {
  it("serves the shell for a top-level navigation", async () => {
    await publish();
    const res = await navigate("/demo/", OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<iframe");
    expect(html).not.toContain("<h1>hello</h1>");
  });

  /**
   * The one line in this feature where a regression is a vulnerability.
   * Without allow-same-origin the framed document gets an opaque origin and
   * cannot read cookies or reach the shell. With it, uploaded HTML owns the
   * share controls.
   */
  it("sandboxes the frame and never grants allow-same-origin", async () => {
    await publish();
    const html = await (await navigate("/demo/", OWNER)).text();
    const tag = /<iframe[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toContain("sandbox=");
    expect(tag).not.toContain("allow-same-origin");
    expect(tag).toContain("allow-scripts");
  });

  it("serves raw content inside the frame", async () => {
    await publish();
    const res = await req("/demo/?raw=1", as(OWNER));
    expect(await res.text()).toContain("<h1>hello</h1>");
  });

  it("serves raw content to a machine client with no Sec-Fetch headers", async () => {
    await publish();
    const res = await req("/demo/", as(OWNER));
    expect(await res.text()).toContain("<h1>hello</h1>");
  });

  it("serves raw content for subresource requests", async () => {
    await publish();
    const res = await req("/demo/", {
      ...as(OWNER),
      headers: { ...(as(OWNER).headers as Record<string, string>), "Sec-Fetch-Dest": "script" },
    });
    expect(await res.text()).toContain("<h1>hello</h1>");
  });

  it("lets our own shell frame the content, but nobody else", async () => {
    await publish();
    const res = await req("/demo/?raw=1", as(OWNER));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors *");
  });

  it("shows the share banner to someone who can manage it", async () => {
    await publish();
    const html = await (await navigate("/demo/", OWNER)).text();
    expect(html).toContain("data-share-banner");
  });

  it("shows no banner markup at all to a plain viewer", async () => {
    await publish();
    const html = await (await navigate("/demo/", OTHER)).text();
    expect(html).not.toContain("data-share-banner");
  });

  it("still 404s an artifact the caller may not view", async () => {
    const body = new FormData();
    body.set("slug", "secret");
    body.set("title", "Secret");
    body.set("visibility", "restricted");
    body.set("file", new File(["<p>x</p>"], "index.html", { type: "text/html" }));
    await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
    const res = await navigate("/secret/", OTHER);
    expect(res.status).toBe(404);
  });
});
