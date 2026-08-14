import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { ArtifactRow, ViewRow } from "../src/env";
import { recordViewAndMaybeNotify } from "../src/read-receipts";
import { hasViewed, readReceiptsEnabled, setReadReceipts } from "../src/db";
import { initDb } from "./fixtures";

const OWNER = "owner@rtfx.pro";
const VIEWER = "dana@acme.com";
const AT = "2026-08-14T12:00:00.000Z";

function artifact(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    slug: "report",
    title: "Q3 Report",
    description: null,
    type: "single",
    entry: "index.html",
    file_count: 1,
    size_bytes: 100,
    created_by: OWNER,
    created_at: AT,
    updated_at: AT,
    visibility: "restricted",
    current_version: 1,
    owner_email: OWNER,
    account_id: null,
    read_receipts: 1,
    ...overrides,
  };
}

function view(overrides: Partial<ViewRow> = {}): ViewRow {
  return {
    slug: "report",
    version: 1,
    email: VIEWER,
    path: "",
    country: "US",
    referrer: null,
    viewed_at: AT,
    ...overrides,
  };
}

function envWith(send: (m: any) => Promise<any>) {
  return { ...(env as any), EMAIL: { send }, MAIL_FROM: "no-reply@rtfx.pro" };
}

beforeEach(initDb);

describe("recordViewAndMaybeNotify", () => {
  it("emails the owner once on a first view, naming the viewer and the artifact", async () => {
    let seen: any;
    const e = envWith(async (m) => {
      seen = m;
      return { messageId: "m1" };
    });
    await recordViewAndMaybeNotify(e, view(), artifact());

    expect(seen).toBeDefined();
    expect(seen.to).toBe(OWNER);
    expect(seen.subject).toContain(VIEWER);
    expect(seen.subject).toContain("Q3 Report");
    expect(seen.html).toContain(VIEWER);
    expect(seen.html).toContain("Q3 Report");
  });

  it("still logs the view row", async () => {
    await recordViewAndMaybeNotify(envWith(async () => ({ messageId: "m1" })), view(), artifact());
    const row = await env.DB.prepare("SELECT * FROM artifact_views WHERE slug = ? AND email = ?")
      .bind("report", VIEWER)
      .first<any>();
    expect(row).toBeTruthy();
    expect(row.version).toBe(1);
  });

  it("does not email again on a second view by the same person", async () => {
    let calls = 0;
    const e = envWith(async () => {
      calls++;
      return { messageId: "m1" };
    });
    await recordViewAndMaybeNotify(e, view({ viewed_at: AT }), artifact());
    await recordViewAndMaybeNotify(e, view({ viewed_at: "2026-08-14T13:00:00.000Z" }), artifact());
    expect(calls).toBe(1);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM artifact_views WHERE slug = ? AND email = ?")
      .bind("report", VIEWER)
      .first<{ n: number }>();
    expect(count?.n).toBe(2); // both views are still logged — only the mail is deduped
  });

  it("never emails for the owner's own view", async () => {
    let calls = 0;
    const e = envWith(async () => {
      calls++;
      return { messageId: "m1" };
    });
    await recordViewAndMaybeNotify(e, view({ email: OWNER }), artifact());
    expect(calls).toBe(0);

    const row = await env.DB.prepare("SELECT * FROM artifact_views WHERE email = ?").bind(OWNER).first<any>();
    expect(row).toBeTruthy(); // the view itself is still recorded
  });

  it("never emails for an anonymous view (no identity to name)", async () => {
    let calls = 0;
    const e = envWith(async () => {
      calls++;
      return { messageId: "m1" };
    });
    await recordViewAndMaybeNotify(e, view({ email: null }), artifact());
    expect(calls).toBe(0);
  });

  it("is suppressed by the owner's read_receipts=0 setting", async () => {
    let calls = 0;
    const e = envWith(async () => {
      calls++;
      return { messageId: "m1" };
    });
    await recordViewAndMaybeNotify(e, view(), artifact({ read_receipts: 0 }));
    expect(calls).toBe(0);

    // The view is still logged even though the notification is off.
    const row = await env.DB.prepare("SELECT * FROM artifact_views WHERE email = ?").bind(VIEWER).first<any>();
    expect(row).toBeTruthy();
  });

  it("treats a missing/NULL read_receipts as enabled (default ON)", async () => {
    let calls = 0;
    const e = envWith(async () => {
      calls++;
      return { messageId: "m1" };
    });
    const { read_receipts, ...rest } = artifact();
    await recordViewAndMaybeNotify(e, view(), rest as ArtifactRow);
    expect(calls).toBe(1);
  });

  it("never throws when mail delivery fails, and the view is still logged", async () => {
    const e = envWith(async () => {
      throw Object.assign(new Error("boom"), { code: "E_RECIPIENT_SUPPRESSED" });
    });
    await expect(recordViewAndMaybeNotify(e, view(), artifact())).resolves.toBeUndefined();
    const row = await env.DB.prepare("SELECT * FROM artifact_views WHERE email = ?").bind(VIEWER).first<any>();
    expect(row).toBeTruthy();
  });

  it("case-folds the viewer address against the owner address", async () => {
    let calls = 0;
    const e = envWith(async () => {
      calls++;
      return { messageId: "m1" };
    });
    await recordViewAndMaybeNotify(
      e,
      view({ email: "Owner@RTFX.pro" }),
      artifact({ owner_email: "owner@rtfx.pro" })
    );
    expect(calls).toBe(0);
  });
});

describe("hasViewed", () => {
  beforeEach(initDb);

  it("is false before any view is logged, true after", async () => {
    expect(await hasViewed(env as any, "report", VIEWER)).toBe(false);
    await recordViewAndMaybeNotify(
      { ...(env as any), EMAIL: undefined },
      view(),
      artifact()
    );
    expect(await hasViewed(env as any, "report", VIEWER)).toBe(true);
  });
});

describe("readReceiptsEnabled", () => {
  it("is true for 1 and for a missing column, false only for an explicit 0", () => {
    expect(readReceiptsEnabled({ read_receipts: 1 })).toBe(true);
    expect(readReceiptsEnabled({ read_receipts: undefined })).toBe(true);
    expect(readReceiptsEnabled({ read_receipts: null })).toBe(true);
    expect(readReceiptsEnabled({ read_receipts: 0 })).toBe(false);
  });
});

describe("setReadReceipts", () => {
  beforeEach(async () => {
    await initDb();
    await env.DB.prepare(
      `INSERT INTO artifacts (slug, title, type, entry, created_at, updated_at, visibility, current_version, owner_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind("report", "Q3 Report", "single", "index.html", AT, AT, "restricted", 1, OWNER)
      .run();
  });

  it("flips the flag off and on", async () => {
    await setReadReceipts(env as any, "report", false, AT);
    let row = await env.DB.prepare("SELECT read_receipts FROM artifacts WHERE slug = ?").bind("report").first<any>();
    expect(row.read_receipts).toBe(0);

    await setReadReceipts(env as any, "report", true, AT);
    row = await env.DB.prepare("SELECT read_receipts FROM artifacts WHERE slug = ?").bind("report").first<any>();
    expect(row.read_receipts).toBe(1);
  });
});
