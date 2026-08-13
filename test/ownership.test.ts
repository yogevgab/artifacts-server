import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { strToU8 } from "fflate";
import app from "../src/index";
import { initDb, clearR2, req, as, htmlForm } from "./fixtures";

/**
 * Invite-only beta ownership model: an artifact belongs to the signed-in person
 * who published it. Admins manage everything; a beta user manages only their
 * own and must not be able to see, probe, or touch anyone else's.
 */

const ADMIN = "admin@test.com"; // matches ADMIN_EMAILS in vitest.config.ts
const BOB = "bob@beta.com";
const CAROL = "carol@beta.com";

beforeEach(async () => {
  await initDb();
  await clearR2();
});

/** Publish as `email`; returns the parsed JSON body. */
async function publish(email: string, slug: string, title = slug, html = `<h1>${slug}</h1>`) {
  const res = await req(
    "/api/artifacts",
    as(email, { method: "POST", body: htmlForm({ title, slug }, "x.html", strToU8(html)) })
  );
  return { status: res.status, body: await res.json<any>() };
}

const setAccess = (email: string, slug: string, visibility: string, emails: string[]) =>
  req(
    `/api/artifacts/${slug}/access`,
    as(email, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility, emails }),
    })
  );

/** Every management operation on one artifact, keyed by name. */
const operations: Record<string, (email: string, slug: string) => Promise<Response>> = {
  "read versions": (email, slug) => req(`/api/artifacts/${slug}/versions`, as(email)),
  "read analytics": (email, slug) => req(`/api/artifacts/${slug}/views`, as(email)),
  "read access": (email, slug) => req(`/api/artifacts/${slug}/access`, as(email)),
  "edit access": (email, slug) => setAccess(email, slug, "everyone", []),
  "roll back": (email, slug) =>
    req(
      `/api/artifacts/${slug}/current`,
      as(email, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1 }),
      })
    ),
  delete: (email, slug) => req(`/api/artifacts/${slug}`, as(email, { method: "DELETE" })),
};

describe("ownership: publishing assigns an owner", () => {
  it("records the publisher as the owner", async () => {
    await publish(BOB, "bobs-page");
    const row = await env.DB.prepare("SELECT owner_email FROM artifacts WHERE slug = 'bobs-page'").first<any>();
    expect(row.owner_email).toBe(BOB);
  });

  it("keeps the original owner when the owner publishes a new version", async () => {
    await publish(BOB, "keeper");
    expect((await publish(BOB, "keeper")).body.version).toBe(2);
    const row = await env.DB.prepare("SELECT owner_email FROM artifacts WHERE slug = 'keeper'").first<any>();
    expect(row.owner_email).toBe(BOB);
  });

  it("does not transfer ownership when an admin publishes a new version", async () => {
    await publish(BOB, "adopted");
    expect((await publish(ADMIN, "adopted")).status).toBe(200);
    const row = await env.DB.prepare("SELECT owner_email FROM artifacts WHERE slug = 'adopted'").first<any>();
    expect(row.owner_email).toBe(BOB);
  });

  it("matches owners case-insensitively", async () => {
    await publish("Bob@Beta.com", "mixed-case");
    expect((await req("/api/artifacts/mixed-case/versions", as("BOB@BETA.COM"))).status).toBe(200);
  });
});

describe("ownership: listing is scoped", () => {
  beforeEach(async () => {
    await publish(BOB, "bob-one");
    await publish(CAROL, "carol-one");
  });

  it("a beta user's API list contains only their own artifacts", async () => {
    const mine = await (await req("/api/artifacts", as(BOB))).json<any>();
    expect(mine.artifacts.map((a: any) => a.slug)).toEqual(["bob-one"]);
  });

  it("an admin's API list contains everyone's artifacts", async () => {
    const all = await (await req("/api/artifacts", as(ADMIN))).json<any>();
    expect(all.artifacts.map((a: any) => a.slug).sort()).toEqual(["bob-one", "carol-one"]);
  });

  it("a beta user's dashboard renders only their own artifacts", async () => {
    const body = await (await req("/admin", as(BOB))).text();
    expect(body).toContain('data-artifact="bob-one"');
    expect(body).not.toContain('data-artifact="carol-one"');
    expect(body).not.toContain("carol-one");
  });

  it("an admin's dashboard renders everyone's artifacts, labelled by owner", async () => {
    const body = await (await req("/admin", as(ADMIN))).text();
    expect(body).toContain('data-artifact="bob-one"');
    expect(body).toContain('data-artifact="carol-one"');
    expect(body).toContain(`data-badge="owner">${CAROL}`);
  });

  it("only admins get the team panel; a beta user gets no user management", async () => {
    expect(await (await req("/admin", as(ADMIN))).text()).toContain('data-panel="users"');
    const betaBody = await (await req("/admin", as(BOB))).text();
    expect(betaBody).not.toContain('data-panel="users"');
    expect(betaBody).toContain("Your artifacts");
  });

  it("a beta user's gallery excludes other people's private artifacts", async () => {
    const body = await (await req("/gallery", as(BOB))).text();
    expect(body).toContain('data-artifact="bob-one"');
    expect(body).not.toContain('data-artifact="carol-one"');
  });
});

describe("ownership: another user's artifact is untouchable", () => {
  beforeEach(async () => {
    await publish(BOB, "bobs-secret");
    await publish(BOB, "bobs-secret"); // v2, so rollback has somewhere to go
  });

  for (const [name, run] of Object.entries(operations)) {
    it(`a beta user cannot ${name} on another user's artifact (404, existence hidden)`, async () => {
      const res = await run(CAROL, "bobs-secret");
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error).toBe("not_found");
    });

    it(`the owner can ${name} on their own artifact`, async () => {
      expect((await run(BOB, "bobs-secret")).status).toBe(200);
    });

    it(`an admin can ${name} on someone else's artifact`, async () => {
      expect((await run(ADMIN, "bobs-secret")).status).toBe(200);
    });
  }

  it("a failed delete attempt leaves the artifact and its files intact", async () => {
    expect((await req("/api/artifacts/bobs-secret", as(CAROL, { method: "DELETE" }))).status).toBe(404);
    expect((await req("/api/artifacts/bobs-secret/versions", as(BOB))).status).toBe(200);
    expect((await req("/bobs-secret/", as(BOB))).status).toBe(200);
  });

  it("a beta user cannot hijack another user's slug by publishing to it", async () => {
    const res = await publish(CAROL, "bobs-secret", "Hijacked", "<h1>hijacked</h1>");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slug_taken");
    // the artifact still serves Bob's content at the version he published
    const served = await req("/bobs-secret/", as(BOB));
    expect(await served.text()).toContain("bobs-secret");
    const row = await env.DB.prepare("SELECT owner_email FROM artifacts WHERE slug = 'bobs-secret'").first<any>();
    expect(row.owner_email).toBe(BOB);
  });

  it("a beta user cannot preview another user's versions", async () => {
    expect((await req("/v/bobs-secret/1/", as(CAROL))).status).toBe(404);
    expect((await req("/v/bobs-secret/1/", as(BOB))).status).toBe(200);
    expect((await req("/v/bobs-secret/1/", as(ADMIN))).status).toBe(200);
  });

  it("a beta user cannot open another user's restricted artifact", async () => {
    expect((await req("/bobs-secret/", as(CAROL))).status).toBe(404);
  });
});

describe("ownership: viewing vs managing", () => {
  it("the owner can open their own restricted artifact without granting themselves", async () => {
    await publish(BOB, "self-view");
    const acc = await (await req("/api/artifacts/self-view/access", as(BOB))).json<any>();
    expect(acc.visibility).toBe("restricted");
    expect(acc.emails).toEqual([]);
    expect((await req("/self-view/", as(BOB))).status).toBe(200);
  });

  it("being granted view access never confers management rights", async () => {
    await publish(BOB, "shared-out");
    expect((await setAccess(BOB, "shared-out", "restricted", [CAROL])).status).toBe(200);
    // Carol can read it...
    expect((await req("/shared-out/", as(CAROL))).status).toBe(200);
    expect(await (await req("/gallery", as(CAROL))).text()).toContain('data-artifact="shared-out"');
    // ...but it is not hers to manage, and it is not on her dashboard.
    expect((await req("/api/artifacts/shared-out/access", as(CAROL))).status).toBe(404);
    expect((await req("/api/artifacts/shared-out", as(CAROL, { method: "DELETE" }))).status).toBe(404);
    expect((await (await req("/api/artifacts", as(CAROL))).json<any>()).artifacts).toEqual([]);
    expect(await (await req("/admin", as(CAROL))).text()).not.toContain('data-artifact="shared-out"');
  });

  it("an 'everyone' artifact is viewable by all but managed only by its owner", async () => {
    await publish(BOB, "open-house");
    await setAccess(BOB, "open-house", "everyone", []);
    expect((await req("/open-house/", as(CAROL))).status).toBe(200);
    expect((await req("/api/artifacts/open-house/views", as(CAROL))).status).toBe(404);
  });
});

describe("ownership: unowned (legacy / service-token) artifacts stay admin-only", () => {
  beforeEach(async () => {
    await publish(ADMIN, "legacy");
    // Simulate a row published before this model existed, or by a service token.
    await env.DB.prepare("UPDATE artifacts SET owner_email = NULL WHERE slug = 'legacy'").run();
  });

  it("no beta user can manage an artifact with no owner", async () => {
    for (const run of Object.values(operations)) {
      expect((await run(BOB, "legacy")).status).toBe(404);
    }
  });

  it("an admin still manages it", async () => {
    expect((await req("/api/artifacts/legacy/versions", as(ADMIN))).status).toBe(200);
  });

  it("an empty owner_email never matches an empty caller email", async () => {
    await env.DB.prepare("UPDATE artifacts SET owner_email = '' WHERE slug = 'legacy'").run();
    expect((await req("/api/artifacts/legacy/versions", as(BOB))).status).toBe(404);
  });
});

describe("ownership: user management stays admin-only", () => {
  it("a beta user cannot read or change the sign-in allow-list", async () => {
    expect((await req("/api/users", as(BOB))).status).toBe(403);
    const add = await req(
      "/api/users",
      as(BOB, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "eve@x.com" }),
      })
    );
    expect(add.status).toBe(403);
    expect((await req("/api/users/eve@x.com", as(BOB, { method: "DELETE" }))).status).toBe(403);
  });

  it("an admin reaches the endpoint and gets the local directory", async () => {
    const res = await req("/api/users", as(ADMIN));
    expect(res.status).toBe(200);
    // Access isn't configured in tests, so the directory is D1-only — which is
    // exactly the state the panel has to stay usable in.
    expect((await res.json<any>()).allowlist.configured).toBe(false);
  });
});

describe("ownership: granting does not widen the beta invite list", () => {
  // Cloudflare Access "configured" so the allow-list sync path is live.
  const cfEnv = {
    ...env,
    CF_API_TOKEN: "test-token",
    CF_ACCOUNT_ID: "acct",
    ACCESS_VIEWER_APP_ID: "app",
    ACCESS_VIEWER_POLICY_ID: "policy",
  } as any;
  const putAccess = async (email: string, slug: string, emails: string[]): Promise<Response> =>
    app.request(
      `/api/artifacts/${slug}/access`,
      as(email, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "restricted", emails }),
      }),
      cfEnv
    );

  const spyOnFetch = () => vi.spyOn(globalThis, "fetch");
  let fetchSpy: ReturnType<typeof spyOnFetch>;
  beforeEach(() => {
    fetchSpy = spyOnFetch().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { decision: "allow", include: [] } }), {
        headers: { "Content-Type": "application/json" },
      })
    );
  });
  afterEach(() => fetchSpy.mockRestore());

  it("a beta user's grant is saved but never adds anyone to Cloudflare Access", async () => {
    await publish(BOB, "invite-test");
    const res = await putAccess(BOB, "invite-test", ["stranger@x.com"]);
    expect(res.status).toBe(200);
    const data = await res.json<any>();
    expect(data.emails).toEqual(["stranger@x.com"]);
    expect(data.allowlistWarning).toMatch(/admin/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an admin's grant does sync the allow-list", async () => {
    await publish(ADMIN, "admin-invite");
    const res = await putAccess(ADMIN, "admin-invite", ["stranger@x.com"]);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
    expect(String(fetchSpy.mock.calls[0][0])).toContain("api.cloudflare.com");
  });
});
