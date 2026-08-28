import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { personalAccountFor, setAccountPublicSlug } from "../src/accounts";
import { createShareLink } from "../src/share";
import { initDb, clearR2, as } from "./fixtures";

/**
 * The branded link itself: `GET https://rtfx.pro/yogev/q3-board-report`.
 *
 * What is being pinned here is a boundary, not a convenience. The app origin
 * must never serve uploaded HTML — that is the whole reason artifacts live on
 * `a.rtfx.pro` — so a branded link can only ever be a *redirect* to the content
 * origin, where every existing access rule then runs unchanged. If one of these
 * tests ever has to assert on artifact bytes coming back from the app host, the
 * feature has been implemented wrongly.
 *
 * The second thing pinned is what the branded route may reveal. A namespace
 * that answers differently for "maya has no such artifact" and "that artifact
 * belongs to somebody else" is an existence oracle over every workspace on the
 * instance.
 */

const OWNER = "yogev@rtfx.local";
const OTHER = "maya@rtfx.local";
const AT = "2026-08-28T09:00:00.000Z";

// See the note in test/account-slugs.test.ts: DEV_LOGIN is inert on a canonical
// production hostname, so the suite runs the same routes on a `.local` origin.
const APP = "https://rtfx.local";
const CONTENT_HOST = "a.rtfx.local";

const appEnv = () => ({
  ...(env as any),
  CONTENT_HOSTNAMES: CONTENT_HOST,
  PUBLIC_BASE_URL: APP,
});

const appReq = (path: string, init?: RequestInit) =>
  app.request(`${APP}${path}`, init, appEnv() as any);
const contentReq = (path: string, init?: RequestInit) =>
  app.request(`https://${CONTENT_HOST}${path}`, init, appEnv() as any);

async function publish(slug: string, email: string, visibility = "restricted") {
  const body = new FormData();
  body.set("slug", slug);
  body.set("title", slug);
  body.set("visibility", visibility);
  body.set("file", new File([`<h1>${slug}</h1>`], "index.html", { type: "text/html" }));
  const res = await appReq("/api/artifacts", { method: "POST", body, ...as(email) });
  expect(res.status).toBe(200);
  return res;
}

/** Give somebody's personal workspace a plan and a branded address. */
async function claim(email: string, address: string) {
  const account = await personalAccountFor(env as any, email);
  await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(account!.id).run();
  const set = await setAccountPublicSlug(env as any, account!.id, address, AT);
  expect(set.ok).toBe(true);
  return account!;
}

beforeEach(async () => {
  await initDb();
  await clearR2();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS share_links (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, token_hash TEXT NOT NULL,
      created_by TEXT NOT NULL, expires_at TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL, last_used_at TEXT)`
  ).run();
  await env.DB.prepare("DELETE FROM share_links").run();
});

describe("rtfx.pro/:account/:artifact", () => {
  it("sends a branded link to the artifact's real URL on the content origin", async () => {
    await publish("q3-board-report", OWNER);
    await claim(OWNER, "yogev");

    const res = await appReq("/yogev/q3-board-report", as(OWNER));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`https://${CONTENT_HOST}/q3-board-report/`);
  });

  it("works for a second workspace with its own address", async () => {
    await publish("client-proposal", OTHER);
    await claim(OTHER, "maya");
    const res = await appReq("/maya/client-proposal", as(OTHER));
    expect(res.headers.get("Location")).toBe(`https://${CONTENT_HOST}/client-proposal/`);
  });

  it("resolves for a trailing slash and a mixed-case address", async () => {
    await publish("q3-board-report", OWNER);
    await claim(OWNER, "yogev");
    for (const path of ["/yogev/q3-board-report/", "/YOGEV/q3-board-report"]) {
      const res = await appReq(path, as(OWNER));
      expect(res.status, path).toBe(302);
      expect(res.headers.get("Location"), path).toBe(`https://${CONTENT_HOST}/q3-board-report/`);
    }
  });

  /**
   * The redirect is the entire implementation of "does this person get to see
   * it": the branded route hands off to the content origin, which applies the
   * artifact's own rules. A signed-out browser therefore meets exactly the
   * sign-in bounce it would have met had the link been the content URL.
   */
  it("hands authorization to the content origin rather than deciding it twice", async () => {
    await publish("q3-board-report", OWNER);
    await claim(OWNER, "yogev");

    // Somebody with no relationship to the artifact gets the same redirect…
    const stranger = await appReq("/yogev/q3-board-report", as(OTHER));
    expect(stranger.status).toBe(302);
    // …and is refused at the origin that actually serves it, exactly as they
    // would have been by the URL they'd have been sent before this feature.
    const refused = await contentReq("/q3-board-report/", as(OTHER));
    expect(refused.status).toBe(404);
  });

  it("carries a share key through, so a branded capability URL opens the page", async () => {
    await publish("q3-board-report", OWNER);
    await claim(OWNER, "yogev");
    const link = await createShareLink(env as any, { slug: "q3-board-report", createdBy: OWNER, now: AT });

    const res = await appReq(`/yogev/q3-board-report?k=${encodeURIComponent(link.key)}`);
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get("Location")!);
    expect(target.host).toBe(CONTENT_HOST);
    expect(target.pathname).toBe("/q3-board-report/");
    expect(target.searchParams.get("k")).toBe(link.key);

    // And the key still opens the artifact at the end of that redirect.
    const opened = await contentReq(`/q3-board-report/?k=${encodeURIComponent(link.key)}`, {
      headers: { "X-Dev-Anonymous": "true" },
    });
    expect([200, 302]).toContain(opened.status);
  });
});

describe("what a branded namespace must not reveal", () => {
  it("404s an artifact that belongs to another workspace", async () => {
    await publish("client-proposal", OTHER);
    await claim(OTHER, "maya");
    await publish("q3-board-report", OWNER);
    await claim(OWNER, "yogev");

    const res = await appReq("/yogev/client-proposal", as(OWNER));
    expect(res.status).toBe(404);
  });

  /**
   * The real oracle test: the SAME request, against two databases that differ
   * only in whether the other workspace's artifact exists. If those two answers
   * can be told apart, `rtfx.pro/yogev/<guess>` enumerates every slug on the
   * instance — which is exactly the probe the 404-for-everything rule on the
   * content origin was built to defeat.
   */
  it("answers a cross-account artifact identically to one that does not exist", async () => {
    await publish("client-proposal", OTHER);
    await claim(OTHER, "maya");
    await publish("q3-board-report", OWNER);
    await claim(OWNER, "yogev");

    const exists = await appReq("/yogev/client-proposal", as(OWNER));
    const existsBody = await exists.text();

    await env.DB.prepare("DELETE FROM artifacts WHERE slug = 'client-proposal'").run();
    const gone = await appReq("/yogev/client-proposal", as(OWNER));

    expect(exists.status).toBe(gone.status);
    expect(exists.status).toBe(404);
    expect(existsBody).toBe(await gone.text());
  });

  it("gives the owner of the other artifact no better answer than a stranger", async () => {
    await publish("client-proposal", OTHER);
    await claim(OTHER, "maya");
    await publish("q3-board-report", OWNER);
    await claim(OWNER, "yogev");

    // Maya owns `client-proposal`, but it is not in Yogev's namespace.
    const asOwnerOfIt = await appReq("/yogev/client-proposal", as(OTHER));
    const asStranger = await appReq("/yogev/client-proposal", as(OWNER));
    expect(asOwnerOfIt.status).toBe(404);
    expect(await asOwnerOfIt.text()).toBe(await asStranger.text());
  });

  it("never serves artifact bytes from the app origin", async () => {
    await publish("q3-board-report", OWNER);
    await claim(OWNER, "yogev");
    for (const path of ["/yogev/q3-board-report", "/yogev/q3-board-report/"]) {
      const res = await appReq(path, {
        ...as(OWNER),
        headers: { ...(as(OWNER).headers as Record<string, string>), "Sec-Fetch-Dest": "document" },
      });
      expect(res.status, path).toBe(302);
      expect(await res.text()).not.toContain("<h1>q3-board-report</h1>");
    }
  });
});

describe("nothing that worked before stops working", () => {
  it("keeps the content-origin URL as the artifact's real address", async () => {
    await publish("q3-board-report", OWNER);
    await claim(OWNER, "yogev");
    const res = await contentReq("/q3-board-report/", as(OWNER));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>q3-board-report</h1>");
  });

  it("still redirects a two-segment app-host path when nobody holds that address", async () => {
    await publish("report", OWNER);
    // `/report/preview` is an artifact sub-path, not a namespace — and it must
    // behave exactly as it did before branded addresses existed.
    const res = await appReq("/report/preview", as(OWNER));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`https://${CONTENT_HOST}/report/preview`);
  });

  it("still redirects a single-segment app-host artifact path", async () => {
    await publish("report", OWNER);
    const res = await appReq("/report/", as(OWNER));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`https://${CONTENT_HOST}/report/`);
  });

  it("leaves the content origin's own two-segment paths alone", async () => {
    await publish("q3-board-report", OWNER);
    await claim(OWNER, "yogev");
    // On the content host this is an asset lookup inside artifact `yogev`,
    // which does not exist — never a branded address.
    const res = await contentReq("/yogev/q3-board-report", as(OWNER));
    expect(res.status).toBe(404);
  });

  it("keeps the public pages and management routes off the branded route", async () => {
    await publish("q3-board-report", OWNER);
    await claim(OWNER, "yogev");
    for (const [path, status] of [
      ["/docs", 200],
      ["/pro", 200],
      ["/privacy", 200],
      ["/health", 200],
    ] as const) {
      const res = await appReq(path, { headers: { "X-Dev-Anonymous": "true" } });
      expect(res.status, path).toBe(status);
    }
  });
});

describe("the branded link in API responses", () => {
  it("is reported on publish once the workspace has an address, and not before", async () => {
    const before = await publish("q3-board-report", OWNER);
    expect((await before.json() as any).branded_url).toBeUndefined();

    await claim(OWNER, "yogev");
    const after = await publish("q3-board-report", OWNER);
    const body = (await after.json()) as any;
    expect(body.url).toBe(`https://${CONTENT_HOST}/q3-board-report/`);
    expect(body.branded_url).toBe(`${APP}/yogev/q3-board-report`);
  });

  it("appears on the artifact list without disturbing anything already there", async () => {
    await publish("q3-board-report", OWNER);
    await claim(OWNER, "yogev");
    const res = await appReq("/api/artifacts", as(OWNER));
    const body = (await res.json()) as any;
    const row = body.artifacts.find((a: any) => a.slug === "q3-board-report");
    expect(body.content_base).toBe(`https://${CONTENT_HOST}`);
    expect(row.branded_url).toBe(`${APP}/yogev/q3-board-report`);
    // The fields a client already reads are untouched.
    expect(row.title).toBe("q3-board-report");
    expect(row.current_version).toBe(1);
  });

  it("reports the workspace's address on GET /api/accounts", async () => {
    await publish("q3-board-report", OWNER);
    await claim(OWNER, "yogev");
    const body = (await (await appReq("/api/accounts", as(OWNER))).json()) as any;
    expect(body.accounts[0].public_slug).toBe("yogev");
  });
});
