import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { initDb, clearR2, req, as, withToken } from "./fixtures";

/**
 * The dashboard's token-management panel (issue #22). It is a thin UI over the
 * existing `/api/tokens` endpoints, so these tests cover two things: the markers
 * the panel renders, and the API assumptions the client script depends on —
 * the exact request shapes it sends and the fields it reads back.
 */

const ADMIN = "admin@test.com"; // matches ADMIN_EMAILS in vitest.config.ts
const BOB = "bob@beta.com";
const CAROL = "carol@beta.com";

beforeEach(async () => {
  await initDb();
  await clearR2();
});

const dash = async (email: string) => await (await req("/admin", as(email))).text();

/** Mint a token the way the panel does. */
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

/** The markup of the token row for `id`, or "" if the row isn't rendered. */
function rowFor(body: string, id: string): string {
  const start = body.indexOf(`data-token="${id}"`);
  if (start === -1) return "";
  const end = body.indexOf('data-token="', start + 12);
  return body.slice(start, end === -1 ? body.indexOf("</section>", start) : end);
}

describe("token panel — creation UI", () => {
  it("renders a token panel with a named, scoped, expiring create form", async () => {
    const body = await dash(BOB);
    expect(body).toContain('data-panel="tokens"');
    expect(body).toContain('id="tokenform"');
    expect(body).toContain('id="tok-name"');
    expect(body).toContain('id="tok-expires"');
    expect(body).toContain("data-token-scopes");
    for (const scope of ["read", "publish", "manage"]) {
      expect(body).toContain(`name="scope" value="${scope}"`);
    }
    // read + publish are the sensible default for a publishing integration;
    // manage (delete/share) is opt-in.
    expect(body).toMatch(/name="scope" value="read" checked/);
    expect(body).toMatch(/name="scope" value="publish" checked/);
    expect(body).toMatch(/name="scope" value="manage"(?! checked)/);
  });

  it("shows the one-time secret UI with a copy control and a store-it-now warning", async () => {
    const body = await dash(BOB);
    expect(body).toContain("data-token-secret");
    expect(body).toContain("data-token-value");
    expect(body).toContain("data-copy-token");
    expect(body).toContain("data-token-another");
    expect(body).toContain("RTFX_API_TOKEN");
    expect(body).toContain("only a hash is stored");
    expect(body).toContain("showToken");
  });

  it("offers owner and admin-token controls to an admin only", async () => {
    const adminBody = await dash(ADMIN);
    expect(adminBody).toContain("data-token-admin-fields");
    expect(adminBody).toContain('id="tok-owner"');
    expect(adminBody).toContain('id="tok-admin"');

    const betaBody = await dash(BOB);
    expect(betaBody).not.toContain("data-token-admin-fields");
    expect(betaBody).not.toContain('id="tok-owner"');
    expect(betaBody).not.toContain('id="tok-admin"');
    expect(betaBody).toContain("data-token-self-only");
  });

  it("gives an empty state when there are no tokens yet", async () => {
    const body = await dash(BOB);
    expect(body).toContain('data-empty="tokens"');
    expect(body).toContain("No API tokens yet");
  });
});

describe("token panel — listing", () => {
  it("lists id, name, scopes, state, last used and expiry — never a secret or hash", async () => {
    const { body: created } = await createToken(BOB, {
      name: "hermes-cloud",
      scopes: ["read", "publish"],
    });
    const body = await dash(BOB);
    const row = rowFor(body, created.id);

    expect(row).toContain('data-token-state="active"');
    expect(row).toContain("hermes-cloud");
    expect(row).toContain(created.id);
    expect(row).toContain("read · publish");
    expect(row).toContain('data-badge="token-state">Active');
    expect(row).toContain("never used");
    expect(row).toContain("no expiry");
    expect(row).toContain(`data-revoke="${created.id}"`);

    // The plaintext exists only in the create response — never in any listing.
    expect(body).not.toContain(created.token);
    const hash = (
      await env.DB.prepare("SELECT token_hash FROM api_tokens WHERE id = ?").bind(created.id).first<any>()
    ).token_hash;
    expect(body).not.toContain(hash);
  });

  it("marks revoked and expired tokens distinctly, and drops the revoke action once revoked", async () => {
    const { body: revoked } = await createToken(BOB, { name: "old" });
    const { body: expired } = await createToken(BOB, { name: "stale", expires_in_days: 1 });
    await req(`/api/tokens/${revoked.id}`, as(BOB, { method: "DELETE" }));
    await env.DB.prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", expired.id)
      .run();

    const body = await dash(BOB);
    const revokedRow = rowFor(body, revoked.id);
    expect(revokedRow).toContain('data-token-state="revoked"');
    expect(revokedRow).toContain('data-badge="token-state">Revoked');
    expect(revokedRow).not.toContain(`data-revoke="${revoked.id}"`);

    const expiredRow = rowFor(body, expired.id);
    expect(expiredRow).toContain('data-token-state="expired"');
    expect(expiredRow).toContain('data-badge="token-state">Expired');
    // An expired token can still be revoked — a tombstone is cheap insurance.
    expect(expiredRow).toContain(`data-revoke="${expired.id}"`);

    // Only the still-usable ones are counted as active in the heading.
    expect(body).toContain("0 active tokens");
    expect(body).toContain('data-token-active-count="0"');
  });

  it("shows a beta user only their own tokens; an admin sees every token with its owner", async () => {
    const { body: bobs } = await createToken(BOB, { name: "bobs" });
    const { body: carols } = await createToken(CAROL, { name: "carols" });

    const bobBody = await dash(BOB);
    expect(bobBody).toContain(`data-token="${bobs.id}"`);
    expect(bobBody).not.toContain(`data-token="${carols.id}"`);
    expect(bobBody).not.toContain(CAROL);

    const adminBody = await dash(ADMIN);
    expect(adminBody).toContain(`data-token="${bobs.id}"`);
    expect(adminBody).toContain(`data-token="${carols.id}"`);
    expect(rowFor(adminBody, carols.id)).toContain(CAROL);
  });

  it("flags an admin token in the list", async () => {
    const { body: adminToken } = await createToken(ADMIN, { name: "ci", is_admin: true });
    expect(rowFor(await dash(ADMIN), adminToken.id)).toContain('data-badge="token-admin"');
  });

  it("revokes through a confirmed DELETE, wired to the API by id", async () => {
    const body = await dash(BOB);
    expect(body).toContain("button[data-revoke]");
    expect(body).toContain("confirm('Revoke");
    expect(body).toContain("'/api/tokens/' + encodeURIComponent(id), { method:'DELETE' }");
  });
});

describe("token panel — access control", () => {
  it("is not rendered for an API-token caller, who may not manage tokens", async () => {
    const { body: created } = await createToken(ADMIN, { name: "ci", is_admin: true });
    const res = await req("/admin", withToken(created.token));
    expect(res.status).toBe(200);
    const body = await res.text();
    // A bearer token is refused by /api/tokens, so the dashboard must not hand
    // it the same data (not even token ids) by another route.
    expect(body).not.toContain('data-panel="tokens"');
    expect(body).not.toContain(`data-token="${created.id}"`);
    // No create form either (the shared client script still ships, but it wires
    // up nothing — there is no panel markup for it to find).
    expect(body).not.toContain('id="tokenform"');
    expect(body).not.toContain('id="tok-name"');
  });
});

describe("token panel — API assumptions the client script relies on", () => {
  it("accepts the exact payload the beta form sends", async () => {
    const { status, body } = await createToken(BOB, {
      name: "hermes-cloud",
      scopes: ["read", "publish"],
      expires_in_days: 90,
    });
    expect(status).toBe(201);
    // Fields the success panel and list rows read back.
    expect(body.token).toMatch(/^rtfx_/);
    expect(body.id).toMatch(/^[0-9a-f]{12}$/);
    expect(body.name).toBe("hermes-cloud");
    expect(body.scopes).toEqual(["read", "publish"]);
    expect(body.owner_email).toBe(BOB);
    expect(body.expires_at).toBeTruthy();
    expect(body.revoked_at).toBeNull();
  });

  it("accepts the owner and admin payloads the admin form sends", async () => {
    const forOwner = await createToken(ADMIN, {
      name: "for-bob",
      scopes: ["read", "publish"],
      expires_in_days: 30,
      owner_email: BOB,
    });
    expect(forOwner.status).toBe(201);
    expect(forOwner.body.owner_email).toBe(BOB);

    const service = await createToken(ADMIN, {
      name: "ci",
      scopes: ["read", "publish", "manage"],
      is_admin: true,
    });
    expect(service.status).toBe(201);
    expect(service.body.is_admin).toBe(true);
    expect(service.body.owner_email).toBeNull();
  });

  it("returns a readable `detail` for the errors the panel surfaces", async () => {
    // A beta user reaching past their own identity (the UI hides these controls,
    // but the API is the thing that enforces it).
    const escalate = await createToken(BOB, { name: "nope", is_admin: true });
    expect(escalate.status).toBe(403);
    expect(escalate.body.detail).toBeTruthy();

    const unnamed = await createToken(BOB, { name: "" });
    expect(unnamed.status).toBe(400);
    expect(unnamed.body.detail).toBeTruthy();

    const inert = await createToken(ADMIN, { name: "inert", scopes: ["read"] });
    expect(inert.status).toBe(400);
    expect(inert.body.detail).toMatch(/owner_email/);
  });

  it("revoking is a 200 with the id, and repeats stay safe", async () => {
    const { body } = await createToken(BOB, { name: "t" });
    const first = await req(`/api/tokens/${body.id}`, as(BOB, { method: "DELETE" }));
    expect(first.status).toBe(200);
    expect((await first.json<any>()).revoked).toBe(body.id);
    expect((await req(`/api/tokens/${body.id}`, as(BOB, { method: "DELETE" }))).status).toBe(200);
  });
});

describe("token panel — existing flows are untouched", () => {
  it("keeps the publish panel, artifact list and team panel intact", async () => {
    const body = await dash(ADMIN);
    expect(body).toContain('id="up"');
    expect(body).toContain("data-dropzone");
    expect(body).toContain('data-panel="users"');
  });

  it("a bearer token still publishes and reads normally", async () => {
    const { body: created } = await createToken(BOB, { name: "cli" });
    expect((await req("/api/artifacts", withToken(created.token))).status).toBe(200);
    // ...and still cannot reach token management itself.
    expect((await req("/api/tokens", withToken(created.token))).status).toBe(403);
  });
});
