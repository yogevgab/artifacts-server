import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { zipSync, strToU8 } from "fflate";
import app from "../src/index";
import { MAX_UPLOAD_BYTES } from "../src/upload";

async function initDb() {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS artifacts (
      slug TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, type TEXT NOT NULL,
      entry TEXT NOT NULL DEFAULT 'index.html', file_count INTEGER NOT NULL DEFAULT 1,
      size_bytes INTEGER NOT NULL DEFAULT 0, created_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'restricted', current_version INTEGER NOT NULL DEFAULT 1)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS artifact_grants (
      slug TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (slug, email))`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS artifact_versions (
      slug TEXT NOT NULL, version INTEGER NOT NULL, type TEXT NOT NULL,
      entry TEXT NOT NULL DEFAULT 'index.html', file_count INTEGER NOT NULL DEFAULT 1,
      size_bytes INTEGER NOT NULL DEFAULT 0, note TEXT, created_by TEXT,
      created_at TEXT NOT NULL, PRIMARY KEY (slug, version))`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS artifact_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, version INTEGER NOT NULL,
      email TEXT, path TEXT, country TEXT, referrer TEXT, viewed_at TEXT NOT NULL)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS waitlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`
  ).run();
  await env.DB.prepare("DELETE FROM artifacts").run();
  await env.DB.prepare("DELETE FROM artifact_grants").run();
  await env.DB.prepare("DELETE FROM artifact_versions").run();
  await env.DB.prepare("DELETE FROM artifact_views").run();
  await env.DB.prepare("DELETE FROM waitlist").run();
}

async function clearR2() {
  const listed = await env.FILES.list();
  if (listed.objects.length) await env.FILES.delete(listed.objects.map((o) => o.key));
}

beforeEach(async () => {
  await initDb();
  await clearR2();
});

const req = (path: string, init?: RequestInit) => app.request(path, init, env as any);

function htmlForm(fields: Record<string, string>, fileName: string, bytes: Uint8Array, field = "file") {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.set(field, new File([bytes], fileName, { type: "text/html" }));
  return fd;
}

describe("health + landing", () => {
  it("health returns ok", async () => {
    const res = await req("/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("serves the public landing page at / with waitlist + beta messaging", async () => {
    const res = await req("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="waitlist"');
    expect(body).toContain('id="wl"');
    expect(body.toLowerCase()).toContain("beta");
    expect(body).toContain("Sign in");
    expect(body).not.toContain("No artifacts yet");
  });

  it("landing page is served the same regardless of caller identity", async () => {
    const anon = await req("/", { headers: { "X-Dev-Anonymous": "true" } });
    expect(anon.status).toBe(200);
    expect(await anon.text()).toContain('id="waitlist"');
  });
});

describe("gallery", () => {
  it("gallery shows empty state then artifacts", async () => {
    let res = await req("/gallery");
    expect(await res.text()).toContain("No artifacts yet");

    await req("/api/artifacts", { method: "POST", body: htmlForm({ title: "Hello Page" }, "x.html", strToU8("<h1>hi</h1>")) });
    res = await req("/gallery");
    const body = await res.text();
    expect(body).toContain("Hello Page");
    expect(body).toContain('href="/hello-page/"');
    // premium list markers: each card carries visibility + version badges
    expect(body).toContain('data-artifact="hello-page"');
    expect(body).toMatch(/data-badge="visibility">restricted</);
    expect(body).toMatch(/data-badge="version">v1</);
  });

  it("gallery empty state explains what to expect", async () => {
    const body = await (await req("/gallery")).text();
    expect(body).toContain('data-empty="gallery"');
    expect(body.toLowerCase()).toContain("grants you access");
  });

  it("not-found page explains the likely cause and links back", async () => {
    const body = await (await req("/nope/")).text();
    expect(body).toContain('data-empty="not-found"');
    expect(body.toLowerCase()).toContain("access");
    expect(body).toContain('href="/gallery"');
  });

  it("redirects anonymous visitors to the public landing page instead of an empty gallery", async () => {
    const res = await req("/gallery", { headers: { "X-Dev-Anonymous": "true" }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });
});

describe("upload + serve", () => {
  it("publishes a single HTML file and serves it", async () => {
    const res = await req("/api/artifacts", {
      method: "POST",
      body: htmlForm({ title: "Solo", slug: "solo" }, "page.html", strToU8("<h1>solo</h1>")),
    });
    expect(res.status).toBe(200);
    const data = await res.json<any>();
    expect(data.slug).toBe("solo");
    expect(data.file_count).toBe(1);

    const served = await req("/solo/");
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("solo");
    expect(served.headers.get("Content-Type")).toContain("text/html");
  });

  it("publishes a zip bundle and serves nested files", async () => {
    const zip = zipSync({ "index.html": strToU8("<h1>bundle</h1>"), "app.js": strToU8("console.log(1)") });
    const fd = new FormData();
    fd.set("title", "Bundle");
    fd.set("slug", "bundle");
    fd.set("bundle", new File([zip], "b.zip", { type: "application/zip" }));
    const res = await req("/api/artifacts", { method: "POST", body: fd });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).file_count).toBe(2);

    expect(await (await req("/bundle/")).text()).toContain("bundle");
    const js = await req("/bundle/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("Content-Type")).toContain("javascript");
  });

  it("404s for missing files", async () => {
    const res = await req("/nope/missing.css");
    expect(res.status).toBe(404);
  });

  it("rejects a zip bundle containing a path traversal entry and stores nothing", async () => {
    const zip = zipSync({
      "index.html": strToU8("<h1>bundle</h1>"),
      "../../evil.html": strToU8("evil"),
    });
    const fd = new FormData();
    fd.set("title", "Evil");
    fd.set("slug", "evil");
    fd.set("bundle", new File([zip], "b.zip", { type: "application/zip" }));
    const res = await req("/api/artifacts", { method: "POST", body: fd });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error).toBe("bad_request");

    expect((await req("/evil/")).status).toBe(404);
    const listed = await env.FILES.list();
    expect(listed.objects).toHaveLength(0);
  });

  it("rejects an upload larger than the max upload size", async () => {
    const fd = new FormData();
    fd.set("title", "Huge");
    fd.set("slug", "huge");
    fd.set("file", new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "x.html", { type: "text/html" }));
    const res = await req("/api/artifacts", { method: "POST", body: fd });
    expect(res.status).toBe(413);
    expect((await res.json<any>()).error).toBe("payload_too_large");
  });
});

describe("validation + conflicts", () => {
  it("rejects bad slug", async () => {
    const res = await req("/api/artifacts", { method: "POST", body: htmlForm({ title: "X", slug: "Bad Slug" }, "x.html", strToU8("x")) });
    expect(res.status).toBe(400);
  });

  it("republishing an existing slug creates a new version (no 409)", async () => {
    const mk = () =>
      req("/api/artifacts", { method: "POST", body: htmlForm({ title: "Dup", slug: "dup" }, "x.html", strToU8("x")) });
    const r1 = await (await mk()).json<any>();
    expect(r1.version).toBe(1);
    const r2 = await (await mk()).json<any>();
    expect(r2.version).toBe(2);
  });

  it("rejects reserved slugs", async () => {
    for (const s of ["admin", "api", "v", "health", "waitlist", "gallery"]) {
      const res = await req("/api/artifacts", { method: "POST", body: htmlForm({ title: "X", slug: s }, "x.html", strToU8("x")) });
      expect(res.status).toBe(400);
    }
  });

  it("requires a file", async () => {
    const fd = new FormData();
    fd.set("title", "NoFile");
    const res = await req("/api/artifacts", { method: "POST", body: fd });
    expect(res.status).toBe(400);
  });
});

describe("list + delete + admin", () => {
  it("lists and deletes", async () => {
    await req("/api/artifacts", { method: "POST", body: htmlForm({ title: "ToDelete", slug: "td" }, "x.html", strToU8("x")) });
    let list = await (await req("/api/artifacts")).json<any>();
    expect(list.artifacts).toHaveLength(1);

    const del = await req("/api/artifacts/td", { method: "DELETE" });
    expect(del.status).toBe(200);

    list = await (await req("/api/artifacts")).json<any>();
    expect(list.artifacts).toHaveLength(0);
    expect((await req("/td/")).status).toBe(404);
  });

  it("admin page renders the upload form", async () => {
    const res = await req("/admin");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Admin");
    expect(body).toContain('id="up"');
  });
});

describe("admin dashboard UX", () => {
  const admin = async () => await (await req("/admin")).text();
  const publish = (slug: string, title: string, note = "") =>
    req("/api/artifacts", {
      method: "POST",
      body: htmlForm({ title, slug, note }, "x.html", strToU8(`<h1>${slug}</h1>`)),
    });

  it("shows header stats that reflect the real artifact/view/storage totals", async () => {
    let body = await admin();
    expect(body).toContain('data-stat="artifacts"');
    expect(body).toContain('data-stat="versions"');
    expect(body).toContain('data-stat="views"');
    expect(body).toContain('data-stat="storage"');
    // no artifacts yet
    expect(body).toMatch(/data-stat="artifacts"[\s\S]*?data-stat-value>0</);

    await publish("one", "One");
    await publish("two", "Two");
    body = await admin();
    expect(body).toMatch(/data-stat="artifacts"[\s\S]*?data-stat-value>2</);
    expect(body).toMatch(/data-stat="versions"[\s\S]*?data-stat-value>2</);
  });

  it("renders a drag-and-drop publish panel wired to the file and bundle inputs", async () => {
    const body = await admin();
    expect(body).toContain("data-dropzone");
    expect(body).toContain('data-browse="file"');
    expect(body).toContain('data-browse="bundle"');
    expect(body).toContain('type="file" name="file"');
    expect(body).toContain('type="file" name="bundle"');
  });

  it("ships a copy-link success state instead of only reloading after publish", async () => {
    const body = await admin();
    expect(body).toContain("data-publish-success");
    expect(body).toContain("data-artifact-url");
    expect(body).toContain("data-copy-link");
    expect(body).toContain("data-publish-another");
    // reloading the dashboard is an explicit user action, not an automatic
    // redirect that would blow away the share link
    expect(body).toContain("data-refresh");
    expect(body).toContain("showPublished");
  });

  it("gives an actionable empty state when nothing is published", async () => {
    const body = await admin();
    expect(body).toContain('data-empty="artifacts"');
    expect(body).toContain("Nothing published yet");
    expect(body.toLowerCase()).toContain("publish your first artifact");
  });

  it("shows visibility, version, file-count and view badges on each artifact", async () => {
    await publish("badged", "Badged");
    let body = await admin();
    expect(body).toContain('data-artifact="badged"');
    const card = body.slice(body.indexOf('data-artifact="badged"'));
    expect(card).toContain('data-badge="visibility"');
    expect(card).toContain('data-badge="version"');
    expect(card).toContain('data-badge="files"');
    expect(card).toContain('data-badge="views"');
    expect(card).toMatch(/data-badge="visibility">Restricted · 0</);
    expect(card).toMatch(/data-badge="version">v1</);
    expect(card).toMatch(/data-badge="views">0 views</);

    // grant + view + new version, and the badges follow
    await req("/api/artifacts/badged/access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "restricted", emails: ["bob@x.com"] }),
    });
    await req("/badged/", { headers: { "X-Dev-Email": "bob@x.com" } });
    await publish("badged", "Badged");

    body = await admin();
    const updated = body.slice(body.indexOf('data-artifact="badged"'));
    expect(updated).toMatch(/data-badge="visibility">Restricted · 1</);
    expect(updated).toMatch(/data-badge="version">v2 of 2</);
    expect(updated).toMatch(/data-badge="views">1 view</);
  });

  it("marks an 'everyone' artifact as open", async () => {
    await publish("open", "OpenOne");
    await req("/api/artifacts/open/access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "everyone", emails: [] }),
    });
    const card = (await admin()).split('data-artifact="open"')[1];
    expect(card).toMatch(/data-badge="visibility">Everyone</);
  });

  it("keeps versions, views and access management on every artifact card", async () => {
    await publish("full", "Full");
    const card = (await admin()).split('data-artifact="full"')[1];
    expect(card).toContain('data-panel="versions"');
    expect(card).toContain('data-panel="views"');
    expect(card).toContain('data-panel="access"');
    expect(card).toContain("data-newver"); // drag/drop new-version form
    expect(card).not.toContain('data-current="1"'); // v1 is already live
    expect(card).toContain('href="/v/full/1/"'); // version preview link
    expect(card).toContain('data-save="full"'); // save access
    expect(card).toContain('data-del="full"'); // delete
    expect(card).toContain('data-copy="/full/"'); // per-artifact copy link
  });

  it("explains empty views instead of showing a bare dash", async () => {
    await publish("quiet", "Quiet");
    const card = (await admin()).split('data-artifact="quiet"')[1];
    expect(card).toContain("No views yet");
    expect(card.toLowerCase()).toContain("share link");
  });

  it("tells the admin how to fix an unconfigured user-management setup", async () => {
    const body = await admin();
    expect(body).toContain("data-users-unconfigured");
    expect(body).toContain("CF_API_TOKEN");
    expect(body).toContain("ACCESS_VIEWER_POLICY_ID");
  });
});

describe("per-artifact permissions", () => {
  const viewer = (email: string) => ({ headers: { "X-Dev-Email": email } });
  const publish = (slug: string, title: string) =>
    req("/api/artifacts", { method: "POST", body: htmlForm({ title, slug }, "x.html", strToU8(`<h1>${slug}</h1>`)) });
  const setAcc = (slug: string, visibility: string, emails: string[], asEmail?: string) =>
    req(`/api/artifacts/${slug}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(asEmail ? { "X-Dev-Email": asEmail } : {}) },
      body: JSON.stringify({ visibility, emails }),
    });

  it("new artifacts are private (admin-only); viewers get 404 and empty gallery", async () => {
    await publish("secret", "Secret");
    expect((await req("/secret/")).status).toBe(200); // admin
    expect((await req("/secret/", viewer("bob@x.com"))).status).toBe(404); // viewer
    const g = await (await req("/gallery", viewer("bob@x.com"))).text();
    expect(g).not.toContain("Secret");
    expect(g).toContain("No artifacts yet");
  });

  it("granting a viewer lets exactly them see it", async () => {
    await publish("shared", "Shared");
    expect((await setAcc("shared", "restricted", ["bob@x.com"])).status).toBe(200);
    expect((await req("/shared/", viewer("bob@x.com"))).status).toBe(200);
    expect((await req("/shared/", viewer("eve@x.com"))).status).toBe(404);
    expect(await (await req("/gallery", viewer("bob@x.com"))).text()).toContain("Shared");
    expect(await (await req("/gallery", viewer("eve@x.com"))).text()).not.toContain("Shared");
  });

  it("'everyone' visibility is visible to any logged-in viewer", async () => {
    await publish("pub", "PublicOne");
    await setAcc("pub", "everyone", []);
    expect((await req("/pub/", viewer("anyone@x.com"))).status).toBe(200);
    expect(await (await req("/gallery", viewer("anyone@x.com"))).text()).toContain("PublicOne");
  });

  it("GET access reflects grants; revoke removes a user", async () => {
    await publish("doc", "Doc");
    await setAcc("doc", "restricted", ["a@x.com", "b@x.com"]);
    let acc = await (await req("/api/artifacts/doc/access")).json<any>();
    expect(acc.visibility).toBe("restricted");
    expect(acc.emails.sort()).toEqual(["a@x.com", "b@x.com"]);
    await setAcc("doc", "restricted", ["b@x.com"]);
    acc = await (await req("/api/artifacts/doc/access")).json<any>();
    expect(acc.emails).toEqual(["b@x.com"]);
    expect((await req("/doc/", viewer("a@x.com"))).status).toBe(404);
  });

  it("viewers cannot reach the access API", async () => {
    await publish("guarded", "Guarded");
    expect((await req("/api/artifacts", viewer("bob@x.com"))).status).toBe(403);
    expect((await setAcc("guarded", "everyone", [], "bob@x.com")).status).toBe(403);
  });

  it("access PUT validates visibility and emails", async () => {
    await publish("val", "Val");
    expect((await setAcc("val", "bogus", [])).status).toBe(400);
    expect((await setAcc("val", "restricted", ["noatsign"])).status).toBe(400);
  });

  it("deleting an artifact clears its grants", async () => {
    await publish("temp", "Temp");
    await setAcc("temp", "restricted", ["bob@x.com"]);
    await req("/api/artifacts/temp", { method: "DELETE" });
    await publish("temp", "Temp2");
    const acc = await (await req("/api/artifacts/temp/access")).json<any>();
    expect(acc.emails).toEqual([]);
    expect(acc.visibility).toBe("restricted");
  });

  it("granting still succeeds when user management is not configured", async () => {
    await publish("nocfg", "NoCfg");
    const res = await setAcc("nocfg", "restricted", ["bob@x.com"]);
    expect(res.status).toBe(200);
    const data = await res.json<any>();
    expect(data.emails).toEqual(["bob@x.com"]);
    expect(data.allowlistWarning).toBeUndefined();
  });
});

describe("versioning", () => {
  const pub = (slug: string, html: string, title?: string) => {
    const fd = new FormData();
    if (title) fd.set("title", title);
    fd.set("slug", slug);
    fd.set("file", new File([strToU8(html)], "x.html", { type: "text/html" }));
    return req("/api/artifacts", { method: "POST", body: fd });
  };

  it("new upload becomes live; old versions retained and previewable", async () => {
    expect((await (await pub("doc", "<h1>one</h1>", "Doc")).json<any>()).version).toBe(1);
    expect(await (await req("/doc/")).text()).toContain("one");

    expect((await (await pub("doc", "<h1>two</h1>")).json<any>()).version).toBe(2);
    // current serves v2
    expect(await (await req("/doc/")).text()).toContain("two");
    // admin can preview each version
    expect(await (await req("/v/doc/1/")).text()).toContain("one");
    expect(await (await req("/v/doc/2/")).text()).toContain("two");

    const vs = await (await req("/api/artifacts/doc/versions")).json<any>();
    expect(vs.current).toBe(2);
    expect(vs.versions.map((v: any) => v.version)).toEqual([2, 1]);
  });

  it("rollback makes an older version live", async () => {
    await pub("roll", "<h1>v1</h1>", "Roll");
    await pub("roll", "<h1>v2</h1>");
    expect(await (await req("/roll/")).text()).toContain("v2");
    const res = await req("/api/artifacts/roll/current", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await (await req("/roll/")).text()).toContain("v1");
  });

  it("rollback to a nonexistent version 404s", async () => {
    await pub("r2", "<h1>x</h1>", "R2");
    const res = await req("/api/artifacts/r2/current", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 99 }),
    });
    expect(res.status).toBe(404);
  });

  it("version preview is admin-only (viewer gets 404)", async () => {
    await pub("secretv", "<h1>hidden</h1>", "SecretV");
    expect((await req("/v/secretv/1/", { headers: { "X-Dev-Email": "bob@x.com" } })).status).toBe(404);
  });

  it("concurrent publishes to a slug get distinct versions (no PK collision)", async () => {
    const [a, b] = await Promise.all([pub("race", "<h1>a</h1>", "Race"), pub("race", "<h1>b</h1>", "Race")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const nums = [(await a.json<any>()).version, (await b.json<any>()).version].sort();
    expect(nums).toEqual([1, 2]);
  });

  it("publishing a new version preserves grants and visibility", async () => {
    await pub("keep", "<h1>v1</h1>", "Keep");
    await req("/api/artifacts/keep/access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "everyone", emails: [] }),
    });
    await pub("keep", "<h1>v2</h1>");
    const acc = await (await req("/api/artifacts/keep/access")).json<any>();
    expect(acc.visibility).toBe("everyone");
  });
});

describe("views log", () => {
  const viewer = (email: string) => ({ headers: { "X-Dev-Email": email } });
  const pubBundle = async (slug: string) => {
    const zip = zipSync({ "index.html": strToU8("<h1>home</h1>"), "style.css": strToU8("body{}") });
    const fd = new FormData();
    fd.set("title", slug);
    fd.set("slug", slug);
    fd.set("bundle", new File([zip], "b.zip", { type: "application/zip" }));
    await req("/api/artifacts", { method: "POST", body: fd });
    // Make it visible to any signed-in user so viewers in these tests can load it.
    await req(`/api/artifacts/${slug}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "everyone", emails: [] }),
    });
  };
  const getViews = async (slug: string) => (await req(`/api/artifacts/${slug}/views`)).json<any>();

  it("counts HTML views, ignores assets", async () => {
    await pubBundle("site");
    await req("/site/", viewer("bob@x.com")); // html page load
    await req("/site/style.css", viewer("bob@x.com")); // asset — not a view
    const views = await getViews("site");
    expect(views.total).toBe(1);
    expect(views.unique).toBe(1);
    expect(views.recent[0].email).toBe("bob@x.com");
    expect(views.recent[0].path).toBe("");
  });

  it("tracks total vs unique viewers", async () => {
    await pubBundle("blog");
    await req("/blog/", viewer("a@x.com"));
    await req("/blog/", viewer("a@x.com"));
    await req("/blog/", viewer("b@x.com"));
    const views = await getViews("blog");
    expect(views.total).toBe(3);
    expect(views.unique).toBe(2);
  });

  it("clamps the limit query param (positive applies, negative/0 → default)", async () => {
    await pubBundle("lim");
    await req("/lim/", viewer("a@x.com"));
    await req("/lim/", viewer("b@x.com"));
    expect((await (await req("/api/artifacts/lim/views?limit=1")).json<any>()).recent).toHaveLength(1);
    // negative must NOT return unbounded (SQLite treats negative LIMIT as unlimited) — falls back to default
    expect((await (await req("/api/artifacts/lim/views?limit=-1")).json<any>()).recent).toHaveLength(2);
  });

  it("does not log admin version previews", async () => {
    await pubBundle("qa");
    await req("/v/qa/1/"); // admin preview
    const views = await getViews("qa");
    expect(views.total).toBe(0);
  });

  it("does not log for a viewer who is denied (404)", async () => {
    // publish restricted single, viewer not granted -> 404, no view
    await req("/api/artifacts", { method: "POST", body: htmlForm({ title: "P", slug: "priv" }, "x.html", strToU8("<h1>x</h1>")) });
    const res = await req("/priv/", viewer("nobody@x.com"));
    expect(res.status).toBe(404);
    expect((await getViews("priv")).total).toBe(0);
  });

  it("deleting an artifact clears its views", async () => {
    await pubBundle("temp2");
    await req("/temp2/", viewer("a@x.com"));
    expect((await getViews("temp2")).total).toBe(1);
    await req("/api/artifacts/temp2", { method: "DELETE" });
    await pubBundle("temp2");
    expect((await getViews("temp2")).total).toBe(0);
  });
});

describe("user management (Cloudflare Access not configured in tests)", () => {
  it("GET /api/users returns 503", async () => {
    expect((await req("/api/users")).status).toBe(503);
  });
  it("POST /api/users returns 503", async () => {
    const res = await req("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "x@y.com" }),
    });
    expect(res.status).toBe(503);
  });
  it("POST /api/users rejects bad email with 400 before hitting Access", async () => {
    const res = await req("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "noatsign" }),
    });
    expect(res.status).toBe(400);
  });
  it("viewers cannot reach the users API", async () => {
    expect((await req("/api/users", { headers: { "X-Dev-Email": "bob@x.com" } })).status).toBe(403);
  });
});

describe("content host isolation", () => {
  const CONTENT_HOST = "content.test.local";
  const contentEnv = { ...env, CONTENT_HOSTNAMES: CONTENT_HOST } as any;
  const contentReq = (path: string, init?: RequestInit) =>
    app.request(`https://${CONTENT_HOST}${path}`, init, contentEnv);
  const appReq = (path: string, init?: RequestInit) =>
    app.request(`https://app.test.local${path}`, init, contentEnv);

  it("serves artifact files on the content host", async () => {
    await req("/api/artifacts", {
      method: "POST",
      body: htmlForm({ title: "Solo", slug: "solo" }, "x.html", strToU8("<h1>solo</h1>")),
    });
    const res = await contentReq("/solo/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("solo");
  });

  it("blocks management routes on the content host", async () => {
    await req("/api/artifacts", {
      method: "POST",
      body: htmlForm({ title: "Solo2", slug: "solo2" }, "x.html", strToU8("<h1>solo2</h1>")),
    });
    for (const path of ["/", "/health", "/whoami", "/admin", "/api/artifacts", "/v/solo2/1/", "/gallery", "/waitlist"]) {
      const res = await contentReq(path);
      expect(res.status).toBe(404);
    }
  });

  it("leaves the app host fully functional when CONTENT_HOSTNAMES is configured", async () => {
    expect((await appReq("/health")).status).toBe(200);
    expect((await appReq("/admin")).status).toBe(200);
    expect((await appReq("/")).status).toBe(200);
    expect((await appReq("/gallery")).status).toBe(200);
  });

  it("returns content-host share URLs and redirects app-host artifact requests there", async () => {
    const publish = await appReq("/api/artifacts", {
      method: "POST",
      body: htmlForm({ title: "Solo3", slug: "solo3" }, "x.html", strToU8("<h1>solo3-secret</h1>")),
    });
    expect((await publish.json<any>()).url).toBe(`https://${CONTENT_HOST}/solo3/`);

    const res = await appReq("/solo3/?foo=bar");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`https://${CONTENT_HOST}/solo3/?foo=bar`);
    const body = await res.text();
    expect(body).not.toContain("solo3-secret");
  });

  it("does not serve uploaded artifact HTML from the app host on HEAD either", async () => {
    await req("/api/artifacts", {
      method: "POST",
      body: htmlForm({ title: "Solo4", slug: "solo4" }, "x.html", strToU8("<h1>solo4</h1>")),
    });
    const res = await appReq("/solo4/", { method: "HEAD" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`https://${CONTENT_HOST}/solo4/`);
  });

  it("with CONTENT_HOSTNAMES unset, every existing host behaves as before (no restriction)", async () => {
    expect((await req("/admin")).status).toBe(200);
    expect((await req("/health")).status).toBe(200);
  });
});
