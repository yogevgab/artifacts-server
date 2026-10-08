import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { strToU8, zipSync } from "fflate";
import app from "../src/index";
import { initDb, clearR2, req, as } from "./fixtures";
import { MCP_PATH } from "../src/mcp";
import { brandedPathParts } from "../src/account-slugs";
import { reservedTopLevelSegments } from "../src/host";
import { hashToken } from "../src/tokens";
import { createUploadSession } from "../src/upload-sessions";

/**
 * create_upload_link (MCP) + POST /api/uploads/:token + GET /u/:token.
 *
 * The thing under test is a credential that lives in a URL path, so most of
 * these tests are about what the token can and can not do: one upload, to the
 * destination the creator was already allowed to publish to, as the creator.
 */

const BOB = "bob@beta.com";
const EVE = "eve@evil.com";
const HTML = "<!doctype html><html><body>hi</body></html>";

beforeEach(async () => {
  await initDb();
  await clearR2();
});

async function tokenFor(email: string, body: Record<string, unknown> = { name: "mcp", scopes: ["read", "publish"] }) {
  const res = await req(
    "/api/tokens",
    as(email, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as any).token as string;
}

const rpc = (token: string, name: string, args: Record<string, unknown>) =>
  req(MCP_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });

/** Call create_upload_link and return the structured facts (or the error result). */
async function link(token: string, args: Record<string, unknown>) {
  const body = (await (await rpc(token, "create_upload_link", args)).json()) as any;
  const result = body.result;
  const facts = JSON.parse(result.content[result.content.length - 1].text);
  return { result, facts, error: body.error };
}

async function newLink(owner = BOB, args: Record<string, unknown> = { title: "My Site", slug: "my-site" }) {
  const { facts } = await link(await tokenFor(owner), args);
  expect(facts.ok).toBe(true);
  const token = String(facts.upload_url).split("/").pop()!;
  return { facts, token };
}

const post = (token: string, init: RequestInit) => req(`/api/uploads/${token}`, { method: "POST", ...init });

function multipart(files: Array<{ path: string; body: string | Uint8Array; sendPath?: boolean }>) {
  const fd = new FormData();
  for (const f of files) {
    const bytes = typeof f.body === "string" ? strToU8(f.body) : f.body;
    if (f.sendPath !== false) fd.append("path", f.path);
    fd.append("file", new File([bytes], f.path.split("/").pop()!), f.path.split("/").pop());
  }
  return fd;
}

const zipOf = (files: Record<string, string | Uint8Array>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v])));

const bundleForm = (bytes: Uint8Array) => {
  const fd = new FormData();
  fd.set("bundle", new File([bytes], "site.zip", { type: "application/zip" }));
  return fd;
};

describe("create_upload_link", () => {
  it("returns page and upload URLs and stores only a hash of the token", async () => {
    const { facts, token } = await newLink();
    expect(facts.slug).toBe("my-site");
    expect(facts.new_version).toBe(false);
    expect(facts.page_url).toMatch(/\/u\/[0-9a-f]{64}$/);
    expect(facts.upload_url).toMatch(/\/api\/uploads\/[0-9a-f]{64}$/);
    expect(Date.parse(facts.expires_at) - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(Date.parse(facts.expires_at) - Date.now()).toBeLessThanOrEqual(30 * 60_000);

    const row = await env.DB.prepare("SELECT * FROM upload_sessions").first<any>();
    expect(row.token_hash).toBe(await hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row).toMatchObject({ email: BOB, slug: "my-site", title: "My Site", used_at: null });
    // Nothing is published by creating a link.
    expect(await env.DB.prepare("SELECT 1 FROM artifacts").first()).toBeNull();
  });

  it("requires the publish scope and does not advertise itself to read-only tokens", async () => {
    const readOnly = await tokenFor(BOB, { name: "ro", scopes: ["read"] });
    const { result } = await link(readOnly, { title: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("publish");
    const list = (await (await req(MCP_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readOnly}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })).json()) as any;
    expect(list.result.tools.map((t: any) => t.name)).not.toContain("create_upload_link");
  });

  it("needs a title for a new artifact, and reuses an existing one for a new version", async () => {
    const token = await tokenFor(BOB);
    const missing = await link(token, { slug: "fresh" });
    expect(missing.result.isError).toBe(true);

    await rpc(token, "publish", { slug: "mine", title: "Mine", content_text: HTML });
    const { facts, result } = await link(token, { slug: "mine" });
    expect(result.isError).toBeUndefined();
    expect(facts.new_version).toBe(true);
    expect(facts.title).toBe("Mine");
  });

  it("refuses a slug somebody else owns", async () => {
    await rpc(await tokenFor(BOB), "publish", { slug: "bobs", title: "Bobs", content_text: HTML });
    const { result, facts } = await link(await tokenFor(EVE), { slug: "bobs", title: "Mine now" });
    expect(result.isError).toBe(true);
    expect(facts.error).toBe("slug_taken");
    expect(await env.DB.prepare("SELECT 1 FROM upload_sessions").first()).toBeNull();
  });

  it("steers the model in the tool description and server instructions", async () => {
    const { REMOTE_TOOLS, HTTP_INSTRUCTIONS } = await import("../src/mcp");
    const desc = REMOTE_TOOLS.find((t) => t.name === "create_upload_link")!.description;
    for (const text of [desc, HTTP_INSTRUCTIONS]) {
      expect(text).toContain("curl -sS -F bundle=@site.zip");
      expect(text).toContain("Never ask them to use a terminal");
      // Sandbox first; when it can't connect, the link + zip AND the one-time
      // setting that lets Claude publish by itself next time.
      expect(text).toContain("page_url");
      expect(text).toContain("downloadable .zip");
      expect(text).toContain('"Allow network egress"');
      expect(text).toContain('"All domains"');
    }
    expect(REMOTE_TOOLS.find((t) => t.name === "publish")!.description).toContain("create_upload_link");
  });
});

describe("POST /api/uploads/:token", () => {
  it("publishes a multipart zip as the link's creator, then burns the link", async () => {
    const { token } = await newLink();
    const zip = zipOf({ "index.html": HTML, "img/a.png": new Uint8Array([1, 2, 3]) });
    const res = await post(token, { body: bundleForm(zip) });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const data = (await res.json()) as any;
    expect(data).toMatchObject({ slug: "my-site", version: 1, file_count: 2 });
    expect(data.url).toContain("/my-site/");

    const row = await env.DB.prepare("SELECT owner_email, account_id, title FROM artifacts WHERE slug = 'my-site'").first<any>();
    const account = await env.DB.prepare("SELECT id FROM accounts WHERE personal_email = ?").bind(BOB).first<any>();
    expect(row.owner_email).toBe(BOB);
    expect(row.title).toBe("My Site");
    expect(row.account_id).toBe(account.id);
    expect(await env.FILES.get("my-site/v1/img/a.png")).toBeTruthy();

    const again = await post(token, { body: bundleForm(zip) });
    expect(again.status).toBe(410);
    expect(((await again.json()) as any).error).toBe("used");
  });

  it("accepts a raw application/zip body and adds a version to an existing artifact", async () => {
    const owner = await tokenFor(BOB);
    await rpc(owner, "publish", { slug: "my-site", title: "My Site", content_text: HTML });
    const { facts } = await link(owner, { slug: "my-site" });
    const token = String(facts.upload_url).split("/").pop()!;
    const res = await post(token, { headers: { "Content-Type": "application/zip" }, body: zipOf({ "index.html": HTML }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).version).toBe(2);
  });

  it("accepts multiple files with relative paths", async () => {
    const { token } = await newLink();
    const res = await post(token, {
      body: multipart([
        { path: "index.html", body: HTML },
        { path: "assets/app.js", body: "1" },
        { path: "assets/img/p.png", body: new Uint8Array([9, 9]) },
      ]),
    });
    expect(res.status).toBe(200);
    expect(await env.FILES.get("my-site/v1/assets/img/p.png")).toBeTruthy();
    expect(await env.FILES.get("my-site/v1/index.html")).toBeTruthy();
  });

  it("falls back to the filename when no path fields are sent", async () => {
    const { token } = await newLink();
    const res = await post(token, { body: multipart([{ path: "index.html", body: HTML, sendPath: false }]) });
    expect(res.status).toBe(200);
  });

  it("strips a single top-level folder, and quietly drops OS junk files", async () => {
    const { token } = await newLink();
    const res = await post(token, {
      body: multipart([
        { path: "portfolio/index.html", body: HTML },
        { path: "portfolio/css/s.css", body: "a{}" },
        { path: "portfolio/.DS_Store", body: "x" },
        { path: "__MACOSX/portfolio/._index.html", body: "x" },
      ]),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).file_count).toBe(2);
    expect(await env.FILES.get("my-site/v1/index.html")).toBeTruthy();
    expect(await env.FILES.get("my-site/v1/css/s.css")).toBeTruthy();
    expect(await env.FILES.get("my-site/v1/portfolio/index.html")).toBeNull();
  });

  it("strips the folder inside a zip too", async () => {
    const { token } = await newLink();
    const res = await post(token, { body: bundleForm(zipOf({ "site/index.html": HTML, "site/a.css": "a{}" })) });
    expect(res.status).toBe(200);
    expect(await env.FILES.get("my-site/v1/a.css")).toBeTruthy();
  });

  it("answers 400 with a friendly message when index.html is missing, and keeps the link usable", async () => {
    const { token } = await newLink();
    for (const body of [
      multipart([{ path: "about.html", body: HTML }, { path: "b.css", body: "a{}" }]),
      bundleForm(zipOf({ "about.html": HTML })),
    ]) {
      const res = await post(token, { body });
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toBe("no_index");
      expect(data.detail).toContain("index.html");
    }
    const ok = await post(token, { body: multipart([{ path: "index.html", body: HTML }]) });
    expect(ok.status).toBe(200);
  });

  it("refuses credential-looking files in a folder drop and does not burn the link", async () => {
    const { token } = await newLink();
    const res = await post(token, {
      body: multipart([{ path: "index.html", body: HTML }, { path: ".env", body: "SECRET=1" }]),
    });
    expect(res.status).toBe(400);
    expect(await env.FILES.get("my-site/v1/index.html")).toBeNull();
    const row = await env.DB.prepare("SELECT used_at FROM upload_sessions").first<any>();
    expect(row.used_at).toBeNull();
  });

  it("never publishes a .env that rides inside a zip", async () => {
    const { token } = await newLink();
    const res = await post(token, { body: bundleForm(zipOf({ "index.html": HTML, ".env": "SECRET=1" })) });
    expect(res.status).toBe(200);
    expect(await env.FILES.get("my-site/v1/.env")).toBeNull();
  });

  it("rejects unsafe paths", async () => {
    const { token } = await newLink();
    const res = await post(token, { body: multipart([{ path: "index.html", body: HTML }, { path: "../x.txt", body: "x" }]) });
    expect(res.status).toBe(400);
  });

  it("enforces the 50 MiB cap on a declared length and on a streamed body", async () => {
    const { token } = await newLink();
    const declared = await post(token, {
      headers: { "Content-Type": "application/zip", "Content-Length": String(60 * 1024 * 1024) },
      body: new Uint8Array(10),
    });
    expect(declared.status).toBe(413);
    expect(((await declared.json()) as any).error).toBe("payload_too_large");

    const big = await post(token, { headers: { "Content-Type": "application/zip" }, body: new Uint8Array(51 * 1024 * 1024) });
    expect(big.status).toBe(413);
    // Still usable afterwards.
    const ok = await post(token, { body: bundleForm(zipOf({ "index.html": HTML })) });
    expect(ok.status).toBe(200);
  });

  it("answers 404 for an unknown token and 410 for an expired one", async () => {
    const unknown = await post("0".repeat(64), { body: bundleForm(zipOf({ "index.html": HTML })) });
    expect(unknown.status).toBe(404);
    const junk = await post("nope", { body: bundleForm(zipOf({ "index.html": HTML })) });
    expect(junk.status).toBe(404);

    const { token } = await newLink();
    await env.DB.prepare("UPDATE upload_sessions SET expires_at = ?").bind(new Date(Date.now() - 1000).toISOString()).run();
    const expired = await post(token, { body: bundleForm(zipOf({ "index.html": HTML })) });
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as any).error).toBe("expired");
    expect(await env.DB.prepare("SELECT 1 FROM artifacts").first()).toBeNull();
  });

  it("answers 409 when the slug was taken by somebody else after the link was made", async () => {
    const { token } = await newLink(BOB, { title: "Race", slug: "race" });
    await rpc(await tokenFor(EVE), "publish", { slug: "race", title: "Eve's", content_text: HTML });
    const res = await post(token, { body: bundleForm(zipOf({ "index.html": HTML })) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe("slug_taken");
    const art = await env.DB.prepare("SELECT owner_email FROM artifacts WHERE slug = 'race'").first<any>();
    expect(art.owner_email).toBe(EVE);
  });

  it("lets only one of two racing uploads win", async () => {
    const { token } = await newLink();
    const make = () => post(token, { body: bundleForm(zipOf({ "index.html": HTML })) });
    const statuses = (await Promise.all([make(), make()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 410]);
    const versions = await env.DB.prepare("SELECT COUNT(*) AS n FROM artifact_versions WHERE slug = 'my-site'").first<any>();
    expect(versions.n).toBe(1);
  });

  it("does not need a cookie or bearer, and answers CORS preflight", async () => {
    const pre = await req("/api/uploads/abc", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("applies the same plan quota as REST publish and hands the link back", async () => {
    const { token } = await newLink();
    const owner = await tokenFor(BOB);
    // The free plan allows 10 artifacts.
    for (let i = 0; i < 10; i++) {
      expect((await rpc(owner, "publish", { slug: `filler-${i}`, title: `F${i}`, content_text: HTML })).status).toBe(200);
    }
    const res = await post(token, { body: bundleForm(zipOf({ "index.html": HTML })) });
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error).toBe("quota_exceeded");
    expect(await env.DB.prepare("SELECT 1 FROM artifacts WHERE slug = 'my-site'").first()).toBeNull();
    const row = await env.DB.prepare("SELECT used_at FROM upload_sessions").first<any>();
    expect(row.used_at).toBeNull();
  });
});

describe("GET /u/:token", () => {
  it("renders the drop page with the destination, and escapes the title", async () => {
    const { token } = await newLink(BOB, { title: '<img src=x onerror=alert(1)> "Q3"', slug: "q3" });
    const res = await req(`/u/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    expect(html).toContain("Publish &lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("/q3/");
    expect(html).toContain("webkitdirectory");
    expect(html).toContain(`/api/uploads/${token}`);
    expect(html).toContain("Choose folder");
  });

  it("shows friendly, detail-free pages for expired, used and unknown links", async () => {
    const unknown = await req(`/u/${"1".repeat(64)}`);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("couldn't find this upload link");

    const { token } = await newLink(BOB, { title: "Secret Title", slug: "secret-slug" });
    await env.DB.prepare("UPDATE upload_sessions SET expires_at = ?").bind(new Date(Date.now() - 1000).toISOString()).run();
    const expired = await req(`/u/${token}`);
    expect(expired.status).toBe(410);
    const html = await expired.text();
    expect(html).toContain("expired");
    expect(html).not.toContain("Secret Title");
    expect(html).not.toContain("secret-slug");

    await env.DB.prepare("UPDATE upload_sessions SET expires_at = ?, used_at = ?")
      .bind(new Date(Date.now() + 60_000).toISOString(), new Date().toISOString())
      .run();
    const used = await req(`/u/${token}`);
    expect(used.status).toBe(410);
    expect(await used.text()).toContain("already been used");
  });
});

describe("host routing", () => {
  const prod = { ...(env as any), CONTENT_HOSTNAMES: "a.rtfx.pro", PUBLIC_BASE_URL: "https://rtfx.pro" };

  it("never serves /u or /api/uploads on the content host", async () => {
    for (const path of ["/u/abc", `/u/${"a".repeat(64)}`, "/api/uploads/abc"]) {
      const res = await app.request(`https://a.rtfx.pro${path}`, {}, prod);
      expect(res.status, path).toBe(404);
    }
    const post = await app.request(`https://a.rtfx.pro/api/uploads/abc`, { method: "POST" }, prod);
    expect(post.status).toBe(404);
  });

  it("serves them on the app host, not redirecting to the content host", async () => {
    const res = await app.request(`https://rtfx.pro/u/${"b".repeat(64)}`, { redirect: "manual" }, prod);
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("upload link");
  });

  it("reserves `u` and does not treat /u/<token> as a branded address", () => {
    expect(reservedTopLevelSegments()).toContain("u");
    expect(brandedPathParts(`/u/${"c".repeat(64)}`)).toBeNull();
  });
});

describe("upload sessions", () => {
  it("keeps the raw token out of the table", async () => {
    const s = await createUploadSession(env as any, {
      accountId: null,
      email: BOB,
      isAdmin: false,
      slug: "s",
      title: "T",
    });
    const row = await env.DB.prepare("SELECT * FROM upload_sessions WHERE id = ?").bind(s.id).first<any>();
    expect(Object.values(row)).not.toContain(s.token);
    expect(row.token_hash).toBe(await hashToken(s.token));
  });
});
