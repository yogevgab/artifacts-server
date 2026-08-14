import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { mintSession } from "../src/session";
import { initDb, clearR2, req, as } from "./fixtures";

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const CONTENT = "https://a.rtfx.pro";
const OWNER = "owner@rtfx.pro";
const GUEST = "dana@acme.com";
const NOW = () => new Date().toISOString();

function e(extra: Record<string, unknown> = {}) {
  return {
    ...(env as any),
    SESSION_SECRET: SECRET,
    DEV_LOGIN: undefined,
    CONTENT_HOSTNAMES: "a.rtfx.pro",
    PUBLIC_BASE_URL: "https://rtfx.pro",
    ADMIN_EMAILS: OWNER,
    ...extra,
  };
}
const nav = (cookie?: string) => ({
  headers: {
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    ...(cookie ? { Cookie: cookie } : {}),
  },
});

beforeEach(async () => {
  await initDb();
  await clearR2();
  const body = new FormData();
  body.set("slug", "report");
  body.set("title", "Report");
  body.set("visibility", "restricted");
  body.set("file", new File(["<h1>secret</h1>"], "index.html", { type: "text/html" }));
  await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
  await req("/api/artifacts/report/access", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visibility: "restricted", emails: [GUEST] }),
    ...as(OWNER),
  });
});

async function guestSession(email = GUEST, slug = "report") {
  return mintSession(SECRET, { email, kind: "guest", slug }, NOW());
}

describe("guests view what they were granted", () => {
  it("lets a granted guest open the artifact", async () => {
    const res = await app.request(
      `${CONTENT}/report/`,
      nav(`${SESSION_COOKIE}=${await guestSession()}`),
      e()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<iframe");
  });

  it("refuses a guest for an artifact they were not granted", async () => {
    const other = await mintSession(SECRET, { email: GUEST, kind: "guest", slug: "something-else" }, NOW());
    const res = await app.request(`${CONTENT}/report/`, nav(`${SESSION_COOKIE}=${other}`), e());
    expect(res.status).toBe(404);
  });

  it("refuses a guest whose grant was revoked", async () => {
    await req("/api/artifacts/report/access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "restricted", emails: [] }),
      ...as(OWNER),
    });
    const res = await app.request(
      `${CONTENT}/report/`,
      nav(`${SESSION_COOKIE}=${await guestSession()}`),
      e()
    );
    expect(res.status).toBe(404);
  });

  it("never lets a guest reach the dashboard", async () => {
    const res = await app.request(
      "https://rtfx.pro/admin",
      { headers: { Accept: "text/html", Cookie: `${SESSION_COOKIE}=${await guestSession()}` } },
      e()
    );
    expect(res.status).toBe(403);
  });

  it("shows a guest no share banner", async () => {
    const html = await (
      await app.request(`${CONTENT}/report/`, nav(`${SESSION_COOKIE}=${await guestSession()}`), e())
    ).text();
    expect(html).not.toContain("data-share-banner");
  });
});

describe("guest sign-in on the content host", () => {
  it("sends an unknown visitor to a guest sign-in for that artifact", async () => {
    const res = await app.request(`${CONTENT}/report/`, nav(), e());
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/auth/content");
  });

  it("mints a guest session for someone holding a grant but no account", async () => {
    const res = await app.request(
      `https://rtfx.pro/auth/guest?slug=report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: GUEST }),
      },
      e()
    );
    expect(res.status).toBe(202);
  });

  it("answers the same for an address with no grant, so it is not an oracle", async () => {
    const granted = await app.request(
      `https://rtfx.pro/auth/guest?slug=report`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: GUEST }) },
      e()
    );
    const not = await app.request(
      `https://rtfx.pro/auth/guest?slug=report`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "nobody@x.com" }) },
      e()
    );
    expect(granted.status).toBe(not.status);
    expect(await granted.json()).toEqual(await not.json());
  });
});

describe("the shared-link landing page", () => {
  it("asks an unknown visitor for the address it was shared with", async () => {
    const res = await app.request("https://rtfx.pro/shared/report", { headers: { Accept: "text/html" } }, e());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("data-guest-form");
    expect(html).toContain("/auth/guest");
  });

  it("looks identical for an artifact that does not exist", async () => {
    const real = await (await app.request("https://rtfx.pro/shared/report", {}, e())).text();
    const fake = await (await app.request("https://rtfx.pro/shared/no-such-thing", {}, e())).text();
    expect(fake.replace(/no-such-thing/g, "report")).toBe(real);
  });

  it("sends a signed-in member straight to the artifact", async () => {
    const session = await mintSession(SECRET, { email: OWNER, kind: "member" }, NOW());
    const res = await app.request(
      "https://rtfx.pro/shared/report",
      { headers: { Cookie: `${SESSION_COOKIE}=${session}` } },
      e()
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://a.rtfx.pro/report/");
  });

  it("bounces the content host to the guest page, carrying the slug", async () => {
    const res = await app.request(`${CONTENT}/report/`, nav(), e());
    expect(res.headers.get("location") ?? "").toContain("slug=report");
  });
});
