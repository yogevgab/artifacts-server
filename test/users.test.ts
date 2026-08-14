import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { strToU8 } from "fflate";
import { initDb, clearR2, dropUsersTable, req, as, withToken, htmlForm } from "./fixtures";

/**
 * Full beta user management (issue #24).
 *
 * The model under test has three layers that must never be confused:
 *
 *   1. **Cloudflare Access** decides who can authenticate. Not configured in
 *      tests, which is itself an important case — the product has to stay usable
 *      and the local layer has to keep working without it.
 *   2. **The local `users` table** holds product state: status, name, notes,
 *      timestamps. `status` is authoritative — disabling somebody works even
 *      when the Access write can't happen.
 *   3. **Configuration** (`ADMIN_EMAILS` / `SUPER_ADMIN_EMAILS`) holds privilege.
 *      Nothing written through the API may ever change it.
 *
 * Per vitest.config.ts: admin@test.com is the super admin, admin2@test.com is a
 * plain admin, everyone else is a member.
 */

const SUPER = "admin@test.com";
const ADMIN2 = "admin2@test.com";
const BOB = "bob@beta.com";
const CAROL = "carol@beta.com";

beforeEach(async () => {
  await initDb();
  await clearR2();
});

const json = (body: unknown) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function call(email: string, path: string, init: RequestInit = {}) {
  const res = await req(path, as(email, init));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const listUsers = (email = SUPER) => call(email, "/api/users");
const invite = (email: string, target: string, extra: Record<string, unknown> = {}) =>
  call(email, "/api/users", { method: "POST", ...json({ email: target, ...extra }) });
const disable = (email: string, target: string) =>
  call(email, `/api/users/${encodeURIComponent(target)}/disable`, { method: "POST" });
const enable = (email: string, target: string) =>
  call(email, `/api/users/${encodeURIComponent(target)}/enable`, { method: "POST" });
const remove = (email: string, target: string) =>
  call(email, `/api/users/${encodeURIComponent(target)}`, { method: "DELETE" });

/** One person out of a directory response. */
const find = (body: any, email: string) => body.users.find((u: any) => u.email === email);

// ---------------------------------------------------------------------------

describe("directory shape", () => {
  it("lists configured admins even before they have ever signed in", async () => {
    const { status, body } = await listUsers();
    expect(status).toBe(200);
    expect(find(body, SUPER)).toMatchObject({ role: "super_admin", is_protected: true });
    expect(find(body, ADMIN2)).toMatchObject({ role: "admin", is_protected: false });
    expect(body.super_admins).toEqual([SUPER]);
    expect(body.admins).toEqual([SUPER, ADMIN2].sort());
  });

  it("reads an allow-list-only person as invited, not active", async () => {
    // They can sign in as far as Access is concerned, but this product has never
    // met them — which is exactly what `invited` means. Only the operator is
    // pinned to active regardless.
    const { body } = await listUsers();
    expect(find(body, ADMIN2)).toMatchObject({ status: "invited", in_directory: false });
    expect(find(body, SUPER).status).toBe("active");
  });


  it("sorts the operator first, then admins, then members", async () => {
    await invite(SUPER, CAROL);
    await invite(SUPER, BOB);
    const { body } = await listUsers();
    expect(body.users.map((u: any) => u.email)).toEqual([SUPER, ADMIN2, BOB, CAROL]);
  });

  it("is admin-only", async () => {
    expect((await listUsers(BOB)).status).toBe(403);
    expect((await invite(BOB, "eve@x.com")).status).toBe(403);
    expect((await disable(BOB, CAROL)).status).toBe(403);
    expect((await enable(BOB, CAROL)).status).toBe(403);
    expect((await remove(BOB, CAROL)).status).toBe(403);
  });
});

describe("invite lifecycle", () => {
  it("invites somebody with metadata and records who did it", async () => {
    const { status, body } = await invite(SUPER, BOB, {
      display_name: "Bob Beta",
      notes: "design partner",
    });
    expect(status).toBe(200);
    expect(body.user).toMatchObject({
      email: BOB,
      role: "member",
      status: "invited",
      display_name: "Bob Beta",
      notes: "design partner",
      invited_by: SUPER,
      in_directory: true,
      is_protected: false,
    });
    expect(body.user.invited_at).toBeTruthy();
    expect(body.user.last_seen_at).toBeNull();
  });

  it("promotes invited → active on first sign-in, and records last_seen_at", async () => {
    await invite(SUPER, BOB);
    await req("/admin", as(BOB));
    const after = find((await listUsers()).body, BOB);
    expect(after.status).toBe("active");
    expect(after.last_seen_at).toBeTruthy();
  });

  it("self-provisions a row for an Access-allowed person the directory never met", async () => {
    // CAROL was never invited through the API — she just shows up, which is how
    // an existing deployment populates without an import step.
    await req("/admin", as(CAROL));
    expect(find((await listUsers()).body, CAROL)).toMatchObject({
      status: "active",
      role: "member",
      in_directory: true,
    });
  });

  it("re-inviting preserves history instead of resetting the person", async () => {
    await invite(SUPER, BOB, { display_name: "Bob Beta" });
    const first = find((await listUsers()).body, BOB);
    await req("/admin", as(BOB));
    const { body } = await invite(SUPER, BOB, { notes: "second thoughts" });
    expect(body.user).toMatchObject({
      status: "active", // already signed in — not demoted back to invited
      display_name: "Bob Beta", // omitted field is kept, not blanked
      notes: "second thoughts",
      created_at: first.created_at,
      invited_at: first.invited_at,
    });
  });

  it("normalises and validates the email", async () => {
    const { body } = await invite(SUPER, "  BOB@Beta.com  ");
    expect(body.user.email).toBe(BOB);
    expect((await invite(SUPER, "noatsign")).status).toBe(400);
    expect((await invite(SUPER, "")).status).toBe(400);
  });

  it("rejects over-long metadata rather than silently truncating it", async () => {
    expect((await invite(SUPER, BOB, { display_name: "x".repeat(81) })).status).toBe(400);
    expect((await invite(SUPER, BOB, { notes: "x".repeat(501) })).status).toBe(400);
    expect((await invite(SUPER, BOB, { display_name: 42 })).status).toBe(400);
  });

  it("edits profile metadata without touching role or status", async () => {
    await invite(SUPER, BOB);
    const { status, body } = await call(SUPER, `/api/users/${BOB}`, {
      method: "PATCH",
      ...json({ display_name: "Robert", notes: "renamed" }),
    });
    expect(status).toBe(200);
    expect(body.user).toMatchObject({ display_name: "Robert", notes: "renamed", status: "invited", role: "member" });
  });

  it("PATCH refuses an empty patch and an unknown person", async () => {
    await invite(SUPER, BOB);
    expect((await call(SUPER, `/api/users/${BOB}`, { method: "PATCH", ...json({}) })).status).toBe(400);
    expect(
      (await call(SUPER, "/api/users/ghost@x.com", { method: "PATCH", ...json({ notes: "hi" }) })).status
    ).toBe(404);
  });
});

describe("pause and re-enable", () => {
  it("pausing takes effect immediately on every surface", async () => {
    await invite(SUPER, BOB);
    await req("/admin", as(BOB));
    expect((await disable(SUPER, BOB)).status).toBe(200);

    // API: a distinct code, so a CLI can say something specific.
    const api = await call(BOB, "/api/artifacts");
    expect(api.status).toBe(403);
    expect(api.body.error).toBe("account_disabled");

    // HTML: the explanatory page, not raw JSON.
    const page = await req("/admin", as(BOB, { headers: { Accept: "text/html" } }));
    expect(page.status).toBe(403);
    expect(await page.text()).toContain('data-state="paused"');
  });

  it("pausing revokes their API tokens", async () => {
    await invite(SUPER, BOB);
    const minted = await call(SUPER, "/api/tokens", {
      method: "POST",
      ...json({ name: "bob-cli", owner_email: BOB }),
    });
    const token = minted.body.token;
    expect((await req("/api/artifacts", withToken(token))).status).toBe(200);

    await disable(SUPER, BOB);
    expect((await req("/api/artifacts", withToken(token))).status).toBe(401);
  });

  it("pausing keeps their artifacts", async () => {
    await req(
      "/api/artifacts",
      as(BOB, { method: "POST", body: htmlForm({ title: "Bob's", slug: "bobs" }, "x.html", strToU8("<h1>hi</h1>")) })
    );
    await disable(SUPER, BOB);
    const row = await env.DB.prepare("SELECT owner_email FROM artifacts WHERE slug = 'bobs'").first<any>();
    expect(row?.owner_email).toBe(BOB);
  });

  it("re-enabling restores access but not revoked tokens", async () => {
    await invite(SUPER, BOB);
    await req("/admin", as(BOB));
    const minted = await call(SUPER, "/api/tokens", {
      method: "POST",
      ...json({ name: "bob-cli", owner_email: BOB }),
    });
    await disable(SUPER, BOB);

    const { status, body } = await enable(SUPER, BOB);
    expect(status).toBe(200);
    // Signed in before, so straight back to active rather than "invited" again.
    expect(body.user).toMatchObject({ status: "active", disabled_at: null });
    expect((await call(BOB, "/api/artifacts")).status).toBe(200);
    expect((await req("/api/artifacts", withToken(minted.body.token))).status).toBe(401);
  });

  it("pauses somebody the directory has never met", async () => {
    const { status, body } = await disable(SUPER, "stranger@x.com");
    expect(status).toBe(200);
    expect(body.user).toMatchObject({ status: "disabled", in_directory: true });
    expect(body.user.disabled_at).toBeTruthy();
  });

  it("re-inviting a paused person lifts the pause", async () => {
    await invite(SUPER, BOB);
    await disable(SUPER, BOB);
    const { body } = await invite(SUPER, BOB);
    expect(body.user).toMatchObject({ status: "invited", disabled_at: null });
    expect((await call(BOB, "/api/artifacts")).status).toBe(200);
  });
});

describe("removal", () => {
  it("removes the login, grants and tokens — but never the published work", async () => {
    await req(
      "/api/artifacts",
      as(BOB, { method: "POST", body: htmlForm({ title: "Keep", slug: "keep" }, "x.html", strToU8("<h1>k</h1>")) })
    );
    await call(SUPER, "/api/artifacts/keep/access", {
      method: "PUT",
      ...json({ visibility: "restricted", emails: [CAROL] }),
    });
    const minted = await call(SUPER, "/api/tokens", {
      method: "POST",
      ...json({ name: "carol-cli", owner_email: CAROL }),
    });

    const { status, body } = await remove(SUPER, CAROL);
    expect(status).toBe(200);
    expect(body.removed).toBe(CAROL);
    expect(find(body, CAROL)).toBeUndefined();

    expect((await req("/api/artifacts", withToken(minted.body.token))).status).toBe(401);
    const grants = await env.DB.prepare(
      "SELECT count(*) AS n FROM artifact_grants WHERE email = ?"
    ).bind(CAROL).first<any>();
    expect(grants.n).toBe(0);
    const art = await env.DB.prepare("SELECT slug FROM artifacts WHERE slug = 'keep'").first<any>();
    expect(art?.slug).toBe("keep");
  });

  it("removing somebody who was never in the directory still succeeds", async () => {
    expect((await remove(SUPER, "ghost@x.com")).status).toBe(200);
  });
});

describe("privilege safeguards", () => {
  it("the super admin cannot be paused or removed — not even by themselves", async () => {
    for (const actor of [SUPER, ADMIN2]) {
      expect((await disable(actor, SUPER)).status).toBe(403);
      expect((await remove(actor, SUPER)).status).toBe(403);
      expect((await invite(actor, SUPER)).status).toBe(403);
    }
  });

  it("the super admin reads as active even if the row claims otherwise", async () => {
    // A hand-edited row (or a bug) must not be able to lock the operator out.
    await env.DB.prepare(
      "INSERT INTO users (email, role, status, created_at, disabled_at) VALUES (?, 'super_admin', 'disabled', ?, ?)"
    )
      .bind(SUPER, "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z")
      .run();
    expect((await listUsers(SUPER)).status).toBe(200);
    expect(find((await listUsers()).body, SUPER).status).toBe("active");
  });

  it("a plain admin cannot act on another admin, but the super admin can", async () => {
    expect((await disable(ADMIN2, SUPER)).status).toBe(403);
    // ADMIN2 acting on themselves is blocked by the self-lockout rule too.
    expect((await disable(ADMIN2, ADMIN2)).status).toBe(403);
    expect((await disable(SUPER, ADMIN2)).status).toBe(200);
    expect((await enable(SUPER, ADMIN2)).status).toBe(200);
  });

  it("nobody can pause or remove their own account", async () => {
    await invite(SUPER, BOB);
    expect((await disable(SUPER, SUPER)).status).toBe(403);
    expect((await disable(ADMIN2, ADMIN2)).status).toBe(403);
    expect((await remove(ADMIN2, ADMIN2)).status).toBe(403);
  });

  it("a paused admin row never grants or removes privilege — config is the only source", async () => {
    await disable(SUPER, ADMIN2);
    // Still an admin by configuration...
    expect(find((await listUsers()).body, ADMIN2).role).toBe("admin");
    // ...but paused, so the app refuses them anyway.
    expect((await call(ADMIN2, "/api/users")).status).toBe(403);
  });

  it("writing role into the table cannot escalate anybody", async () => {
    await invite(SUPER, BOB);
    await env.DB.prepare("UPDATE users SET role = 'super_admin' WHERE email = ?").bind(BOB).run();
    expect(find((await listUsers()).body, BOB).role).toBe("member");
    expect((await listUsers(BOB)).status).toBe(403);
  });

  it("an API token can never reach user management, even an admin one", async () => {
    const minted = await call(SUPER, "/api/tokens", {
      method: "POST",
      ...json({ name: "ci", is_admin: true }),
    });
    const t = minted.body.token;
    expect((await req("/api/users", withToken(t))).status).toBe(403);
    expect(
      (await req("/api/users", withToken(t, { method: "POST", ...json({ email: BOB }) }))).status
    ).toBe(403);
    expect((await req(`/api/users/${BOB}/disable`, withToken(t, { method: "POST" }))).status).toBe(403);
    expect((await req(`/api/users/${BOB}`, withToken(t, { method: "DELETE" }))).status).toBe(403);
  });
});

describe("resilience", () => {
  it("authentication still works when the directory table does not exist yet", async () => {
    // Code deployed ahead of migration 0007. Failing open on the *local* layer is
    // deliberate: Access is still the gate, and failing closed would lock out
    // every user including the operator.
    await dropUsersTable();
    expect((await req("/admin", as(BOB))).status).toBe(200);
    expect((await call(BOB, "/api/artifacts")).status).toBe(200);
  });
});

describe("dashboard People panel", () => {
  const dash = async (email: string) => await (await req("/admin/people", as(email))).text();

  it("renders the section for an admin only", async () => {
    expect(await dash(SUPER)).toContain('data-panel="users"');
    const beta = await req("/admin/people", as(BOB));
    expect(beta.status).toBe(404);
    expect(await beta.text()).not.toContain('data-panel="users"');
  });

  it("shows role, status and lifecycle actions per person", async () => {
    await invite(SUPER, BOB, { display_name: "Bob Beta", notes: "design partner" });
    const html = await dash(SUPER);
    expect(html).toContain(`data-user="${BOB}"`);
    expect(html).toContain('data-user-status="invited"');
    expect(html).toContain(`data-user-action="disable" data-user-email="${BOB}"`);
    expect(html).toContain(`data-user-action="remove" data-user-email="${BOB}"`);
    expect(html).toContain("Bob Beta");
    expect(html).toContain("design partner");
  });

  it("offers re-enable rather than pause for a paused person", async () => {
    await invite(SUPER, BOB);
    await disable(SUPER, BOB);
    const html = await dash(SUPER);
    expect(html).toContain('data-user-status="disabled"');
    expect(html).toContain(`data-user-action="enable" data-user-email="${BOB}"`);
    expect(html).not.toContain(`data-user-action="disable" data-user-email="${BOB}"`);
  });

  it("offers no destructive action against the operator, or against yourself", async () => {
    const html = await dash(SUPER);
    expect(html).not.toContain(`data-user-email="${SUPER}"`);
    expect(html).toContain("data-locked");
  });

  it("hides admin-level actions from a plain admin", async () => {
    const html = await dash(ADMIN2);
    expect(html).not.toContain(`data-user-email="${SUPER}"`);
    expect(html).not.toContain(`data-user-email="${ADMIN2}"`);
  });


  it("shows an empty state only when nobody but the operators exist", async () => {
    // Admins always appear, so the list is never truly empty in this config —
    // the point is that it renders rows rather than the empty state.
    expect(await dash(SUPER)).not.toContain('data-empty="users"');
  });
});

describe("login page", () => {
  const page = async (init?: RequestInit) => {
    const res = await req("/login", init);
    return { status: res.status, html: await res.text() };
  };

  it("is public and offers both signup and sign-in paths", async () => {
    const { status, html } = await page({ headers: { "X-Dev-Anonymous": "true" } });
    expect(status).toBe(200);
    expect(html).toContain('data-page="login"');
    expect(html).toContain('data-state="signed-out"');
    expect(html).toContain('data-cta="sign-in"');
    expect(html).toContain('data-cta="signup"');
    expect(html).toContain('href="/signup"');
    // App-owned email OTP stays passwordless: no password field anywhere.
    expect(html).not.toContain('type="password"');
  });

  it("tells a signed-in person who they are and sends them onward", async () => {
    const { status, html } = await page(as(BOB));
    expect(status).toBe(200);
    expect(html).toContain('data-state="signed-in"');
    expect(html).toContain(BOB);
    expect(html).toContain('data-cta="dashboard"');
  });

  it("explains a paused account rather than looking signed out", async () => {
    await invite(SUPER, BOB);
    await disable(SUPER, BOB);
    const { status, html } = await page(as(BOB));
    expect(status).toBe(403);
    expect(html).toContain('data-state="paused"');
    expect(html).toContain(BOB);
  });

  it("sends a paused person to the same explanation from /gallery", async () => {
    await disable(SUPER, BOB);
    const res = await req("/gallery", as(BOB));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('data-state="paused"');
  });

  it("is never served from a content host", async () => {
    const contentEnv = { ...env, CONTENT_HOSTNAMES: "content.test.local" } as any;
    const res = await (await import("../src/index")).default.request(
      "https://content.test.local/login",
      {},
      contentEnv
    );
    expect(res.status).toBe(404);
  });
});

describe("landing page CTAs", () => {
  it("distinguishes starting free from signing in", async () => {
    const html = await (await req("/")).text();
    expect(html).toContain('data-cta="signup"');
    expect(html).toContain('data-cta="sign-in"');
    expect(html).toContain('href="/signup"');
    expect(html).toContain('href="/login"');
    expect(html).toContain("Start free");
  });
});
