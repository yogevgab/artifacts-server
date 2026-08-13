import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { strToU8 } from "fflate";
import app from "../src/index";
import { initDb, clearR2, req, as, withToken, htmlForm } from "./fixtures";

/**
 * The machine API — `/api/machine/*`.
 *
 * Why it exists: on an Access-gated deployment, `/api` is guarded at the edge by
 * Cloudflare Access, so a request carrying only an `rtfx_…` bearer token is
 * answered by Access's login redirect before the Worker ever runs. The
 * documented "publish from Claude Code / the CLI / curl" path therefore could
 * not be completed by an invited external user unless they were *also* handed
 * Cloudflare service-token credentials — a per-deployment secret an operator
 * cannot reasonably give out per person.
 *
 * `/api/machine/*` is the same artifact routes behind a *stricter* app-layer
 * gate, so it can be put on an Access Bypass policy safely. These tests pin the
 * three properties that makes true:
 *
 *  1. A valid bearer token works with no Access identity of any kind.
 *  2. Nothing else works: no token, a bad token, a revoked/expired token, and —
 *     crucially — a browser-style session identity are all refused. That last
 *     one is what keeps an un-gated surface immune to CSRF.
 *  3. It is not a bypass of anything else. Scopes, ownership, the paused-account
 *     check and the "no credential management from a token" rule all still
 *     apply, and `/api` itself is untouched.
 */

const ADMIN = "admin@test.com"; // matches ADMIN_EMAILS in vitest.config.ts
const BOB = "bob@beta.com";
const CAROL = "carol@beta.com";

const MACHINE = "/api/machine";

beforeEach(async () => {
  await initDb();
  await clearR2();
});

/** Mint a token as a signed-in person (an Access login — the only way to get one). */
async function tokenFor(email: string, body: Record<string, unknown> = { name: "t" }) {
  const res = await req(
    "/api/tokens",
    as(email, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  expect(res.status).toBe(201);
  return (await res.json<any>()).token as string;
}

const html = (slug: string) => htmlForm({ title: slug, slug }, "x.html", strToU8(`<h1>${slug}</h1>`));

/** Publish over the machine surface with a bearer token and nothing else. */
const machinePublish = (token: string, slug: string) =>
  req(`${MACHINE}/artifacts`, withToken(token, { method: "POST", body: html(slug) }));

/** Publish over the dashboard surface as a signed-in person. */
const publishAs = (email: string, slug: string) =>
  req("/api/artifacts", as(email, { method: "POST", body: html(slug) }));

const json = async (res: Response) => await res.json<any>();

describe("a bearer token alone is enough", () => {
  it("publishes with no Access identity — no session, no service-token headers", async () => {
    const token = await tokenFor(BOB, { name: "agent" });
    const res = await machinePublish(token, "from-an-agent");
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.slug).toBe("from-an-agent");
    expect(body.version).toBe(1);
    // The artifact belongs to the person the token acts as, exactly as on /api.
    const row = await env.DB.prepare("SELECT owner_email FROM artifacts WHERE slug = ?")
      .bind("from-an-agent")
      .first<any>();
    expect(row.owner_email).toBe(BOB);
  });

  it("covers the whole publishing story: list, versions, rollback, share, delete", async () => {
    const token = await tokenFor(BOB, { name: "agent", scopes: ["read", "publish", "manage"] });

    expect((await machinePublish(token, "report")).status).toBe(200);
    expect((await json(await machinePublish(token, "report"))).version).toBe(2);

    const list = await json(await req(`${MACHINE}/artifacts`, withToken(token)));
    expect(list.artifacts.map((a: any) => a.slug)).toEqual(["report"]);
    // The one thing a client cannot derive: where artifacts are actually served.
    expect(list.content_base).toBeTruthy();

    const versions = await json(await req(`${MACHINE}/artifacts/report/versions`, withToken(token)));
    expect(versions.current).toBe(2);
    expect(versions.versions).toHaveLength(2);
    expect(versions.url).toContain("/report/");

    const rolledBack = await req(
      `${MACHINE}/artifacts/report/current`,
      withToken(token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1 }),
      })
    );
    expect(rolledBack.status).toBe(200);
    expect((await json(rolledBack)).current).toBe(1);

    const views = await req(`${MACHINE}/artifacts/report/views`, withToken(token));
    expect(views.status).toBe(200);

    const shared = await req(
      `${MACHINE}/artifacts/report/access`,
      withToken(token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "restricted", emails: [CAROL] }),
      })
    );
    expect(shared.status).toBe(200);
    expect((await json(shared)).emails).toEqual([CAROL]);
    expect((await json(await req(`${MACHINE}/artifacts/report/access`, withToken(token)))).visibility).toBe(
      "restricted"
    );

    expect((await req(`${MACHINE}/artifacts/report`, withToken(token, { method: "DELETE" }))).status).toBe(200);
    expect((await json(await req(`${MACHINE}/artifacts`, withToken(token)))).artifacts).toEqual([]);
  });

  it("answers exactly what /api answers for the same token", async () => {
    const token = await tokenFor(BOB, { name: "agent" });
    await machinePublish(token, "same-shape");

    const viaMachine = await json(await req(`${MACHINE}/artifacts`, withToken(token)));
    const viaApi = await json(await req("/api/artifacts", withToken(token)));
    expect(viaMachine).toEqual(viaApi);
  });
});

describe("nothing but a valid bearer token gets in", () => {
  it("refuses a request with no Authorization header, with a Bearer challenge", async () => {
    const res = await req(`${MACHINE}/artifacts`);
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("unauthorized");
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("refuses an unknown, malformed, revoked or expired token", async () => {
    expect((await req(`${MACHINE}/artifacts`, withToken("nonsense"))).status).toBe(401);
    const unknown = await req(`${MACHINE}/artifacts`, withToken("rtfx_deadbeefdead_notarealtokenatall"));
    expect(unknown.status).toBe(401);
    expect((await json(unknown)).error).toBe("invalid_token");

    const revoked = await req(
      "/api/tokens",
      as(BOB, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "doomed" }),
      })
    );
    const { id, token } = await json(revoked);
    expect((await req(`${MACHINE}/artifacts`, withToken(token))).status).toBe(200);
    await req(`/api/tokens/${id}`, as(BOB, { method: "DELETE" }));
    expect((await req(`${MACHINE}/artifacts`, withToken(token))).status).toBe(401);

    const expiring = await tokenFor(BOB, { name: "expiring", expires_in_days: 1 });
    await env.DB.prepare("UPDATE api_tokens SET expires_at = ? WHERE name = 'expiring'")
      .bind("2020-01-01T00:00:00.000Z")
      .run();
    expect((await req(`${MACHINE}/artifacts`, withToken(expiring))).status).toBe(401);
  });

  /**
   * The CSRF property. `/api/machine` is meant to sit outside Cloudflare Access,
   * so if it honoured a session identity, any website could make a logged-in
   * person's browser publish or delete on their behalf — a browser attaches
   * cookies to a cross-site request by itself, but never an `Authorization`
   * header. A session identity is therefore refused outright, even though the
   * very same identity is welcome on `/api`.
   */
  it("refuses a signed-in browser identity — the same one /api accepts", async () => {
    expect((await req("/api/artifacts", as(ADMIN))).status).toBe(200);
    expect((await req(`${MACHINE}/artifacts`, as(ADMIN))).status).toBe(401);

    const drive_by = await req(`${MACHINE}/artifacts`, as(ADMIN, { method: "POST", body: html("csrf") }));
    expect(drive_by.status).toBe(401);
    expect(await env.DB.prepare("SELECT slug FROM artifacts").first()).toBeNull();
  });

  /**
   * The other Access identity: a *service token*, which authenticates as a
   * `common_name` and carries no email at all. `ADMIN_SERVICE_TOKENS` makes one
   * of those an admin everywhere else in the product (the CLI's original
   * credential, see docs/DEPLOY_RTFX.md §5.1) — and it must still get nothing
   * here, because the machine surface authenticates the `rtfx_…` bearer token
   * and nothing else. `requireApiToken` never consults an Access assertion, so
   * presenting one — header or cookie, valid or not — is the same as presenting
   * no credential at all.
   *
   * (The JWT itself is not verified in tests: `ACCESS_AUD`/`ACCESS_TEAM_DOMAIN`
   * are empty in vitest.config.ts, so `verifyAccess` short-circuits. What this
   * pins is the gate's *input* — that the machine surface reads `Authorization`
   * and nothing else — which is the property that would be violated by wiring
   * Access identity back in.)
   */
  it("refuses an Access service-token identity — a common_name, no email", async () => {
    const serviceToken = {
      "CF-Access-Client-Id": "admin-token.access", // the allow-listed admin one
      "CF-Access-Client-Secret": "not-a-real-secret",
      "Cf-Access-Jwt-Assertion": "header.payload.signature",
      Cookie: "CF_Authorization=header.payload.signature",
    };

    const listed = await req(`${MACHINE}/artifacts`, { headers: serviceToken });
    expect(listed.status).toBe(401);
    expect((await json(listed)).error).toBe("unauthorized");
    expect(listed.headers.get("WWW-Authenticate")).toContain("Bearer");

    const published = await req(`${MACHINE}/artifacts`, {
      method: "POST",
      headers: serviceToken,
      body: html("service-token"),
    });
    expect(published.status).toBe(401);
    expect(await env.DB.prepare("SELECT slug FROM artifacts").first()).toBeNull();
  });

  /**
   * An Access JWT is a bearer credential too, and somebody wiring up a client by
   * hand will eventually put one in the `Authorization` header. It is not an
   * `rtfx_…` token, so it is refused — and refused on shape alone, before any
   * database lookup (see `identityFromApiToken`).
   */
  it("refuses an Access JWT presented as the bearer token", async () => {
    const jwtish = "eyJhbGciOiJSUzI1NiJ9.eyJjb21tb25fbmFtZSI6ImFkbWluLXRva2VuLmFjY2VzcyJ9.sig";
    const res = await req(`${MACHINE}/artifacts`, withToken(jwtish));
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("invalid_token");
  });

  it("refuses a paused account's token, and says why", async () => {
    const token = await tokenFor(BOB, { name: "soon-paused" });
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users (email, role, status, created_at, disabled_at)
       VALUES (?, 'member', 'disabled', ?, ?)
       ON CONFLICT(email) DO UPDATE SET status = 'disabled', disabled_at = excluded.disabled_at`
    )
      .bind(BOB, now, now)
      .run();
    const res = await req(`${MACHINE}/artifacts`, withToken(token));
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("account_disabled");
  });
});

describe("it is not a bypass of anything else", () => {
  it("still enforces scopes", async () => {
    await publishAs(BOB, "scoped");
    await publishAs(BOB, "scoped"); // v2, so rollback has somewhere to go
    const reader = await tokenFor(BOB, { name: "reader", scopes: ["read"] });

    expect((await req(`${MACHINE}/artifacts`, withToken(reader))).status).toBe(200);
    const denied = await machinePublish(reader, "scoped");
    expect(denied.status).toBe(403);
    expect((await json(denied)).error).toBe("insufficient_scope");
    expect(
      (await req(`${MACHINE}/artifacts/scoped`, withToken(reader, { method: "DELETE" }))).status
    ).toBe(403);
  });

  it("still enforces ownership — another person's artifact is a 404, and the slug can't be taken", async () => {
    await publishAs(BOB, "bobs-page");
    const carols = await tokenFor(CAROL, { name: "carol", scopes: ["read", "publish", "manage"] });

    expect((await req(`${MACHINE}/artifacts/bobs-page/versions`, withToken(carols))).status).toBe(404);
    expect(
      (await req(`${MACHINE}/artifacts/bobs-page`, withToken(carols, { method: "DELETE" }))).status
    ).toBe(404);
    expect((await machinePublish(carols, "bobs-page")).status).toBe(409);
    expect((await json(await req(`${MACHINE}/artifacts`, withToken(carols)))).artifacts).toEqual([]);
  });

  /**
   * The surface is an allow-list of artifact routes, not a second front door to
   * the whole API. Inviting a user and minting a token are the two actions that
   * hand out credentials; both stay on `/api`, where Cloudflare Access can still
   * gate them, and both already refuse API tokens in code.
   */
  it("does not answer for user, token or workspace management at all", async () => {
    const admin = await tokenFor(ADMIN, {
      name: "ci",
      is_admin: true,
      scopes: ["read", "publish", "manage"],
    });
    for (const path of ["", "/users", "/tokens", "/accounts", "/users/reauth"]) {
      const res = await req(`${MACHINE}${path}`, withToken(admin));
      expect(res.status, path).toBe(404);
      // An explicit code, so a client can tell this apart from an older
      // deployment that has no machine surface at all (a bare framework 404).
      expect((await json(res)).error, path).toBe("not_found");
    }
    const invite = await req(
      `${MACHINE}/users`,
      withToken(admin, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "eve@x.com" }),
      })
    );
    expect(invite.status).toBe(404);
    expect(await env.DB.prepare("SELECT email FROM users WHERE email = 'eve@x.com'").first()).toBeNull();

    const mint = await req(
      `${MACHINE}/tokens`,
      withToken(admin, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "child", is_admin: true }),
      })
    );
    expect(mint.status).toBe(404);
    expect(
      await env.DB.prepare("SELECT id FROM api_tokens WHERE name = 'child'").first()
    ).toBeNull();
  });

  it("leaves /api exactly as it was", async () => {
    const token = await tokenFor(BOB, { name: "t" });
    // Browser/dashboard identity: unchanged.
    expect((await publishAs(BOB, "classic")).status).toBe(200);
    expect((await req("/api/artifacts", as(BOB))).status).toBe(200);
    expect((await req("/api/artifacts/classic/versions", as(BOB))).status).toBe(200);
    // A bearer token on /api: unchanged (this is how an Access-gated CLI works).
    expect((await req("/api/artifacts", withToken(token))).status).toBe(200);
    // Credential management: unchanged, both ways round.
    expect((await req("/api/users", as(BOB))).status).toBe(403);
    expect((await req("/api/users", as(ADMIN))).status).toBe(200);
    expect((await req("/api/tokens", withToken(token))).status).toBe(403);
  });

  it("is still refused on a content host, like the rest of the API", async () => {
    const token = await tokenFor(BOB, { name: "t" });
    const contentEnv = { ...env, CONTENT_HOSTNAMES: "a.test.local" } as any;
    const res = await app.request(
      `https://a.test.local${MACHINE}/artifacts`,
      withToken(token),
      contentEnv
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });
});

/**
 * The one thing that must reach `/api/machine/*` *without* a token: a browser
 * preflight.
 *
 * `apiCors` is mounted on `/api/*` ahead of `requireApiToken` (src/api.ts), and
 * the order is load-bearing. A preflight carries no credentials — the browser
 * strips them, by definition — so authenticating it would refuse it, and a
 * refused preflight blocks the authorized request that was going to follow. The
 * whole point of the machine surface is a bearer token in an `Authorization`
 * header, and `Authorization` is not a CORS-safelisted header, so *every*
 * cross-origin call to it is preflighted. Put the gate first and the surface is
 * unreachable from a browser at all.
 *
 * Answering it grants nothing: it returns no body and no identity, and the
 * request that follows is authenticated exactly as it always was.
 */
describe("a browser preflight is answered before the gate", () => {
  const APP_ORIGIN = "http://localhost"; // what app.request() synthesizes
  const FOREIGN = "https://evil.example.com";

  const preflight = (path: string, origin?: string) =>
    req(path, {
      method: "OPTIONS",
      headers: {
        ...(origin ? { Origin: origin } : {}),
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });

  it("answers OPTIONS with the policy, not a 401", async () => {
    for (const path of [`${MACHINE}/artifacts`, `${MACHINE}/artifacts/anything/versions`]) {
      const res = await preflight(path, APP_ORIGIN);
      expect(res.status, path).toBe(204);
      expect(res.headers.get("WWW-Authenticate"), path).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Origin"), path).toBe(APP_ORIGIN);
      expect(res.headers.get("Access-Control-Allow-Credentials"), path).toBe("true");
      expect(res.headers.get("Access-Control-Allow-Methods"), path).toContain("POST");
      // Without this the bearer header the surface exists for can't be sent.
      expect(res.headers.get("Access-Control-Allow-Headers"), path).toContain("Authorization");
      expect(res.headers.get("Access-Control-Max-Age"), path).toBeTruthy();
      expect(res.headers.get("Vary"), path).toContain("Origin");
      expect(await res.text(), path).toBe("");
    }
  });

  it("answers one with no Origin at all, and one from a foreign origin, without naming them", async () => {
    for (const origin of [undefined, FOREIGN]) {
      const res = await preflight(`${MACHINE}/artifacts`, origin);
      expect(res.status, String(origin)).toBe(204);
      // No allow-origin, so the browser blocks the call it was asking about —
      // but the preflight itself never has to fail closed.
      expect(res.headers.get("Access-Control-Allow-Origin"), String(origin)).toBeNull();
    }
  });

  it("grants nothing on its own — the request after it still needs the token", async () => {
    expect((await preflight(`${MACHINE}/artifacts`, APP_ORIGIN)).status).toBe(204);

    const uncredentialed = await req(`${MACHINE}/artifacts`, { headers: { Origin: APP_ORIGIN } });
    expect(uncredentialed.status).toBe(401);

    const posted = await req(`${MACHINE}/artifacts`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN },
      body: html("preflighted"),
    });
    expect(posted.status).toBe(401);
    expect(await env.DB.prepare("SELECT slug FROM artifacts").first()).toBeNull();

    // And the real call, with the token, works and is annotated for the browser.
    const token = await tokenFor(BOB, { name: "browser" });
    const allowed = await req(
      `${MACHINE}/artifacts`,
      withToken(token, { headers: { Origin: APP_ORIGIN } })
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
  });
});
