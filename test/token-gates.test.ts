import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createApiToken, type Scope } from "../src/tokens";
import { memberRole } from "../src/accounts";
import { initDb, clearR2, req, as, withToken } from "./fixtures";

/**
 * Routes outside the machine API that sit behind `requireUser` — which accepts
 * a bearer token — must still apply the token rules the machine API does: a
 * token can never change who is in a workspace, and anything else that
 * changes a workspace or an artifact needs the `manage` scope.
 */

const PLATFORM_ADMIN = "admin@test.com"; // per vitest.config.ts
const ALICE = "alice@test.com";
const MALLORY = "mallory@evil.example";

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function teamOwnedByAlice(): Promise<string> {
  const res = await req("/api/accounts", as(PLATFORM_ADMIN, json("POST", { name: "Acme", owner_email: ALICE })));
  expect(res.status).toBe(201);
  const { id } = await res.json<{ id: string }>();
  // Plenty of seats, so a refusal below is the token rule and not the seat cap.
  await env.DB.prepare("UPDATE accounts SET plan = 'team' WHERE id = ?").bind(id).run();
  return id;
}

async function tokenFor(accountId: string, scopes: Scope[]): Promise<string> {
  const { token } = await createApiToken(env as any, {
    name: `ci-${scopes.join("-")}`,
    ownerEmail: ALICE,
    accountId,
    isAdmin: false,
    scopes,
    createdBy: ALICE,
    expiresAt: null,
    now: new Date().toISOString(),
  });
  return token;
}

beforeEach(async () => {
  await initDb();
  await clearR2();
});

describe("workspace member routes refuse API tokens for changes", () => {
  for (const scopes of [["read"], ["read", "publish", "manage"]] as Scope[][]) {
    it(`a ${scopes.join("+")} token cannot add, change or remove members`, async () => {
      const id = await teamOwnedByAlice();
      const token = await tokenFor(id, scopes);

      const add = await req(
        `/api/workspace/${id}/members`,
        withToken(token, json("POST", { email: MALLORY, role: "owner" }))
      );
      expect(add.status).toBe(403);
      expect((await add.json<{ detail: string }>()).detail).toMatch(/API tokens/);
      expect(await memberRole(env as any, id, MALLORY)).toBeNull();

      const promote = await req(
        `/api/workspace/${id}/members/${encodeURIComponent(ALICE)}`,
        withToken(token, json("PUT", { role: "viewer" }))
      );
      expect(promote.status).toBe(403);
      expect((await promote.json<{ detail: string }>()).detail).toMatch(/API tokens/);

      const remove = await req(
        `/api/workspace/${id}/members/${encodeURIComponent(ALICE)}`,
        withToken(token, json("DELETE"))
      );
      expect(remove.status).toBe(403);
      expect(await memberRole(env as any, id, ALICE)).toBe("owner");
    });
  }

  it("still lets a token read the member list", async () => {
    const id = await teamOwnedByAlice();
    const res = await req(`/api/workspace/${id}/members`, withToken(await tokenFor(id, ["read"])));
    expect(res.status).toBe(200);
  });

  it("still lets the signed-in owner add a member", async () => {
    const id = await teamOwnedByAlice();
    const res = await req(`/api/workspace/${id}/members`, as(ALICE, json("POST", { email: "bob@test.com", role: "member" })));
    expect(res.status).toBeLessThan(300);
  });
});

describe("workspace address form refuses API tokens", () => {
  it("a token cannot release or rename the address through the portal form", async () => {
    const id = await teamOwnedByAlice();
    const body = new FormData();
    body.set("release", "1");
    const res = await req("/admin/workspace/address", withToken(await tokenFor(id, ["read"]), { method: "POST", body }));
    expect(res.status).toBe(403);
  });
});

describe("read-receipts toggle needs the manage scope", () => {
  it("a read-only token cannot change it", async () => {
    const id = await teamOwnedByAlice();
    const form = new FormData();
    form.set("slug", "report");
    form.set("file", new File(["<h1>x</h1>"], "index.html", { type: "text/html" }));
    form.set("account_id", id);
    await req("/api/artifacts", { method: "POST", body: form, ...as(ALICE) });

    const res = await req(
      "/api/artifacts/report/receipts",
      withToken(await tokenFor(id, ["read"]), json("PUT", { enabled: false }))
    );
    expect(res.status).toBe(403);
  });
});

describe("workspace viewers cannot create artifacts", () => {
  it("refuses a new slug from a viewer acting in the workspace, and allows a member", async () => {
    const id = await teamOwnedByAlice();
    const { upsertMember } = await import("../src/accounts");
    const now = new Date().toISOString();
    await upsertMember(env as any, { accountId: id, email: "vic@test.com", role: "viewer", now, invitedBy: ALICE });
    await upsertMember(env as any, { accountId: id, email: "meg@test.com", role: "member", now, invitedBy: ALICE });

    const publishAs = async (email: string, slug: string) => {
      const { token } = await createApiToken(env as any, {
        name: "ci",
        ownerEmail: email,
        accountId: id,
        isAdmin: false,
        scopes: ["publish"],
        createdBy: email,
        expiresAt: null,
        now,
      });
      const form = new FormData();
      form.set("slug", slug);
      form.set("title", slug);
      form.set("file", new File(["<h1>x</h1>"], "index.html", { type: "text/html" }));
      return req("/api/artifacts", withToken(token, { method: "POST", body: form }));
    };

    const viewer = await publishAs("vic@test.com", "viewer-spam");
    expect(viewer.status).toBe(403);
    expect(await env.DB.prepare("SELECT slug FROM artifacts WHERE slug = 'viewer-spam'").first()).toBeNull();

    const member = await publishAs("meg@test.com", "member-doc");
    expect(member.status).toBe(200);
  });
});

describe("a publish never lands on an artifact that changed hands mid-upload", () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({
      slug: "resume",
      title: "Victim's resume",
      description: null,
      type: "html",
      entry: "index.html",
      file_count: 1,
      size_bytes: 10,
      created_by: "victim@x.com",
      created_at: "2026-11-01T00:00:00.000Z",
      updated_at: "2026-11-01T00:00:00.000Z",
      visibility: "restricted",
      current_version: 1,
      owner_email: "victim@x.com",
      account_id: null,
      ...over,
    }) as any;

  it("a 'new artifact' publish does not overwrite a row created after it started", async () => {
    const { upsertArtifact, getArtifact } = await import("../src/db");
    expect(await upsertArtifact(env as any, row())).toBe(true);
    const attacker = row({
      title: "attacker",
      created_at: "2026-11-02T00:00:00.000Z",
      current_version: 2,
      owner_email: MALLORY,
    });
    expect(await upsertArtifact(env as any, attacker, true)).toBe(false);
    const after = await getArtifact(env as any, "resume");
    expect(after?.title).toBe("Victim's resume");
    expect(after?.current_version).toBe(1);
  });

  it("a republish does not land on a slug that was deleted and re-created", async () => {
    const { upsertArtifact, getArtifact } = await import("../src/db");
    await upsertArtifact(env as any, row());
    // The publisher resolved an older artifact under this slug (different created_at).
    const stale = row({ title: "stale", created_at: "2026-10-01T00:00:00.000Z", current_version: 2 });
    expect(await upsertArtifact(env as any, stale, false)).toBe(false);
    expect((await getArtifact(env as any, "resume"))?.current_version).toBe(1);

    // A genuine republish of the same artifact still goes through.
    expect(await upsertArtifact(env as any, row({ current_version: 2, title: "v2" }), false)).toBe(true);
    expect((await getArtifact(env as any, "resume"))?.current_version).toBe(2);
  });
});

describe("plan limits hold under concurrent publishes", () => {
  it("parallel brand-new publishes cannot push a free workspace past its artifact cap", async () => {
    const publish = (slug: string) => {
      const form = new FormData();
      form.set("slug", slug);
      form.set("title", slug);
      form.set("file", new File(["<h1>x</h1>"], "index.html", { type: "text/html" }));
      return req("/api/artifacts", as("carol@test.com", { method: "POST", body: form }));
    };
    // Nine of ten used, then five at once.
    for (let i = 0; i < 9; i++) expect((await publish(`seed-${i}`)).status).toBe(200);
    await Promise.all([0, 1, 2, 3, 4].map((i) => publish(`burst-${i}`)));

    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM artifacts WHERE owner_email = 'carol@test.com'"
    ).all<{ n: number }>();
    expect(results[0].n).toBeLessThanOrEqual(10);
  });
});
