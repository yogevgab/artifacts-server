import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { mintSession } from "../src/session";
import { createChallenge } from "../src/otp";
import { GUEST_COOKIE } from "../src/viewing";
import { initDb, clearR2, req, as, viewerPath } from "./fixtures";

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const CONTENT = "https://a.rtfx.pro";
const APP = "https://rtfx.pro";
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

/** The canonical viewer URL for `report`. */
const viewerUrl = async () => `${APP}${await viewerPath("report")}`;

async function guestSession(email = GUEST, slug = "report") {
  return mintSession(SECRET, { email, kind: "guest", slug }, NOW());
}

describe("guests view what they were granted", () => {
  it("lets a granted guest open the artifact, on the app host", async () => {
    const res = await app.request(await viewerUrl(), nav(`${GUEST_COOKIE}=${await guestSession()}`), e());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<iframe");
  });

  it("refuses a guest credential minted for a different artifact", async () => {
    const other = await mintSession(SECRET, { email: GUEST, kind: "guest", slug: "something-else" }, NOW());
    const res = await app.request(await viewerUrl(), nav(`${GUEST_COOKIE}=${other}`), e());
    // Not a credential for THIS artifact, so it is no credential: the visitor is sent to sign in.
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/shared/report");
    const inSession = await app.request(await viewerUrl(), nav(`${SESSION_COOKIE}=${other}`), e());
    expect(inSession.status).toBe(404);
  });

  it("refuses a guest whose grant was revoked", async () => {
    await req("/api/artifacts/report/access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "restricted", emails: [] }),
      ...as(OWNER),
    });
    const res = await app.request(await viewerUrl(), nav(`${GUEST_COOKIE}=${await guestSession()}`), e());
    expect(res.status).toBe(404);
  });

  it("does not replace a signed-in member: the guest cookie is separate", async () => {
    const member = await mintSession(SECRET, { email: OWNER, kind: "member" }, NOW());
    const res = await app.request(
      await viewerUrl(),
      nav(`${SESSION_COOKIE}=${member}; ${GUEST_COOKIE}=${await guestSession()}`),
      e()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("data-share-banner"); // the member (owner) won
  });

  it("falls back to the guest credential when the signed-in member has no access", async () => {
    const member = await mintSession(SECRET, { email: "stranger@example.com", kind: "member" }, NOW());
    const res = await app.request(
      await viewerUrl(),
      nav(`${SESSION_COOKIE}=${member}; ${GUEST_COOKIE}=${await guestSession()}`),
      e()
    );
    expect(res.status).toBe(200);
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
      await app.request(await viewerUrl(), nav(`${GUEST_COOKIE}=${await guestSession()}`), e())
    ).text();
    expect(html).not.toContain("data-share-banner");
  });
});

describe("guest sign-in", () => {
  it("sends an unknown visitor to a guest sign-in that returns to the canonical address", async () => {
    const res = await app.request(await viewerUrl(), nav(), e());
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("/shared/report?next=")).toBe(true);
    expect(decodeURIComponent(loc.split("next=")[1])).toBe(await viewerPath("report"));
  });

  it("redeeming the emailed link sets a guest cookie on the app host and lands on the canonical address", async () => {
    const issued = await createChallenge(env as any, { email: GUEST, purpose: "guest", slug: "report", now: NOW() });
    const res = await app.request(`${APP}/auth/m/${issued.token}`, { method: "POST" }, e());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(await viewerPath("report"));
    const cookies = res.headers.getSetCookie();
    const guest = cookies.find((c) => c.startsWith(`${GUEST_COOKIE}=`)) ?? "";
    expect(guest).toContain("HttpOnly");
    expect(guest).toContain("Secure");
    expect(guest).toContain("SameSite=Lax");
    // Never a member session: redeeming an invitation does not create an account.
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);

    const opened = await app.request(await viewerUrl(), nav(guest.split(";")[0]), e());
    expect(opened.status).toBe(200);
  });

  it("retired the content-host handoff", async () => {
    const res = await app.request(`${APP}/auth/content?next=${encodeURIComponent(`${CONTENT}/report/`)}`, {}, e());
    expect(res.status).toBe(404);
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

  it("sends a signed-in member straight to the artifact's canonical address", async () => {
    const session = await mintSession(SECRET, { email: OWNER, kind: "member" }, NOW());
    const res = await app.request(
      "https://rtfx.pro/shared/report",
      { headers: { Cookie: `${SESSION_COOKIE}=${session}` } },
      e()
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(await viewerUrl());
  });

  it("honours ?next= for a signed-in member, but only a local path", async () => {
    const session = await mintSession(SECRET, { email: OWNER, kind: "member" }, NOW());
    const headers = { Cookie: `${SESSION_COOKIE}=${session}` };
    const ok = await app.request("https://rtfx.pro/shared/report?next=%2Fabc%2Freport", { headers }, e());
    expect(ok.headers.get("location")).toBe("/abc/report");
    const evil = await app.request("https://rtfx.pro/shared/report?next=https%3A%2F%2Fevil.example", { headers }, e());
    expect(evil.headers.get("location")).toBe(await viewerUrl());
  });

  it("carries next into the guest page's sign-in link", async () => {
    const html = await (
      await app.request("https://rtfx.pro/shared/report?next=%2Fabc%2Freport", {}, e())
    ).text();
    expect(html).toContain("/login?next=%2Fabc%2Freport");
  });
});
