import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { billingRoutes } from "../src/billing-routes";
import { ensurePersonalAccount, effectivePlan, getAccount, type AccountRow } from "../src/accounts";
import { listAudit } from "../src/audit";
import { parseExpiry } from "../src/platform-routes";
import { as, clearR2, dropOperatorColumns, htmlForm, initDb, req, withToken } from "./fixtures";

/**
 * The operator control plane (Production SaaS plan, Phase 1): `/admin/platform`,
 * the per-account detail page, and the five controls that change what an account
 * may do.
 *
 * Two properties carry most of the weight here, and both are negative:
 *
 *  1. **Only a super admin reaches any of it**, and never through a bearer
 *     token. A plain platform admin manages artifacts and people; comping an
 *     account and suspending one are the operator's, and they are re-checked on
 *     every POST rather than only on the page that renders the form.
 *  2. **Nothing changes without a trail.** Every assertion that a control worked
 *     is paired with one that the audit row exists, because an unaudited
 *     override is the failure this whole subsystem was built to prevent.
 *
 * Assertions are on `data-*` markers rather than copy, matching the rest of the
 * portal suite: wording can be improved without breaking anything here.
 */

// vitest.config.ts: admin@test.com is the super admin, admin2@test.com a plain admin.
const SUPER = "admin@test.com";
const PLATFORM_ADMIN = "admin2@test.com";
const BOB = "bob@test.com";

const NOW = "2026-08-15T09:00:00.000Z";
const html = new TextEncoder().encode("<h1>hi</h1>");

/** Bob's personal workspace, created the way the product creates one. */
async function bobsAccount(): Promise<AccountRow> {
  const account = await ensurePersonalAccount(env as any, BOB, NOW);
  expect(account, "fixture: personal account should be creatable").not.toBeNull();
  return account!;
}

/** A form POST, exactly as the server-rendered page submits one. */
async function post(path: string, email: string, fields: Record<string, string> = {}) {
  return req(
    path,
    as(email, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    })
  );
}

const detailPath = (id: string) => `/admin/platform/accounts/${encodeURIComponent(id)}`;

/** The account detail page's HTML, as the operator sees it. */
async function detailHtml(id: string, email = SUPER): Promise<string> {
  const res = await req(detailPath(id), as(email));
  expect(res.status).toBe(200);
  return res.text();
}

/**
 * The page an operator actually lands on after a control: follow the redirect
 * rather than re-fetching the bare URL, so what is asserted is the page the
 * browser renders — flash message included.
 */
async function follow(res: Response, email = SUPER): Promise<string> {
  expect(res.status).toBe(303);
  const location = res.headers.get("Location");
  expect(location).toBeTruthy();
  const page = await req(location!, as(email));
  expect(page.status).toBe(200);
  return page.text();
}

async function publish(email: string, slug: string) {
  return req(
    "/api/artifacts",
    as(email, { method: "POST", body: htmlForm({ title: slug, slug }, "index.html", html) })
  );
}

beforeEach(async () => {
  await initDb();
  await clearR2();
});

describe("/admin/platform — the operator readouts", () => {
  it("renders every operator panel the plan calls for", async () => {
    const account = await bobsAccount();
    await env.DB.prepare(
      "INSERT INTO contact_requests (email, plan, message, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind("buyer@corp.com", "enterprise", "We need SSO", NOW)
      .run();
    await env.DB.prepare(
      "INSERT INTO billing_events (id, event_name, account_id, processed_at) VALUES (?, ?, ?, ?)"
    )
      .bind("evt_1", "subscription_created", account.id, NOW)
      .run();
    await env.DB.prepare(
      "INSERT INTO mail_log (email, kind, status, error_code, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(BOB, "otp", "failed", "bounced", NOW)
      .run();

    const html = await (await req("/admin/platform", as(SUPER))).text();

    for (const panel of [
      "platform-accounts",
      "platform-audit",
      "platform-contacts",
      "platform-billing",
      "platform-mail",
    ]) {
      expect(html, panel).toContain(`data-panel="${panel}"`);
    }
    // The instance-configuration panels the page already had are still there.
    expect(html).toContain('data-panel="platform-config"');
    expect(html).toContain('data-panel="platform-operators"');

    // The account row carries every column an operator asks about.
    expect(html).toContain(`data-account="${account.id}"`);
    expect(html).toContain(`href="${detailPath(account.id)}"`);
    expect(html).toContain('data-effective-plan="free"');
    expect(html).toContain('data-account-status="active"');
    for (const cell of ["owner", "kind", "members", "artifacts", "storage", "last-publish"]) {
      expect(html, cell).toContain(`data-cell="${cell}"`);
    }
    expect(html).toContain(BOB);

    // And the three feeds that had no operator surface at all before this.
    expect(html).toContain("buyer@corp.com");
    expect(html).toContain("subscription_created");
    expect(html).toContain('data-mail-status="failed"');
  });

  it("filters the account list in SQL, so the limit stays meaningful", async () => {
    const bob = await bobsAccount();
    await ensurePersonalAccount(env as any, "zara@test.com", NOW);

    const hit = await (await req("/admin/platform?q=bob", as(SUPER))).text();
    expect(hit).toContain(`data-account="${bob.id}"`);
    expect(hit).not.toContain("zara@test.com");

    const miss = await (await req("/admin/platform?q=nobody-at-all", as(SUPER))).text();
    expect(miss).toContain('data-empty="accounts"');
  });
});

describe("who may operate this instance", () => {
  it("keeps a plain admin and a member out of the account page and every control", async () => {
    const account = await bobsAccount();
    const paths: [string, Record<string, string>][] = [
      [`${detailPath(account.id)}/plan-override`, { plan: "team" }],
      [`${detailPath(account.id)}/clear-plan-override`, {}],
      [`${detailPath(account.id)}/suspend`, {}],
      [`${detailPath(account.id)}/unsuspend`, {}],
      [`${detailPath(account.id)}/notes`, { notes: "hi" }],
    ];

    for (const who of [PLATFORM_ADMIN, BOB]) {
      // 404, not 403: refusing with "forbidden" would confirm the account id is real.
      expect((await req(detailPath(account.id), as(who))).status, who).toBe(404);
      for (const [path, fields] of paths) {
        expect((await post(path, who, fields)).status, `${who} ${path}`).toBe(404);
      }
    }

    // Nothing leaked through: the account is exactly as it was.
    const after = await getAccount(env as any, account.id);
    expect(after?.plan_override ?? null).toBeNull();
    expect(after?.status).toBe("active");
    expect(await listAudit(env as any, {})).toHaveLength(0);
  });

  it("refuses an API token even when its owner is the super admin", async () => {
    const account = await bobsAccount();
    const create = await req(
      "/api/tokens",
      as(SUPER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ci", owner_email: SUPER, scopes: ["read", "publish"] }),
      })
    );
    expect(create.status).toBe(201);
    const { token } = await create.json<{ token: string }>();

    // `role` is capped at `admin` for every non-interactive caller, so a leaked
    // machine credential can never comp or suspend anything.
    expect((await req(detailPath(account.id), withToken(token))).status).toBe(404);
    const res = await req(
      `${detailPath(account.id)}/suspend`,
      withToken(token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
      })
    );
    expect(res.status).toBe(404);
    expect((await getAccount(env as any, account.id))?.status).toBe("active");
  });

  it("refuses a form posted from another origin", async () => {
    const account = await bobsAccount();
    const res = await req(
      `${detailPath(account.id)}/suspend`,
      as(SUPER, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://evil.example",
        },
        body: "reason=gotcha",
      })
    );
    expect(res.status).toBe(404);
    expect((await getAccount(env as any, account.id))?.status).toBe("active");
  });

  it("answers 404 for an account id that does not exist", async () => {
    expect((await req(detailPath("acct_nope"), as(SUPER))).status).toBe(404);
    expect((await post(`${detailPath("acct_nope")}/suspend`, SUPER)).status).toBe(404);
  });
});

describe("plan override", () => {
  it("applies, shows on the page, and leaves an audit row an operator can read", async () => {
    const account = await bobsAccount();

    const res = await post(`${detailPath(account.id)}/plan-override`, SUPER, {
      plan: "team",
      note: "Comped for the pilot",
    });
    // Post/Redirect/Get: a reload must never re-apply an operator action.
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`${detailPath(account.id)}?ok=override_set`);

    const row = await getAccount(env as any, account.id);
    expect(row?.plan_override).toBe("team");
    expect(row?.plan).toBe("free"); // billing is untouched — that is the whole point
    expect(row?.plan_override_by).toBe(SUPER);
    expect(row?.plan_override_note).toBe("Comped for the pilot");
    expect(effectivePlan(row!)).toBe("team");

    const audit = await listAudit(env as any, { targetId: account.id });
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("account.plan_override_set");
    expect(audit[0].actor_email).toBe(SUPER);
    expect(audit[0].actor_role).toBe("super_admin");

    // Visible in the UI, on both the detail page and the instance-wide trail.
    const detail = await detailHtml(account.id);
    expect(detail).toContain('data-override="active"');
    expect(detail).toContain('data-effective-plan="team"');
    expect(detail).toContain('data-billed-plan="free"');
    expect(detail).toContain('data-audit-action="account.plan_override_set"');
    // The outcome survives the redirect, so the operator sees that it worked.
    expect(await follow(res)).toContain('data-flash="ok"');

    const platform = await (await req("/admin/platform", as(SUPER))).text();
    expect(platform).toContain('data-audit-action="account.plan_override_set"');
    // The list distinguishes what the account gets from what it is billed.
    expect(platform).toContain('data-effective-plan="team"');
    expect(platform).toContain('data-billed-plan="free"');
  });

  it("clears back to the billed plan, and records that too", async () => {
    const account = await bobsAccount();
    await post(`${detailPath(account.id)}/plan-override`, SUPER, { plan: "team" });

    const res = await post(`${detailPath(account.id)}/clear-plan-override`, SUPER);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toContain("ok=override_cleared");

    const row = await getAccount(env as any, account.id);
    expect(row?.plan_override ?? null).toBeNull();
    expect(row?.plan_override_expires_at ?? null).toBeNull();
    expect(effectivePlan(row!)).toBe("free");

    const actions = (await listAudit(env as any, { targetId: account.id })).map((a) => a.action);
    expect(actions).toContain("account.plan_override_cleared");
    expect(await detailHtml(account.id)).toContain('data-override="none"');
  });

  it("refuses a plan this instance cannot enforce, and changes nothing", async () => {
    const account = await bobsAccount();
    const res = await post(`${detailPath(account.id)}/plan-override`, SUPER, { plan: "enterprise" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toContain("err=bad_plan");

    expect((await getAccount(env as any, account.id))?.plan_override ?? null).toBeNull();
    expect(await listAudit(env as any, { targetId: account.id })).toHaveLength(0);
    expect(await follow(res)).toContain('data-flash="error"');
  });

  it("refuses an expiry that has already passed, rather than writing an inert override", async () => {
    const account = await bobsAccount();
    const res = await post(`${detailPath(account.id)}/plan-override`, SUPER, {
      plan: "pro",
      expires_at: "2020-01-01",
    });
    expect(res.headers.get("Location")).toContain("err=bad_expiry");
    expect((await getAccount(env as any, account.id))?.plan_override ?? null).toBeNull();
  });

  it("stores a submitted date as the end of that day, so 'until the 1st' includes the 1st", () => {
    const now = "2026-08-15T09:00:00.000Z";
    expect(parseExpiry("2026-09-01", now)).toBe("2026-09-01T23:59:59.999Z");
    // A full timestamp is taken as written, for anyone driving this with curl.
    expect(parseExpiry("2026-09-01T06:00:00.000Z", now)).toBe("2026-09-01T06:00:00.000Z");
    // Blank means "until an operator removes it"; nonsense and the past are refused.
    expect(parseExpiry(null, now)).toBeNull();
    expect(parseExpiry("not-a-date", now)).toBeUndefined();
    expect(parseExpiry("2026-08-14", now)).toBeUndefined();
  });

  it("renders unimplemented limit and seat overrides as planned, not as dead controls", async () => {
    const account = await bobsAccount();
    const html = await detailHtml(account.id);
    expect(html).toContain('data-planned="limit-overrides"');
    expect(html).toContain('data-planned="seat-overrides"');
    // No form pretends to do either of them.
    expect(html).not.toContain("max_artifacts");
    expect(html).not.toContain("extra_seats");
  });
});

describe("a billing webhook under a live override", () => {
  it("moves the billed plan and leaves the override winning", async () => {
    const account = await bobsAccount();
    await post(`${detailPath(account.id)}/plan-override`, SUPER, { plan: "team" });

    const body = JSON.stringify({
      meta: { event_name: "subscription_created", custom_data: { account_id: account.id } },
      data: { type: "subscriptions", id: "sub_1", attributes: { store_id: 1, variant_id: "1001", status: "active" } },
    });
    const secret = "whsec_test_lemonsqueezy_secret";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const signature = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

    const res = await billingRoutes.request(
      "https://rtfx.pro/api/billing/webhook",
      {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json", "X-Signature": signature },
      },
      {
        ...(env as any),
        LEMONSQUEEZY_WEBHOOK_SECRET: secret,
        LEMONSQUEEZY_STORE_ID: "rtfx-store",
        LEMONSQUEEZY_VARIANT_PRO: "1001",
        LEMONSQUEEZY_VARIANT_TEAM: "2002",
      }
    );
    expect(res.status).toBe(200);

    const row = await getAccount(env as any, account.id);
    // Billing wrote its own column, and could not reach the operator's.
    expect(row?.plan).toBe("pro");
    expect(row?.plan_override).toBe("team");
    expect(effectivePlan(row!)).toBe("team");

    // The collision is recorded, so "why is this account on Team while paying
    // for Pro?" is answerable six months later.
    const actions = (await listAudit(env as any, { targetId: account.id })).map((a) => a.action);
    expect(actions).toContain("billing.plan_change_under_override");

    const html = await detailHtml(account.id);
    expect(html).toContain('data-effective-plan="team"');
    expect(html).toContain('data-billed-plan="pro"');
    expect(html).toContain('data-audit-action="billing.plan_change_under_override"');
  });
});

describe("suspension", () => {
  it("stops the workspace publishing, with an error that says what happened", async () => {
    const account = await bobsAccount();
    expect((await publish(BOB, "before")).status).toBe(200);

    const res = await post(`${detailPath(account.id)}/suspend`, SUPER, {
      reason: "Chargeback opened",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toContain("ok=suspended");

    const blocked = await publish(BOB, "during");
    expect(blocked.status).toBe(403);
    const body = await blocked.json<{ error: string; detail: string }>();
    expect(body.error).toBe("account_suspended");
    // The customer must learn that nothing was deleted and who to talk to,
    // rather than being handed a bare "forbidden".
    expect(body.detail).toMatch(/suspended/i);
    expect(body.detail).toMatch(/nothing has been deleted/i);

    const row = await getAccount(env as any, account.id);
    expect(row?.status).toBe("suspended");
    expect(row?.suspended_by).toBe(SUPER);
    expect(row?.suspended_reason).toBe("Chargeback opened");

    const audit = await listAudit(env as any, { targetId: account.id });
    expect(audit[0].action).toBe("account.suspended");

    const html = await detailHtml(account.id);
    expect(html).toContain('data-account-status="suspended"');
    expect(html).toContain('data-form="unsuspend"');
    expect(html).not.toContain('data-form="suspend"');
  });

  it("restores publishing when the suspension is lifted", async () => {
    const account = await bobsAccount();
    await post(`${detailPath(account.id)}/suspend`, SUPER, { reason: "Chargeback opened" });
    expect((await publish(BOB, "during")).status).toBe(403);

    const res = await post(`${detailPath(account.id)}/unsuspend`, SUPER);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toContain("ok=unsuspended");

    expect((await publish(BOB, "after")).status).toBe(200);

    const row = await getAccount(env as any, account.id);
    expect(row?.status).toBe("active");
    expect(row?.suspended_at ?? null).toBeNull();
    // The reason is history, and history is what this subsystem exists to keep.
    expect(row?.suspended_reason).toBe("Chargeback opened");

    const actions = (await listAudit(env as any, { targetId: account.id })).map((a) => a.action);
    expect(actions).toContain("account.unsuspended");
    expect(await detailHtml(account.id)).toContain('data-account-status="active"');
  });

  it("refuses to suspend twice, or to unsuspend what is not suspended", async () => {
    const account = await bobsAccount();
    expect((await post(`${detailPath(account.id)}/unsuspend`, SUPER)).headers.get("Location")).toContain(
      "err=not_suspended"
    );
    await post(`${detailPath(account.id)}/suspend`, SUPER);
    expect((await post(`${detailPath(account.id)}/suspend`, SUPER)).headers.get("Location")).toContain(
      "err=already_suspended"
    );
    // One suspension, one audit row — a no-op never writes a trail.
    const audit = await listAudit(env as any, { targetId: account.id });
    expect(audit.filter((a) => a.action === "account.suspended")).toHaveLength(1);
  });
});

describe("operator notes", () => {
  it("saves, redisplays and audits a note without copying it into the trail", async () => {
    const account = await bobsAccount();
    const res = await post(`${detailPath(account.id)}/notes`, SUPER, {
      notes: "Invoices by bank transfer",
    });
    expect(res.headers.get("Location")).toContain("ok=notes_saved");
    expect((await getAccount(env as any, account.id))?.notes).toBe("Invoices by bank transfer");

    const audit = await listAudit(env as any, { targetId: account.id });
    expect(audit[0].action).toBe("account.notes_updated");
    // The text itself stays on the account; the trail records only that it moved.
    expect(audit[0].detail ?? "").not.toContain("bank transfer");

    expect(await detailHtml(account.id)).toContain("Invoices by bank transfer");
  });

  it("refuses an over-long note rather than silently storing half of it", async () => {
    const account = await bobsAccount();
    const res = await post(`${detailPath(account.id)}/notes`, SUPER, { notes: "x".repeat(2001) });
    expect(res.headers.get("Location")).toContain("err=notes_too_long");
    expect((await getAccount(env as any, account.id))?.notes ?? null).toBeNull();
  });

  it("clears the note when the box is submitted empty", async () => {
    const account = await bobsAccount();
    await post(`${detailPath(account.id)}/notes`, SUPER, { notes: "temporary" });
    await post(`${detailPath(account.id)}/notes`, SUPER, { notes: "" });
    expect((await getAccount(env as any, account.id))?.notes ?? null).toBeNull();
  });
});

describe("a Worker deployed ahead of migration 0018", () => {
  it("still renders the platform page, with the operator reads failing soft to empty", async () => {
    await bobsAccount();
    await dropOperatorColumns();

    // Never a 500: an operator page that dies on an un-migrated instance is the
    // one page you cannot afford to lose while diagnosing that instance.
    const res = await req("/admin/platform", as(SUPER));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-panel="platform-accounts"');
    expect(html).toContain('data-panel="platform-audit"');
    expect(html).toContain('data-empty="audit"');
    // The accounts list reads `SELECT *`, so it survives the missing columns and
    // every account simply reports no override.
    expect(html).toContain('data-effective-plan="free"');
  });

  it("keeps publishing working, since suspension is a column that isn't there", async () => {
    await bobsAccount();
    await dropOperatorColumns();
    expect((await publish(BOB, "still-fine")).status).toBe(200);
  });
});

describe("flash messages", () => {
  it("renders only outcomes this app produces, never text from the query string", async () => {
    const account = await bobsAccount();
    const injected = await (
      await req(`${detailPath(account.id)}?ok=${encodeURIComponent("<script>alert(1)</script>")}`, as(SUPER))
    ).text();
    expect(injected).not.toContain("<script>alert(1)</script>");
    // No banner at all: a code that isn't one of ours renders nothing.
    expect(injected).not.toContain('data-flash="');
  });
});
