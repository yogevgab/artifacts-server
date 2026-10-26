import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { strToU8 } from "fflate";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { mintSession } from "../src/session";
import { initDb, clearR2, req, as, withToken, htmlForm, openViewer } from "./fixtures";
import { MCP_PATH } from "../src/mcp";

/**
 * Platform admins (admin AND super admin, human or token) have NO access to
 * other users' artifact content. They keep instance metadata (counts, owner,
 * size), account-level actions, and an audited abuse-delete that never reads
 * the artifact. Decision of 2026-10-26; see docs/ARCHITECTURE.md
 * "Operators are artifact-blind".
 */

const SUPER = "admin@test.com"; // SUPER_ADMIN_EMAILS in vitest.config.ts
const ADMIN2 = "admin2@test.com"; // plain admin
const BOB = "bob@beta.com";
const CAROL = "carol@beta.com";
const STRANGER = "stranger@x.com";
const SLUG = "bobs-secret";
const SECRET_BODY = "TOP-SECRET-BODY";

async function publish(email: string, slug: string, html = `<h1>${SECRET_BODY}</h1>`) {
  const res = await req(
    "/api/artifacts",
    as(email, { method: "POST", body: htmlForm({ title: slug, slug }, "index.html", strToU8(html)) })
  );
  expect(res.status).toBe(200);
}

async function tokenFor(email: string, body: Record<string, unknown>) {
  const res = await req(
    "/api/tokens",
    as(email, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  );
  expect(res.status).toBe(201);
  return (await res.json<any>()).token as string;
}

const json = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function viewRows(slug = SLUG) {
  const { results } = await env.DB.prepare("SELECT email FROM artifact_views WHERE slug = ?").bind(slug).all<{ email: string }>();
  return results ?? [];
}

beforeEach(async () => {
  await initDb();
  await clearR2();
  await publish(BOB, SLUG);
  await publish(BOB, SLUG); // v2
  await req(`/api/artifacts/${SLUG}/access`, as(BOB, { method: "PUT", ...json({ visibility: "restricted", emails: [CAROL] }) }));
  // A view by a real reader, so the view log is non-empty.
  await openViewer(SLUG, BOB);
  await env.DB.prepare(
    "INSERT INTO artifact_views (slug, version, email, path, viewed_at) VALUES (?, 2, ?, '/', ?)"
  ).bind(SLUG, CAROL, new Date().toISOString()).run();
});

const admins = [
  ["super admin (human)", SUPER],
  ["admin (human)", ADMIN2],
] as const;

describe("viewer, raw, chat and previews: an admin is a stranger", () => {
  for (const [label, who] of admins) {
    it(`${label}: viewer navigation is the same 404 a stranger gets`, async () => {
      const stranger = await openViewer(SLUG, STRANGER);
      const res = await openViewer(SLUG, who);
      expect(res.status).toBe(404);
      expect(res.status).toBe(stranger.status);
      const text = await res.text();
      expect(text).not.toContain("<iframe");
      expect(text).not.toContain(SECRET_BODY);
    });

    it(`${label}: raw content and a version preview are 404`, async () => {
      for (const path of [`/${SLUG}/?raw=1`, `/${SLUG}/index.html`, `/v/${SLUG}/1/`, `/v/${SLUG}/2/index.html`]) {
        const res = await req(path, as(who));
        expect(res.status, path).toBe(404);
        expect(await res.text()).not.toContain(SECRET_BODY);
      }
    });

    it(`${label}: the chat socket is refused`, async () => {
      const res = await req(`/_chat/${SLUG}`, as(who, { headers: { Upgrade: "websocket" } }));
      expect(res.status).toBe(404);
    });
  }

  it("the owner and a granted reader still get in", async () => {
    expect((await openViewer(SLUG, BOB)).status).toBe(200);
    expect((await openViewer(SLUG, CAROL)).status).toBe(200);
    expect((await req(`/${SLUG}/?raw=1`, as(BOB))).status).toBe(200);
  });

  it("an admin granted BY NAME reads it like any grantee, and no more", async () => {
    await req(`/api/artifacts/${SLUG}/access`, as(BOB, { method: "PUT", ...json({ visibility: "restricted", emails: [SUPER] }) }));
    expect((await openViewer(SLUG, SUPER)).status).toBe(200);
    expect((await req(`/api/artifacts/${SLUG}/access`, as(SUPER))).status).toBe(404);
    expect((await req(`/api/artifacts/${SLUG}/views`, as(SUPER))).status).toBe(404);
  });

  it("an admin is not special on an 'everyone' artifact either", async () => {
    await req(`/api/artifacts/${SLUG}/access`, as(BOB, { method: "PUT", ...json({ visibility: "everyone", emails: [] }) }));
    expect((await openViewer(SLUG, SUPER)).status).toBe(404);
    expect((await req(`/${SLUG}/?raw=1`, as(ADMIN2))).status).toBe(404);
  });

  it("a suspended-workspace takedown no longer has an admin carve-out to serve through", async () => {
    // Nothing to bypass: the admin has no read path in the first place.
    expect((await req(`/${SLUG}/?raw=1`, as(SUPER))).status).toBe(404);
  });
});

describe("management API: reads and writes are 404 for an admin", () => {
  const ops: Record<string, (who: string) => Promise<Response>> = {
    versions: (who) => req(`/api/artifacts/${SLUG}/versions`, as(who)),
    views: (who) => req(`/api/artifacts/${SLUG}/views`, as(who)),
    "read access": (who) => req(`/api/artifacts/${SLUG}/access`, as(who)),
    "edit access": (who) =>
      req(`/api/artifacts/${SLUG}/access`, as(who, { method: "PUT", ...json({ visibility: "everyone", emails: [] }) })),
    links: (who) => req(`/api/artifacts/${SLUG}/links`, as(who)),
    "create link": (who) => req(`/api/artifacts/${SLUG}/links`, as(who, { method: "POST", ...json({}) })),
    "read receipts": (who) => req(`/api/artifacts/${SLUG}/receipts`, as(who)),
    "set receipts": (who) =>
      req(`/api/artifacts/${SLUG}/receipts`, as(who, { method: "PUT", ...json({ enabled: false }) })),
    rollback: (who) => req(`/api/artifacts/${SLUG}/current`, as(who, { method: "POST", ...json({ version: 1 }) })),
    delete: (who) => req(`/api/artifacts/${SLUG}`, as(who, { method: "DELETE" })),
    publish: (who) =>
      req("/api/artifacts", as(who, { method: "POST", body: htmlForm({ title: "x", slug: SLUG }, "index.html", strToU8("<h1>hijack</h1>")) })),
    "machine publish": (who) =>
      req("/api/machine/artifacts", as(who, { method: "POST", body: htmlForm({ title: "x", slug: SLUG }, "index.html", strToU8("<h1>hijack</h1>")) })),
    "share page": (who) => req(`/share/${SLUG}`, as(who)),
    "artifact detail page": (who) => req(`/admin/artifacts/${SLUG}`, as(who)),
  };

  for (const [label, who] of admins) {
    for (const [name, run] of Object.entries(ops)) {
      it(`${label} cannot ${name}`, async () => {
        const res = await run(who);
        // 404 (existence hidden) for everything except a publish into a taken slug, which is the
        // same 409 any stranger gets. The machine surface takes bearer tokens only (401 for a session).
        if (name === "machine publish") expect(res.status).toBe(401);
        else if (name === "publish") expect(res.status).toBe(409);
        else expect(res.status).toBe(404);
        expect(await res.text()).not.toContain(CAROL);
      });
    }
  }

  it("after every admin attempt the artifact is untouched", async () => {
    for (const run of Object.values(ops)) {
      await run(SUPER);
      await run(ADMIN2);
    }
    const row = await env.DB.prepare("SELECT visibility, current_version, owner_email FROM artifacts WHERE slug = ?")
      .bind(SLUG)
      .first<any>();
    expect(row).toMatchObject({ visibility: "restricted", current_version: 2, owner_email: BOB });
    expect((await req(`/api/artifacts/${SLUG}/versions`, as(BOB))).status).toBe(200);
  });

  it("an admin-minted token acting for the admin has the same blindness; an admin token too", async () => {
    const asSelf = await tokenFor(SUPER, { name: "self", owner_email: SUPER, scopes: ["read", "publish", "manage"] });
    const platform = await tokenFor(SUPER, { name: "platform", is_admin: true, scopes: ["read", "publish", "manage"] });
    for (const token of [asSelf, platform]) {
      expect((await req(`/api/machine/artifacts/${SLUG}/versions`, withToken(token))).status).toBe(404);
      expect((await req(`/api/machine/artifacts/${SLUG}/access`, withToken(token))).status).toBe(404);
      expect((await req(`/api/machine/artifacts/${SLUG}`, withToken(token, { method: "DELETE" }))).status).toBe(404);
      expect((await req(`/${SLUG}/?raw=1`, withToken(token))).status).toBe(404);
    }
  });
});

describe("listings exclude other people's artifacts for admins", () => {
  it("GET /api/artifacts, the dashboard and the gallery show only their own", async () => {
    await publish(SUPER, "admins-own");
    for (const who of [SUPER, ADMIN2]) {
      const list = (await (await req("/api/artifacts", as(who))).json<any>()).artifacts.map((a: any) => a.slug);
      expect(list).not.toContain(SLUG);
      for (const path of ["/admin", "/admin/artifacts", "/admin/gallery"]) {
        const html = await (await req(path, as(who))).text();
        expect(html, `${who} ${path}`).not.toContain(SLUG);
        expect(html, `${who} ${path}`).not.toContain(BOB);
        expect(html, `${who} ${path}`).not.toContain(CAROL);
      }
    }
    const mine = (await (await req("/api/artifacts", as(SUPER))).json<any>()).artifacts.map((a: any) => a.slug);
    expect(mine).toEqual(["admins-own"]);
  });
});

describe("MCP: an admin token sees and changes nothing of other people's", () => {
  const rpc = (token: string, name: string, args: Record<string, unknown> = {}) =>
    req(MCP_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
  const unwrap = async (res: Response) => {
    const body = await res.json<any>();
    const text = body.result.content[body.result.content.length - 1].text;
    return { isError: !!body.result.isError, data: JSON.parse(text), raw: JSON.stringify(body) };
  };

  it("list_artifacts, artifact_statistics, details, share, rollback, delete, publish", async () => {
    for (const body of [
      { name: "a", owner_email: SUPER, scopes: ["read", "publish", "manage"] },
      { name: "b", is_admin: true, scopes: ["read", "publish", "manage"] },
    ]) {
      const token = await tokenFor(SUPER, body);
      const listed = await unwrap(await rpc(token, "list_artifacts"));
      expect(listed.data.total).toBe(0);
      expect(listed.raw).not.toContain(SLUG);

      const stats = await unwrap(await rpc(token, "artifact_statistics"));
      expect(stats.data.totals.artifacts).toBe(0);
      expect(stats.data.totals.views).toBe(0);

      for (const [tool, args] of [
        ["artifact_details", { slug: SLUG }],
        ["artifact_statistics", { slug: SLUG }],
        ["share_artifact", { slug: SLUG, visibility: "everyone" }],
        ["rollback_artifact", { slug: SLUG, version: 1 }],
        ["delete_artifact", { slug: SLUG, confirm_slug: SLUG }],
        ["publish", { slug: SLUG, title: "x", content_text: "<h1>hijack</h1>" }],
      ] as const) {
        const out = await unwrap(await rpc(token, tool, args as any));
        expect(out.isError, tool).toBe(true);
        expect(out.raw, tool).not.toContain(CAROL);
        expect(out.raw, tool).not.toContain(SECRET_BODY);
      }
    }
    const row = await env.DB.prepare("SELECT current_version, visibility FROM artifacts WHERE slug = ?").bind(SLUG).first<any>();
    expect(row).toMatchObject({ current_version: 2, visibility: "restricted" });
  });
});

describe("operator console: metadata only", () => {
  it("a super admin sees owner, counts and size, but no grantee emails, view log or open links", async () => {
    const res = await req("/admin/platform", as(SUPER));
    expect(res.status).toBe(200);
    const html = await res.text();
    const row = new RegExp(`<tr data-artifact-meta="${SLUG}">[\\s\\S]*?</tr>`).exec(html)?.[0] ?? "";
    expect(row).toContain(BOB); // owner
    expect(row).toContain('data-cell="versions" class="numeric">2<');
    expect(row).toContain('data-cell="grants" class="numeric">1<'); // a count...
    expect(row).toContain('data-cell="views" class="numeric">1<'); // ...of Carol's logged view
    expect(html).not.toContain(CAROL); // ...never the grantee or the viewer
    // No way into the artifact from the operator console.
    expect(html).not.toMatch(new RegExp(`href="[^"]*/${SLUG}["/?#]`));
    expect(html).not.toContain(`/share/${SLUG}`);
    expect(html).not.toContain(`/admin/artifacts/${SLUG}`);
    expect(html).not.toContain(SECRET_BODY);
  });

  it("search filters the metadata list", async () => {
    await publish(CAROL, "other-one");
    const html = await (await req("/admin/platform?aq=other-one", as(SUPER))).text();
    expect(html).toContain('data-artifact-meta="other-one"');
    expect(html).not.toContain(`data-artifact-meta="${SLUG}"`);
  });

  it("a plain admin does not get the console at all", async () => {
    expect((await req("/admin/platform", as(ADMIN2))).status).toBe(404);
  });
});

describe("operator abuse-delete", () => {
  const del = (who: string, slug = SLUG, body: unknown = { reason: "phishing page" }) =>
    req(`/api/platform/artifacts/${slug}`, as(who, { method: "DELETE", ...json(body) }));

  it("works for a human super admin: removes rows and bytes, writes admin_audit, never reads content", async () => {
    expect(await env.FILES.get(`${SLUG}/v1/index.html`)).toBeTruthy();
    const res = await del(SUPER);
    expect(res.status).toBe(200);
    expect(await res.json<any>()).toMatchObject({ deleted: SLUG });

    expect(await env.DB.prepare("SELECT slug FROM artifacts WHERE slug = ?").bind(SLUG).first()).toBeNull();
    for (const t of ["artifact_versions", "artifact_grants", "artifact_views", "share_links"]) {
      expect(await env.DB.prepare(`SELECT slug FROM ${t} WHERE slug = ?`).bind(SLUG).first(), t).toBeNull();
    }
    expect(await env.FILES.get(`${SLUG}/v1/index.html`)).toBeNull();
    expect(await env.FILES.get(`${SLUG}/v2/index.html`)).toBeNull();

    const audit = await env.DB.prepare("SELECT * FROM admin_audit WHERE target_id = ?").bind(SLUG).all<any>();
    expect(audit.results).toHaveLength(1);
    const a = audit.results[0];
    expect(a).toMatchObject({ actor_email: SUPER, actor_role: "super_admin", action: "artifact.operator_deleted", target_type: "artifact" });
    expect(JSON.parse(a.detail)).toMatchObject({ slug: SLUG, owner_email: BOB, reason: "phishing page" });
    expect(a.detail).not.toContain(SECRET_BODY);
    expect(a.detail).not.toContain(CAROL);
  });

  it("requires a reason (and nothing is deleted without one)", async () => {
    for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: "x".repeat(501) }, null]) {
      expect((await del(SUPER, SLUG, body)).status).toBe(400);
    }
    expect(await env.DB.prepare("SELECT slug FROM artifacts WHERE slug = ?").bind(SLUG).first()).toBeTruthy();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit").first<any>()).n).toBe(0);
  });

  it("is refused for a plain admin, an API token (even a super admin's), a member and a stranger", async () => {
    const superToken = await tokenFor(SUPER, { name: "t", owner_email: SUPER, scopes: ["read", "publish", "manage"] });
    const platformToken = await tokenFor(SUPER, { name: "p", is_admin: true, scopes: ["read", "publish", "manage"] });
    const bobToken = await tokenFor(BOB, { name: "b", scopes: ["read", "publish", "manage"] });
    const attempts: Response[] = [
      await del(ADMIN2),
      await del(BOB),
      await del(STRANGER),
      await req(`/api/platform/artifacts/${SLUG}`, withToken(superToken, { method: "DELETE", ...json({ reason: "x" }) })),
      await req(`/api/platform/artifacts/${SLUG}`, withToken(platformToken, { method: "DELETE", ...json({ reason: "x" }) })),
      await req(`/api/platform/artifacts/${SLUG}`, withToken(bobToken, { method: "DELETE", ...json({ reason: "x" }) })),
      await req(`/api/platform/artifacts/${SLUG}`, { method: "DELETE", ...json({ reason: "x" }), headers: { "Content-Type": "application/json", "X-Dev-Anonymous": "true" } }),
    ];
    for (const res of attempts) expect([401, 403, 404]).toContain(res.status);
    expect(attempts.every((r) => !r.ok)).toBe(true);
    expect(await env.DB.prepare("SELECT slug FROM artifacts WHERE slug = ?").bind(SLUG).first()).toBeTruthy();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit").first<any>()).n).toBe(0);
  });

  it("answers 404 for an unknown slug and a cross-origin browser call is refused", async () => {
    expect((await del(SUPER, "no-such-slug")).status).toBe(404);
    const cross = await req(
      `/api/platform/artifacts/${SLUG}`,
      as(SUPER, { method: "DELETE", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ reason: "x" }) })
    );
    expect(cross.status).toBe(404);
    expect(await env.DB.prepare("SELECT slug FROM artifacts WHERE slug = ?").bind(SLUG).first()).toBeTruthy();
  });

  it("the console form does the same and shows the outcome", async () => {
    const form = new URLSearchParams({ reason: "abuse report #12" });
    const res = await req(`/admin/platform/artifacts/${SLUG}/delete`, as(SUPER, { method: "POST", body: form }));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toContain("ok=artifact_deleted");
    expect(await env.DB.prepare("SELECT slug FROM artifacts WHERE slug = ?").bind(SLUG).first()).toBeNull();
    const page = await (await req(res.headers.get("Location")!, as(SUPER))).text();
    expect(page).toContain("Artifact deleted");
    // Plain admin: refused, nothing happens.
    await publish(BOB, "second");
    const denied = await req("/admin/platform/artifacts/second/delete", as(ADMIN2, { method: "POST", body: form }));
    expect(denied.status).toBe(404);
    expect(await env.DB.prepare("SELECT slug FROM artifacts WHERE slug = 'second'").first()).toBeTruthy();
  });
});

describe("no view is ever recorded for an admin on someone else's artifact", () => {
  it("every admin read attempt leaves artifact_views untouched", async () => {
    const before = await viewRows();
    const tokens = [
      await tokenFor(SUPER, { name: "a", owner_email: SUPER }),
      await tokenFor(SUPER, { name: "b", is_admin: true }),
    ];
    for (const who of [SUPER, ADMIN2]) {
      await openViewer(SLUG, who);
      await openViewer(SLUG, who, { query: "?k=bogus" });
      await req(`/${SLUG}/?raw=1`, as(who));
      await req(`/${SLUG}/index.html`, { ...as(who), headers: { ...(as(who).headers as any), "Sec-Fetch-Dest": "document" } });
      await req(`/v/${SLUG}/1/`, as(who));
    }
    for (const t of tokens) await req(`/${SLUG}/?raw=1`, withToken(t));
    const after = await viewRows();
    expect(after).toHaveLength(before.length);
    expect(after.map((r) => r.email).filter((e) => e === SUPER || e === ADMIN2)).toEqual([]);
  });
});

describe("what platform authority keeps", () => {
  it("an admin still manages an artifact that belongs to nobody (service-token publish) and their own", async () => {
    const platform = await tokenFor(SUPER, { name: "p", is_admin: true, scopes: ["read", "publish", "manage"] });
    const made = await req(
      "/api/machine/artifacts",
      withToken(platform, { method: "POST", body: htmlForm({ title: "orphan", slug: "orphan" }, "index.html", strToU8("<h1>o</h1>")) })
    );
    expect(made.status).toBe(200);
    const row = await env.DB.prepare("SELECT owner_email, account_id FROM artifacts WHERE slug = 'orphan'").first<any>();
    expect(row).toMatchObject({ owner_email: null, account_id: null });
    expect((await req("/api/machine/artifacts/orphan/versions", withToken(platform))).status).toBe(200);
    expect((await req("/api/artifacts", withToken(platform))).status).toBe(200);
    expect(((await (await req("/api/artifacts", withToken(platform))).json<any>()).artifacts as any[]).map((a) => a.slug)).toEqual(["orphan"]);
    // nobody else reaches it
    expect((await req("/api/artifacts/orphan/versions", as(BOB))).status).toBe(404);
  });

  it("account-level operator actions are unchanged: people directory, tokens list, workspace pages", async () => {
    expect((await req("/api/users", as(SUPER))).status).toBe(200);
    expect((await req("/api/users", as(ADMIN2))).status).toBe(200);
    expect((await req("/api/tokens", as(SUPER))).status).toBe(200);
    expect((await req("/admin/platform", as(SUPER))).status).toBe(200);
    expect((await req("/admin/people", as(SUPER))).status).toBe(200);
  });

  it("an admin who is a MEMBER of a workspace manages that workspace's artifacts like any member", async () => {
    // Account roles are customer data and were never platform authority.
    const { ensurePersonalAccount, upsertMember } = await import("../src/accounts");
    const account = await ensurePersonalAccount(env as any, BOB, new Date().toISOString());
    await upsertMember(env as any, {
      accountId: account!.id,
      email: ADMIN2,
      role: "member",
      invitedBy: BOB,
      now: new Date().toISOString(),
    });
    expect((await req(`/api/artifacts/${SLUG}/versions`, as(ADMIN2))).status).toBe(200);
  });
});

describe("the privacy page says so plainly", () => {
  it("names metadata as all operators see", async () => {
    const html = await (await req("/privacy")).text();
    expect(html).toContain("metadata");
    expect(html).toMatch(/cannot open your artifacts/);
    expect(html).toMatch(/who has viewed them/);
  });
});

// A session cookie is not how admins prove themselves in production; the same
// answers must hold for one (no DEV_LOGIN impersonation path in the result).
describe("with a real session cookie", () => {
  it("an admin session still gets 404 on viewer and raw", async () => {
    const SECRETKEY = "test-secret-at-least-32-bytes-long-for-hs256!!";
    const cookie = `${SESSION_COOKIE}=${await mintSession(SECRETKEY, { email: SUPER, kind: "member" }, new Date().toISOString())}`;
    const e = { ...(env as any), SESSION_SECRET: SECRETKEY, DEV_LOGIN: undefined, ADMIN_EMAILS: SUPER, SUPER_ADMIN_EMAILS: SUPER };
    for (const path of [`/${SLUG}/?raw=1`, `/v/${SLUG}/1/`, `/api/artifacts/${SLUG}/versions`]) {
      const res = await app.request(path, { headers: { Cookie: cookie } }, e);
      expect(res.status, path).toBe(404);
    }
  });
});

describe("tokens minted before the rule cannot impersonate", () => {
  /**
   * POST /api/tokens no longer lets an operator mint a token that acts as
   * somebody else, but a row created under the old rule would still resolve to
   * its owner. Such a row (a PERSON as creator, a different owner) is refused at
   * authentication; the person's own tokens and OAuth grants are untouched.
   */
  it("refuses a legacy admin-minted token that acts as another user", async () => {
    const { createApiToken } = await import("../src/tokens");
    const now = new Date().toISOString();
    const legacy = await createApiToken(env as any, {
      name: "for-bob", ownerEmail: BOB, accountId: null, isAdmin: false,
      scopes: ["read", "publish", "manage"], createdBy: SUPER, expiresAt: null, now,
    });
    expect((await req("/api/artifacts", withToken(legacy.token))).status).toBe(401);

    const own = await createApiToken(env as any, {
      name: "bob-own", ownerEmail: BOB, accountId: null, isAdmin: false,
      scopes: ["read"], createdBy: BOB, expiresAt: null, now,
    });
    expect((await req("/api/artifacts", withToken(own.token))).status).toBe(200);

    const oauth = await createApiToken(env as any, {
      name: "Claude (OAuth)", ownerEmail: BOB, accountId: null, isAdmin: false,
      scopes: ["read"], createdBy: "oauth:oc_test", expiresAt: null, now,
    });
    expect((await req("/api/artifacts", withToken(oauth.token))).status).toBe(200);
  });
});
