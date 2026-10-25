import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { mintSession } from "../src/session";
import { canEdit } from "../src/authz";
import { grantRole, hasGrant, listGrantsWithRoles, setAccess } from "../src/db";
import { normalizeAccessInput } from "../src/api";
import { MCP_PATH } from "../src/mcp";
import { initDb, clearR2, req, as, withToken } from "./fixtures";

/**
 * Grant roles: `viewer` (default) and `editor`.
 *
 * An editor may publish a new version to the artifact and list/roll back its
 * versions, and nothing else. These tests pin both halves — what an editor can
 * now do, and everything they still cannot — plus the rule that a guest
 * sign-in is never an editor and that the legacy `emails` API still means
 * "viewer".
 */

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const OWNER = "owner@beta.com";
const EDITOR = "erin@beta.com";
const VIEWER = "vic@beta.com";
const STRANGER = "stan@beta.com";

const json = { "Content-Type": "application/json" };

function e(extra: Record<string, unknown> = {}) {
  return {
    ...(env as any),
    SESSION_SECRET: SECRET,
    DEV_LOGIN: undefined,
    CONTENT_HOSTNAMES: "a.rtfx.pro",
    PUBLIC_BASE_URL: "https://rtfx.pro",
    ADMIN_EMAILS: "admin@test.com",
    ...extra,
  };
}

function publishForm(slug: string, html: string, title?: string) {
  const body = new FormData();
  body.set("slug", slug);
  if (title) body.set("title", title);
  body.set("file", new File([html], "index.html", { type: "text/html" }));
  return body;
}

const publishAs = (who: string, html: string) =>
  req("/api/artifacts", { method: "POST", body: publishForm("report", html), ...as(who) });

const putAccess = (who: string, body: unknown) =>
  req("/api/artifacts/report/access", {
    method: "PUT",
    headers: json,
    body: JSON.stringify(body),
    ...as(who),
  });

beforeEach(async () => {
  await initDb();
  await clearR2();
  expect((await req("/api/artifacts", { method: "POST", body: publishForm("report", "<h1>v1</h1>", "Report"), ...as(OWNER) })).status).toBe(200);
  const res = await putAccess(OWNER, {
    visibility: "restricted",
    grants: [
      { email: EDITOR, role: "editor" },
      { email: VIEWER, role: "viewer" },
    ],
  });
  expect(res.status).toBe(200);
});

describe("access API shape", () => {
  it("round-trips grants with roles and keeps the flat emails list", async () => {
    const res = await req("/api/artifacts/report/access", as(OWNER));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      visibility: "restricted",
      emails: [EDITOR, VIEWER],
      grants: [
        { email: EDITOR, role: "editor" },
        { email: VIEWER, role: "viewer" },
      ],
    });
  });

  it("treats legacy `emails` as viewers for new addresses but keeps existing roles", async () => {
    await putAccess(OWNER, { visibility: "restricted", grants: [{ email: EDITOR, role: "editor" }] });
    // An old client re-saving the list it read must not silently demote the editor.
    const res = await putAccess(OWNER, { visibility: "restricted", emails: [EDITOR, "New@Beta.com"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      slug: "report",
      emails: [EDITOR, "new@beta.com"],
      grants: [
        { email: EDITOR, role: "editor" },
        { email: "new@beta.com", role: "viewer" },
      ],
    });
  });

  it("a request that names roles is taken exactly as given", async () => {
    await putAccess(OWNER, { visibility: "restricted", grants: [{ email: EDITOR, role: "editor" }] });
    const res = await putAccess(OWNER, { visibility: "restricted", grants: [{ email: EDITOR, role: "viewer" }] });
    expect((await res.json<any>()).grants).toEqual([{ email: EDITOR, role: "viewer" }]);
  });

  it("last mention of a duplicate address wins", async () => {
    const res = await putAccess(OWNER, {
      visibility: "restricted",
      grants: [
        { email: EDITOR, role: "viewer" },
        { email: EDITOR.toUpperCase(), role: "editor" },
      ],
    });
    expect((await res.json<any>()).grants).toEqual([{ email: EDITOR, role: "editor" }]);
  });

  it("defaults a grant without a role to viewer and refuses an unknown role", async () => {
    const ok = await putAccess(OWNER, { visibility: "restricted", grants: [{ email: VIEWER }] });
    expect((await ok.json<any>()).grants).toEqual([{ email: VIEWER, role: "viewer" }]);

    for (const grants of [[{ email: VIEWER, role: "admin" }], [{ email: VIEWER, role: 5 }], ["x@y.com"], [{ role: "editor" }], "nope"]) {
      const bad = await putAccess(OWNER, { visibility: "restricted", grants });
      expect(bad.status, JSON.stringify(grants)).toBe(400);
    }
    // The failed attempts changed nothing.
    expect((await (await req("/api/artifacts/report/access", as(OWNER))).json<any>()).grants).toEqual([
      { email: VIEWER, role: "viewer" },
    ]);
  });

  it("normalizeAccessInput merges emails, grants and editors, last mention wins", () => {
    expect(
      normalizeAccessInput({
        visibility: "restricted",
        emails: ["a@x.com", "b@x.com"],
        grants: [{ email: "b@x.com", role: "editor" }],
        editors: ["a@x.com"],
      })
    ).toEqual({
      visibility: "restricted",
      emails: ["a@x.com", "b@x.com"],
      grants: [
        { email: "a@x.com", role: "editor" },
        { email: "b@x.com", role: "editor" },
      ],
      legacy: false,
    });
    expect(normalizeAccessInput({ visibility: "restricted", editors: "x" })).toHaveProperty("error");
  });

  it("an editor cannot read or change access", async () => {
    expect((await req("/api/artifacts/report/access", as(EDITOR))).status).toBe(404);
    const res = await putAccess(EDITOR, { visibility: "everyone", grants: [] });
    expect(res.status).toBe(404);
    expect((await (await req("/api/artifacts/report/access", as(OWNER))).json<any>()).visibility).toBe("restricted");
  });

  it("a viewing grant does not change hasGrant, and grantRole reports the role", async () => {
    expect(await hasGrant(env as any, "report", EDITOR)).toBe(true);
    expect(await hasGrant(env as any, "report", VIEWER)).toBe(true);
    expect(await grantRole(env as any, "report", EDITOR.toUpperCase())).toBe("editor");
    expect(await grantRole(env as any, "report", VIEWER)).toBe("viewer");
    expect(await grantRole(env as any, "report", STRANGER)).toBeNull();
  });
});

describe("what an editor may do", () => {
  it("publishes a new version, keeping owner and workspace", async () => {
    const before = await env.DB.prepare("SELECT owner_email, account_id, title FROM artifacts WHERE slug = 'report'").first<any>();
    const res = await publishAs(EDITOR, "<h1>v2 by erin</h1>");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ slug: "report", version: 2 });
    const after = await env.DB.prepare("SELECT owner_email, account_id, title, current_version FROM artifacts WHERE slug = 'report'").first<any>();
    expect(after.owner_email).toBe(before.owner_email);
    expect(after.account_id).toBe(before.account_id);
    expect(after.title).toBe("Report");
    expect(after.current_version).toBe(2);
    const v = await env.DB.prepare("SELECT created_by FROM artifact_versions WHERE slug = 'report' AND version = 2").first<any>();
    expect(v.created_by).toBe(EDITOR);
  });

  it("lists versions and rolls back", async () => {
    await publishAs(EDITOR, "<h1>v2</h1>");
    const versions = await req("/api/artifacts/report/versions", as(EDITOR));
    expect(versions.status).toBe(200);
    expect((await versions.json<any>()).versions).toHaveLength(2);

    const back = await req("/api/artifacts/report/current", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ version: 1 }),
      ...as(EDITOR),
    });
    expect(back.status).toBe(200);
    expect((await env.DB.prepare("SELECT current_version FROM artifacts WHERE slug = 'report'").first<any>()).current_version).toBe(1);
  });

  it("cannot do anything else: links, views, delete, analytics", async () => {
    const link = await req("/api/artifacts/report/links", { method: "POST", headers: json, body: "{}", ...as(EDITOR) });
    expect(link.status).toBe(404);
    expect((await req("/api/artifacts/report/links", as(EDITOR))).status).toBe(404);
    expect((await req("/api/artifacts/report/views", as(EDITOR))).status).toBe(404);
    const del = await req("/api/artifacts/report", { method: "DELETE", ...as(EDITOR) });
    expect(del.status).toBe(404);
    expect(await env.DB.prepare("SELECT slug FROM artifacts WHERE slug = 'report'").first()).not.toBeNull();
    // Nor the dashboard's own share page.
    expect((await req("/share/report", as(EDITOR))).status).toBe(404);
  });
});

describe("what a viewer or stranger may not do", () => {
  it("a viewer still gets slug_taken on publish, and 404 on versions and rollback", async () => {
    const res = await publishAs(VIEWER, "<h1>nope</h1>");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "slug_taken" });
    expect((await req("/api/artifacts/report/versions", as(VIEWER))).status).toBe(404);
    const back = await req("/api/artifacts/report/current", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ version: 1 }),
      ...as(VIEWER),
    });
    expect(back.status).toBe(404);
  });

  it("a stranger gets slug_taken", async () => {
    expect((await publishAs(STRANGER, "<h1>x</h1>")).status).toBe(409);
  });

  it("demoting an editor takes the right away immediately", async () => {
    await putAccess(OWNER, { visibility: "restricted", grants: [{ email: EDITOR, role: "viewer" }] });
    expect((await publishAs(EDITOR, "<h1>x</h1>")).status).toBe(409);
  });

  it("a guest session is never an editor, even holding an editor grant", async () => {
    const guest = `${SESSION_COOKIE}=${await mintSession(SECRET, { email: EDITOR, kind: "guest", slug: "report" }, new Date().toISOString())}`;
    const res = await app.request(
      "https://rtfx.pro/api/artifacts",
      { method: "POST", headers: { Cookie: guest }, body: publishForm("report", "<h1>guest</h1>") },
      e()
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await env.DB.prepare("SELECT current_version FROM artifacts WHERE slug = 'report'").first<any>()).current_version).toBe(1);

    const versions = await app.request("https://rtfx.pro/api/artifacts/report/versions", { headers: { Cookie: guest } }, e());
    expect(versions.status).toBeGreaterThanOrEqual(400);
  });

  it("a signed-in session of the same person is an editor", async () => {
    const member = `${SESSION_COOKIE}=${await mintSession(SECRET, { email: EDITOR, kind: "member" }, new Date().toISOString())}`;
    const res = await app.request(
      "https://rtfx.pro/api/artifacts",
      { method: "POST", headers: { Cookie: member }, body: publishForm("report", "<h1>member</h1>") },
      e()
    );
    expect(res.status).toBe(200);
  });

  it("canEdit: owner, editor, viewer, guest, anonymous", () => {
    const art = { owner_email: OWNER };
    const id = (email: string, extra: Record<string, unknown> = {}) => ({ email, isAdmin: false, ...extra }) as any;
    expect(canEdit(id(OWNER), art, null, null)).toBe(true);
    expect(canEdit(id(EDITOR), art, null, "editor")).toBe(true);
    expect(canEdit(id(VIEWER), art, null, "viewer")).toBe(false);
    expect(canEdit(id(STRANGER), art, null, null)).toBe(false);
    expect(canEdit(id(EDITOR, { kind: "guest" }), art, null, "editor")).toBe(false);
    expect(canEdit(id(undefined as any), art, null, "editor")).toBe(false);
    expect(canEdit(null, art, null, "editor")).toBe(false);
  });
});

describe("editor token scopes", () => {
  async function tokenFor(email: string, scopes: string[]) {
    const res = await req("/api/tokens", as(email, { method: "POST", headers: json, body: JSON.stringify({ name: "t", scopes }) }));
    expect(res.status).toBe(201);
    return (await res.json<any>()).token as string;
  }

  it("an editor's read-only token cannot publish; a publish-scoped one can", async () => {
    const readOnly = await tokenFor(EDITOR, ["read"]);
    const refused = await req("/api/artifacts", { method: "POST", body: publishForm("report", "<h1>x</h1>"), ...withToken(readOnly) });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "insufficient_scope" });

    const pub = await tokenFor(EDITOR, ["read", "publish"]);
    const ok = await req("/api/artifacts", { method: "POST", body: publishForm("report", "<h1>via token</h1>"), ...withToken(pub) });
    expect(ok.status).toBe(200);
  });
});

describe("MCP", () => {
  async function tokenFor(email: string, scopes: string[]) {
    const res = await req("/api/tokens", as(email, { method: "POST", headers: json, body: JSON.stringify({ name: "mcp", scopes }) }));
    return (await res.json<any>()).token as string;
  }
  const call = async (token: string, name: string, args: Record<string, unknown>) => {
    const res = await req(MCP_PATH, {
      method: "POST",
      headers: { ...json, Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return (await res.json<any>()).result;
  };
  const data = (r: any) => JSON.parse(r.content[r.content.length - 1].text);

  it("share_artifact takes editors, answers grants, and artifact_details shows roles", async () => {
    const owner = await tokenFor(OWNER, ["read", "publish", "manage"]);
    const shared = await call(owner, "share_artifact", {
      slug: "report",
      visibility: "restricted",
      emails: [VIEWER, EDITOR],
      editors: [EDITOR, "Zed@Beta.com"],
    });
    expect(shared.isError).toBeFalsy();
    const out = data(shared);
    expect(out.emails.sort()).toEqual([EDITOR, VIEWER, "zed@beta.com"].sort());
    expect(out.grants).toEqual([
      { email: EDITOR, role: "editor" },
      { email: VIEWER, role: "viewer" },
      { email: "zed@beta.com", role: "editor" },
    ]);

    const details = data(await call(owner, "artifact_details", { slug: "report" }));
    expect(details.access.grants).toEqual(out.grants);
    expect(details.access.emails).toEqual(out.emails);
  });

  it("an editor publishes and rolls back over MCP; a viewer does not", async () => {
    const editor = await tokenFor(EDITOR, ["read", "publish", "manage"]);
    const pub = await call(editor, "publish", { slug: "report", content_text: "<h1>v2 mcp</h1>" });
    expect(pub.isError).toBeFalsy();
    expect(data(pub).version).toBe(2);

    const back = await call(editor, "rollback_artifact", { slug: "report", version: 1 });
    expect(back.isError).toBeFalsy();
    expect(data(back).current).toBe(1);

    // ...but nothing else: details and sharing stay manager-only.
    expect((await call(editor, "artifact_details", { slug: "report" })).isError).toBe(true);
    expect((await call(editor, "share_artifact", { slug: "report", visibility: "everyone" })).isError).toBe(true);
    expect((await call(editor, "delete_artifact", { slug: "report", confirm_slug: "report" })).isError).toBe(true);

    const viewer = await tokenFor(VIEWER, ["read", "publish", "manage"]);
    const refused = await call(viewer, "publish", { slug: "report", content_text: "<h1>no</h1>" });
    expect(refused.isError).toBe(true);
    expect((await call(viewer, "rollback_artifact", { slug: "report", version: 1 })).isError).toBe(true);
  });
});

describe("before migration 0024 (no role column)", () => {
  async function dropRole() {
    await env.DB.prepare("DROP TABLE artifact_grants").run();
    await env.DB.prepare(
      "CREATE TABLE artifact_grants (slug TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (slug, email))"
    ).run();
    await env.DB.prepare("INSERT INTO artifact_grants VALUES ('report', ?, '2026-01-01T00:00:00Z')").bind(EDITOR).run();
  }

  it("every grant reads as a viewer and nobody edits", async () => {
    await dropRole();
    expect(await listGrantsWithRoles(env as any, "report")).toEqual([{ email: EDITOR, role: "viewer" }]);
    expect(await grantRole(env as any, "report", EDITOR)).toBe("viewer");
    expect(await grantRole(env as any, "report", STRANGER)).toBeNull();
    expect((await publishAs(EDITOR, "<h1>x</h1>")).status).toBe(409);
    const res = await req("/api/artifacts/report/access", as(OWNER));
    expect(await res.json()).toMatchObject({ emails: [EDITOR], grants: [{ email: EDITOR, role: "viewer" }] });
  });

  it("setAccess still writes the grants, as viewers", async () => {
    await dropRole();
    await setAccess(env as any, "report", "restricted", [{ email: "a@x.com", role: "editor" }, "b@x.com"], "2026-01-02T00:00:00Z");
    expect(await listGrantsWithRoles(env as any, "report")).toEqual([
      { email: "a@x.com", role: "viewer" },
      { email: "b@x.com", role: "viewer" },
    ]);
  });
});
