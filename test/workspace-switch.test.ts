import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createAccount, ensurePersonalAccount, upsertMember } from "../src/accounts";
import { safeNext } from "../src/workspace-routes";
import { as, htmlForm, initDb, req, withToken } from "./fixtures";

/**
 * Switching the workspace an interactive session acts in.
 *
 * The properties under test are mostly negative, and each is one somebody could
 * plausibly ship a switcher without:
 *
 *  - a selection is honored only for a *current* member, so a cookie cannot
 *    widen reach past what `account_members` already says;
 *  - a stale selection is ignored rather than fatal, so being removed from a
 *    workspace leaves you signed in and on your own one;
 *  - an API token is never moved by a cookie riding on the same request;
 *  - `next` cannot leave the site.
 *
 * The positive case is that the choice actually reaches the three places it has
 * to: what /admin renders, what /api/accounts reports, and — the one that
 * matters most, because it cannot be undone — which workspace a publish lands in.
 */

// vitest.config.ts: admin@test.com is the super admin.
const ALICE = "alice@test.com";
const BOB = "bob@test.com";
const OUTSIDER = "outsider@test.com";

const html = new TextEncoder().encode("<h1>hi</h1>");
const now = () => new Date().toISOString();

beforeEach(async () => {
  await initDb();
});

/** Alice's personal workspace plus a team one she owns. Returns both ids. */
async function twoWorkspaces(): Promise<{ personal: string; team: string }> {
  const personal = await ensurePersonalAccount(env as any, ALICE, now());
  const team = await createAccount(env as any, {
    name: "Acme",
    kind: "team",
    personalEmail: null,
    createdBy: ALICE,
    now: now(),
  });
  await upsertMember(env as any, {
    accountId: team.id,
    email: ALICE,
    role: "owner",
    invitedBy: null,
    now: now(),
  });
  return { personal: personal!.id, team: team.id };
}

/** A Cookie header carrying a workspace selection, as the switch route sets it. */
const selecting = (accountId: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: {
    ...(init.headers as Record<string, string> | undefined),
    Cookie: `rtfx_account=${encodeURIComponent(accountId)}`,
  },
});

/** What `/api/accounts` says this request is acting in. */
async function activeFor(init: RequestInit): Promise<string | null> {
  const res = await req("/api/accounts", init);
  expect(res.status).toBe(200);
  return (await res.json<{ active: string | null }>()).active;
}

/** The `account_id` D1 actually holds for a slug. */
async function accountOf(slug: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT account_id FROM artifacts WHERE slug = ?")
    .bind(slug)
    .first<{ account_id: string | null }>();
  return row?.account_id ?? null;
}

// --- the switcher UI --------------------------------------------------------

describe("the portal header offers a real switcher once there is a choice", () => {
  it("shows a passive chip to somebody with exactly one workspace", async () => {
    const page = await (await req("/admin", as(BOB))).text();
    expect(page).toContain("data-viewer-workspace");
    expect(page).not.toContain("data-workspace-switcher");
  });

  it("lists every workspace, marking the active one, once there are two", async () => {
    const { personal, team } = await twoWorkspaces();
    const page = await (await req("/admin", as(ALICE))).text();

    expect(page).toContain("data-workspace-switcher");
    expect(page).toContain('action="/admin/workspace"');
    // Both are offered…
    expect(page).toContain(`value="${personal}"`);
    expect(page).toContain(`value="${team}"`);
    // …and the personal one is preselected, because nothing has been chosen yet.
    expect(page).toMatch(new RegExp(`value="${personal}" selected`));
    expect(page).not.toMatch(new RegExp(`value="${team}" selected`));
    // Name, kind and role are all on the option, which is what makes two
    // similarly-named workspaces tellable apart.
    expect(page).toContain("Acme · Team · Owner");
  });

  it("preselects the workspace the cookie names", async () => {
    const { personal, team } = await twoWorkspaces();
    const page = await (await req("/admin", as(ALICE, selecting(team)))).text();
    expect(page).toMatch(new RegExp(`value="${team}" selected`));
    expect(page).not.toMatch(new RegExp(`value="${personal}" selected`));
  });

  it("carries the current section back, so switching leaves you where you were", async () => {
    await twoWorkspaces();
    const page = await (await req("/admin/artifacts", as(ALICE))).text();
    expect(page).toContain('<input type="hidden" name="next" value="/admin/artifacts">');
  });
});

// --- POST /admin/workspace --------------------------------------------------

describe("POST /admin/workspace", () => {
  it("sets the selector cookie and redirects back", async () => {
    const { team } = await twoWorkspaces();
    const res = await req(
      "/admin/workspace",
      as(ALICE, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ account_id: team, next: "/admin/artifacts" }),
        redirect: "manual",
      })
    );
    // 303 so a reload of the destination does not re-POST the switch.
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin/artifacts");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(`rtfx_account=${team}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("also answers at /admin/workspace/switch", async () => {
    const { team } = await twoWorkspaces();
    const res = await req(
      "/admin/workspace/switch",
      as(ALICE, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ account_id: team }),
        redirect: "manual",
      })
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin");
  });

  it("404s a workspace the caller does not belong to, and sets no cookie", async () => {
    const { team } = await twoWorkspaces();
    const res = await req(
      "/admin/workspace",
      as(OUTSIDER, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ account_id: team }),
        redirect: "manual",
      })
    );
    // 404 rather than 403: an account id somebody may not act in must be
    // indistinguishable from one that does not exist.
    expect(res.status).toBe(404);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("404s an account id that does not exist at all", async () => {
    await twoWorkspaces();
    const res = await req(
      "/admin/workspace",
      as(ALICE, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ account_id: "acct_deadbeefdeadbeef" }),
        redirect: "manual",
      })
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("refuses a bearer token outright — a token is pinned to its workspace", async () => {
    const { team } = await twoWorkspaces();
    const minted = await req(
      "/api/tokens",
      as(ALICE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "cli" }),
      })
    );
    const { token } = await minted.json<{ token: string }>();

    const res = await req(
      "/admin/workspace",
      withToken(token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ account_id: team }),
        redirect: "manual",
      })
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

// --- open redirects ---------------------------------------------------------

describe("the redirect target cannot leave the site", () => {
  const OFF_SITE = [
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example",
    "\\\\evil.example",
    "/adminfoo", // starts with /admin, is not under it
    "/api/accounts",
    "/login",
    "javascript:alert(1)",
    "/admin/../../evil",
    "/admin\r\nLocation: https://evil.example",
  ];

  it("rejects everything that isn't a relative path under /admin", () => {
    for (const next of OFF_SITE) expect(safeNext(next), next).toBe("/admin");
    // …and non-strings, which is what a crafted form body can send.
    for (const next of [undefined, null, 42, {}, [], ""]) expect(safeNext(next)).toBe("/admin");
  });

  it("keeps a legitimate /admin path, query and fragment included", () => {
    expect(safeNext("/admin")).toBe("/admin");
    expect(safeNext("/admin/artifacts")).toBe("/admin/artifacts");
    expect(safeNext("/admin/artifacts?q=deck")).toBe("/admin/artifacts?q=deck");
    expect(safeNext("/admin/members#seats")).toBe("/admin/members#seats");
  });

  it("sends a browser to /admin rather than off-site, end to end", async () => {
    const { team } = await twoWorkspaces();
    for (const next of ["https://evil.example/", "//evil.example/", "/adminfoo"]) {
      const res = await req(
        "/admin/workspace",
        as(ALICE, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ account_id: team, next }),
          redirect: "manual",
        })
      );
      expect(res.status, next).toBe(303);
      expect(res.headers.get("Location"), next).toBe("/admin");
    }
  });
});

// --- the switch actually takes effect ---------------------------------------

describe("switching changes what the next request acts in", () => {
  it("moves /api/accounts.active", async () => {
    const { personal, team } = await twoWorkspaces();
    expect(await activeFor(as(ALICE))).toBe(personal);
    expect(await activeFor(as(ALICE, selecting(team)))).toBe(team);
  });

  it("moves the workspace /admin renders", async () => {
    const { team } = await twoWorkspaces();
    const before = await (await req("/admin/settings", as(ALICE))).text();
    expect(before).not.toContain('data-badge="workspace-kind">Team<');

    const after = await (await req("/admin/settings", as(ALICE, selecting(team)))).text();
    expect(after).toContain('data-badge="workspace-kind">Team<');
    expect(after).toContain("Acme");
  });

  it("moves the publish target — the change that cannot be undone", async () => {
    const { personal, team } = await twoWorkspaces();

    const mine = await req(
      "/api/artifacts",
      as(ALICE, { method: "POST", body: htmlForm({ title: "Mine", slug: "mine" }, "index.html", html) })
    );
    expect(mine.status).toBe(200);
    expect(await accountOf("mine")).toBe(personal);

    const ours = await req(
      "/api/artifacts",
      as(ALICE, {
        method: "POST",
        body: htmlForm({ title: "Ours", slug: "ours" }, "index.html", html),
        ...selecting(team),
      })
    );
    expect(ours.status).toBe(200);
    expect(await accountOf("ours")).toBe(team);
  });

  it("says where a publish will land, before the file is dropped", async () => {
    const { team } = await twoWorkspaces();
    const page = await (await req("/admin/artifacts", as(ALICE, selecting(team)))).text();
    expect(page).toContain("data-publish-target");
    expect(page).toContain(`data-publish-account="${team}"`);
    expect(page).toMatch(/Publishing to <b>Acme<\/b>/);
  });

  it("moves which workspace's members /admin/members manages", async () => {
    const { team } = await twoWorkspaces();
    await upsertMember(env as any, {
      accountId: team,
      email: BOB,
      role: "member",
      invitedBy: ALICE,
      now: now(),
    });

    const personalPage = await (await req("/admin/members", as(ALICE))).text();
    expect(personalPage).not.toContain(`data-member="${BOB}"`);

    const teamPage = await (await req("/admin/members", as(ALICE, selecting(team)))).text();
    expect(teamPage).toContain(`data-account-id="${team}"`);
    expect(teamPage).toContain(`data-member="${BOB}"`);
  });
});

// --- a selection that stopped being valid -----------------------------------

describe("an unusable selection is ignored, never fatal", () => {
  it("falls back to the personal workspace for an unknown account id", async () => {
    const { personal } = await twoWorkspaces();
    expect(await activeFor(as(ALICE, selecting("acct_deadbeefdeadbeef")))).toBe(personal);
    expect((await req("/admin", as(ALICE, selecting("acct_deadbeefdeadbeef")))).status).toBe(200);
  });

  it("falls back for a workspace that exists but isn't theirs", async () => {
    const { personal } = await twoWorkspaces();
    const theirs = await createAccount(env as any, {
      name: "Someone else",
      kind: "team",
      personalEmail: null,
      createdBy: OUTSIDER,
      now: now(),
    });
    await upsertMember(env as any, {
      accountId: theirs.id,
      email: OUTSIDER,
      role: "owner",
      invitedBy: null,
      now: now(),
    });
    expect(await activeFor(as(ALICE, selecting(theirs.id)))).toBe(personal);
  });

  it("falls back once the membership is revoked, and publishes land at home again", async () => {
    const { personal, team } = await twoWorkspaces();
    expect(await activeFor(as(ALICE, selecting(team)))).toBe(team);

    await env.DB.prepare("DELETE FROM account_members WHERE account_id = ? AND email = ?")
      .bind(team, ALICE)
      .run();

    expect(await activeFor(as(ALICE, selecting(team)))).toBe(personal);
    const res = await req(
      "/api/artifacts",
      as(ALICE, {
        method: "POST",
        body: htmlForm({ title: "After", slug: "after" }, "index.html", html),
        ...selecting(team),
      })
    );
    expect(res.status).toBe(200);
    expect(await accountOf("after")).toBe(personal);
  });

  it("survives a cookie value that isn't an account id at all", async () => {
    const { personal } = await twoWorkspaces();
    for (const junk of ["%E0%A4%A", "../../etc/passwd", "' OR 1=1 --", "x".repeat(400)]) {
      const init = {
        headers: { "X-Dev-Email": ALICE, Cookie: `rtfx_account=${junk}` },
      } satisfies RequestInit;
      expect(await activeFor(init), junk).toBe(personal);
    }
  });
});

// --- API tokens stay pinned -------------------------------------------------

describe("an API token is never moved by an interactive selection", () => {
  it("ignores the cookie on /api/accounts and on publish", async () => {
    const { personal, team } = await twoWorkspaces();
    const minted = await req(
      "/api/tokens",
      as(ALICE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "cli" }),
      })
    );
    const { token } = await minted.json<{ token: string }>();

    // The token was minted against Alice's default (personal) workspace…
    const pinned = await req("/api/accounts", withToken(token));
    const body = await pinned.json<{ active: string | null; pinned: boolean }>();
    expect(body.active).toBe(personal);
    expect(body.pinned).toBe(true);

    // …and a selector cookie smuggled onto the same request changes nothing.
    const withCookie = await req(
      "/api/accounts",
      withToken(token, { headers: { Cookie: `rtfx_account=${team}` } })
    );
    expect((await withCookie.json<{ active: string | null }>()).active).toBe(personal);

    const published = await req(
      "/api/artifacts",
      withToken(token, {
        method: "POST",
        body: htmlForm({ title: "Bot", slug: "bot" }, "index.html", html),
        headers: { Cookie: `rtfx_account=${team}` },
      })
    );
    expect(published.status).toBe(200);
    expect(await accountOf("bot")).toBe(personal);
  });

  it("refuses the JSON switch route with a clear reason", async () => {
    const { team } = await twoWorkspaces();
    const minted = await req(
      "/api/tokens",
      as(ALICE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "cli" }),
      })
    );
    const { token } = await minted.json<{ token: string }>();

    const res = await req(
      "/api/workspace/active",
      withToken(token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: team }),
      })
    );
    expect(res.status).toBe(403);
    expect((await res.json<{ detail: string }>()).detail).toMatch(/pinned/);
  });

  it("never hands a token the list of its owner's other workspaces", async () => {
    const { team } = await twoWorkspaces();
    const minted = await req(
      "/api/tokens",
      as(ALICE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "cli" }),
      })
    );
    const { token } = await minted.json<{ token: string }>();
    const listed = await req("/api/accounts", withToken(token));
    const body = await listed.json<{ accounts: { id: string }[] }>();
    expect(body.accounts.map((a) => a.id)).not.toContain(team);
  });
});

// --- POST /api/workspace/active ---------------------------------------------

describe("POST /api/workspace/active", () => {
  it("switches and reports what the next request will see", async () => {
    const { team } = await twoWorkspaces();
    const res = await req(
      "/api/workspace/active",
      as(ALICE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: team }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ active: string; your_role: string; accounts: { id: string }[] }>();
    expect(body.active).toBe(team);
    expect(body.your_role).toBe("owner");
    expect(body.accounts.map((a) => a.id)).toContain(team);
    expect(res.headers.get("Set-Cookie") ?? "").toContain(`rtfx_account=${team}`);
  });

  it("400s a missing account_id and 404s one that isn't the caller's", async () => {
    const { team } = await twoWorkspaces();
    const missing = await req(
      "/api/workspace/active",
      as(ALICE, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    );
    expect(missing.status).toBe(400);

    const stranger = await req(
      "/api/workspace/active",
      as(OUTSIDER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: team }),
      })
    );
    expect(stranger.status).toBe(404);
    expect(stranger.headers.get("Set-Cookie")).toBeNull();
  });
});
