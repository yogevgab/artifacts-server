import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { strToU8 } from "fflate";
import { initDb, clearR2, req, htmlForm } from "./fixtures";
import { withoutGrant, withAddedGrant, grantRowsFor, accessPanel } from "../src/admin";
import { mailStatusFor } from "../src/db";
import type { ViewerSummary } from "../src/db";
import type { ArtifactRow } from "../src/env";

/** Enough of an ArtifactRow to render accessPanel() directly, bypassing the
 * `/admin/artifacts/:slug` HTTP route — which is how the two delivery-failure
 * tests below exercise the real `mailStatusFor` read helper feeding real
 * markup, without requiring src/index.ts to be wired up (out of scope here;
 * see the report). */
function fixtureRow(slug: string): ArtifactRow {
  return {
    slug,
    title: slug,
    description: null,
    type: "single",
    entry: "index.html",
    file_count: 1,
    size_bytes: 10,
    created_by: "admin@test.com",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    visibility: "restricted",
    current_version: 1,
    owner_email: "admin@test.com",
  } as ArtifactRow;
}

/**
 * The per-artifact access panel (issue: the owner reported the "allowed
 * emails" textarea as dangerous — editing the text could silently drop
 * someone else's access, and a typo was accepted without complaint).
 *
 * This replaces it with a person-per-row list. The tests below pin three
 * things the old textarea could not do:
 *
 *  - a row per grantee with its own, independently-labelled remove control,
 *    so removing one address is structurally incapable of touching another;
 *  - honest per-row state — "never opened" vs. a real last-opened timestamp,
 *    both from `viewersFor` (already exercised by analytics.test.ts);
 *  - a plain statement when the most recent mail_log entry for an address
 *    failed, which used to require reading the database directly.
 */

beforeEach(async () => {
  await initDb();
  await clearR2();
});

const publish = (slug: string, title: string) =>
  req("/api/artifacts", {
    method: "POST",
    body: htmlForm({ title, slug }, "x.html", strToU8(`<h1>${slug}</h1>`)),
  });

const setAccess = (slug: string, emails: string[], visibility = "restricted") =>
  req(`/api/artifacts/${slug}/access`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visibility, emails }),
  });

const detail = async (slug: string) => await (await req(`/admin/artifacts/${slug}`)).text();

async function seedView(slug: string, email: string, viewed_at: string, version = 1) {
  await env.DB.prepare(
    `INSERT INTO artifact_views (slug, version, email, path, country, referrer, viewed_at)
     VALUES (?, ?, ?, '', NULL, NULL, ?)`
  )
    .bind(slug, version, email, viewed_at)
    .run();
}

async function seedMail(email: string, status: "sent" | "failed", created_at: string, errorCode?: string) {
  await env.DB.prepare(
    `INSERT INTO mail_log (email, kind, status, error_code, created_at) VALUES (?, 'share_notice', ?, ?, ?)`
  )
    .bind(email, status, errorCode ?? null, created_at)
    .run();
}

describe("access panel: one row per grantee", () => {
  it("renders a separate row for each granted address", async () => {
    await publish("multi", "Multi");
    await setAccess("multi", ["dana@acme.com", "sam@acme.com"]);
    const page = await detail("multi");
    expect(page).toContain('data-grant="dana@acme.com"');
    expect(page).toContain('data-grant="sam@acme.com"');
  });

  it("gives every row its own remove control naming exactly that address", async () => {
    await publish("named", "Named");
    await setAccess("named", ["dana@acme.com", "sam@acme.com"]);
    const page = await detail("named");
    expect(page).toContain('aria-label="Remove dana@acme.com"');
    expect(page).toContain('aria-label="Remove sam@acme.com"');
    // Each remove button is scoped to one address, not a shared textarea.
    expect(page).toContain('data-remove-grant="dana@acme.com"');
    expect(page).toContain('data-remove-grant="sam@acme.com"');
  });

  it("no longer offers a single textarea that can replace the whole list", async () => {
    await publish("notextarea", "NoTextarea");
    await setAccess("notextarea", ["dana@acme.com"]);
    const page = await detail("notextarea");
    expect(page).not.toMatch(/<textarea[^>]*name="emails"/);
  });

  it("keeps the visibility selector exactly as it was", async () => {
    await publish("vis", "Vis");
    const page = await detail("vis");
    expect(page).toContain("Restricted — only the people you list (plus admins)");
    expect(page).toContain("Everyone — any signed-in user");
  });

  it("has an add-email input and button with an accessible name, plus a hidden inline error region", async () => {
    await publish("addctl", "AddCtl");
    const page = await detail("addctl");
    expect(page).toMatch(/<label for="add-em-addctl">/);
    expect(page).toContain('id="add-em-addctl"');
    expect(page).toContain('data-add-grant="addctl"');
    expect(page).toMatch(/data-add-error[^>]*role="alert"[^>]*hidden/);
  });

  it("puts access-panel status changes in a live region", async () => {
    await publish("live", "Live");
    const page = await detail("live");
    expect(page).toMatch(/class="status acc-status"[^>]*aria-live="polite"/);
  });
});

describe("access panel: per-row state that used to have nowhere to live", () => {
  it("says plainly that an address has never opened it", async () => {
    await publish("never", "Never");
    await setAccess("never", ["ghost@acme.com"]);
    const page = await detail("never");
    expect(page.toLowerCase()).toMatch(/ghost@acme\.com[\s\S]{0,200}hasn't opened it yet/);
  });

  it("shows when an address actually opened it, from artifact_views", async () => {
    await publish("opened", "Opened");
    await setAccess("opened", ["reader@acme.com"]);
    await seedView("opened", "reader@acme.com", "2026-01-02T10:00:00Z");
    const page = await detail("opened");
    expect(page).toMatch(/reader@acme\.com[\s\S]{0,200}Last opened[\s\S]{0,60}2026-01-02/);
  });

  // These two exercise accessPanel() directly with a mailStatus map built by
  // the real mailStatusFor() against seeded mail_log rows — the same
  // rendering code the HTTP route uses, minus src/index.ts actually calling
  // mailStatusFor and threading it through (that wiring is out of this task's
  // scope; see the report).
  it("says plainly when mail to an address most recently failed", async () => {
    await seedMail("bounced@acme.com", "failed", "2026-01-01T00:00:00Z", "E_RECIPIENT_SUPPRESSED");
    const mailStatus = await mailStatusFor(env as any, ["bounced@acme.com"]);
    const page = accessPanel(fixtureRow("bounced"), ["bounced@acme.com"], [], mailStatus);
    expect(page).toMatch(/bounced@acme\.com[\s\S]{0,300}couldn't deliver mail to this address/);
    expect(page).toContain("Delivery failed");
  });

  it("only trusts the most recent mail_log entry, not any historical failure", async () => {
    await seedMail("recovered@acme.com", "failed", "2026-01-01T00:00:00Z");
    await seedMail("recovered@acme.com", "sent", "2026-01-05T00:00:00Z");
    const mailStatus = await mailStatusFor(env as any, ["recovered@acme.com"]);
    const page = accessPanel(fixtureRow("recovered"), ["recovered@acme.com"], [], mailStatus);
    expect(page).not.toContain("couldn't deliver mail to this address");
  });

  it("never renders access panel for someone who does not manage the artifact", async () => {
    await publish("notmine", "NotMine");
    await setAccess("notmine", ["someone@acme.com"]);
    const res = await req("/admin/artifacts/notmine", { headers: { "X-Dev-Email": "bob@beta.com" } });
    expect(res.status).toBe(404);
  });
});

describe("mailStatusFor (src/db.ts)", () => {
  it("returns nothing for an email with no mail_log entries", async () => {
    const map = await mailStatusFor(env as any, ["nobody@acme.com"]);
    expect(map.has("nobody@acme.com")).toBe(false);
  });

  it("returns only the most recent status per email", async () => {
    await seedMail("a@x.com", "failed", "2026-01-01T00:00:00Z");
    await seedMail("a@x.com", "sent", "2026-01-02T00:00:00Z");
    const map = await mailStatusFor(env as any, ["a@x.com"]);
    expect(map.get("a@x.com")?.status).toBe("sent");
  });

  it("keeps different addresses' logs separate", async () => {
    await seedMail("a@x.com", "failed", "2026-01-01T00:00:00Z");
    await seedMail("b@x.com", "sent", "2026-01-01T00:00:00Z");
    const map = await mailStatusFor(env as any, ["a@x.com", "b@x.com"]);
    expect(map.get("a@x.com")?.status).toBe("failed");
    expect(map.get("b@x.com")?.status).toBe("sent");
  });
});

describe("grantRowsFor (src/admin.ts): the display state behind each row", () => {
  it("marks an address with no view history as never opened", () => {
    const rows = grantRowsFor(["ghost@acme.com"], [], new Map());
    expect(rows[0].status.toLowerCase()).toContain("hasn't opened it yet");
    expect(rows[0].mailFailed).toBe(false);
  });

  it("matches viewer summaries case-insensitively", () => {
    const viewers: ViewerSummary[] = [
      { email: "Reader@Acme.com", views: 3, lastVersion: 2, lastViewedAt: "2026-01-01T00:00:00Z" },
    ];
    const rows = grantRowsFor(["reader@acme.com"], viewers, new Map());
    expect(rows[0].status).toContain("Last opened");
    expect(rows[0].status).toContain("v2");
  });

  it("flags a row whose last mail_log entry failed", () => {
    const rows = grantRowsFor(
      ["bounced@acme.com"],
      [],
      new Map([["bounced@acme.com", { status: "failed", kind: "share_notice", errorCode: "E_X", createdAt: "2026-01-01T00:00:00Z" }]])
    );
    expect(rows[0].mailFailed).toBe(true);
    expect(rows[0].status).toContain("couldn't deliver mail to this address");
  });
});

describe("withoutGrant / withAddedGrant (src/admin.ts): the pure arithmetic behind Add/Remove", () => {
  it("removing one address leaves the others in the submitted list", () => {
    expect(withoutGrant(["dana@acme.com", "sam@acme.com"], "dana@acme.com")).toEqual(["sam@acme.com"]);
  });

  it("removal is case-insensitive", () => {
    expect(withoutGrant(["Dana@Acme.com", "sam@acme.com"], "dana@acme.com")).toEqual(["sam@acme.com"]);
  });

  it("removing an address not in the list changes nothing", () => {
    expect(withoutGrant(["sam@acme.com"], "nope@acme.com")).toEqual(["sam@acme.com"]);
  });

  it("adds a new address to the end of the list", () => {
    expect(withAddedGrant(["sam@acme.com"], "dana@acme.com")).toEqual(["sam@acme.com", "dana@acme.com"]);
  });

  it("does not add a duplicate, case-insensitively", () => {
    expect(withAddedGrant(["sam@acme.com"], "Sam@Acme.com")).toEqual(["sam@acme.com"]);
  });

  it("ignores a blank address", () => {
    expect(withAddedGrant(["sam@acme.com"], "   ")).toEqual(["sam@acme.com"]);
  });
});
