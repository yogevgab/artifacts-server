import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { initDb, clearR2, req, as } from "./fixtures";
import { isManagementPath } from "../src/host";
import { PUBLIC_PAGES, sitemapXml, llmsTxt } from "../src/seo";
import { CONSENT_KEY, CONSENT_VERSION } from "../src/consent";
import type { Env } from "../src/env";

/**
 * Privacy, terms and the cookie notice (issue #36).
 *
 * The interesting assertions here are the honesty ones. It is easy to ship a
 * cookie banner that asks permission for tracking that does not exist, and a
 * privacy policy describing a product somebody else built. So these tests pin:
 *
 *  - the two pages are **public** — no identity read, no Access needed, and they
 *    stay off the artifact content origin like every other management path;
 *  - canonical rtfx.pro pages render production-facing legal copy, while
 *    non-canonical/self-host deployments keep the operator-template banner;
 *  - nothing on any public page **sets a cookie or loads a third-party script**,
 *    which is the claim the notice makes on the product's behalf.
 */

const ANON = { headers: { "X-Dev-Anonymous": "true" } };
const SUPER = "admin@test.com";
const LEGAL = ["/privacy", "/terms"];
const PUBLIC = ["/", "/login", "/privacy", "/terms"];

beforeEach(async () => {
  await initDb();
  await clearR2();
});

const html = async (path: string, init?: RequestInit) => await (await req(path, init)).text();
const text = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

// --- the pages exist, publicly ----------------------------------------------

describe("/privacy and /terms are public pages", () => {
  it("answer 200 to a visitor with no identity at all", async () => {
    for (const path of LEGAL) {
      const res = await req(path, ANON);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type"), path).toContain("text/html");
      expect(res.headers.get("Cache-Control"), path).toBe("public, max-age=300");
    }
  });

  it("answer identically whether or not somebody is signed in", async () => {
    for (const path of LEGAL) {
      expect(await html(path, as(SUPER)), path).toBe(await html(path, ANON));
    }
  });

  it("are management paths, so the artifact content origin never serves them", async () => {
    for (const path of LEGAL) expect(isManagementPath(path), path).toBe(true);
    const contentEnv = { ...env, CONTENT_HOSTNAMES: "content.test.local" } as unknown as Env;
    for (const path of LEGAL) {
      const res = await app.request(`https://content.test.local${path}`, ANON, contentEnv as any);
      expect(res.status, path).toBe(404);
    }
  });

  it("wear the same chrome as every other public page", async () => {
    for (const path of LEGAL) {
      const body = await html(path, ANON);
      expect(body, path).toContain("data-brand-lockup");
      expect(body, path).toContain('<nav class="nav" aria-label="Primary">');
      expect(body, path).toContain('<footer class="site">');
    }
  });

  it("drop their own link from the nav, like the other public pages do", async () => {
    expect(await html("/privacy", ANON)).not.toContain('data-nav="privacy"');
    expect(await html("/terms", ANON)).not.toContain('data-nav="terms"');
  });
});

// --- discoverability --------------------------------------------------------

describe("the legal pages are findable", () => {
  it("is linked from the footer of every public page", async () => {
    for (const path of PUBLIC) {
      const body = await html(path, ANON);
      expect(body, path).toContain('<a href="/privacy" data-legal="privacy">Privacy</a>');
      expect(body, path).toContain('<a href="/terms" data-legal="terms">Terms</a>');
      expect(body, path).toContain('<nav class="legal" aria-label="Legal">');
    }
  });

  it("is linked from the dashboard too, where signed-in people are", async () => {
    for (const path of ["/admin", "/admin/settings", "/admin/gallery"]) {
      const body = await html(path, as(SUPER));
      expect(body, path).toContain('<a href="/privacy" data-legal="privacy">Privacy</a>');
      expect(body, path).toContain('<a href="/terms" data-legal="terms">Terms</a>');
    }
  });

  it("is crawlable: indexed, canonical, and in the sitemap and llms.txt", async () => {
    for (const path of LEGAL) {
      const body = await html(path, ANON);
      expect(body, path).toContain('<meta name="robots" content="index,follow,max-image-preview:large">');
      expect(body, path).toContain(`<link rel="canonical" href="https://rtfx.pro${path}">`);
      expect(body, path).toMatch(/<meta name="description" content="[^"]{80,}">/);
      expect(body, path).toContain("application/ld+json");
    }
    expect(PUBLIC_PAGES.map((p) => p.path)).toContain("/privacy");
    const xml = sitemapXml({ PUBLIC_BASE_URL: "https://rtfx.pro" });
    for (const path of LEGAL) expect(xml).toContain(`<loc>https://rtfx.pro${path}</loc>`);
    for (const path of LEGAL) expect(llmsTxt({ PUBLIC_BASE_URL: "https://rtfx.pro" })).toContain(path);
  });

  it("points at each other, so neither is a dead end", async () => {
    expect(await html("/terms", ANON)).toContain('href="/privacy"');
    expect(await html("/", ANON)).toContain('href="/terms"');
  });
});

// --- what the pages actually say --------------------------------------------

describe("the legal pages are honest about what they are", () => {
  it("shows the not-legal-advice banner on canonical rtfx.pro until the real legal entity is filled in", async () => {
    for (const path of LEGAL) {
      const body = await html(path, ANON);
      expect(body, path).toContain("data-legal-template");
      expect(body, path).toContain("Operator template — not legal advice");
      expect(body, path).toContain("Last updated");
      expect(body, path).toContain("privacy@rtfx.pro");
    }
  });

  it("keeps the operator-template banner on non-canonical/self-host deployments", async () => {
    const selfHostEnv = { ...env, PUBLIC_BASE_URL: "https://example.test" } as unknown as Env;
    for (const path of LEGAL) {
      const res = await app.request(`https://example.test${path}`, ANON, selfHostEnv as any);
      const body = await res.text();
      expect(body, path).toContain("data-legal-template");
      expect(body, path).toContain("Operator template — not legal advice");
      expect(body, path).toContain("governing law");
    }
  });

  it("describes the data this codebase actually stores, table by table", async () => {
    const body = (await html("/privacy", ANON)).toLowerCase();
    for (const claim of [
      "one-time code",
      "magic link",
      "view log",
      "api token",
      "hash",
      "r2",
      "lemon squeezy",
    ]) {
      expect(body, claim).toContain(claim);
    }
    // The view log is the part people are most surprised by, so it is stated
    // plainly rather than buried: the owner sees who opened their artifact.
    expect(body).toContain("who opened");
    expect(body).toContain("approximate country");
  });

  it("does not claim analytics, advertising or tracking that do not exist", async () => {
    const body = await html("/privacy", ANON);
    expect(body).toContain("no analytics");
    expect(body).toMatch(/no third-party tracking/i);
  });
});

// --- the cookie notice ------------------------------------------------------

describe("the cookie notice", () => {
  it("appears on every public page, and blocks nothing", async () => {
    for (const path of PUBLIC) {
      const body = await html(path, ANON);
      expect(body, path).toContain("data-cookie-notice");
      // Rendered hidden; only the script unhides it, and only if not dismissed.
      expect(body, path).toMatch(/<aside class="cnotice"[^>]*\bhidden\b/);
      // A region, not a dialog: no modal, no focus trap, no scroll lock.
      expect(body, path).toContain('role="region"');
      expect(body, path).not.toMatch(/role="(dialog|alertdialog)"/);
      expect(body, path).not.toContain("aria-modal");
    }
  });

  it("is a labelled region with a real dismiss button", async () => {
    const body = await html("/privacy", ANON);
    expect(body).toContain('aria-labelledby="cookie-notice-title"');
    expect(body).toContain('id="cookie-notice-title"');
    expect(body).toContain('<button type="button" class="ghost small" data-cookie-dismiss>');
  });

  it("remembers the dismissal in local storage, not in a cookie", async () => {
    const body = await html("/", ANON);
    expect(body).toContain(`var KEY = "${CONSENT_KEY}"`);
    expect(body).toContain(`var VERSION = "${CONSENT_VERSION}"`);
    expect(body).toContain("localStorage.setItem(KEY, v)");
    expect(body).not.toContain("document.cookie");
  });

  it("tells the truth: essential cookies only, nothing to opt out of on this page", async () => {
    const body = text(await html("/", ANON));
    expect(body).toContain("cookies on rtfx.pro");
    expect(body).toContain("our own sign-in session cookie");
    expect(body).toContain("edge security cookies");
    expect(body).toContain("first-party localstorage dismissal");
    expect(body).toContain("no analytics, no advertising");
    expect(body).toContain("nothing on this page to opt out of");
    expect(body).toContain('href="/privacy#cookies"');
    // No PostHog on this deployment, so there is no dashboard recording and no
    // /privacy#dashboard-analytics section — the notice must not link to one.
    expect(body).not.toContain('href="/privacy#dashboard-analytics"');
  });

  it("keeps the short notice consistent with the privacy cookie inventory", async () => {
    const notice = text(await html("/", ANON));
    const privacy = text(await html("/privacy", ANON));
    for (const claim of ["sign-in session cookie", "security cookies", "localstorage", "no analytics"]) {
      expect(notice, claim).toContain(claim);
      expect(privacy, claim).toContain(claim);
    }
  });

  it("leaves a gate closed for any non-essential script that ever arrives", async () => {
    const body = await html("/", ANON);
    expect(body).toContain("window.rtfxConsent = { acknowledged: read() === VERSION, analytics: false }");
  });

  it("documents each stored item on /privacy under a stable #cookies anchor", async () => {
    const body = await html("/privacy", ANON);
    expect(body).toContain('<section id="cookies">');
    for (const name of ["rtfx_session", "__cf_bm", CONSENT_KEY]) {
      expect(body, name).toContain(name);
    }
    expect(body).toContain("strictly necessary");
  });
});

describe("no non-essential anything runs before consent", () => {
  it("sets no cookie on any public page", async () => {
    for (const path of PUBLIC) {
      const res = await req(path, ANON);
      const setCookie = res.headers.get("Set-Cookie");
      if (path === "/login") {
        // `/login` may clear a stale OAuth continuation cookie. That is a
        // deletion (`Max-Age=0`), not pre-consent storage.
        expect(setCookie, path).toMatch(/^rtfx_next=; .*Max-Age=0/);
      } else {
        expect(setCookie, path).toBeNull();
      }
    }
  });

  it("loads no third-party script, font, image or beacon", async () => {
    for (const path of PUBLIC) {
      const body = await html(path, ANON);
      // Every script on these pages is inline, and nothing is fetched from
      // anywhere else: no external src, no remote stylesheet or font, no
      // preconnect warming up a third party, no url()/@import in the CSS.
      // (`rel="canonical"` and the inline SVG favicon are not subresources.)
      expect(body.match(/<script\b[^>]*\bsrc=/g) ?? [], path).toEqual([]);
      expect(body.match(/\bsrc="(https?:)?\/\//g) ?? [], path).toEqual([]);
      expect(
        body.match(/<link\b[^>]*rel="(stylesheet|preload|prefetch|preconnect|dns-prefetch)"/g) ?? [],
        path
      ).toEqual([]);
      expect(body.match(/@import|url\((https?:)?\/\//g) ?? [], path).toEqual([]);
      for (const tracker of ["googletagmanager", "google-analytics", "plausible", "segment.com"]) {
        expect(body, `${path} — ${tracker}`).not.toContain(tracker);
      }
    }
  });
});

// --- a deployment that says who it is ---------------------------------------

describe("the legal pages on a deployment with a configured operator (rtfx.pro)", () => {
  const configured = {
    ...(env as any),
    LEGAL_OPERATOR: "Yogev Gabrielovitch",
    LEGAL_OPERATOR_DETAIL: "an individual sole proprietor based in Israel",
    LEGAL_CONTACT: "privacy@rtfx.pro",
    LEGAL_GOVERNING_LAW: "the State of Israel",
    LEGAL_COURTS: "the competent courts of the Tel Aviv district, Israel",
  } as unknown as Env;
  const page = async (path: string) => (await app.request(path, ANON, configured as any)).text();

  it("drops the template notice and names the operator and contact", async () => {
    for (const path of LEGAL) {
      const body = await page(path);
      expect(body, path).not.toContain("data-legal-template");
      expect(body, path).not.toContain("Operator template");
      expect(body, path).toContain("Yogev Gabrielovitch, an individual sole proprietor based in Israel");
      expect(body, path).toContain('href="mailto:privacy@rtfx.pro"');
      expect(body, path).not.toMatch(/intended to be governed|is a placeholder/i);
    }
  });

  it("states Israeli law and courts without removing consumers' home-country protections", async () => {
    const body = await page("/terms");
    expect(body).toContain("governed by the laws of the State of Israel");
    expect(body).toContain("the competent courts of the Tel Aviv district, Israel");
    expect(body).toContain("mandatory laws of the country");
  });

  it("states the plans, renewal, cancel-anytime and refund rule, with the legal carve-out", async () => {
    const body = await page("/terms");
    expect(body).toContain("US$12 per month");
    expect(body).toContain("US$40 per month");
    expect(body).toContain("merchant of record");
    expect(body).toContain("renew automatically");
    expect(body).toContain("cancel at any time");
    expect(body).toContain("except where the law requires it");
  });

  it("is honest about the retention the code actually does", async () => {
    const body = await page("/privacy");
    // IP erasure is opportunistic, not a hard 90-day deadline.
    expect(body).toContain("no longer shown to anyone");
    expect(body).toContain("erased from storage in batches");
    expect(body).not.toContain("is erased after 90 days");
    // Removing a user does not delete their workspace.
    expect(body).toContain("does not by itself delete");
    // Workspace members, not just owners, see the activity log.
    expect(body).toContain("members (not viewers)");
    // Every cookie the Worker sets is listed.
    for (const name of ["rtfx_session", "rtfx_guest", "rtfx_link_", "rtfx_next", "rtfx_account"]) {
      expect(body, name).toContain(name);
    }
  });
});
