import { describe, it, expect, beforeEach } from "vitest";
import { strToU8 } from "fflate";
import { initDb, clearR2, req, as, htmlForm } from "./fixtures";

/**
 * The /admin portal shell (issue #28): navigation, section routing and who may
 * open what. The sections' own contents are covered by integration.test.ts
 * (artifacts), users.test.ts (People) and dashboard-tokens.test.ts
 * (Integrations) — this file is about the shell that holds them together.
 *
 * Everything here asserts on `data-*` markers, never on copy, so wording can be
 * improved without breaking the suite. The same markers are what a browser
 * smoke test drives.
 */

const SUPER = "admin@test.com"; // SUPER_ADMIN_EMAILS in vitest.config.ts
const ADMIN2 = "admin2@test.com"; // a plain admin
const BOB = "bob@beta.com"; // a member

beforeEach(async () => {
  await initDb();
  await clearR2();
});

const page = async (path: string, email = SUPER) => await (await req(path, as(email))).text();

/** Which nav items this person is offered, in the order they are rendered. */
function navItems(html: string): string[] {
  return [...html.matchAll(/data-nav="([a-z-]+)"/g)].map((m) => m[1]);
}

/** The section marker the shell stamps on `<main>`'s wrapper. */
function currentSection(html: string): string | null {
  return /data-section="([a-z-]+)"/.exec(html)?.[1] ?? null;
}

const SECTIONS: [string, string][] = [
  ["/admin", "overview"],
  ["/admin/artifacts", "artifacts"],
  ["/admin/gallery", "gallery"],
  ["/admin/people", "people"],
  ["/admin/integrations", "integrations"],
  ["/admin/settings", "settings"],
  ["/admin/platform", "platform"],
];

describe("portal shell", () => {
  it("gives every section its own URL, marked with the section it is", async () => {
    for (const [path, section] of SECTIONS) {
      const res = await req(path, as(SUPER));
      expect(res.status, path).toBe(200);
      expect(currentSection(await res.text()), path).toBe(section);
    }
  });

  it("renders navigation on every section, with the current one marked", async () => {
    for (const [path, section] of SECTIONS) {
      const html = await page(path);
      expect(html, path).toContain("data-portal-nav");
      // aria-current is what a screen reader announces, and what a smoke test reads.
      expect(html, path).toMatch(
        new RegExp(`data-nav="${section}"[^>]*aria-current="page"`)
      );
    }
  });

  it("navigates with real links, not a client router", async () => {
    const html = await page("/admin");
    for (const [path] of SECTIONS) {
      expect(html).toContain(`href="${path}"`);
    }
    // No history/pushState games, and no fetch-and-swap of the whole page.
    expect(html).not.toContain("pushState");
    expect(html).not.toContain("popstate");
  });

  it("carries the landmarks and skip link the keyboard path needs", async () => {
    const html = await page("/admin/artifacts");
    expect(html).toContain('class="skip" href="#main"');
    expect(html).toContain('id="main"');
    expect(html).toContain("data-portal-main");
    expect(html).toContain('aria-label="Portal sections"');
    // Exactly one h1 per page.
    expect(html.match(/<h1[ >]/g) ?? []).toHaveLength(1);
  });

  it("responds to the viewport rather than shipping a separate mobile page", async () => {
    const html = await page("/admin");
    expect(html).toContain('name="viewport" content="width=device-width,initial-scale=1"');
    // The sidebar becomes a scrolling tab strip; both come from one document.
    expect(html).toContain("@media(max-width:900px)");
    expect(html).toContain(".pnav{");
  });

  it("identifies the signed-in person and their role in the top bar", async () => {
    const html = await page("/admin");
    expect(html).toContain("data-portal-top");
    expect(html).toContain(`data-viewer-email>${SUPER}`);
    expect(html).toContain("data-viewer-role>Owner");
    expect(await page("/admin", BOB)).toContain("data-viewer-role>Member");
  });

  it("offers Cloudflare Access logout from the portal top bar", async () => {
    const html = await page("/admin");
    expect(html).toContain('href="/logout" data-cta="logout"');
  });

  it("has a first-party logout route that clears Access cookies", async () => {
    const res = await req("/logout", as(SUPER, { redirect: "manual" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
    const cookies = res.headers.getSetCookie().join("\n");
    expect(cookies).toContain("CF_Authorization=");
    expect(cookies).toContain("CF_AppSession=");
    expect(cookies).toContain("Max-Age=0");
  });

  it("keeps the whole portal out of every index", async () => {
    for (const [path] of SECTIONS) {
      expect(await page(path), path).toContain(
        '<meta name="robots" content="noindex,nofollow">'
      );
    }
  });

  it("404s an unknown /admin path but still hands back the navigation", async () => {
    const res = await req("/admin/nonsense", as(SUPER));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("data-portal-nav");
    expect(html).toContain('data-empty="section"');
  });
});

describe("portal navigation is scoped to the viewer", () => {
  it("offers a member five sections, and neither People nor Platform", async () => {
    expect(navItems(await page("/admin", BOB))).toEqual([
      "overview",
      "artifacts",
      "gallery",
      "integrations",
      "settings",
    ]);
  });

  it("offers an admin People, but not the operator section", async () => {
    expect(navItems(await page("/admin", ADMIN2))).toEqual([
      "overview",
      "artifacts",
      "gallery",
      "people",
      "integrations",
      "settings",
    ]);
  });

  it("offers a super admin everything, Platform last", async () => {
    expect(navItems(await page("/admin", SUPER))).toEqual([
      "overview",
      "artifacts",
      "gallery",
      "people",
      "integrations",
      "settings",
      "platform",
    ]);
  });

  it("refuses Platform to a plain admin, not just hides it", async () => {
    const res = await req("/admin/platform", as(ADMIN2));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).not.toContain('data-panel="platform-config"');
    expect(html).not.toContain("data-config=");
  });
});

describe("overview", () => {
  const publish = (slug: string, title: string) =>
    req(
      "/api/artifacts",
      as(SUPER, {
        method: "POST",
        body: htmlForm({ title, slug }, "x.html", strToU8(`<h1>${slug}</h1>`)),
      })
    );

  it("reads as a control centre: usage, next steps, recent work, health", async () => {
    const html = await page("/admin");
    expect(html).toContain('data-stat="artifacts"');
    expect(html).toContain('data-panel="next-actions"');
    expect(html).toContain('data-panel="recent"');
    expect(html).toContain('data-panel="health"');
  });

  it("proposes publishing first when nothing has been published", async () => {
    const html = await page("/admin");
    expect(html).toContain('data-action="publish"');
    expect(html).toContain('data-empty="recent"');
  });

  it("switches to sharing once something exists but nobody can open it", async () => {
    await publish("lonely", "Lonely");
    const html = await page("/admin");
    expect(html).not.toContain('data-action="publish"');
    expect(html).toContain('data-action="share"');
    expect(html).toContain('data-recent="lonely"');
    expect(html).toContain('href="/admin/artifacts/lonely"');
    // Sharing health reflects the same fact, rather than contradicting it.
    expect(html).toMatch(/data-health="sharing" data-health-state="todo"/);
  });

  it("clears the sharing prompt once the artifact has an audience", async () => {
    await publish("shared", "Shared");
    await req(
      "/api/artifacts/shared/access",
      as(SUPER, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "everyone", emails: [] }),
      })
    );
    const html = await page("/admin");
    expect(html).not.toContain('data-action="share"');
    expect(html).toMatch(/data-health="sharing" data-health-state="ok"/);
  });


  it("shows a member no health rows about other people", async () => {
    const html = await page("/admin", BOB);
    expect(html).toContain('data-panel="health"');
    expect(html).not.toContain('data-health="sign-in"');
  });
});

describe("settings", () => {
  it("states the account facts without inventing editable ones", async () => {
    const html = await page("/admin/settings", BOB);
    expect(html).toContain('data-setting="email"');
    expect(html).toContain('data-setting="role"');
    expect(html).toContain('data-setting="sign-in"');
    expect(html).toContain('data-panel="security"');
    // A member is told who manages sign-in rather than given a dead link.
    expect(html).not.toContain('href="/admin/people"');
  });

  it("names the gaps instead of leaving people hunting for them", async () => {
    const html = await page("/admin/settings");
    expect(html).toContain('data-placeholder="custom-domain"');
    expect(html).toContain('data-placeholder="webhooks"');
    expect(html).toContain('data-placeholder="audit-log"');
  });
});

describe("integrations", () => {
  it("puts token creation and agent setup on one page", async () => {
    const html = await page("/admin/integrations", BOB);
    expect(html).toContain('data-panel="tokens"');
    expect(html).toContain('data-panel="agent-setup"');
    expect(html).toContain('data-snippet="setup-env"');
    expect(html).toContain('data-snippet="setup-cli"');
    expect(html).toContain('data-snippet="setup-http"');
  });

  it("shows the instance's own origin in the setup snippets, never a placeholder host", async () => {
    const html = await page("/admin/integrations");
    expect(html).toContain("export ARTIFACTS_URL=https://rtfx.pro");
    // A token value is never pre-filled into a snippet.
    expect(html).not.toMatch(/RTFX_API_TOKEN=rtfx_[a-zA-Z0-9]/);
  });

  it("gives a command that runs today, not an npm package we never published", async () => {
    const html = await page("/admin/integrations");
    // `npx artifacts …` resolves to a stranger's package on the registry; the
    // CLI lives in this repository and the plugin carries its own copy.
    expect(html).not.toMatch(/npx\s+artifacts\b/i);
    expect(html).toContain("node cli/artifacts.mjs publish");
  });

  it("gives a curl that runs with the token on this page and nothing else", async () => {
    const html = await page("/admin/integrations");
    // The machine surface: it authenticates the bearer token on its own, so the
    // token this very page mints is sufficient. Sending somebody to Cloudflare
    // Zero Trust for a service token would make the panel's own credential a
    // half-measure — and an invited member cannot get one at all.
    expect(html).toContain("/api/machine/artifacts");
    expect(html).toContain("Authorization: Bearer $RTFX_API_TOKEN");
    expect(html).not.toContain("CF-Access-Client-Id");
    expect(html).not.toContain("CF-Access-Client-Secret");
    // `bundle` is the zip field; `file` is one HTML document.
    expect(html).toContain("-F bundle=@./dist.zip");
    expect(html).not.toMatch(/file=@\S*\.zip/);
  });
});

describe("platform", () => {
  it("reports how the instance is configured, for the operator only", async () => {
    const html = await page("/admin/platform", SUPER);
    expect(html).toContain('data-panel="platform-config"');
    expect(html).toContain('data-config="access"');
    expect(html).toContain('data-config="content-hosts"');
    expect(html).toContain('data-config="dev-login"');
    expect(html).toContain('data-panel="platform-operators"');
    expect(html).toContain('data-stat="instance-artifacts"');
  });

  it("flags the dev-login bypass as unset-in-production rather than healthy", async () => {
    // DEV_LOGIN is "true" under test, which is exactly the state to shout about.
    expect(await page("/admin/platform")).toMatch(
      /data-config="dev-login" data-config-state="unset"/
    );
  });

  it("never prints a secret, only whether one is set", async () => {
    const html = await page("/admin/platform");
    // Values, never. CF_API_TOKEN used to be the example here; it went with
    // Cloudflare Access, so this now guards the secrets that actually exist.
    for (const secret of ["SESSION_SECRET=", "LEMONSQUEEZY_WEBHOOK_SECRET=", "rtfx_", "Bearer "]) {
      expect(html, secret).not.toContain(secret);
    }
  });
});
