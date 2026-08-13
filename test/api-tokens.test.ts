import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { strToU8 } from "fflate";
import { initDb, clearR2, req, as, withToken, htmlForm } from "./fixtures";

/**
 * API tokens: bearer credentials for server-to-server publishing (Hermes Cloud,
 * CI). A token is never more privileged than the person it was issued for — it
 * inherits their ownership (issue #7) and may only be narrower, via scopes.
 */

const ADMIN = "admin@test.com"; // matches ADMIN_EMAILS in vitest.config.ts
const BOB = "bob@beta.com";
const CAROL = "carol@beta.com";

beforeEach(async () => {
  await initDb();
  await clearR2();
});

/** Create a token as a signed-in person; returns { status, body }. */
async function createToken(email: string, body: Record<string, unknown>) {
  const res = await req(
    "/api/tokens",
    as(email, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, body: await res.json<any>() };
}

/** Mint a token and return just the secret (asserting it worked). */
async function tokenFor(email: string, body: Record<string, unknown> = { name: "t" }) {
  const { status, body: data } = await createToken(email, body);
  expect(status).toBe(201);
  return data.token as string;
}

/** Publish with a bearer token. */
const publishWithToken = (token: string, slug: string, title = slug) =>
  req(
    "/api/artifacts",
    withToken(token, {
      method: "POST",
      body: htmlForm({ title, slug }, "x.html", strToU8(`<h1>${slug}</h1>`)),
    })
  );

/** Publish as a signed-in person (the pre-existing Access flow). */
const publishAs = (email: string, slug: string) =>
  req(
    "/api/artifacts",
    as(email, { method: "POST", body: htmlForm({ title: slug, slug }, "x.html", strToU8("<h1>hi</h1>")) })
  );

describe("token issuance", () => {
  it("returns the plaintext exactly once and stores only a hash", async () => {
    const { status, body } = await createToken(BOB, { name: "hermes" });
    expect(status).toBe(201);
    expect(body.token).toMatch(/^rtfx_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(body.owner_email).toBe(BOB);
    expect(body.scopes).toEqual(["read", "publish"]);

    // Stored row holds a hash, never the token.
    const row = await env.DB.prepare("SELECT * FROM api_tokens WHERE id = ?").bind(body.id).first<any>();
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(body.token);

    // Listing it again never re-reveals the secret.
    const list = await (await req("/api/tokens", as(BOB))).json<any>();
    expect(list.tokens).toHaveLength(1);
    expect(list.tokens[0].token).toBeUndefined();
    expect(list.tokens[0].token_hash).toBeUndefined();
  });

  it("validates name, scopes, and expiry", async () => {
    expect((await createToken(BOB, {})).status).toBe(400);
    expect((await createToken(BOB, { name: "x".repeat(81) })).status).toBe(400);
    expect((await createToken(BOB, { name: "t", scopes: ["root"] })).status).toBe(400);
    expect((await createToken(BOB, { name: "t", scopes: [] })).status).toBe(400);
    expect((await createToken(BOB, { name: "t", expires_in_days: 0 })).status).toBe(400);
    expect((await createToken(BOB, { name: "t", expires_in_days: 999 })).status).toBe(400);
    expect((await createToken(BOB, { name: "t", expires_in_days: 30 })).status).toBe(201);
  });

  it("a beta user can only issue tokens that act as themselves", async () => {
    expect((await createToken(BOB, { name: "t", is_admin: true })).status).toBe(403);
    expect((await createToken(BOB, { name: "t", owner_email: CAROL })).status).toBe(403);
    expect((await createToken(BOB, { name: "t", owner_email: BOB })).status).toBe(201);
  });

  it("an admin can issue tokens for another user, or an admin token", async () => {
    const forBob = await createToken(ADMIN, { name: "t", owner_email: BOB });
    expect(forBob.status).toBe(201);
    expect(forBob.body.owner_email).toBe(BOB);
    expect(forBob.body.is_admin).toBe(false);

    const adminToken = await createToken(ADMIN, { name: "ci", is_admin: true });
    expect(adminToken.status).toBe(201);
    expect(adminToken.body.is_admin).toBe(true);
  });

  it("refuses a token that could own nothing and manage nothing", async () => {
    const res = await createToken(ADMIN, { name: "inert" });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/owner_email/);
  });
});

describe("token authentication", () => {
  it("a valid token publishes, and the artifact belongs to the token's owner", async () => {
    const token = await tokenFor(BOB, { name: "hermes" });
    const res = await publishWithToken(token, "from-hermes");
    expect(res.status).toBe(200);
    expect((await res.json<any>()).version).toBe(1);

    const row = await env.DB.prepare("SELECT * FROM artifacts WHERE slug = 'from-hermes'").first<any>();
    expect(row.owner_email).toBe(BOB);
    // Bob sees it in his dashboard listing; Carol does not.
    expect((await (await req("/api/artifacts", as(BOB))).json<any>()).artifacts).toHaveLength(1);
    expect((await (await req("/api/artifacts", as(CAROL))).json<any>()).artifacts).toEqual([]);
  });

  it("an unknown token is 401 with a Bearer challenge — never a downgrade to the dev/Access identity", async () => {
    const res = await req("/api/artifacts", withToken("rtfx_deadbeefdead_notarealtokenatall"));
    expect(res.status).toBe(401);
    expect((await res.json<any>()).error).toBe("invalid_token");
    expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
  });

  it("a revoked token stops working immediately", async () => {
    const { body } = await createToken(BOB, { name: "short-lived" });
    expect((await publishWithToken(body.token, "before-revoke")).status).toBe(200);

    const revoke = await req(`/api/tokens/${body.id}`, as(BOB, { method: "DELETE" }));
    expect(revoke.status).toBe(200);
    expect((await publishWithToken(body.token, "after-revoke")).status).toBe(401);
  });

  it("an expired token stops working", async () => {
    const { body } = await createToken(BOB, { name: "expiring", expires_in_days: 1 });
    await env.DB.prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", body.id)
      .run();
    expect((await publishWithToken(body.token, "too-late")).status).toBe(401);
  });

  it("records last_used_at", async () => {
    const { body } = await createToken(BOB, { name: "tracked" });
    expect(
      (await env.DB.prepare("SELECT last_used_at FROM api_tokens WHERE id = ?").bind(body.id).first<any>())
        .last_used_at
    ).toBeNull();
    await req("/api/artifacts", withToken(body.token));
    const after = await env.DB.prepare("SELECT last_used_at FROM api_tokens WHERE id = ?")
      .bind(body.id)
      .first<any>();
    expect(after.last_used_at).toBeTruthy();
  });

  it("ignores non-bearer Authorization schemes (no bearer presented → normal auth)", async () => {
    const res = await req("/api/artifacts", {
      headers: { Authorization: "Basic dXNlcjpwYXNz", "X-Dev-Email": ADMIN },
    });
    expect(res.status).toBe(200);
  });

  it("a token whose owner is removed from the beta is revoked with them", async () => {
    // Access isn't configured in tests, so removeUser fails before revocation —
    // drive the same path the endpoint uses via a direct grant/removal instead.
    const { body } = await createToken(BOB, { name: "doomed" });
    const { revokeTokensForEmail } = await import("../src/tokens");
    await revokeTokensForEmail(env, BOB, new Date().toISOString());
    expect((await publishWithToken(body.token, "orphaned")).status).toBe(401);
  });
});

describe("token scopes", () => {
  it("a read-only token can list but not publish, roll back, grant, or delete", async () => {
    await publishAs(BOB, "bobs-page");
    await publishAs(BOB, "bobs-page"); // v2, so rollback has somewhere to go
    const token = await tokenFor(BOB, { name: "reader", scopes: ["read"] });

    expect((await req("/api/artifacts", withToken(token))).status).toBe(200);
    expect((await req("/api/artifacts/bobs-page/versions", withToken(token))).status).toBe(200);
    expect((await req("/api/artifacts/bobs-page/views", withToken(token))).status).toBe(200);

    const publish = await publishWithToken(token, "bobs-page");
    expect(publish.status).toBe(403);
    expect((await publish.json<any>()).error).toBe("insufficient_scope");

    const rollback = await req(
      "/api/artifacts/bobs-page/current",
      withToken(token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1 }),
      })
    );
    expect(rollback.status).toBe(403);
    expect((await req("/api/artifacts/bobs-page", withToken(token, { method: "DELETE" }))).status).toBe(403);
    const grant = await req(
      "/api/artifacts/bobs-page/access",
      withToken(token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "everyone", emails: [] }),
      })
    );
    expect(grant.status).toBe(403);
  });

  it("a publish token can publish and roll back but not delete or grant", async () => {
    const token = await tokenFor(BOB, { name: "publisher", scopes: ["publish"] });
    expect((await publishWithToken(token, "ci-page")).status).toBe(200);
    expect((await publishWithToken(token, "ci-page")).status).toBe(200); // v2

    const rollback = await req(
      "/api/artifacts/ci-page/current",
      withToken(token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1 }),
      })
    );
    expect(rollback.status).toBe(200);
    expect((await rollback.json<any>()).current).toBe(1);

    // read is a separate scope
    expect((await req("/api/artifacts", withToken(token))).status).toBe(403);
    expect((await req("/api/artifacts/ci-page", withToken(token, { method: "DELETE" }))).status).toBe(403);
  });

  it("a manage token can grant and delete", async () => {
    await publishAs(BOB, "managed");
    const token = await tokenFor(BOB, { name: "manager", scopes: ["read", "manage"] });
    const grant = await req(
      "/api/artifacts/managed/access",
      withToken(token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "restricted", emails: [CAROL] }),
      })
    );
    expect(grant.status).toBe(200);
    expect((await grant.json<any>()).emails).toEqual([CAROL]);
    expect((await req("/api/artifacts/managed", withToken(token, { method: "DELETE" }))).status).toBe(200);
  });
});

describe("token ownership (scope never widens rights)", () => {
  beforeEach(async () => {
    await publishAs(BOB, "bobs-secret");
    await publishAs(BOB, "bobs-secret"); // v2
  });

  it("a full-scope token cannot reach another user's artifact", async () => {
    const carols = await tokenFor(CAROL, { name: "carol", scopes: ["read", "publish", "manage"] });
    expect((await req("/api/artifacts/bobs-secret/versions", withToken(carols))).status).toBe(404);
    expect((await req("/api/artifacts/bobs-secret/views", withToken(carols))).status).toBe(404);
    expect((await req("/api/artifacts/bobs-secret", withToken(carols, { method: "DELETE" }))).status).toBe(404);
    // ...and cannot hijack the slug by publishing to it
    expect((await publishWithToken(carols, "bobs-secret")).status).toBe(409);
    expect((await (await req("/api/artifacts", withToken(carols))).json<any>()).artifacts).toEqual([]);
  });

  it("the owner's token reaches only their own artifacts", async () => {
    const bobs = await tokenFor(BOB, { name: "bob", scopes: ["read", "publish", "manage"] });
    expect((await req("/api/artifacts/bobs-secret/versions", withToken(bobs))).status).toBe(200);
    expect((await (await req("/api/artifacts", withToken(bobs))).json<any>()).artifacts.map((a: any) => a.slug)).toEqual([
      "bobs-secret",
    ]);
  });

  it("an admin token manages everyone's artifacts", async () => {
    const admin = await tokenFor(ADMIN, { name: "ci", is_admin: true, scopes: ["read", "publish", "manage"] });
    expect((await req("/api/artifacts/bobs-secret/versions", withToken(admin))).status).toBe(200);
    expect((await (await req("/api/artifacts", withToken(admin))).json<any>()).artifacts).toHaveLength(1);
    // Publishing a new version as admin does not steal ownership.
    expect((await publishWithToken(admin, "bobs-secret")).status).toBe(200);
    const row = await env.DB.prepare("SELECT owner_email FROM artifacts WHERE slug='bobs-secret'").first<any>();
    expect(row.owner_email).toBe(BOB);
  });

  it("an admin token publishing a new artifact leaves it unowned (admin-only)", async () => {
    const admin = await tokenFor(ADMIN, { name: "ci", is_admin: true });
    expect((await publishWithToken(admin, "machine-made")).status).toBe(200);
    const row = await env.DB.prepare("SELECT owner_email FROM artifacts WHERE slug='machine-made'").first<any>();
    expect(row.owner_email).toBeNull();
    expect((await req("/api/artifacts/machine-made/versions", as(BOB))).status).toBe(404);
  });
});

describe("tokens cannot escalate", () => {
  it("no token — not even an admin one — can mint or list tokens", async () => {
    const admin = await tokenFor(ADMIN, { name: "ci", is_admin: true, scopes: ["read", "publish", "manage"] });
    const list = await req("/api/tokens", withToken(admin));
    expect(list.status).toBe(403);
    expect((await list.json<any>()).detail).toMatch(/API tokens cannot/);

    const create = await req(
      "/api/tokens",
      withToken(admin, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "child", is_admin: true }),
      })
    );
    expect(create.status).toBe(403);
  });

  it("no token can touch the sign-in allow-list", async () => {
    const admin = await tokenFor(ADMIN, { name: "ci", is_admin: true, scopes: ["read", "publish", "manage"] });
    expect((await req("/api/users", withToken(admin))).status).toBe(403);
    const add = await req(
      "/api/users",
      withToken(admin, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "eve@x.com" }),
      })
    );
    expect(add.status).toBe(403);
    expect((await req("/api/users/eve@x.com", withToken(admin, { method: "DELETE" }))).status).toBe(403);
  });

  it("a beta user cannot see or revoke another user's token", async () => {
    const { body: carols } = await createToken(CAROL, { name: "carols" });
    const bobsList = await (await req("/api/tokens", as(BOB))).json<any>();
    expect(bobsList.tokens).toEqual([]);
    expect((await req(`/api/tokens/${carols.id}`, as(BOB, { method: "DELETE" }))).status).toBe(404);
    // still usable by Carol
    expect((await publishWithToken(carols.token, "carols-page")).status).toBe(200);
  });

  it("an admin sees and can revoke every token", async () => {
    const { body: carols } = await createToken(CAROL, { name: "carols" });
    const all = await (await req("/api/tokens", as(ADMIN))).json<any>();
    expect(all.tokens.map((t: any) => t.id)).toContain(carols.id);
    expect((await req(`/api/tokens/${carols.id}`, as(ADMIN, { method: "DELETE" }))).status).toBe(200);
    expect((await publishWithToken(carols.token, "nope")).status).toBe(401);
  });

  it("revoking twice is idempotent, and unknown ids are 404", async () => {
    const { body } = await createToken(BOB, { name: "t" });
    expect((await (await req(`/api/tokens/${body.id}`, as(BOB, { method: "DELETE" }))).json<any>()).already_revoked).toBe(false);
    expect((await (await req(`/api/tokens/${body.id}`, as(BOB, { method: "DELETE" }))).json<any>()).already_revoked).toBe(true);
    expect((await req("/api/tokens/doesnotexist", as(ADMIN, { method: "DELETE" }))).status).toBe(404);
  });
});

describe("backward compatibility", () => {
  it("the Access/dev flow is unchanged when no bearer token is sent", async () => {
    expect((await publishAs(BOB, "classic")).status).toBe(200);
    expect((await req("/api/artifacts", as(BOB))).status).toBe(200);
    expect((await req("/api/artifacts/classic/versions", as(BOB))).status).toBe(200);
    expect((await req("/api/users", as(BOB))).status).toBe(403); // still admin-only
    expect((await req("/api/users", as(ADMIN))).status).toBe(200); // local directory, no Access needed
  });

  it("an Access-authenticated caller holds every scope (scopes only narrow tokens)", async () => {
    await publishAs(BOB, "scopeless");
    expect((await req("/api/artifacts/scopeless", as(BOB, { method: "DELETE" }))).status).toBe(200);
  });

  it("serving artifacts still works, and a bad token never grants a view", async () => {
    await publishAs(BOB, "served");
    expect((await req("/served/", as(BOB))).status).toBe(200);
    expect((await req("/served/", withToken("rtfx_deadbeefdead_nope"))).status).toBe(404);
    const token = await tokenFor(BOB, { name: "viewer", scopes: ["read"] });
    expect((await req("/served/", withToken(token))).status).toBe(200);
  });

  it("/whoami reports the token's owner", async () => {
    const token = await tokenFor(BOB, { name: "who" });
    expect((await (await req("/whoami", withToken(token))).json<any>()).email).toBe(BOB);
  });
});
