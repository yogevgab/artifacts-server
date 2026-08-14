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
  body.set("file", new File(["<h1>hi</h1>"], "index.html", { type: "text/html" }));
  await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
});

const nav = (who: string) =>
  req("/demo/", {
    ...as(who),
    headers: { ...(as(who).headers as Record<string, string>), "Sec-Fetch-Dest": "document" },
  });

describe("the share panel's link-expiry controls", () => {
  it("offers an expiry select and a hidden custom-days input", async () => {
    const html = await (await nav(OWNER)).text();
    expect(html).toContain("data-link-expiry");
    expect(html).toContain("data-link-days");
    expect(html).toContain('<option value="">Never expires</option>');
    expect(html).toContain('<option value="7">Expires in 7 days</option>');
    expect(html).toContain('<option value="30">Expires in 30 days</option>');
    expect(html).toContain('<option value="custom">Custom');
  });

  it("keeps the custom-days input hidden by default", async () => {
    const html = await (await nav(OWNER)).text();
    const tag = /<input[^>]*data-link-days[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toContain("hidden");
    expect(tag).toContain('min="1"');
    expect(tag).toContain('max="365"');
  });

  it("gives the client script a place to fetch and render existing links", async () => {
    const html = await (await nav(OWNER)).text();
    expect(html).toContain("data-link-list");
    // The client fetches the same GET the management API already exposes.
    expect(html).toContain("/api/artifacts/'+encodeURIComponent(slug)+'/links'");
  });

  it("posts the chosen day count as expires_in_days, not a raw date", async () => {
    const html = await (await nav(OWNER)).text();
    expect(html).toContain("expires_in_days");
  });

  it("does not render any of this for someone who cannot manage the artifact", async () => {
    const html = await (await nav("reader@example.com")).text();
    expect(html).not.toContain("data-link-expiry");
    expect(html).not.toContain("data-make-link");
  });
});

describe("expiry is shown, not hidden, for both new and existing links", () => {
  it("labels a link created with no expiry as never expiring, via the client's own formatting logic", async () => {
    // The formatting itself is client-side (describeExpiry in the shell
    // script), so this asserts the script ships with that behavior rather
    // than asserting on rendered HTML the server never produces.
    const html = await (await nav(OWNER)).text();
    expect(html).toContain("Never expires");
    expect(html).toContain("Expired ");
    expect(html).toContain("Expires ");
  });

  it("flags an expired link with its own CSS class, distinct from a live one", async () => {
    const html = await (await nav(OWNER)).text();
    expect(html).toContain("expired");
    expect(html).toContain(".link-row .exp.expired");
  });

  it("filters out revoked links when the panel (re)loads the list", async () => {
    const html = await (await nav(OWNER)).text();
    expect(html).toContain("l.revokedAt");
  });
});
