import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { accessRequestRoutes } from "../src/access-request-routes";
import { notFoundPage } from "../src/pages";
import { isManagementPath, isContentPrefix } from "../src/host";
import { setAccess } from "../src/db";
import { initDb, clearR2, req, as } from "./fixtures";

const OWNER = "owner@rtfx.pro";
const REQUESTER = "stranger@example.com";
const AT = "2026-08-14T12:00:00.000Z";

function envWith(send: (m: any) => Promise<any>) {
  return {
    ...(env as any),
    EMAIL: { send },
    MAIL_FROM: "no-reply@rtfx.pro",
    PUBLIC_BASE_URL: "https://rtfx.pro",
  };
}

async function post(path: string, email: unknown, e: any) {
  return accessRequestRoutes.request(
    path,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) },
    e
  );
}

beforeEach(async () => {
  await initDb();
  await clearR2();
  const body = new FormData();
  body.set("slug", "report");
  body.set("title", "Q3 Report");
  body.set("visibility", "restricted");
  body.set("file", new File(["<h1>secret</h1>"], "index.html", { type: "text/html" }));
  await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
});

describe("POST /_access-request/:slug", () => {
  it("emails the owner when the artifact exists and the requester has no grant", async () => {
    let seen: any;
    const e = envWith(async (m) => {
      seen = m;
      return { messageId: "m1" };
    });
    const res = await post("/_access-request/report", REQUESTER, e);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
    expect(seen).toBeDefined();
    expect(seen.to).toBe(OWNER);
    expect(seen.subject).toContain(REQUESTER);
    expect(seen.subject).toContain("Q3 Report");
    expect(seen.html).toContain("/admin/artifacts/report");
  });

  it("sends no mail when the requester already holds a grant", async () => {
    await setAccess(env as any, "report", "restricted", [REQUESTER], AT);
    let calls = 0;
    const e = envWith(async () => {
      calls++;
      return { messageId: "m1" };
    });
    const res = await post("/_access-request/report", REQUESTER, e);
    expect(res.status).toBe(202);
    expect(calls).toBe(0);
  });

  it("sends no mail for a slug that does not exist, and answers identically to the already-granted case", async () => {
    await setAccess(env as any, "report", "restricted", [REQUESTER], AT);
    let calls = 0;
    const e = envWith(async () => {
      calls++;
      return { messageId: "m1" };
    });

    const granted = await post("/_access-request/report", REQUESTER, e);
    const missing = await post("/_access-request/totally-made-up-slug", REQUESTER, e);

    expect(calls).toBe(0);
    expect(granted.status).toBe(missing.status);
    expect(await granted.json()).toEqual(await missing.json());
  });

  it("does not notify the owner about their own request", async () => {
    let calls = 0;
    const e = envWith(async () => {
      calls++;
      return { messageId: "m1" };
    });
    const res = await post("/_access-request/report", OWNER, e);
    expect(res.status).toBe(202);
    expect(calls).toBe(0);
  });

  it("rejects a malformed email with 400", async () => {
    const res = await post("/_access-request/report", "not-an-email", envWith(async () => ({ messageId: "m1" })));
    expect(res.status).toBe(400);
  });

  it("rejects a malformed email identically for a made-up slug", async () => {
    const e = envWith(async () => ({ messageId: "m1" }));
    const real = await post("/_access-request/report", "not-an-email", e);
    const fake = await post("/_access-request/totally-made-up-slug", "not-an-email", e);
    expect(real.status).toBe(fake.status);
    expect(await real.json()).toEqual(await fake.json());
  });

  it("rate-limits repeated requests from the same address", async () => {
    const e = envWith(async () => ({ messageId: "m1" }));
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      last = await post("/_access-request/report", REQUESTER, e);
    }
    expect(last!.status).toBe(429);
  });
});

describe("notFoundPage", () => {
  it("offers the same ask-for-access form for any slug, real or invented", async () => {
    // "report" genuinely exists (created in beforeEach); this slug does not.
    expect(await env.DB.prepare("SELECT 1 FROM artifacts WHERE slug='report'").first()).toBeTruthy();
    expect(await env.DB.prepare("SELECT 1 FROM artifacts WHERE slug='totally-made-up-slug'").first()).toBeNull();

    const real = notFoundPage("report");
    const fake = notFoundPage("totally-made-up-slug");
    // The only expected difference between the two pages is the slug text
    // itself — normalize it out and the rest must be identical.
    const normalize = (html: string, slug: string) => html.split(slug).join("SLUG");
    expect(normalize(real, "report")).toBe(normalize(fake, "totally-made-up-slug"));
  });

  it("posts to the access-request route for that slug", () => {
    const html = notFoundPage("report");
    expect(html).toContain('data-request-access="/_access-request/report"');
  });

  it("shows no ask-for-access form on the bare 404 (no slug at all)", () => {
    const html = notFoundPage();
    expect(html).not.toContain("data-request-access");
    expect(html).not.toContain("data-ask-access");
  });
});

describe("content-host routing for the access-request path", () => {
  it("is never treated as a management-only path", () => {
    expect(isManagementPath("/_access-request/report")).toBe(false);
  });

  it("is recognized as a content-host prefix, like /_chat", () => {
    expect(isContentPrefix("/_access-request/report")).toBe(true);
    expect(isContentPrefix("/_access-request")).toBe(true);
  });
});
