import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { SESSION_COOKIE } from "../src/auth";
import { mintSession } from "../src/session";
import { createShareLink, revokeShareLink } from "../src/share";
import { upsertMember, personalAccountFor, setAccountPublicSlug } from "../src/accounts";
import { GUEST_COOKIE } from "../src/viewing";
import {
  canonicalPath,
  canonicalArtifactLink,
  frameAncestorOrigins,
  frameAncestorsDirective,
  appOriginFor,
  contentOrigin,
} from "../src/canonical";
import { isManagementPath, reservedTopLevelSegments } from "../src/host";
import cliSource from "../cli/artifacts.mjs?raw";
import pluginMain from "../plugins/rtfx/scripts/rtfx.mjs?raw";
import pluginLib from "../plugins/rtfx/scripts/rtfx.lib.mjs?raw";
import pluginMcp from "../plugins/rtfx/scripts/rtfx.mcp.lib.mjs?raw";
import pluginApiRef from "../plugins/rtfx/skills/publishing-to-rtfx/references/api.md?raw";
import pluginSkill from "../plugins/rtfx/skills/publishing-to-rtfx/SKILL.md?raw";
import architecture from "../docs/ARCHITECTURE.md?raw";
import mcpSource from "../src/mcp.ts?raw";
import { initDb, clearR2, req, as, viewerPath } from "./fixtures";

/**
 * The canonical viewer: `https://rtfx.pro/<workspace>/<artifact>` on the APP host.
 *
 * These run production-shaped: a real signing secret, real session cookies, no
 * dev-login shortcut, two hostnames. What is being pinned is a boundary —
 * uploaded HTML is only ever served from the content host; the app host renders
 * our own shell around a cross-origin sandboxed frame.
 */

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256!!";
const APP = "https://rtfx.pro";
const CONTENT = "https://a.rtfx.pro";
const OWNER = "owner@rtfx.pro";
const GRANTEE = "dana@acme.com";
const MEMBER = "maya@rtfx.pro";
const STRANGER = "nobody@example.com";
const NOW = () => new Date().toISOString();
const NAV = { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const SECRET_BYTES = "<h1>top-secret-artifact-bytes</h1>";

function e(extra: Record<string, unknown> = {}) {
  return {
    ...(env as any),
    SESSION_SECRET: SECRET,
    DEV_LOGIN: undefined,
    CONTENT_HOSTNAMES: "a.rtfx.pro",
    PUBLIC_BASE_URL: APP,
    ADMIN_EMAILS: "ops@rtfx.pro",
    ...extra,
  };
}

const cookie = async (email: string) =>
  `${SESSION_COOKIE}=${await mintSession(SECRET, { email, kind: "member" }, NOW())}`;

const onApp = (path: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  app.request(`${APP}${path}`, { headers }, e(extra));
const onContent = (path: string, headers: Record<string, string> = {}) =>
  app.request(`${CONTENT}${path}`, { headers }, e());

async function viewer(slug: string, who: string | null, rest = "", query = "", headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...NAV, ...headers };
  if (who) h.Cookie = await cookie(who);
  return onApp(`${await viewerPath(slug, rest)}${query}`, h);
}

async function publish(slug: string, who: string, visibility = "restricted", html = SECRET_BYTES) {
  const body = new FormData();
  body.set("slug", slug);
  body.set("title", `Title of ${slug}`);
  body.set("visibility", visibility);
  body.set("file", new File([`<!doctype html><body>${html}</body>`], "index.html", { type: "text/html" }));
  const res = await app.request(`${APP}/api/artifacts`, { method: "POST", body, headers: { Cookie: await cookie(who) } }, e());
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  await initDb();
  await clearR2();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS share_links (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, token_hash TEXT NOT NULL,
      created_by TEXT NOT NULL, expires_at TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL, last_used_at TEXT)`
  ).run();
  await env.DB.prepare("DELETE FROM share_links").run();
  await publish("report", OWNER);
});

describe("who gets the viewer at the canonical address", () => {
  it("renders it for the owner, with management controls", async () => {
    const res = await viewer("report", OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("data-share-banner");
    expect(html).toContain("data-open-chat");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("renders it for a named grantee, without management controls", async () => {
    await req("/api/artifacts/report/access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "restricted", emails: [GRANTEE] }),
      ...as(OWNER),
    });
    const res = await viewer("report", GRANTEE);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("data-share-banner");
  });

  it("renders it for a workspace member on an 'everyone' artifact", async () => {
    await publish("team-doc", OWNER, "everyone");
    const account = await personalAccountFor(env as any, OWNER);
    await upsertMember(env as any, { accountId: account!.id, email: MEMBER, role: "viewer", invitedBy: OWNER, now: NOW() });
    expect((await viewer("team-doc", MEMBER)).status).toBe(200);
    expect((await viewer("team-doc", STRANGER)).status).toBe(404);
  });

  it("404s a signed-in stranger", async () => {
    const res = await viewer("report", STRANGER);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<iframe");
  });

  it("sends a signed-out browser to sign in, returning to exactly this address", async () => {
    const res = await viewer("report", null);
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("/shared/report?next=")).toBe(true);
    expect(decodeURIComponent(loc.split("next=")[1])).toBe(await viewerPath("report"));
  });

  it("answers a signed-out browser identically for a workspace address whether or not the artifact exists", async () => {
    const real = await viewer("report", null);
    const ws = (await viewerPath("report")).split("/")[1];
    const missing = await onApp(`/${ws}/no-such-artifact`, NAV);
    // Same shape: a redirect to sign in (carrying only its own slug in the URL).
    expect(missing.status).toBe(real.status);
    expect((missing.headers.get("location") ?? "").replace("no-such-artifact", "report").split("?")[0]).toBe(
      (real.headers.get("location") ?? "").split("?")[0]
    );
  });

  it("serves a sub-path of the artifact in the frame", async () => {
    const res = await viewer("report", OWNER, "deck/p1.html");
    expect(res.status).toBe(200);
    const src = /<iframe[^>]*\ssrc="([^"]+)"/.exec(await res.text())?.[1] ?? "";
    expect(src).toMatch(/^https:\/\/a\.rtfx\.pro\/report\/~t\/[^/]+\/deck\/p1\.html\?raw=1$/);
  });

  it("refuses to frame a path that tries to smuggle a query or an escape", async () => {
    const ws = (await viewerPath("report")).split("/")[1];
    const res = await app.request(
      `${APP}/${ws}/report/a%3Fb%23c/..%2Fx`,
      { headers: { ...NAV, Cookie: await cookie(OWNER) } },
      e()
    );
    const src = /<iframe[^>]*\ssrc="([^"]+)"/.exec(await res.text())?.[1] ?? "";
    // Encoded, so it stays inside the path.
    expect(src).toContain("/a%3Fb%23c/x?raw=1");
    expect(src).not.toContain("..");
    expect(src.split("?").length).toBe(2);
  });
});

describe("the viewer page contains no artifact bytes", () => {
  it("is our shell plus one cross-origin sandboxed iframe", async () => {
    const html = await (await viewer("report", OWNER)).text();
    expect(html).not.toContain("top-secret-artifact-bytes");
    const frames = html.match(/<iframe/g) ?? [];
    expect(frames).toHaveLength(1);
    const tag = /<iframe[^>]*>/.exec(html)![0];
    expect(tag).toContain("sandbox=");
    expect(tag).toContain("allow-scripts");
    expect(tag).not.toContain("allow-same-origin");
    expect(tag).toMatch(/ src="https:\/\/a\.rtfx\.pro\//);
  });

  it("limits what the page may frame to the content origin", async () => {
    const res = await viewer("report", OWNER);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-src https://a.rtfx.pro");
    expect(csp).toContain("base-uri 'none'");
    // ...and nobody may frame the viewer itself.
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("untrusted artifact bytes never come from the app host", () => {
  it("redirects every non-navigation request for a canonical address to the content host", async () => {
    const ws = (await viewerPath("report")).split("/")[1];
    const variants: Record<string, string>[] = [{}, { "Sec-Fetch-Dest": "iframe" }, { "Sec-Fetch-Dest": "script" }, { "Sec-Fetch-Dest": "empty" }];
    for (const headers of variants) {
      for (const path of [`/${ws}/report`, `/${ws}/report/`, `/${ws}/report/index.html`, `/${ws}/report?raw=1`]) {
        const res = await onApp(path, { ...headers, Cookie: await cookie(OWNER) });
        expect(res.status, path).toBe(302);
        expect(res.headers.get("location"), path).toMatch(/^https:\/\/a\.rtfx\.pro\/report\//);
        expect(await res.text(), path).not.toContain("top-secret-artifact-bytes");
      }
    }
  });

  it("never yields HTML for ?raw=1 as a top-level navigation either", async () => {
    const res = await viewer("report", OWNER, "", "?raw=1");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(await viewerPath("report"));
    expect(await res.text()).not.toContain("top-secret-artifact-bytes");
  });

  it("does not serve a frame-token path on the app host", async () => {
    const res = await onApp("/report/~t/anything/index.html", { Cookie: await cookie(OWNER) });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("top-secret-artifact-bytes");
  });

  it("does not serve content from the app host for any legacy path either", async () => {
    for (const path of ["/report", "/report/", "/report/index.html"]) {
      const variants: Record<string, string>[] = [NAV, {}];
      for (const headers of variants) {
        const res = await onApp(path, { ...headers, Cookie: await cookie(OWNER) });
        expect(await res.text(), path).not.toContain("top-secret-artifact-bytes");
        expect(res.status, path).toBe(302);
      }
    }
  });

  it("answers POST to a viewer address with a plain 404", async () => {
    const res = await app.request(`${APP}${await viewerPath("report")}`, { method: "POST" }, e());
    expect(res.status).toBe(404);
  });
});

describe("the content host", () => {
  it("still refuses management routes", async () => {
    for (const path of ["/api/artifacts", "/admin", "/mcp", "/oauth/token", "/share/report", "/v/report/1/", "/_chat/report"]) {
      expect((await onContent(path, { Cookie: await cookie(OWNER) })).status, path).toBe(404);
    }
  });

  it("serves frame tokens and nothing else to a sandboxed frame, with an exact frame-ancestors allowlist", async () => {
    const html = await (await viewer("report", OWNER)).text();
    const src = /<iframe[^>]*\ssrc="([^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
    const res = await onContent(src.slice(CONTENT.length), { "Sec-Fetch-Dest": "iframe" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("top-secret-artifact-bytes");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self' https://rtfx.pro;");
    expect(csp).not.toMatch(/frame-ancestors[^;]*\*/);
    expect(csp).not.toContain("a.rtfx.pro");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
  });

  it("sends a browser navigation to a frame URL to the canonical viewer, serving no bytes", async () => {
    const html = await (await viewer("report", OWNER)).text();
    const src = /<iframe[^>]*\ssrc="([^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
    const res = await onContent(src.slice(CONTENT.length), NAV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP}${await viewerPath("report")}`);
    expect(await res.text()).not.toContain("top-secret-artifact-bytes");
  });
});

describe("the frame-ancestors allowlist", () => {
  it("is the app origin plus APP_ORIGINS, never a content host and never a wildcard", () => {
    const base = { CONTENT_HOSTNAMES: "a.rtfx.pro", PUBLIC_BASE_URL: "https://rtfx.pro" } as any;
    expect(frameAncestorOrigins(base)).toEqual(["https://rtfx.pro"]);
    expect(frameAncestorsDirective(base)).toBe("frame-ancestors 'self' https://rtfx.pro");

    const extra = { ...base, APP_ORIGINS: "https://ops.example.com, https://a.rtfx.pro, javascript:alert(1), *, not a url" };
    expect(frameAncestorOrigins(extra)).toEqual(["https://rtfx.pro", "https://ops.example.com"]);
    expect(frameAncestorsDirective(extra)).not.toContain("*");
    expect(frameAncestorsDirective(extra)).not.toContain("a.rtfx.pro");
  });

  it("does not include the mcp host: it never renders the viewer", async () => {
    const res = await app.request(`https://mcp.rtfx.pro${await viewerPath("report")}?x=1`, { headers: NAV }, e());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP}${await viewerPath("report")}?x=1`);
  });
});

describe("a workspace address that does not match", () => {
  it("404s a real artifact under the wrong address exactly like a missing one", async () => {
    await publish("other-doc", MEMBER);
    const maya = await personalAccountFor(env as any, MEMBER);
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(maya!.id).run();
    await setAccountPublicSlug(env as any, maya!.id, "maya", "2026-10-01T00:00:00.000Z");
    const ws = (await viewerPath("report")).split("/")[1];

    const real = await onApp(`/${ws}/other-doc`, { ...NAV, Cookie: await cookie(OWNER) });
    const missing = await onApp(`/${ws}/no-such-doc`, { ...NAV, Cookie: await cookie(OWNER) });
    expect(real.status).toBe(404);
    expect(missing.status).toBe(404);
    expect((await real.text()).replace(/other-doc/g, "X")).toBe((await missing.text()).replace(/no-such-doc/g, "X"));
  });

  it("keeps a share link working after the workspace address changes", async () => {
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: NOW() });
    const oldPath = await viewerPath("report");
    const account = await personalAccountFor(env as any, OWNER);
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(account!.id).run();
    expect((await setAccountPublicSlug(env as any, account!.id, "yogev", "2026-10-01T00:00:00.000Z")).ok).toBe(true);

    // Without the key the old address is gone...
    expect((await onApp(oldPath, { ...NAV, Cookie: await cookie(STRANGER) })).status).toBe(404);
    // ...with it, the visitor is sent to the current address, key intact.
    const res = await onApp(`${oldPath}?k=${encodeURIComponent(link.key)}`, NAV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP}/yogev/report?k=${encodeURIComponent(link.key)}`);
  });
});

describe("share links on the canonical address", () => {
  it("exchanges the key for a per-artifact, HttpOnly, Secure, SameSite=Lax cookie and a clean URL", async () => {
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: NOW() });
    const res = await onApp(`${await viewerPath("report")}?k=${encodeURIComponent(link.key)}`, NAV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(await viewerPath("report"));
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^rtfx_link_report=/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(set).toContain(attr);
    expect(set).not.toMatch(/Domain=/i);
  });

  it("opens the viewer chromeless for a link holder, who is a reader and not an owner", async () => {
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: NOW() });
    const first = await onApp(`${await viewerPath("report")}?k=${encodeURIComponent(link.key)}`, NAV);
    const ck = (first.headers.get("set-cookie") ?? "").split(";")[0];
    // Even an owner arriving by link is shown the artifact alone.
    const res = await onApp(await viewerPath("report"), { ...NAV, Cookie: `${ck}; ${await cookie(OWNER)}` });
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const hook of ["data-bar", "data-open-chat", "data-share-banner"]) expect(html).not.toContain(hook);
    expect(html).toContain("<iframe");
  });

  it("does not let one artifact's link cookie open another", async () => {
    await publish("second", OWNER);
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: NOW() });
    const first = await onApp(`${await viewerPath("report")}?k=${encodeURIComponent(link.key)}`, NAV);
    const ck = (first.headers.get("set-cookie") ?? "").split(";")[0].replace("rtfx_link_report", "rtfx_link_second");
    const res = await onApp(await viewerPath("second"), { ...NAV, Cookie: ck });
    expect(res.status).toBe(302); // no credential for `second`: sign-in, not content
  });

  it("stops working immediately when revoked", async () => {
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: NOW() });
    const first = await onApp(`${await viewerPath("report")}?k=${encodeURIComponent(link.key)}`, NAV);
    const ck = (first.headers.get("set-cookie") ?? "").split(";")[0];
    await revokeShareLink(env as any, "report", link.id, NOW());
    const res = await onApp(await viewerPath("report"), { ...NAV, Cookie: ck });
    expect(res.status).not.toBe(200);
  });

  it("gives a link-card crawler the artifact's title on the canonical ?k= URL, and records a preview", async () => {
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: NOW() });
    for (const ua of ["Twitterbot/1.0", "WhatsApp/2.23", "Slackbot-LinkExpanding 1.0"]) {
      const res = await onApp(`${await viewerPath("report")}?k=${encodeURIComponent(link.key)}`, { "User-Agent": ua });
      expect(res.status, ua).toBe(200);
      const html = await res.text();
      expect(html, ua).toContain("Title of report");
      expect(html, ua).not.toContain("<iframe");
      expect(html, ua).not.toContain(link.key);
    }
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM artifact_views WHERE outcome = 'preview'").first<any>();
    expect(n.n).toBeGreaterThan(0);
  });

  it("gives a crawler holding a dead key no card", async () => {
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: NOW() });
    await revokeShareLink(env as any, "report", link.id, NOW());
    const res = await onApp(`${await viewerPath("report")}?k=${encodeURIComponent(link.key)}`, { "User-Agent": "Twitterbot/1.0" });
    expect(res.status).toBe(302);
    expect(await res.text()).not.toContain("Title of report");
  });

  it("records an attempt with an expired link, and shows the visitor the sign-in they always got", async () => {
    const link = await createShareLink(env as any, {
      slug: "report",
      createdBy: OWNER,
      now: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
    });
    const res = await onApp(`${await viewerPath("report")}?k=${encodeURIComponent(link.key)}`, NAV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/shared\/report/);
    const row = await env.DB.prepare("SELECT outcome, link_id FROM artifact_views WHERE slug = 'report'").first<any>();
    expect(row).toMatchObject({ outcome: "link_expired", link_id: link.id });
  });
});

describe("guests", () => {
  it("open the artifact with their guest cookie and are never treated as a member elsewhere", async () => {
    await req("/api/artifacts/report/access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "restricted", emails: [GRANTEE] }),
      ...as(OWNER),
    });
    const guest = `${GUEST_COOKIE}=${await mintSession(SECRET, { email: GRANTEE, kind: "guest", slug: "report" }, NOW())}`;
    expect((await onApp(await viewerPath("report"), { ...NAV, Cookie: guest })).status).toBe(200);
    // The guest cookie is not a session: it opens no dashboard and no API.
    expect((await onApp("/admin", { Accept: "text/html", Cookie: guest })).status).not.toBe(200);
    expect((await onApp("/api/artifacts", { Cookie: guest })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("old URLs redirect, in every form", () => {
  const canonical = async (rest = "") => `${APP}${await viewerPath("report", rest)}`;

  it("a.rtfx.pro/<slug>/ in a browser", async () => {
    for (const path of ["/report", "/report/", "/report/deck/p1.html", "/report/?raw=1", "/report/deck/p1.html?raw=1"]) {
      const res = await onContent(path, { ...NAV, Cookie: await cookie(OWNER) });
      expect(res.status, path).toBe(302);
      const rest = path.replace(/^\/report\/?/, "").replace(/\?.*$/, "");
      expect(res.headers.get("location"), path).toBe(await canonical(rest));
      expect(await res.text(), path).not.toContain("top-secret-artifact-bytes");
    }
  });

  it("a.rtfx.pro/<slug>/?k= keeps the key for redemption at the canonical address", async () => {
    const link = await createShareLink(env as any, { slug: "report", createdBy: OWNER, now: NOW() });
    const res = await onContent(`/report/?k=${encodeURIComponent(link.key)}`, NAV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${await canonical()}?k=${encodeURIComponent(link.key)}`);
    // and the redirect target redeems it
    const redeemed = await onApp(`${await viewerPath("report")}?k=${encodeURIComponent(link.key)}`, NAV);
    expect(redeemed.headers.get("set-cookie")).toContain("rtfx_link_report=");
  });

  it("a machine client on the content host is unchanged: raw bytes with its bearer identity or cookie", async () => {
    const res = await onContent("/report/", { Cookie: await cookie(OWNER) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("top-secret-artifact-bytes");
    const denied = await onContent("/report/", { Cookie: await cookie(STRANGER) });
    expect(denied.status).toBe(404);
  });

  it("rtfx.pro/<slug>/... (the old app-host form) in a browser", async () => {
    for (const [path, rest] of [["/report", ""], ["/report/", ""], ["/report/a/b.html", "a/b.html"]] as const) {
      const res = await onApp(path, { ...NAV, Cookie: await cookie(OWNER) });
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe(await canonical(rest));
    }
  });

  it("rtfx.pro/<slug>/... for a machine goes straight to the raw bytes", async () => {
    const res = await onApp("/report/a/b.html?x=1");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://a.rtfx.pro/report/a/b.html?x=1");
  });

  it("an unknown first segment is a 404", async () => {
    for (const headers of [NAV, {}]) {
      const res = await onApp("/definitely-not-a-thing/at-all", headers);
      expect(res.status).toBe(404);
    }
  });

  it("a workspace address wins over an artifact slug of the same name", async () => {
    const ws = (await viewerPath("report")).split("/")[1];
    await publish(ws, OWNER); // an artifact whose slug is the workspace's own address
    // /<ws>/report is still the workspace's artifact...
    expect((await onApp(`/${ws}/report`, { ...NAV, Cookie: await cookie(OWNER) })).status).toBe(200);
    // ...and the lone /<ws> is the artifact of that name (there is no workspace landing page).
    const lone = await onApp(`/${ws}`, { ...NAV, Cookie: await cookie(OWNER) });
    expect(lone.status).toBe(302);
  });
});

describe("the 404 page's ask-for-access form", () => {
  it("posts to the app host now that the viewer's 404 renders there", async () => {
    const res = await app.request(
      `${APP}/_access-request/report`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: STRANGER }) },
      e()
    );
    expect(res.status).toBe(202);
  });
});

describe("routing precedence", () => {
  it("never captures management paths, however deep", async () => {
    for (const path of ["/share/report", "/u/abc", "/api/artifacts", "/admin/artifacts/report", "/auth/start", "/oauth/token", "/mcp", "/v/report/1/index.html", "/.well-known/security.txt", "/robots.txt", "/sitemap.xml", "/llms.txt", "/docs", "/health"]) {
      expect(isManagementPath(path) || path === "/robots.txt", path).toBe(true);
    }
    // And the live app host answers them as itself, not as an artifact.
    expect((await onApp("/health")).status).toBe(200);
    expect((await onApp("/docs", { Accept: "text/html" })).status).toBe(200);
    expect((await onApp("/robots.txt")).status).toBe(200);
    expect((await onApp("/share/report", { Cookie: await cookie(OWNER) })).status).toBe(200);
  });

  it("reserves every top-level route as a workspace name", () => {
    const reserved = reservedTopLevelSegments();
    for (const s of ["share", "u", "api", "admin", "auth", "oauth", "mcp", "v", "_chat", "_access-request"]) {
      expect(reserved, s).toContain(s);
    }
  });

  it("serves a depth > 2 address as an app-host GET", async () => {
    const res = await viewer("report", OWNER, "a/b/c/d.html");
    expect(res.status).toBe(200);
  });
});

describe("single-host deployments (no CONTENT_HOSTNAMES)", () => {
  const single = (path: string, headers: Record<string, string> = {}) =>
    app.request(`http://localhost:8787${path}`, { headers }, e({ CONTENT_HOSTNAMES: undefined, PUBLIC_BASE_URL: undefined }));

  it("renders the viewer at the canonical address with a same-origin frame", async () => {
    const res = await single(await viewerPath("report"), { ...NAV, Cookie: await cookie(OWNER) });
    expect(res.status).toBe(200);
    const src = /<iframe[^>]*\ssrc="([^"]+)"/.exec(await res.text())?.[1] ?? "";
    expect(src).toMatch(/^\/report\/~t\/[^/]+\/\?raw=1$/);
    const frame = await single(src.replace("&amp;", "&"), { "Sec-Fetch-Dest": "iframe" });
    expect(frame.status).toBe(200);
    expect(await frame.text()).toContain("top-secret-artifact-bytes");
  });

  it("redirects a browser at /<slug>/ to the canonical address on the same origin", async () => {
    const res = await single("/report/", { ...NAV, Cookie: await cookie(OWNER) });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`http://localhost:8787${await viewerPath("report")}`);
  });
});

describe("canonical URL helpers", () => {
  it("builds addresses from the workspace and slug", () => {
    expect(canonicalPath("yogev", "q3-board-report")).toBe("/yogev/q3-board-report");
    expect(canonicalPath("yogev", "q3", "a b/c.html")).toBe("/yogev/q3/a%20b/c.html");
    expect(canonicalPath(null, "legacy")).toBe("/legacy");
    expect(canonicalArtifactLink("https://rtfx.pro/", "w-3f9a0c12", "deck")).toBe("https://rtfx.pro/w-3f9a0c12/deck");
  });

  it("uses the configured app origin on two hosts and the request's own on one", () => {
    const two = { CONTENT_HOSTNAMES: "a.rtfx.pro", PUBLIC_BASE_URL: "https://rtfx.pro" } as any;
    expect(appOriginFor(two, "https://mcp.rtfx.pro/x")).toBe("https://rtfx.pro");
    expect(appOriginFor({} as any, "http://localhost:8787/x")).toBe("http://localhost:8787");
    expect(contentOrigin(two, "https://rtfx.pro/x")).toBe("https://a.rtfx.pro");
    expect(contentOrigin({} as any, "https://rtfx.pro/x")).toBeNull();
  });
});

describe("owner-less artifacts (no workspace)", () => {
  it("are addressed at /<slug> on the app host and viewed there", async () => {
    await env.DB.prepare("UPDATE artifacts SET account_id = NULL WHERE slug = 'report'").run();
    const admin = e({ ADMIN_EMAILS: "ops@rtfx.pro" });
    const list = await app.request(`${APP}/api/artifacts`, { headers: { Cookie: await cookie("ops@rtfx.pro") } }, admin);
    const row = ((await list.json()) as any).artifacts.find((a: any) => a.slug === "report");
    expect(row.url).toBe(`${APP}/report`);

    const res = await app.request(`${APP}/report`, { headers: { ...NAV, Cookie: await cookie("ops@rtfx.pro") } }, admin);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<iframe");
    // No one but admins reach an owner-less artifact.
    expect((await app.request(`${APP}/report`, { headers: { ...NAV, Cookie: await cookie(STRANGER) } }, admin)).status).toBe(404);
  });
});

describe("first-party clients and docs show only the canonical URL", () => {
  it("the CLI and the local plugin print `url` and never a content-host address", () => {
    for (const [name, src] of Object.entries({ cliSource, pluginMain, pluginLib, pluginMcp })) {
      expect(src, name).not.toMatch(/content_base(?!64)/);
      expect(src, name).not.toMatch(/https?:\/\/a\.rtfx\.pro/);
      expect(src, name).not.toContain("branded_url");
    }
  });

  it("the remote MCP server tells models to show `url` exactly as given", () => {
    expect(mcpSource).not.toMatch(/content_base(?!64)/);
    expect(mcpSource).toContain("Show the person the returned `url` exactly as given");
    expect(pluginMcp).toContain("Show the person the returned url exactly as given");
  });

  it("the plugin's skill and API reference document rtfx.pro/<workspace>/<slug>", () => {
    expect(pluginSkill).toContain("https://rtfx.pro/<workspace>/<slug>");
    expect(pluginApiRef).not.toContain("a.rtfx.pro");
  });

  it("ARCHITECTURE.md describes the viewer on the app host and the invisible content origin", () => {
    expect(architecture).toContain("https://rtfx.pro/<workspace>/<artifact>");
    expect(architecture).toContain("viewer lives on the app host");
    expect(architecture).toContain("Invisible");
    expect(architecture).toContain("frame-ancestors");
    expect(architecture).toContain("PUBLIC_BASE_URL");
  });
});
