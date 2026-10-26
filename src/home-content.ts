import { MCP_URL } from "./seo";

/**
 * The home page's copy as data, so the page, its structured data and
 * `/llms-full.txt` all read the SAME strings. Nothing here is rendered twice by
 * hand: `landingPage()` (src/landing.ts) turns it into HTML, `llmsFullTxt()`
 * (src/llms-full.ts) turns it into markdown, and the FAQPage JSON-LD is built
 * from `FAQS` — a rich result must never quote an answer the page does not show.
 *
 * Inline markup is a deliberate, tiny subset (`<b>`, `<em>`, `<code>`, `<q>`,
 * `<a>`) that `htmlToMarkdown` (src/llms-full.ts) understands.
 */

export interface Faq {
  q: string;
  /** Plain text. Escaped when rendered, emitted verbatim in JSON-LD and markdown. */
  a: string;
  /** Optional "Read more" link to a page with the long answer; not part of the JSON-LD answer text. */
  more?: { href: string; label: string };
}

/** Questions people actually ask, answered only from facts the product ships. */
export const FAQS: readonly Faq[] = [
  {
    q: "How do I share a Claude artifact privately?",
    a:
      `Add rtfx.pro to Claude as a custom connector (${MCP_URL}), then ask Claude to publish ` +
      "your artifact. You get a private link that only you can open. Then ask Claude to share it " +
      "with named people as viewers or editors, or with everyone in your workspace. For someone " +
      "without an account, create a named share link on the artifact's Share page; it can " +
      "expire, and you can extend or revoke it any time.",
    more: { href: "/share-claude-artifacts-privately", label: "Read more" },
  },
  {
    q: "Isn't Claude's own Publish enough?",
    a:
      "On Free, Pro and Max plans, Claude's own Publish makes an artifact public to anyone with " +
      "the link (on Team and Enterprise it is limited to your organization). rtfx is for when you " +
      "want only the people you choose to open it: every artifact is private by default.",
    more: { href: "/claude-publish-vs-private-link", label: "Read more" },
  },
  {
    q: "Does it work with Claude Desktop, claude.ai, mobile, Claude Code and other MCP clients?",
    a:
      "Yes. rtfx.pro is a remote MCP server. Add it once in claude.ai on the web or in Claude " +
      "Desktop (Customize → Connectors → + Add → Add custom connector, with the URL " +
      `${MCP_URL}) and it is available in the Claude mobile apps too. In Claude Code, run: ` +
      `claude mcp add --transport http rtfx ${MCP_URL}. ` +
      "Other MCP clients connect with the same URL. Sign-in is OAuth, so there is nothing to paste.",
  },
  {
    q: "Who can see my artifacts?",
    a:
      "You, the people you add (or everyone in your workspace, if you choose), and anyone " +
      "holding a share link you created. rtfx staff (operators) see metadata only, never " +
      "artifact content or who viewed it.",
  },
  {
    q: "Can I see who opened an artifact?",
    a:
      "Yes. Each artifact has a view log on its Share page showing who opened it and when. You " +
      "can also ask Claude who has opened it.",
  },
  {
    q: "Can I update an artifact without sending a new link?",
    a:
      "Yes. Publish again under the same name and the same link shows the new version. Each " +
      "publish is a new version, and you can roll back to an earlier one from chat.",
  },
  {
    q: "Is it free?",
    a:
      "There is a Free plan; sign up with your email. Pro, Team and Enterprise are for more " +
      "artifacts, storage and people. See the pricing section below for the limits.",
  },
];

/** Step list under "1. Add rtfx to Claude" for Claude on web, desktop and mobile (HTML). */
export const CONNECT_STEPS: readonly string[] = [
  "Open <b>Customize → Connectors</b> (or Settings → Connectors), click <b>+ Add</b>, then <b>Add custom connector</b>.",
  `Name it <code>rtfx</code> and use the URL <code>${MCP_URL}</code>.`,
  "Keep the detected defaults and click <b>Add</b>, then <b>Connect</b>.",
  "Sign in with the code we email you, then <b>Allow</b>.",
];

export const CONNECT_NOTE =
  "Once added, it works in Claude on web, desktop and mobile. The consent screen lists " +
  "“Manage access and delete artifacts” — allow it so Claude can share and delete from chat.";

export const OTHER_CLIENTS_NOTE =
  "Any client with remote MCP and OAuth connects the same way, with nothing to paste. It asks " +
  "for read and publish by default; it must also request <code>rtfx:manage</code> to share and " +
  "delete from chat.";

export const CLAUDE_CODE_CMD = `claude mcp add --transport http rtfx ${MCP_URL}`;
export const MCP_JSON = `{"mcpServers":{"rtfx":{"url":"${MCP_URL}"}}}`;

export interface WalkthroughSection {
  id: "publish" | "share" | "delete";
  heading: string;
  /** Inner HTML of each list item. */
  asks: readonly string[];
  /** Inner HTML of the closing paragraph. */
  note: string;
}

export const WALKTHROUGH: readonly WalkthroughSection[] = [
  {
    id: "publish",
    heading: "2. Publish",
    asks: [
      "<q>Publish this as a private link.</q> Claude replies with your link, like <code>https://rtfx.pro/your-workspace/q3-report</code>. It is private to you until you share it.",
      "<q>Publish the fix to the same link.</q> A new version at the same URL. <q>Roll back to version 2.</q> The link points at the earlier version again.",
    ],
    note: `For big sites or images, Claude gives you an upload link instead. <a href="/guide#publish">See it step by step &rarr;</a>`,
  },
  {
    id: "share",
    heading: "3. Share",
    asks: [
      "<q>Share it with dana@acme.com.</q> Dana signs in with their email and can open it.",
      "<q>Let alex@acme.com edit it.</q> Editors can publish new versions and roll back.",
      "<q>Make it visible to everyone in my workspace.</q>",
    ],
    note: `For someone without an account, open the artifact's Share page on rtfx.pro and create a link for them. Name each link for who it's for, set an expiry, and extend or revoke it any time. <a href="/guide#share">See the Share page &rarr;</a>`,
  },
  {
    id: "delete",
    heading: "4. Delete",
    asks: [
      "<q>Delete q3-report.</q> Claude confirms the exact name first, then it's gone: every version, the link and its share links. This can't be undone.",
    ],
    note: "You can also delete it from the artifact's page on rtfx.pro.",
  },
];

/** Enterprise has no row in PLANS to render; these are the lines both the card and llms-full show. */
export const ENTERPRISE_LINES: readonly string[] = [
  "Dedicated URL for every artifact",
  "Branded workspace address",
  "Everything in Team, plus a conversation",
  "SSO, SCIM and contractual SLAs — none built yet",
  "Security review, DPA, invoicing",
  "Or self-host it: the source is MIT",
];

/** The walkthrough video's facts: one record for the player, the JSON-LD and llms-full. */
export const VIDEO = {
  file: "rtfx-guide.mp4",
  poster: "rtfx-guide-poster.jpg",
  width: 1920,
  height: 1080,
  /** ISO 8601 duration of the 55 s video. */
  duration: "PT55S",
  uploadDate: "2026-10-26",
  name: "rtfx.pro in 55 seconds: private links for Claude artifacts (MCP)",
  description:
    "Add the rtfx MCP server to Claude, publish a page to a private link, share it with " +
    "chosen people and see who opened it.",
} as const;
