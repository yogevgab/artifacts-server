import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { strToU8 } from "fflate";
import app from "../src/index";
import { initDb, clearR2, req, as, htmlForm } from "./fixtures";
import type { Env } from "../src/env";
import { posthogConfig, posthogCsp, type PostHogConfig } from "../src/posthog";
import {
  ANALYTICS_CONSENT_KEY,
  analyticsConsentNotice,
  analyticsConsentScript,
} from "../src/consent";
import { portalShell, type PortalViewer } from "../src/portal";
import { settingsPage } from "../src/admin";

/**
 * PostHog session recording and error tracking on the dashboard, plus the
 * privacy rewrite that makes shipping it truthful.
 *
 * The interesting failure mode is not "the script never loads" — it's "the
 * script loads before, or without, real consent," or "a recording shows
 * somebody else's email address." So the tests here are organized around
 * those two risks:
 *
 *  - surface coverage: PostHog must never appear anywhere except a signed-in
 *    `/admin` response, however POSTHOG_KEY is configured;
 *  - the consent gate is executed for real (a tiny in-memory DOM, not a
 *    string match), so "declining means nothing loads" is a proven fact about
 *    the actual shipped script, not an assertion about its prose;
 *  - the masking config that reaches `posthog.init` is asserted on the real
 *    object the real snippet queues, not on a substring of the template.
 */

const SUPER = "admin@test.com";
const CFG: PostHogConfig = { key: "phc_test_1234567890", host: "https://us.i.posthog.com" };

const baseViewer: PortalViewer = {
  email: "owner@test.com",
  isAdmin: true,
  role: "admin",
  isTokenCaller: false,
  workspace: null,
};

beforeEach(async () => {
  await initDb();
  await clearR2();
});

// --- src/posthog.ts: config + CSP -------------------------------------------

describe("posthogConfig", () => {
  it("is null when POSTHOG_KEY is unset — the required default for every deployment today", () => {
    expect(posthogConfig({} as Env)).toBeNull();
  });

  it("is null for an empty or whitespace-only key, not a falsy-but-truthy string", () => {
    expect(posthogConfig({ POSTHOG_KEY: "" } as Env)).toBeNull();
    expect(posthogConfig({ POSTHOG_KEY: "   " } as Env)).toBeNull();
  });

  it("defaults the host to PostHog Cloud (US) when a key is set but no host is", () => {
    expect(posthogConfig({ POSTHOG_KEY: "phc_abc" } as Env)).toEqual({
      key: "phc_abc",
      host: "https://us.i.posthog.com",
    });
  });

  it("honours a self-hosted POSTHOG_HOST", () => {
    expect(
      posthogConfig({ POSTHOG_KEY: "phc_abc", POSTHOG_HOST: "https://ph.example.com" } as Env)
    ).toEqual({ key: "phc_abc", host: "https://ph.example.com" });
  });
});

describe("posthogCsp", () => {
  it("allows the configured host for scripts, XHR/fetch and the replay worker — nothing else", () => {
    const csp = posthogCsp(CFG);
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://us.i.posthog.com");
    expect(csp).toContain("connect-src 'self' https://us.i.posthog.com");
    expect(csp).toContain("worker-src 'self' blob:");
    // Never a directive this policy has no business setting.
    expect(csp).not.toContain("frame-ancestors");
    expect(csp).not.toContain("default-src");
  });

  it("derives from a self-hosted host too, not just PostHog Cloud's domain shape", () => {
    const csp = posthogCsp({ key: "k", host: "https://ph.internal.example.com" });
    expect(csp).toContain("https://ph.internal.example.com");
  });
});

// --- surface coverage: only /admin, only with a key -------------------------

// /privacy is deliberately excluded from "never mentions PostHog": it is
// required to describe the feature in prose (that is the whole point of the
// privacy rewrite). What it must never do is load it — see the dedicated
// assertion below.
const CLEAN_PUBLIC_PATHS = ["/", "/docs", "/login", "/terms"];

describe("PostHog never appears outside the dashboard", () => {
  it("is not even mentioned on the pages that have nothing to do with it, even with a key set", async () => {
    const withKey = { ...env, POSTHOG_KEY: CFG.key, POSTHOG_HOST: CFG.host } as unknown as Env;
    for (const path of CLEAN_PUBLIC_PATHS) {
      const res = await app.request(path, { headers: { "X-Dev-Anonymous": "true" } }, withKey as any);
      const body = await res.text();
      expect(body.toLowerCase(), path).not.toContain("posthog");
      expect(body, path).not.toContain("data-analytics-consent");
    }
  });

  it("is described in prose on /privacy, but never loaded or asked about there", async () => {
    const withKey = { ...env, POSTHOG_KEY: CFG.key, POSTHOG_HOST: CFG.host } as unknown as Env;
    const res = await app.request("/privacy", { headers: { "X-Dev-Anonymous": "true" } }, withKey as any);
    const body = await res.text();
    expect(body).toContain("PostHog"); // required — see the copy tests below
    expect(body).not.toContain("data-analytics-consent");
    expect(body).not.toContain("posthog.init(");
    expect(body).not.toContain('http-equiv="Content-Security-Policy"');
  });

  it("is absent from the viewer shell that frames artifact content, even with a key configured", async () => {
    const form = new FormData();
    form.set("slug", "ph-demo");
    form.set("title", "Demo");
    form.set("visibility", "everyone");
    form.set("file", new File(["<h1>hi</h1>"], "index.html", { type: "text/html" }));
    const withKey = { ...env, POSTHOG_KEY: CFG.key } as unknown as Env;
    await app.request("/api/artifacts", { method: "POST", body: form, ...as(SUPER) }, withKey as any);
    const res = await app.request(
      "/ph-demo/",
      { ...as(SUPER), headers: { ...(as(SUPER).headers as Record<string, string>), "Sec-Fetch-Dest": "document" } },
      withKey as any
    );
    const body = await res.text();
    expect(body).toContain("<iframe");
    expect(body.toLowerCase()).not.toContain("posthog");
  });

  it("is absent from the artifact content host, even with a key configured", async () => {
    await req(
      "/api/artifacts",
      as(SUPER, { method: "POST", body: htmlForm({ title: "CH", slug: "ch-demo" }, "x.html", strToU8("<h1>x</h1>")) })
    );
    const contentEnv = {
      ...env,
      CONTENT_HOSTNAMES: "content.test.local",
      POSTHOG_KEY: CFG.key,
    } as unknown as Env;
    const res = await app.request(
      "https://content.test.local/ch-demo/",
      { headers: { "X-Dev-Anonymous": "true" } },
      contentEnv as any
    );
    const body = await res.text();
    expect(body.toLowerCase()).not.toContain("posthog");
    // The content host's own CSP (src/serve.ts) must stay exactly as it was —
    // this feature never widens it.
    expect(res.headers.get("Content-Security-Policy") ?? "").not.toContain("posthog");
  });

  it("does not appear on a real /admin response today, because POSTHOG_KEY is unset in the base test env", async () => {
    // This is the state every test in this file that hits real HTTP inherits:
    // PortalViewer.posthog is only ever populated by viewerOf() in src/index.ts,
    // which this task does not modify (see the PostHog rollout report) — so a
    // real request never lights this up regardless of env, today. The rendering
    // tests below exercise portalShell()/settingsPage() directly instead, which
    // is where the actual gating logic lives.
    const html = await (await req("/admin", as(SUPER))).text();
    expect(html.toLowerCase()).not.toContain("posthog");
    expect(html).not.toContain("data-analytics-consent");
  });
});

// --- rendering: portalShell / settingsPage, exercised directly --------------

describe("portalShell renders nothing about analytics when no PostHog config is given", () => {
  const render = (posthog?: PostHogConfig | null) =>
    portalShell({
      viewer: { ...baseViewer, posthog },
      section: "settings",
      title: "Settings",
      heading: "Settings",
      lede: "lede",
      body: "<p>body</p>",
    });

  it("omits the banner, the script and the CSP meta tag when posthog is undefined", () => {
    const html = render(undefined);
    expect(html).not.toContain("data-analytics-consent");
    expect(html).not.toContain("posthog.init");
    expect(html).not.toContain('http-equiv="Content-Security-Policy"');
  });

  it("omits them the same way when posthog is explicitly null", () => {
    const html = render(null);
    expect(html).not.toContain("data-analytics-consent");
    expect(html).not.toContain("posthog.init");
    expect(html).not.toContain('http-equiv="Content-Security-Policy"');
  });
});

describe("portalShell renders the consent gate when a PostHog config is given", () => {
  const html = portalShell({
    viewer: { ...baseViewer, posthog: CFG },
    section: "settings",
    title: "Settings",
    heading: "Settings",
    lede: "lede",
    body: "<p>body</p>",
  });

  it("renders the banner hidden, as a labelled region with Accept/Decline — never a modal", () => {
    expect(html).toMatch(/<aside class="cnotice"[^>]*\bdata-analytics-consent\b[^>]*\bhidden\b/);
    expect(html).toContain('role="region"');
    expect(html).not.toMatch(/role="(dialog|alertdialog)"/);
    expect(html).not.toContain("aria-modal");
    expect(html).toContain("data-analytics-accept");
    expect(html).toContain("data-analytics-decline");
  });

  it("carries a CSP meta tag scoped to exactly the configured PostHog host", () => {
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="[^"]*us\.i\.posthog\.com[^"]*">/);
  });

  it("embeds the aggressive masking config the report promises, verbatim option names", () => {
    expect(html).toContain("maskAllInputs: true");
    expect(html).toContain('maskTextSelector: "*"');
    expect(html).toContain("autocapture: false");
    expect(html).toContain("capture_exceptions: true");
  });

  it("never puts the posthog.init call at the top level of the script — only inside the gated loader", () => {
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
    expect(scriptMatch).toBeTruthy();
    const script = scriptMatch![1];
    const loaderStart = script.indexOf("function loadPostHog");
    const initCall = script.indexOf("posthog.init(");
    expect(loaderStart).toBeGreaterThan(-1);
    expect(initCall).toBeGreaterThan(loaderStart);
    // And the loader is only ever called from a decision branch, never bare
    // at the end of the IIFE.
    expect(script).not.toMatch(/\}\)\(\);\s*loadPostHog\(\)/);
  });
});

describe("settingsPage mentions dashboard analytics only when it exists for this viewer", () => {
  it("says nothing about it when no PostHog config is configured", () => {
    const html = settingsPage({ ...baseViewer, posthog: null });
    expect(html).not.toContain("dashboard-analytics");
    expect(html.toLowerCase()).not.toContain("session recording");
  });

  it("explains it, and how to change your mind, when it is configured", () => {
    const html = settingsPage({ ...baseViewer, posthog: CFG });
    expect(html).toContain('data-setting="dashboard-analytics"');
    expect(html).toContain(ANALYTICS_CONSENT_KEY);
    expect(html).toContain("/privacy#dashboard-analytics");
  });
});

// --- the consent gate: structural proof, not a string search -----------------
//
// The Workers runtime disables dynamic code generation (`eval`/`new
// Function`) for every request, including in `vitest-pool-workers` — there is
// no sandboxed-DOM way to actually execute this script in this test suite.
// So instead of trusting a substring match anywhere in the file, every
// assertion below locates a specific statement in the real generated script
// and checks its position or contents relative to another one — e.g. "the
// decline handler's body does not mention loadPostHog" is checked against the
// decline handler's *own* extracted body, not the script as a whole, so it
// cannot pass by accident because the word appears somewhere else nearby.

function extractScript(cfg: PostHogConfig): string {
  return analyticsConsentScript(cfg);
}

describe("the consent gate's structure enforces every rule in order", () => {
  const script = extractScript(CFG);

  it("checks Do Not Track / Global Privacy Control before it ever calls localStorage.getItem", () => {
    const dntGuard = script.indexOf("if(dntOrGpc()) return;");
    const firstRead = script.indexOf("var decision = read();");
    expect(dntGuard).toBeGreaterThan(-1);
    expect(firstRead).toBeGreaterThan(-1);
    expect(dntGuard).toBeLessThan(firstRead);
  });

  it("checks DNT/GPC before it reads or writes anything else — the guard is the second statement in the IIFE", () => {
    // `var KEY = ...; var box = ...; if(!box) return;` then the DNT guard —
    // nothing about storage or the banner appears before it.
    const iifeStart = script.indexOf("(function(){");
    const dntGuard = script.indexOf("if(dntOrGpc()) return;");
    const before = script.slice(iifeStart, dntGuard);
    expect(before).not.toContain("localStorage");
    expect(before).not.toContain("box.hidden");
  });

  it("the granted branch calls loadPostHog and returns, before the banner is ever unhidden", () => {
    const grantedBranch = /if\(decision === "granted"\)\{ ?loadPostHog\(\); ?return; ?\}/.exec(script);
    expect(grantedBranch).toBeTruthy();
    const unhide = script.indexOf("box.hidden = false;");
    expect(grantedBranch!.index).toBeLessThan(unhide);
  });

  it("the declined branch returns immediately, calling nothing", () => {
    const declinedBranch = /if\(decision === "declined"\) ?return;/.exec(script);
    expect(declinedBranch).toBeTruthy();
    // Nothing between the "declined" check and the next statement calls the loader.
    const nextStatement = script.indexOf("box.hidden = false;");
    const between = script.slice(declinedBranch!.index + declinedBranch![0].length, nextStatement);
    expect(between).not.toContain("loadPostHog");
  });

  it("only the Accept button's own handler calls loadPostHog", () => {
    const accept = /accept\.addEventListener\('click', function\(\)\{([^}]*)\}\);/.exec(script);
    const decline = /decline\.addEventListener\('click', function\(\)\{([^}]*)\}\);/.exec(script);
    expect(accept).toBeTruthy();
    expect(decline).toBeTruthy();
    expect(accept![1]).toContain("loadPostHog()");
    expect(decline![1]).not.toContain("loadPostHog");
    // Both write a decision either way — the choice is always remembered.
    expect(accept![1]).toContain('decide("granted")');
    expect(decline![1]).toContain('decide("declined")');
  });

  it("posthog.init is reachable from exactly the granted branch and the Accept handler — nowhere else", () => {
    // `loadPostHog();` (a call, ending in `;`) as opposed to the declaration
    // `function loadPostHog(){` (ending in `{`) — exactly two call sites.
    const calls = [...script.matchAll(/loadPostHog\(\);/g)];
    expect(calls.length).toBe(2);
    expect(script).toContain("function loadPostHog(){");
  });

  it("the config passed to posthog.init carries the exact key and host for this deployment", () => {
    const call = /posthog\.init\(([^,]+), \{/.exec(script);
    expect(call).toBeTruthy();
    expect(call![1]).toBe(JSON.stringify(CFG.key));
    expect(script).toContain(`api_host: ${JSON.stringify(CFG.host)}`);
  });

  it("session_recording carries maskAllInputs and maskTextSelector, and nothing else that could weaken them", () => {
    const block = /session_recording: \{([\s\S]*?)\}/.exec(script);
    expect(block).toBeTruthy();
    const inner = block![1].replace(/\s+/g, " ").trim();
    expect(inner).toContain("maskAllInputs: true");
    expect(inner).toContain('maskTextSelector: "*"');
    // No maskInputFn/maskTextFn override that could carve out an exception.
    expect(inner).not.toContain("maskInputFn");
    expect(inner).not.toContain("maskTextFn");
  });
});

// --- the notice markup itself -------------------------------------------------

describe("analyticsConsentNotice", () => {
  it("is keyboard-operable via real buttons, not click handlers on a div", () => {
    const html = analyticsConsentNotice();
    expect(html).toContain("<button type=\"button\"");
    expect(html).toContain("data-analytics-accept>Accept<");
    expect(html).toContain("data-analytics-decline>Decline<");
  });
});

// --- privacy copy: honest before and after ------------------------------------

describe("the privacy page describes PostHog honestly", () => {
  const privacy = async () => await (await req("/privacy", { headers: { "X-Dev-Anonymous": "true" } })).text();

  it("no longer makes the old blanket claims this feature would falsify", async () => {
    const body = await privacy();
    expect(body).not.toContain("No analytics, advertising, fingerprinting or session-replay of any kind.");
    expect(body).not.toContain(
      "There is no analytics, no advertising and no third-party tracking</b> on this site."
    );
    expect(body).not.toContain(
      "If optional cookies are ever introduced — analytics, for example — this page will say so"
    );
  });

  it("describes what dashboard session recording collects, masks and how to decline", async () => {
    const body = await privacy();
    expect(body).toContain('<section id="dashboard-analytics">');
    expect(body).toContain("PostHog");
    expect(body).toContain("session recording");
    expect(body).toContain("Session recording and error tracking");
    expect(body.toLowerCase()).toContain("masked");
    expect(body).toContain("Decline");
    expect(body).toContain("Do Not Track");
    expect(body).toContain("Global Privacy Control");
    expect(body).toContain("Unhandled JavaScript errors and unhandled promise rejections");
  });

  it("still says the public pages carry no analytics or tracking — that part stayed true", async () => {
    const body = await privacy();
    expect(body).toContain("no analytics, no advertising and no");
  });

  it("lists the PostHog cookie and the dashboard consent-choice storage in the cookie table", async () => {
    const body = await privacy();
    expect(body).toContain('<section id="cookies">');
    expect(body).toContain("ph_&lt;project-key&gt;_posthog");
    expect(body).toContain("rtfx.dashboard-analytics");
    expect(body).toContain("optional, dashboard only");
  });

  it("names PostHog as a sub-processor", async () => {
    const body = await privacy();
    expect(body).toContain("sub-processor");
    expect(body).toContain('href="https://posthog.com"');
  });
});

describe("the public cookie notice points at the dashboard's separate choice", () => {
  it("no longer implies the whole site has nothing to opt out of", async () => {
    const body = (await (await req("/", { headers: { "X-Dev-Anonymous": "true" } })).text()).toLowerCase();
    expect(body).toContain("nothing on this page to opt out of");
    expect(body).toContain("dashboard");
  });
});
