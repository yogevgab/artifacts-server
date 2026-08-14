import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { mintSession } from "../src/session";
import { createShareLink } from "../src/share";
import { initDb, clearR2, req, as } from "./fixtures";

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const CONTENT = "https://a.rtfx.pro";
const OWNER = "owner@rtfx.pro";
const GRANTEE = "dana@acme.com";
const NOW = () => new Date().toISOString();

function e(extra: Record<string, unknown> = {}) {
  return {
    ...(env as any),
    SESSION_SECRET: SECRET,
    DEV_LOGIN: undefined,
    CONTENT_HOSTNAMES: "a.rtfx.pro",
    PUBLIC_BASE_URL: "https://rtfx.pro",
    ADMIN_EMAILS: OWNER,
    ...extra,
  };
}

const ws = (cookie?: string) => ({
  headers: { Upgrade: "websocket", ...(cookie ? { Cookie: cookie } : {}) },
});

const session = async (email: string, kind: "member" | "guest", slug?: string) =>
  `${SESSION_COOKIE}=${await mintSession(SECRET, { email, kind, ...(slug ? { slug } : {}) }, NOW())}`;

beforeEach(async () => {
  await initDb();
  await clearR2();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS share_links (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, token_hash TEXT NOT NULL,
      created_by TEXT NOT NULL, expires_at TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL, last_used_at TEXT)`
  ).run();
  const body = new FormData();
  body.set("slug", "report");
  body.set("title", "Report");
  body.set("visibility", "restricted");
  body.set("file", new File(["<h1>x</h1>"], "index.html", { type: "text/html" }));
  await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
  await req("/api/artifacts/report/access", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visibility: "restricted", emails: [GRANTEE] }),
    ...as(OWNER),
  });
});

/**
 * The whole authorization boundary for chat is the Worker handler. The Durable
 * Object never sees a credential, so every one of these is the only thing
 * standing between a stranger and a private conversation.
 */
describe("who may open a chat socket", () => {
  it("lets the owner in", async () => {
    const res = await app.request(`${CONTENT}/_chat/report`, ws(await session(OWNER, "member")), e());
    expect(res.status).toBe(101);
  });

  it("lets a granted member in", async () => {
    const res = await app.request(`${CONTENT}/_chat/report`, ws(await session(GRANTEE, "member")), e());
    expect(res.status).toBe(101);
  });

  it("lets a guest bound to this artifact in", async () => {
    const res = await app.request(
      `${CONTENT}/_chat/report`,
      ws(await session(GRANTEE, "guest", "report")),
      e()
    );
    expect(res.status).toBe(101);
  });

  it("refuses a stranger", async () => {
    const res = await app.request(
      `${CONTENT}/_chat/report`,
      ws(await session("nobody@example.com", "member")),
      e()
    );
    expect(res.status).toBe(404);
  });

  it("refuses somebody with no credential at all", async () => {
    const res = await app.request(`${CONTENT}/_chat/report`, ws(), e());
    expect(res.status).toBe(404);
  });

  it("refuses a guest bound to a DIFFERENT artifact", async () => {
    const res = await app.request(
      `${CONTENT}/_chat/report`,
      ws(await session(GRANTEE, "guest", "something-else")),
      e()
    );
    expect(res.status).toBe(404);
  });

  it("refuses a grantee whose grant was revoked", async () => {
    await req("/api/artifacts/report/access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "restricted", emails: [] }),
      ...as(OWNER),
    });
    const res = await app.request(`${CONTENT}/_chat/report`, ws(await session(GRANTEE, "member")), e());
    expect(res.status).toBe(404);
  });

  it("refuses a room for an artifact that does not exist", async () => {
    const res = await app.request(`${CONTENT}/_chat/no-such-thing`, ws(await session(OWNER, "member")), e());
    expect(res.status).toBe(404);
  });

  it("refuses a plain GET that is not an upgrade", async () => {
    const res = await app.request(`${CONTENT}/_chat/report`, { headers: { Cookie: await session(OWNER, "member") } }, e());
    expect(res.status).toBe(426);
  });

  it("lets a share-link holder in", async () => {
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: NOW() });
    const res = await app.request(
      `${CONTENT}/_chat/report`,
      { headers: { Upgrade: "websocket", Cookie: `rtfx_link_report=${link.key}` } },
      e()
    );
    expect(res.status).toBe(101);
  });
});

describe("the chat path is reserved, not a slug", () => {
  it("cannot be published as an artifact", async () => {
    const body = new FormData();
    body.set("slug", "_chat");
    body.set("title", "sneaky");
    body.set("file", new File(["<p>x</p>"], "index.html", { type: "text/html" }));
    const res = await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
    expect(res.status).toBe(400);
  });
});

describe("the chat UI appears for everyone who can see the artifact", () => {
  const nav = (cookie: string) => ({
    headers: { "Sec-Fetch-Dest": "document", Cookie: cookie },
  });

  it("offers chat to the owner", async () => {
    const html = await (await app.request(`${CONTENT}/report/`, nav(await session(OWNER, "member")), e())).text();
    expect(html).toContain("data-open-chat");
    expect(html).toContain("data-chat-form");
  });

  it("offers chat to a guest — being sent a document is enough to talk about it", async () => {
    const html = await (
      await app.request(`${CONTENT}/report/`, nav(await session(GRANTEE, "guest", "report")), e())
    ).text();
    expect(html).toContain("data-open-chat");
    // ...but never the share controls.
    expect(html).not.toContain("data-share-banner");
  });
});
