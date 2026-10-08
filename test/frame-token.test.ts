import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { zipSync, strToU8 } from "fflate";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { initDb, clearR2, req, as, viewerPath } from "./fixtures";
import { mintFrameToken, mintSession, verifySession } from "../src/session";

/**
 * The viewer frame is sandboxed without allow-same-origin, so a real browser
 * sends NO cookie with anything the framed artifact loads. These tests model
 * that browser: every framed request below goes out with no identity at all,
 * which is exactly what broke multi-file sites (2026-10-08, drportfolio — 84
 * files stored, every image a 404 in the viewer).
 */

const OWNER = "owner@rtfx.pro";
const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const CONTENT = "https://a.rtfx.pro";
const APP = "https://rtfx.pro";
const NOW = () => new Date().toISOString();

/** Production-shaped env: a real session secret and no dev-login shortcut. */
const prod = {
  ...(env as any),
  SESSION_SECRET: SECRET,
  DEV_LOGIN: undefined,
  CONTENT_HOSTNAMES: "a.rtfx.pro",
  PUBLIC_BASE_URL: "https://rtfx.pro",
  ADMIN_EMAILS: "nobody-admin@example.com",
};

/** A request to the content host, optionally as the signed-in owner. */
async function content(path: string, headers: Record<string, string> = {}, signedIn = false) {
  const h = { ...headers };
  if (signedIn) {
    const token = await mintSession(SECRET, { email: OWNER, kind: "member" }, NOW());
    h.Cookie = `${SESSION_COOKIE}=${token}`;
  }
  return app.request(`${CONTENT}${path}`, { headers: h }, prod);
}

/** A request to the APP host (where the viewer lives), optionally as the signed-in owner. */
async function appHost(path: string, headers: Record<string, string> = {}, signedIn = false) {
  const h = { ...headers };
  if (signedIn) {
    const token = await mintSession(SECRET, { email: OWNER, kind: "member" }, NOW());
    h.Cookie = `${SESSION_COOKIE}=${token}`;
  }
  return app.request(`${APP}${path}`, { headers: h }, prod);
}

beforeEach(async () => {
  await initDb();
  await clearR2();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const VIDEO = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));

async function publishSite(slug = "site") {
  const zip = zipSync({
    "index.html": strToU8('<h1>home</h1><img src="img/a.png"><a href="work.html">work</a>'),
    "work.html": strToU8("<!doctype html><html><body><h1>work</h1></body></html>"),
    "img/a.png": PNG,
    "media/clip.mp4": VIDEO,
  });
  const fd = new FormData();
  fd.set("slug", slug);
  fd.set("title", "Site");
  fd.set("bundle", new File([zip], "bundle.zip", { type: "application/zip" }));
  const res = await req("/api/artifacts", as(OWNER, { method: "POST", body: fd }));
  expect(res.status).toBeLessThan(300);
}

const NAV = { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };

/** A top-level navigation to the CONTENT host (an old link, or a pasted frame URL). */
const navigate = (path: string, signedIn = false) => content(path, NAV, signedIn);

/** A top-level navigation to the canonical viewer on the app host. */
async function viewer(slug: string, rest = "", signedIn = true) {
  return appHost(await viewerPath(slug, rest), NAV, signedIn);
}

/** What the sandboxed frame sends: a subresource request with no cookie. */
const framed = (path: string, dest = "image", extra: Record<string, string> = {}) =>
  content(path, { "Sec-Fetch-Dest": dest, ...extra });

/** The iframe src exactly as rendered: absolute, on the content host. */
async function frameSrcAbsolute(slug = "site"): Promise<string> {
  const html = await (await viewer(slug)).text();
  const src = /<iframe[^>]*\ssrc="([^"]+)"/.exec(html)?.[1];
  expect(src).toBeTruthy();
  return src!.replace(/&amp;/g, "&");
}

/** The same, as a path on the content host (what the sandboxed frame requests). */
async function frameSrc(slug = "site"): Promise<string> {
  const src = await frameSrcAbsolute(slug);
  expect(src.startsWith(`${CONTENT}/`)).toBe(true);
  return src.slice(CONTENT.length);
}

describe("viewer frame token", () => {
  it("frames the artifact under a token path", async () => {
    await publishSite();
    const src = await frameSrcAbsolute();
    expect(src).toMatch(/^https:\/\/a\.rtfx\.pro\/site\/~t\/[^/]+\/\?raw=1$/);
  });

  it("serves the frame and its relative assets with no cookie", async () => {
    await publishSite();
    const src = await frameSrc();
    const base = src.replace(/\?raw=1$/, "");

    const page = await framed(src, "iframe");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>home</h1>");

    // Exactly what the browser resolves `img/a.png` and `work.html` to.
    const img = await framed(`${base}img/a.png`);
    expect(img.status).toBe(200);
    expect(img.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);

    const work = await framed(`${base}work.html`, "iframe");
    expect(work.status).toBe(200);
    expect(await work.text()).toContain("<h1>work</h1>");
  });

  /** The framed page's own fetch() is cross-origin (opaque origin). */
  it("makes token-path responses CORS-readable, and only those", async () => {
    await publishSite();
    const base = (await frameSrc()).replace(/\?raw=1$/, "");
    const viaToken = await framed(`${base}img/a.png`, "empty", { Origin: "null" });
    expect(viaToken.status).toBe(200);
    expect(viaToken.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const viaCookie = await content("/site/img/a.png", { Origin: "https://evil.example" }, true);
    expect(viaCookie.status).toBe(200);
    expect(viaCookie.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("still 404s the same assets with no cookie and no token", async () => {
    await publishSite();
    expect((await framed("/site/img/a.png")).status).toBe(404);
  });

  it("refuses a token minted for a different artifact", async () => {
    await publishSite("site");
    await publishSite("other");
    const token = await mintFrameToken(SECRET, "other", NOW());
    expect((await framed(`/site/~t/${token}/img/a.png`)).status).toBe(404);
  });

  it("refuses an expired token", async () => {
    await publishSite();
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const token = await mintFrameToken(SECRET, "site", old);
    expect((await framed(`/site/~t/${token}/img/a.png`)).status).toBe(404);
  });

  it("refuses a session token presented as a frame token", async () => {
    await publishSite();
    const session = await mintSession(SECRET, { email: OWNER, kind: "member" }, NOW());
    expect((await framed(`/site/~t/${session}/img/a.png`)).status).toBe(404);
  });

  /** The framed request has no identity now, so the shell must log the view. */
  it("records a view when a signed-in person opens the viewer", async () => {
    await publishSite();
    await viewer("site");
    const row = await (env as any).DB.prepare(
      "SELECT email FROM artifact_views WHERE slug = ?"
    ).bind("site").first();
    expect(row?.email).toBe(OWNER);
  });

  it("is never accepted as a session", async () => {
    const token = await mintFrameToken(SECRET, "site", NOW());
    expect(await verifySession(SECRET, token, NOW())).toBeNull();
  });

  /** Artifact HTML must never become a top-level document on the content origin. */
  it("sends a top-level navigation to a frame URL back to the shell", async () => {
    await publishSite();
    const base = (await frameSrc()).replace(/\?raw=1$/, "");
    const res = await navigate(`${base}work.html?raw=1`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${APP}${await viewerPath("site", "work.html")}`);
    // And the raw bytes were not served on the way.
    expect(await res.text()).not.toContain("<h1>work</h1>");
  });

  it("injects the scroll reporter into pages navigated to inside the frame", async () => {
    await publishSite();
    const base = (await frameSrc()).replace(/\?raw=1$/, "");
    const plain = await (await content("/site/work.html", {}, true)).text();
    const inFrame = await (await framed(`${base}work.html`, "iframe")).text();
    expect(inFrame.length).toBeGreaterThan(plain.length);
  });
});

describe("media serving", () => {
  it("serves video with a video type and honours byte ranges", async () => {
    await publishSite();
    const full = await req("/site/media/clip.mp4", as(OWNER));
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe("video/mp4");
    expect(full.headers.get("Accept-Ranges")).toBe("bytes");

    const part = await req("/site/media/clip.mp4", as(OWNER, { headers: { Range: "bytes=10-19" } }));
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 10-19/100");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(VIDEO.slice(10, 20));

    const tail = await req("/site/media/clip.mp4", as(OWNER, { headers: { Range: "bytes=-5" } }));
    expect(tail.status).toBe(206);
    expect(tail.headers.get("Content-Range")).toBe("bytes 95-99/100");
  });

  it("falls back to the whole file for a malformed range", async () => {
    await publishSite();
    const res = await req("/site/media/clip.mp4", as(OWNER, { headers: { Range: "bytes=zzz" } }));
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });
});

describe("claude.ai downloads shim", () => {
  async function publishPages(slug = "dl") {
    const zip = zipSync({
      "index.html": strToU8(
        "<!doctype html><html><head><title>t</title><script>window.pageScript=1</script></head>" +
          "<body><h1>home</h1></body></html>"
      ),
      "bare.html": strToU8("<body><p>no head</p><script>window.pageScript=1</script></body>"),
    });
    const fd = new FormData();
    fd.set("slug", slug);
    fd.set("title", "DL");
    fd.set("bundle", new File([zip], "bundle.zip", { type: "application/zip" }));
    expect((await req("/api/artifacts", as(OWNER, { method: "POST", body: fd }))).status).toBeLessThan(300);
  }

  it("runs before the page's own scripts in framed HTML", async () => {
    await publishPages();
    const base = (await frameSrc("dl")).replace(/\?raw=1$/, "");
    const html = await (await framed(`${base}`, "iframe")).text();
    const shim = html.indexOf("use:function");
    expect(shim).toBeGreaterThan(-1);
    expect(shim).toBeLessThan(html.indexOf("window.pageScript"));
    expect(shim).toBeGreaterThan(html.indexOf("<head>"));
  });

  it("goes first in <body> when the page has no <head>", async () => {
    await publishPages();
    const base = (await frameSrc("dl")).replace(/\?raw=1$/, "");
    const html = await (await framed(`${base}bare.html`, "iframe")).text();
    expect(html.match(/use:function/g)?.length).toBe(1);
    expect(html.indexOf("use:function")).toBeLessThan(html.indexOf("window.pageScript"));
  });

  it("never alters the bytes a machine client downloads", async () => {
    await publishPages();
    const raw = await (await content("/dl/index.html", {}, true)).text();
    expect(raw).not.toContain("use:function");
  });
});

/**
 * An artifact opened as its own top-level page used to run AS the content
 * origin with the visitor's cookie, and could read every other artifact they
 * can open (2026-10-08: ?raw=1 read a different private artifact, 200).
 */
describe("artifact documents are sandboxed however they are reached", () => {
  it("sends a top-level ?raw=1 navigation to the viewer instead", async () => {
    await publishSite();
    const res = await navigate("/site/work.html?raw=1", true);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${APP}${await viewerPath("site", "work.html")}`);
    // ...and the app host does the same for a top-level ?raw=1: never the bare artifact.
    const onApp = await appHost(`${await viewerPath("site", "work.html")}?raw=1`, NAV, true);
    expect(onApp.status).toBe(302);
    expect(onApp.headers.get("Location")).toBe(await viewerPath("site", "work.html"));
    expect(await onApp.text()).not.toContain("<h1>work</h1>");
  });

  it("serves HTML with a CSP sandbox and no allow-same-origin", async () => {
    await publishSite();
    const res = await content("/site/work.html", {}, true);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
  });

  // Everything but a PDF is sandboxed (an .xml can be a live document); the
  // header is harmless for an image, and the framing rule is kept.
  it("sandboxes images too, keeping their framing rule", async () => {
    await publishSite();
    const res = await content("/site/img/a.png", {}, true);
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'self' https://rtfx.pro; sandbox allow-scripts allow-forms allow-popups allow-downloads allow-modals"
    );
  });

  /** Review finding: /v/ serves uploads on the APP origin; an XHTML-in-XML file must not run there unsandboxed. */
  it("sandboxes an XHTML-in-XML file in a /v/ preview on the app host", async () => {
    const zip = zipSync({
      "index.html": strToU8("<!doctype html><body>home</body>"),
      "x.xml": strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><script>window.pwned=1</script></html>'),
    });
    const fd = new FormData();
    fd.set("slug", "xmlish");
    fd.set("title", "xmlish");
    fd.set("bundle", new File([zip], "b.zip", { type: "application/zip" }));
    expect((await req("/api/artifacts", as(OWNER, { method: "POST", body: fd }))).status).toBeLessThan(300);
    const res = await req("/v/xmlish/1/x.xml", as(OWNER));
    expect(res.status).toBe(200);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
  });
});

describe("the share page", () => {
  it("is on the app host and only for people who can manage", async () => {
    await publishSite();
    const mine = await req("/share/site", as(OWNER));
    expect(mine.status).toBe(200);
    const html = await mine.text();
    expect(html).toContain("data-make-link");
    expect(html).toContain('data-slug="site"');
    expect((await req("/share/site", as("stranger@example.com"))).status).toBe(404);
  });

  it("is refused on the content host", async () => {
    await publishSite();
    expect((await content("/share/site", {}, true)).status).toBe(404);
  });
});
