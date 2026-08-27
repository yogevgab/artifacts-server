import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import type { Env } from "../src/env";
import { appOrigins, isAllowedOrigin } from "../src/cors";
import { initDb, clearR2, req, as, withToken } from "./fixtures";
import { createApiToken } from "../src/tokens";

/**
 * Browser preflight + CORS for the management API (issue #37).
 *
 * The bug this file pins down: the People panel's "Send invite" button POSTs
 * `/api/users` with `Content-Type: application/json`. That is a same-origin
 * request, so no preflight is involved *until* something in front of the Worker
 * answers with a cross-origin redirect — which is what a legacy/self-host edge
 * gate does when the browser has no session for the application guarding
 * `/api/users` (historical evidence: 302 → `…cloudflareaccess.com`). A browser
 * will not follow a cross-origin redirect for a request that would need a
 * preflight, and reports the whole thing as a CORS failure.
 *
 * Two things are the Worker's to fix, and both are tested here:
 *
 *   1. A preflight (`OPTIONS`) must be answered as a *policy* question, never
 *      authenticated. Browsers strip credentials from preflights by definition,
 *      so running `requireAdmin` on one refuses a call that would have worked.
 *   2. The allow-origin answer must name one concrete origin — never `*`, never
 *      a content host — and only ever alongside `Allow-Credentials`.
 *
 * What must NOT change is who may actually *do* anything: the token denial and
 * the admin-only rule on `/api/users` are re-asserted at the bottom of this file.
 */

const SUPER = "admin@test.com";
const MEMBER = "member@beta.com";

/** What `app.request("/x")` synthesizes, and therefore this app's own origin. */
const APP = "http://localhost";
const CONTENT_HOST = "content.test.local";
const FOREIGN = "https://evil.example.com";

beforeEach(async () => {
  await initDb();
  await clearR2();
});

const preflight = (path: string, origin: string | null, init: RequestInit = {}) =>
  req(path, {
    method: "OPTIONS",
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...(origin ? { Origin: origin } : {}),
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });

// ---------------------------------------------------------------------------
// Which origins count as "this app"
// ---------------------------------------------------------------------------

describe("appOrigins", () => {
  it("trusts the origin the request actually arrived on", () => {
    expect(appOrigins({} as Env, "https://rtfx.pro/api/users")).toContain("https://rtfx.pro");
  });

  it("trusts the configured canonical origin even on a preview host", () => {
    const e = { PUBLIC_BASE_URL: "https://rtfx.pro" } as Env;
    const origins = appOrigins(e, "https://staging.workers.dev/api/users");
    expect(origins).toContain("https://rtfx.pro");
    expect(origins).toContain("https://staging.workers.dev");
  });

  it("trusts extra app origins named in APP_ORIGINS, normalized to an origin", () => {
    const e = { APP_ORIGINS: "https://admin.rtfx.pro/ , https://ops.rtfx.pro" } as Env;
    const origins = appOrigins(e, "https://rtfx.pro/api/users");
    expect(origins).toContain("https://admin.rtfx.pro");
    expect(origins).toContain("https://ops.rtfx.pro");
  });

  it("ignores junk in APP_ORIGINS rather than trusting it", () => {
    const e = { APP_ORIGINS: "not-a-url,,*" } as Env;
    expect(appOrigins(e, "https://rtfx.pro/api/users")).toEqual(new Set(["https://rtfx.pro"]));
  });

  /**
   * The whole point of a content host is that it serves untrusted uploaded HTML.
   * If it were ever an allowed API origin, an artifact could call the management
   * API with the viewer's cookies. It is excluded even when it is the host the
   * request arrived on, and even if somebody lists it explicitly.
   */
  it("never trusts a content host — not as the request host", () => {
    const e = { CONTENT_HOSTNAMES: "a.rtfx.pro" } as Env;
    expect(appOrigins(e, "https://a.rtfx.pro/api/users")).toEqual(new Set());
  });

  it("never trusts a content host — not even when named in APP_ORIGINS", () => {
    const e = { CONTENT_HOSTNAMES: "a.rtfx.pro", APP_ORIGINS: "https://a.rtfx.pro" } as Env;
    expect(appOrigins(e, "https://rtfx.pro/api/users")).toEqual(new Set(["https://rtfx.pro"]));
  });

  it("never trusts a content host — not even as PUBLIC_BASE_URL", () => {
    const e = { CONTENT_HOSTNAMES: "a.rtfx.pro", PUBLIC_BASE_URL: "https://a.rtfx.pro" } as Env;
    expect(appOrigins(e, "https://rtfx.pro/api/users")).toEqual(new Set(["https://rtfx.pro"]));
  });
});

describe("isAllowedOrigin", () => {
  const e = { PUBLIC_BASE_URL: "https://rtfx.pro" } as Env;
  const url = "https://rtfx.pro/api/users";

  it("accepts an exact origin match", () => {
    expect(isAllowedOrigin(e, url, "https://rtfx.pro")).toBe(true);
  });

  it("matches on the whole origin, never a prefix or suffix", () => {
    for (const o of [
      "https://rtfx.pro.evil.com",
      "https://evil.com/https://rtfx.pro",
      "http://rtfx.pro", // scheme is part of the origin
      "https://rtfx.pro:8443", // so is the port
    ]) {
      expect(isAllowedOrigin(e, url, o), o).toBe(false);
    }
  });

  it("refuses the opaque origin a sandboxed frame sends", () => {
    expect(isAllowedOrigin(e, url, "null")).toBe(false);
  });

  it("refuses a missing origin", () => {
    expect(isAllowedOrigin(e, url, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

describe("OPTIONS preflight on /api/users", () => {
  /**
   * The regression for the reported bug. A browser sends a preflight with **no**
   * cookies and no `Authorization` — so before the fix this hit `requireAdmin`
   * and was refused, which a browser surfaces as "blocked by CORS policy" on the
   * invite call that follows.
   */
  it("is answered without credentials, and is not 401/403/404", async () => {
    const res = await preflight("/api/users", APP, {
      headers: { "X-Dev-Anonymous": "true" },
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("names the calling origin and allows credentials", async () => {
    const res = await preflight("/api/users", APP);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("permits the method and header the invite form actually sends", async () => {
    const res = await preflight("/api/users", APP);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
    expect(res.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("content-type");
  });

  it("caches the preflight so an invite round trip is one request, not two", async () => {
    const res = await preflight("/api/users", APP);
    expect(Number(res.headers.get("Access-Control-Max-Age"))).toBeGreaterThan(0);
  });

  it("varies on Origin, so a cache can never replay one origin's answer to another", async () => {
    const res = await preflight("/api/users", APP);
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  /**
   * A wildcard is not merely wrong here, it is impossible: `*` with
   * `Allow-Credentials: true` is rejected by every browser, and would be a
   * catastrophe if it weren't.
   */
  it("never answers with a wildcard origin", async () => {
    for (const origin of [APP, FOREIGN, null]) {
      const res = await preflight("/api/users", origin);
      expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
    }
  });

  it("tells a foreign origin nothing it can use", async () => {
    const res = await preflight("/api/users", FOREIGN);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("covers the rest of the management API too, not just /users", async () => {
    for (const path of ["/api/artifacts", "/api/tokens", "/api/accounts"]) {
      const res = await preflight(path, APP);
      expect(res.status, path).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin"), path).toBe(APP);
    }
  });
});

// ---------------------------------------------------------------------------
// Actual (non-preflight) requests
// ---------------------------------------------------------------------------

describe("CORS headers on real API responses", () => {
  it("echoes the app origin on a successful invite", async () => {
    const res = await req(
      "/api/users",
      as(SUPER, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP },
        body: JSON.stringify({ email: "invited@beta.com" }),
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  it("gives a foreign origin no read access to the directory", async () => {
    const res = await req("/api/users", as(SUPER, { headers: { Origin: FOREIGN } }));
    expect(res.status).toBe(200); // the *caller* is authorized; the browser is what gets blocked
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("adds no CORS headers at all when there is no Origin (CLI, curl, agents)", async () => {
    const res = await req("/api/users", as(SUPER));
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("still refuses a foreign origin on an error response", async () => {
    const res = await req("/api/users", as(MEMBER, { headers: { Origin: FOREIGN } }));
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The boundaries that must survive the fix
// ---------------------------------------------------------------------------

describe("content-host isolation is unchanged", () => {
  const contentEnv = { ...env, CONTENT_HOSTNAMES: CONTENT_HOST } as any;
  const onContentHost = (path: string, init?: RequestInit) =>
    app.request(`https://${CONTENT_HOST}${path}`, init, contentEnv);

  it("does not answer a preflight for the management API on a content host", async () => {
    const res = await onContentHost("/api/users", {
      method: "OPTIONS",
      headers: {
        Origin: `https://${CONTENT_HOST}`,
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does not let an artifact page call the API as its viewer", async () => {
    const res = await app.request(
      "https://app.test.local/api/users",
      as(SUPER, { headers: { Origin: `https://${CONTENT_HOST}` } }),
      contentEnv
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("private-route protection is unchanged", () => {
  it("still refuses an API token on /api/users, Origin or not", async () => {
    const { token } = await createApiToken(env as unknown as Env, {
      name: "ci",
      ownerEmail: SUPER,
      accountId: null,
      isAdmin: true,
      scopes: ["read", "publish", "manage"],
      createdBy: SUPER,
      expiresAt: null,
      now: new Date().toISOString(),
    });
    const res = await req(
      "/api/users",
      withToken(token, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP },
        body: JSON.stringify({ email: "nope@beta.com" }),
      })
    );
    expect(res.status).toBe(403);
    expect((await res.json<{ detail: string }>()).detail).toMatch(/API tokens cannot manage/);
  });

  it("still refuses a non-admin on /api/users", async () => {
    const res = await req(
      "/api/users",
      as(MEMBER, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP },
        body: JSON.stringify({ email: "nope@beta.com" }),
      })
    );
    expect(res.status).toBe(403);
  });

  /**
   * A preflight says what a browser *may attempt*, never what it may have. It
   * carries no credentials, so answering it identically for everybody leaks
   * nothing — and the request that follows is authenticated as it always was.
   */
  it("answering a preflight grants nothing on its own", async () => {
    const pre = await preflight("/api/users", APP, { headers: { "X-Dev-Anonymous": "true" } });
    expect(pre.status).toBe(204);
    const real = await req("/api/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP,
        "X-Dev-Anonymous": "true",
      },
      body: JSON.stringify({ email: "nope@beta.com" }),
    });
    expect(real.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Recovering from the edge session handoff that caused the bug
// ---------------------------------------------------------------------------

/**
 * On a legacy/self-host instance `/admin` and `/api/users` can sit behind two
 * *different* edge applications, so a browser holding a session for the first
 * has none for the second and the first invite of a session is answered with a
 * cross-origin redirect the `fetch` cannot follow. This route is the way back: a
 * full-page navigation the edge *can* complete, which then returns the person to
 * the page they were on. The app-owned deployment never needs it.
 */
describe("GET /api/users/reauth", () => {
  it("bounces an admin back to the page they came from", async () => {
    const res = await req("/api/users/reauth?next=/admin/people", as(SUPER));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/people");
  });

  it("defaults to the People section", async () => {
    const res = await req("/api/users/reauth", as(SUPER));
    expect(res.headers.get("Location")).toBe("/admin/people");
  });

  it("never redirects off-site, whatever `next` says", async () => {
    for (const next of [
      "https://evil.example.com/",
      "//evil.example.com/",
      "/\\evil.example.com",
      "javascript:alert(1)",
      "admin/people",
    ]) {
      const res = await req(`/api/users/reauth?next=${encodeURIComponent(next)}`, as(SUPER));
      expect(res.headers.get("Location"), next).toBe("/admin/people");
    }
  });

  it("is admin-only, like every other /api/users route", async () => {
    const res = await req("/api/users/reauth", as(MEMBER));
    expect(res.status).toBe(403);
  });

  it("refuses an API token, like every other /api/users route", async () => {
    const { token } = await createApiToken(env as unknown as Env, {
      name: "ci",
      ownerEmail: SUPER,
      accountId: null,
      isAdmin: true,
      scopes: ["read", "publish", "manage"],
      createdBy: SUPER,
      expiresAt: null,
      now: new Date().toISOString(),
    });
    const res = await req("/api/users/reauth", withToken(token));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The client half of the fix
// ---------------------------------------------------------------------------

/**
 * The People panel's script has to survive the Access redirect rather than let
 * the browser turn it into an unhandled CORS error. Asserting on the rendered
 * script is coarse, but it is the only seam: this code runs in the browser, and
 * a silent regression here reproduces the exact bug users reported.
 */
describe("People panel invite script", () => {
  const peopleHtml = async () => (await req("/admin/people", as(SUPER))).text();

  it("does not follow a cross-origin sign-in redirect", async () => {
    expect(await peopleHtml()).toContain("redirect:'manual'");
  });

  it("recognizes the opaque response an intercepted redirect produces", async () => {
    const html = await peopleHtml();
    expect(html).toContain("opaqueredirect");
  });

  it("re-authenticates through a full-page navigation instead of failing", async () => {
    expect(await peopleHtml()).toContain("/api/users/reauth?next=");
  });
});
