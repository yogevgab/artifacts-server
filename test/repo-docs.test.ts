import { describe, expect, it } from "vitest";

import readme from "../README.md?raw";
import security from "../SECURITY.md?raw";
import openSource from "../OPEN_SOURCE.md?raw";
import contributing from "../CONTRIBUTING.md?raw";
import selfHosting from "../docs/SELF_HOSTING.md?raw";
import publicSite from "../docs/PUBLIC_SITE.md?raw";
import deployRtfx from "../docs/DEPLOY_RTFX.md?raw";
import architecture from "../docs/ARCHITECTURE.md?raw";
import hermesCloud from "../docs/HERMES_CLOUD.md?raw";
import pluginApiRef from "../plugins/rtfx/skills/publishing-to-rtfx/references/api.md?raw";
import pluginSetupCmd from "../plugins/rtfx/commands/setup.md?raw";
import peopleSource from "../src/people.ts?raw";
import cliSource from "../cli/artifacts.mjs?raw";

/**
 * Repository-level trust docs are part of the product surface: Anthropic,
 * self-hosters and security reviewers read them before they run the plugin.
 * These tests pin the lines that are easiest to make dangerously stale.
 */

describe("repository trust docs", () => {
  it("links the public repo to security, self-hosting and the open-source boundary", () => {
    expect(readme).toContain("[SECURITY.md](SECURITY.md)");
    expect(readme).toContain("[`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md)");
    expect(readme).toContain("[`OPEN_SOURCE.md`](OPEN_SOURCE.md)");
  });

  it("documents current plugin auth instead of the old hand-exported-token-only story", () => {
    expect(security).toContain("Browser sign-in is the normal path");
    expect(security).toContain("PKCE S256");
    expect(security).toContain("loopback redirect");
    expect(security).toContain("mode **`0600`**");
    expect(security).toContain("`RTFX_API_TOKEN` is the advanced/CI fallback");
    expect(security).not.toMatch(/hand-exported token/i);
    expect(security).not.toMatch(/token is read from the environment and never written to disk/i);
    expect(security).not.toMatch(/plugin itself still authenticates by/i);
  });

  it("keeps the local-vs-remote MCP publishing boundary explicit", () => {
    expect(security).toContain("Local MCP vs. remote MCP");
    expect(security).toContain("filesystem path");
    expect(security).toContain("no `publish(path)`");
    expect(security).toContain("content_text");
    expect(security).toContain("`REMOTE_TOOLS` is written out by hand");
  });

  it("draws the public/open-source vs hosted-service boundary", () => {
    expect(openSource).toContain("MIT-licensed");
    expect(openSource).toContain("What is intentionally public");
    expect(openSource).toContain("What stays out of this repository");
    expect(openSource).toContain("Customer and user data");
    expect(openSource).toContain("Credentials and secrets");
    expect(openSource).toContain("Analytics and usage exports");
    expect(openSource).toContain("The hosted service is operated separately");
    expect(openSource).toContain("The name and the mark are not part of the grant");
  });

  it("tells self-hosters exactly what they must bring themselves", () => {
    for (const expected of [
      "Cloudflare",
      "A content hostname",
      "Email",
      "Session secret",
      "Billing",
      "Analytics",
      "Legal values",
    ]) {
      expect(selfHosting).toContain(expected);
    }
    expect(selfHosting.toLowerCase()).toContain("operator template");
    expect(selfHosting).toContain("privacy@rtfx.pro");
    expect(selfHosting).toContain("CONTENT_HOSTNAMES");
  });

  /**
   * The single hardest thing to keep true in this repository.
   *
   * rtfx.pro owns identity: app-owned email OTP / magic link into a host-only
   * `rtfx_session` cookie, and a bearer `rtfx_…` token on `/api/machine/*`.
   * Cloudflare Access is *legacy edge pass-through only* — a thing an older
   * self-hosted instance may still have in front of it, never the current or
   * recommended production topology, and not something rtfx.pro runs.
   *
   * Every document below is read by somebody deciding whether to trust or
   * deploy this — including the two that ship *inside* the Claude Code plugin,
   * which an agent reads and then acts on. The audit that produced this list
   * found stale copy in exactly those two, so they are pinned here rather than
   * left to review.
   *
   * The rule is deliberately mechanical: an explicitly legacy/self-host mention
   * of Access is allowed, and every phrase that presents Access as *current*
   * product truth is banned by exact absence. If a sentence you are adding trips
   * one of these, it is describing the old topology — rewrite it, don't relax
   * the pattern.
   */
  const staleAccessAsCurrentTruth: readonly RegExp[] = [
    // Topology presented as current.
    /sitting\s+behind Cloudflare Access/i,
    /Cloudflare Access \(login gate/i,
    /Two Access applications/i,
    /Cloudflare Access decides \*\*who can log in\*\*/i,
    // Access as the authentication layer.
    /Authentication is Cloudflare Access/i,
    /Cloudflare Access is the \*\*?source of truth/i,
    /source of truth for the login allow-list/i,
    /Access allow-list/i,
    // `/api` described as edge-gated, and the fallbacks that implies.
    /\/api is\b[^\n]*gated by Cloudflare Access at the edge/i,
    /falls?\s+through to Cloudflare Access/i,
    /Cloudflare Access with a sign-in page/i,
    /answered by (?:a )?sign-in page there/i,
    /Access gates it at the\s+edge/i,
    // Operator instructions that only made sense under the old topology.
    /must stay outside the Cloudflare Access\s+application/i,
    /Access app needs Bypass destinations/i,
    /step 5\.3/i,
    /302 to the Access login/i,
    /Access service-token headers.*needed/i,
    // Dangling module: `src/access-api.ts` was deleted with the topology.
    /src\/access-api\.ts/,
  ];

  /**
   * Docs that describe the *product* and must therefore state the app-owned
   * story positively, not merely avoid the old one.
   */
  it("keeps app-owned identity docs from regressing to the old Cloudflare Access topology", () => {
    for (const doc of [readme, publicSite, deployRtfx, architecture, hermesCloud]) {
      expect(doc).toContain("app-owned");
      expect(doc).toContain("rtfx_session");
      for (const stale of staleAccessAsCurrentTruth) expect(doc).not.toMatch(stale);
    }
  });

  /**
   * The plugin's own bundled copy. These two files are installed onto a user's
   * machine and read by an agent mid-task, so stale auth instructions here send
   * somebody hunting for a Cloudflare credential that rtfx.pro never wanted.
   * They are held to the absence rule only — neither is a product overview, so
   * requiring the positive "app-owned" phrasing would be noise.
   */
  it("keeps the plugin's bundled copy off the old Cloudflare Access story", () => {
    for (const doc of [pluginApiRef, pluginSetupCmd]) {
      for (const stale of staleAccessAsCurrentTruth) expect(doc).not.toMatch(stale);
    }
    // The machine API's actual contract, stated positively.
    expect(pluginApiRef).toContain("/api/machine");
    expect(pluginApiRef).toMatch(/rtfx\.pro needs no other credential/i);
    // …and the legacy option kept, labelled as the self-host-only thing it is.
    expect(pluginApiRef).toMatch(/self-hosted instance/i);
    expect(pluginSetupCmd).toMatch(/self-host only/i);
  });

  /**
   * `src/access-api.ts` was deleted along with the Access topology. Three
   * documents still pointed readers at it, which is worse than saying nothing:
   * a security reviewer who cannot find the file cannot tell whether it was
   * removed or hidden.
   */
  it("points at no module that does not exist", () => {
    for (const doc of [readme, security, contributing, architecture, selfHosting, openSource]) {
      expect(doc).not.toMatch(/src\/access-api\.ts/);
    }
  });

  /**
   * The one place Cloudflare Access legitimately survives in ARCHITECTURE.md is
   * an explicitly-legacy section. Pin that framing, or the next edit quietly
   * promotes it back to "how this works".
   */
  it("documents the current hosts and files Access under legacy only", () => {
    expect(architecture).toContain("rtfx.pro");
    expect(architecture).toContain("mcp.rtfx.pro");
    expect(architecture).toContain("a.rtfx.pro");
    expect(architecture).toMatch(/requireApiToken/);
    expect(architecture).toMatch(/### Legacy: an edge gate in front of the Worker/);
    expect(architecture).toMatch(/Not the current or recommended production topology/i);

    // Every remaining mention of Access has to carry its legacy/self-host label
    // within sight of itself. A qualifier three paragraphs away is one somebody
    // skimming will miss, which is exactly how this document went stale before.
    const mentions = [...architecture.matchAll(/Cloudflare Access/g)];
    expect(mentions.length).toBeGreaterThan(0);
    for (const match of mentions) {
      const near = architecture.slice(
        Math.max(0, (match.index ?? 0) - 300),
        (match.index ?? 0) + 300
      );
      expect(near).toMatch(/legacy|self-host/i);
    }
  });

  /**
   * The People panel and the CLI's help are read by the same operators as the
   * docs above, and they went stale in exactly the same way: describing the old
   * Cloudflare Access allow-list as if it were still how anybody signs in. These
   * two tests read the shipped source as text — that is the only way to cover a
   * rendered HTML string, the embedded client-side script and CLI `console.log`
   * output in one place.
   */
  it("keeps the People panel describing the app-owned directory, not an Access allow-list", () => {
    for (const stale of [
      /Cloudflare Access/i,
      /Access allow-list/i,
      /allow-list only/i,
      /cloudflareaccess\.com/i,
      /Access session/i,
      /Access login/i,
    ]) {
      expect(peopleSource).not.toMatch(stale);
    }
    // …and says what is actually true instead.
    expect(peopleSource).toContain("emails them a sign-in link");
    expect(peopleSource).toContain("Anyone who verifies an email address can sign in");
    expect(peopleSource).toContain("rtfx_session");
  });

  it("keeps the CLI's user/token help on app sessions, with edge tokens as self-host only", () => {
    for (const stale of [
      /Cloudflare Access isn't configured/i,
      /nobody new can sign in/i,
      /adds them to Cloudflare Access/i,
      /Access allow-list/i,
      /require an Access login/i,
      /an Access login/i,
    ]) {
      expect(cliSource).not.toMatch(stale);
    }
    expect(cliSource).toContain("require a signed-in admin session, not an API token");
    expect(cliSource).toContain("invite a person (adds them to the directory)");
    // The service-token pass-through is real, and must stay documented as the
    // advanced/self-host option it is rather than being scrubbed entirely.
    expect(cliSource).toContain("CF_ACCESS_CLIENT_ID");
    expect(cliSource).toContain("self-hosted instance that gates every path at the edge");
    expect(cliSource).toMatch(/advanced\/self-host/);
  });

  it("keeps public-cookie copy privacy-first until analytics is intentionally redesigned", () => {
    for (const doc of [publicSite, deployRtfx]) {
      expect(doc).toContain("localStorage");
      expect(doc).toMatch(/no analytics|load no analytics|no non-essential storage/i);
      expect(doc).not.toMatch(/Google Analytics|GA4|gtag|GTM|Meta Pixel/i);
    }
  });
});
