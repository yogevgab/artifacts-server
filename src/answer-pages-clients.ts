import { MCP_URL, ANSWER_META } from "./seo";
import type { Faq } from "./home-content";

/**
 * Batch-3 answer pages (published 2026-11-06): one page per AI tool, per
 * messaging channel, and three Claude how-tos. Same rules as src/answer-pages.ts,
 * which renders them with the same page chrome:
 *
 *  - Claims about a tool stop at that vendor's own docs, read 2026-11-06 (the
 *    URL is linked from each page). Where a doc is silent (ChatGPT plan tiers,
 *    Grok authentication and approvals, VS Code dynamic client registration,
 *    the Devin Desktop config snippet) the page says what the doc says or omits it.
 *  - Claims about messaging apps are generic: nothing here says how an app
 *    previews or handles .html attachments.
 *  - Claims about rtfx match the code: the MCP publish tool is a write tool
 *    (readOnlyHint false in src/mcp.ts); OAuth discovery plus dynamic client
 *    registration; same-name publish appends a version; rollback_artifact; Free
 *    keeps the last 5 versions; named share links expire in 1-365 days; view log.
 *  - No competitor names, no custom-domain claims, and the literal word for the
 *    robots meta value never appears (a test bans it on public pages).
 */

export interface TopicSection {
  heading: string;
  /** Trusted HTML written in this file. */
  html: string;
}

export interface Topic {
  /** datePublished of the Article node; defaults to PUBLISHED. */
  published?: string;
  /** dateModified and the visible "Updated" line; defaults to MODIFIED. */
  modified?: string;
  h1: string;
  lead: string;
  sections: readonly TopicSection[];
  faqs: readonly Faq[];
  finalH: string;
  /** Replaces the default "Set it up: …" line (trusted HTML). */
  related?: string;
}

export type AnswerGroup = "claude" | "tools" | "channels";

const B3 = "2026-11-06";
const CLAUDE_SHARING_URL = "https://support.claude.com/en/articles/9547008-share-artifacts";
const CLAUDE_CODE_ARTIFACTS_URL = "https://code.claude.com/docs/en/artifacts";

const SHARE_PATH = "/share-claude-artifacts-privately";
const HTML_FILE_PATH = "/share-claude-html-file-privately";

const src = (url: string, label: string) => `<p>Source: <a href="${url}">${label}</a>, read ${B3}.</p>`;

/** The part that is the same in every AI-tool page: what to ask, who can open it. */
function publishSection(tool: string): TopicSection {
  return {
    heading: "Publish, share, update",
    html: `<ul>
          <li><b>Publish.</b> Ask ${tool}: <q>Publish this page with rtfx as a private link.</q> It replies with
            the link. The artifact is private to you, plus members of your team workspace if you publish to one.</li>
          <li><b>Share.</b> Ask: <q>Share it with dana@acme.com.</q> Dana signs in with a one-time code sent to
            her email; she needs no account with ${tool}. For someone you would rather not add by name, create a
            named share link on the artifact's Share page, with an optional expiry of 1 to 365 days that you can
            extend or revoke.</li>
          <li><b>See who opened it.</b> The view log on the Share page records who, when and on what device.</li>
          <li><b>Update.</b> Publish again to the same name and the same link shows the new version; you can
            roll back.</li>
        </ul>`,
  };
}

const toolFaqs = (tool: string): Faq[] => [
  {
    q: `Do the people I share with need a ${tool} account?`,
    a:
      "No. People you add by email sign in with a one-time code sent to their address, and a share link " +
      "opens with no sign-in. They never need an account with the tool that made the page.",
  },
  {
    q: "Can I see who opened the page?",
    a:
      "Yes. Every artifact has a view log on its Share page: who opened it when signed in, which share link " +
      "was used, when, and on what device. You can also ask the assistant who has opened it.",
  },
  {
    q: "What does it cost?",
    a:
      "There is a Free plan. Pro and Team add more artifacts, storage and people. rtfx staff see metadata " +
      "only, never artifact content.",
  },
];

const connectFaq = (tool: string, extra: string): Faq => ({
  q: `Why does ${tool} ask me to approve a publish?`,
  a:
    "Publishing creates something, so the rtfx publish tool is a write action, not a read-only one. " +
    extra +
    " Listing artifacts and reading details or view statistics are marked read-only.",
});

function toolTopic(o: {
  h1: string;
  lead: string;
  connect: string;
  vendor: string;
  vendorUrl: string;
  tool: string;
  faqs: readonly Faq[];
  finalH: string;
}): Topic {
  return {
    published: B3,
    modified: B3,
    h1: o.h1,
    lead: o.lead,
    sections: [
      { heading: `Connect rtfx to ${o.tool}`, html: o.connect + src(o.vendorUrl, o.vendor) },
      publishSection(o.tool),
    ],
    faqs: [...o.faqs, ...toolFaqs(o.tool)],
    finalH: o.finalH,
    related:
      `Set it up with Claude too: <a href="${SHARE_PATH}">how to share a Claude artifact privately</a>, ` +
      `or <a href="${HTML_FILE_PATH}">publish an HTML file from your browser</a>.`,
  };
}

const URL_NOTE = `The rtfx server address is <code>${MCP_URL}</code>.`;

// --- AI tools -----------------------------------------------------------------

const chatgpt = toolTopic({
  tool: "ChatGPT",
  h1: "How to share ChatGPT-generated HTML privately",
  lead:
    "Add rtfx.pro to ChatGPT as a custom MCP server, ask ChatGPT to publish the page you made, then " +
    "choose who can open it. People sign in with an email code, and you can see who opened it.",
  vendor: "OpenAI's custom MCP server guide",
  vendorUrl: "https://developers.openai.com/api/docs/guides/custom-mcp-server",
  connect: `<p>${URL_NOTE} OpenAI's guide describes this path, on ChatGPT on the web:</p>
        <ol>
          <li>Go to <b>ChatGPT Plugins</b> at chatgpt.com/plugins.</li>
          <li>Select the plus button, then <b>Add custom MCP server</b>.</li>
          <li>Enter a name, such as rtfx, and under <b>Connection</b> the server address above.</li>
          <li>Configure authentication: choose <b>OAuth</b>. rtfx publishes standard OAuth discovery and accepts
            dynamic client registration, so there is no key to paste. Sign in with the code we email you.</li>
          <li>Review the risk warning, select <b>I understand and want to continue</b>, then <b>Create as a plugin</b>.</li>
          <li>Install the plugin. In a conversation, type <b>@</b> and pick it.</li>
        </ol>
        <p>OpenAI notes that workspace permissions and security restrictions apply, and to only connect servers
          you trust. The guide doesn't state plan tiers, so check what your plan and workspace allow.</p>`,
  faqs: [
    connectFaq(
      "ChatGPT",
      "OpenAI's guide says write actions require confirmation by default, and tools count as write actions " +
        "unless they carry a read-only hint. Review the input before approving."
    ),
    {
      q: "Is the connector available on every ChatGPT plan?",
      a:
        "OpenAI's guide for custom MCP servers doesn't list plan tiers, and says workspace permissions apply. " +
        "Check the guide and your workspace settings rather than a third-party summary.",
    },
  ],
  finalH: "Share what ChatGPT built, privately.",
});

const cursor = toolTopic({
  tool: "Cursor",
  h1: "How to share Cursor-generated HTML privately",
  lead:
    "Add rtfx.pro to Cursor as a remote MCP server in mcp.json, ask the agent to publish the page, and " +
    "share it with named people who sign in with an email code.",
  vendor: "Cursor's MCP docs",
  vendorUrl: "https://cursor.com/docs/context/mcp",
  connect: `<p>Cursor's docs put remote servers in <code>mcp.json</code> with a <code>url</code> key instead of a
          command. For rtfx, in <code>~/.cursor/mcp.json</code>:</p>
        <pre><code>{
  "mcpServers": {
    "rtfx": { "url": "${MCP_URL}" }
  }
}</code></pre>
        <p>Cursor supports OAuth for servers that need it, using the authorization code flow with PKCE. When it
          asks you to sign in to rtfx, use the code we email you.</p>`,
  faqs: [
    connectFaq(
      "Cursor",
      "Cursor's docs say it asks for approval before using MCP tools by default; click the arrow next to the " +
        "tool name to see the arguments of a call."
    ),
    {
      q: "Can Cursor publish a whole built site?",
      a:
        "Through the MCP server the agent sends the page contents. For a built folder or zip on disk, use the " +
        "rtfx Claude Code plugin, or drop the zip into the dashboard in your browser.",
    },
  ],
  finalH: "Share what Cursor built, privately.",
});

const vscode = toolTopic({
  tool: "GitHub Copilot",
  h1: "How to share GitHub Copilot HTML privately from VS Code",
  lead:
    "Add rtfx.pro to VS Code as an HTTP MCP server, ask Copilot Chat to publish the page, then share it " +
    "with named people who sign in with an email code.",
  vendor: "VS Code's MCP servers docs",
  vendorUrl: "https://code.visualstudio.com/docs/copilot/customization/mcp-servers",
  connect: `<p>${URL_NOTE} The VS Code docs describe this path:</p>
        <ol>
          <li>Run <b>Chat: Open Customizations</b> from the Command Palette and select <b>MCP Servers</b>, then
            <b>Add Server</b> (+). Alternatively, run <b>MCP: Add Server</b>.</li>
          <li>Choose <b>HTTP (HTTP or Server-Sent Events)</b> and enter the server address above.</li>
          <li>Enter a server ID, such as <code>rtfx</code>.</li>
          <li>For a personal setup, select <b>Global</b>.</li>
        </ol>
        <p>The docs say a remote HTTP server can require sign-in; follow the publisher's instructions. For rtfx,
          that is the code we email you. The docs also say not to paste credentials into chat.</p>`,
  faqs: [
    connectFaq(
      "VS Code",
      "VS Code's docs say to review startup, sign-in and tool approval requests as they appear and approve " +
        "only actions you understand."
    ),
    {
      q: "Where do I control which tools Copilot can use?",
      a:
        "VS Code's docs point to Chat: Open Customizations, then Tools, where you control which tools a " +
        "Copilot session can use.",
    },
  ],
  finalH: "Share what Copilot built, privately.",
});

const devin = toolTopic({
  tool: "Devin Desktop",
  h1: "Use rtfx with Devin Desktop (formerly Windsurf)",
  lead:
    "Devin Desktop, formerly Windsurf, can call remote MCP servers. Add rtfx.pro from Customize, sign in " +
    "with an email code, and publish pages to private links your agent can share with named people.",
  vendor: "Devin Desktop's MCP docs",
  vendorUrl: "https://docs.devin.ai/desktop/cascade/mcp",
  connect: `<p>${URL_NOTE} If you used this tool as Windsurf, its docs have moved to docs.devin.ai. They say:</p>
        <ol>
          <li>Click <b>Customize</b> in the agent sidebar, then <b>MCPs</b>.</li>
          <li>Choose a scope with the <b>Install MCPs for</b> selector.</li>
          <li>To add a remote server yourself, add it to a config file: <code>.devin/mcp_config.json</code> in the
            project, <code>.devin/mcp_config.local.json</code> for a local override, or
            <code>~/.config/devin/mcp_config.json</code> for your user.</li>
        </ol>
        <p>The MCP page doesn't include a remote-server example, so follow the configuration docs it links for the
          file format. It says Devin supports the Streamable HTTP and SSE transports with OAuth for each; if a
          server shows <b>Needs authentication</b>, click <b>Authenticate</b> to run the browser sign-in.</p>`,
  faqs: [
    connectFaq(
      "Devin Desktop",
      "Devin's docs say that by default the agent prompts for approval before calling any MCP tool."
    ),
    {
      q: "Is Devin Desktop the same as Windsurf?",
      a:
        "Devin's docs now live at docs.devin.ai. This page uses the name Devin Desktop and notes the former " +
        "name, Windsurf, so you can find it either way.",
    },
  ],
  finalH: "Share what your agent built, privately.",
});

const gemini = toolTopic({
  tool: "Gemini",
  h1: "How to share Gemini and Antigravity HTML privately",
  lead:
    "Connect rtfx.pro to the Gemini app as a custom app, or to Antigravity as a remote MCP server, then " +
    "ask it to publish the page and share it with named people.",
  vendor: "Google's Gemini custom apps help page",
  vendorUrl: "https://support.google.com/gemini/answer/17209137",
  connect: `<p>${URL_NOTE}</p>
        <h3>Gemini app</h3>
        <p>Google's help page says to go to gemini.google.com, click <b>Settings</b> at the bottom, then
          <b>Connected Apps</b>. Under <b>Custom apps</b>, click <b>Add a custom app</b>, enter the server address
          above, click <b>Next</b> and follow the on-screen instructions. You can only connect an app on the web;
          it then appears in the mobile app too. To use it for a prompt, type <b>@</b> and select the app.</p>
        <p>Limits Google lists: you must be 18 or over and in the US, sign in with a personal Google Account (not
          a work or school one), keep Activity on, and custom connected apps are English only. If a server
          doesn't support dynamic client registration you would enter credentials under Advanced features;
          rtfx supports it, so there is nothing to enter.</p>
        <h3>Antigravity</h3>
        <p>Google's Antigravity docs show a config file, <code>~/.gemini/config/mcp_config.json</code> for the
          CLI and IDE, with a <code>serverUrl</code> key. For rtfx:</p>
        <pre><code>{
  "mcpServers": {
    "rtfx": { "serverUrl": "${MCP_URL}" }
  }
}</code></pre>
        <p>Remote servers must use Streamable HTTP, which rtfx does. In the Antigravity app, open
          <b>Customizations</b>, <b>Installed</b>, then <b>MCP Servers</b> and click <b>Authenticate</b> next to the
          server. For servers that support dynamic client registration, Antigravity handles OAuth with PKCE
          itself.</p>
        <p>Antigravity source: <a href="https://antigravity.google/docs/mcp">antigravity.google/docs/mcp</a>, read ${B3}.</p>`,
  faqs: [
    connectFaq(
      "Gemini",
      "Google's help page says Gemini requires manual confirmation for any write actions, and warns that " +
        "Gemini can make mistakes."
    ),
    {
      q: "Does the Gemini app connector work with a work Google account?",
      a:
        "Google's help page says custom apps aren't available when you sign in with a work or school Google " +
        "Account, and that the feature needs you to be 18 or over and in the US.",
    },
  ],
  finalH: "Share what Gemini built, privately.",
});

const grok = toolTopic({
  tool: "Grok",
  h1: "How to share Grok-generated HTML privately",
  lead:
    "Add rtfx.pro to Grok as a custom connector, ask Grok to publish the page you made, then share it " +
    "with named people who sign in with an email code.",
  vendor: "xAI's connectors docs",
  vendorUrl: "https://docs.x.ai/grok/connectors",
  connect: `<p>${URL_NOTE} xAI's docs describe this path:</p>
        <ol>
          <li>Open grok.com/connectors.</li>
          <li>Click <b>New Connector</b>, then choose <b>Custom</b>.</li>
          <li>Enter the server address above and complete any authentication it requires. For rtfx that is the
            code we email you.</li>
        </ol>
        <p>Grok then discovers the tools the server exposes. The docs say the server must be reachable over the
          public internet, and that on Business and Enterprise a team admin provisions connectors in the console
          before members can use them. The docs don't state per-plan limits on custom connectors, so check what
          your plan allows.</p>`,
  faqs: [
    {
      q: "Does Grok ask me to approve a publish?",
      a:
        "xAI's connectors page doesn't say. Publishing is a write action in rtfx, so review what the assistant " +
        "is about to send whenever it asks.",
    },
    {
      q: "Can I add a custom connector on every Grok plan?",
      a:
        "xAI's page doesn't state plan limits for custom connectors. It does say Business and Enterprise " +
        "connectors are provisioned by a team admin first.",
    },
  ],
  finalH: "Share what Grok built, privately.",
});

const pi = toolTopic({
  tool: "Pi",
  h1: "How to share Pi coding agent HTML privately",
  lead:
    "Add rtfx.pro to the Pi coding agent as a remote MCP server, sign in with an email code, and publish " +
    "pages to private links you can share with named people.",
  vendor: "Pi's MCP docs",
  vendorUrl: "https://pi.dev/docs/latest/mcp",
  connect: `<p>Pi's docs keep user-level servers in <code>~/.pi/agent/mcp.json</code>. For rtfx:</p>
        <pre><code>{
  "mcpServers": {
    "rtfx": { "url": "${MCP_URL}" }
  }
}</code></pre>
        <p>You can also add one from the shell with <code>pi mcp add rtfx --url ${MCP_URL}</code>. Servers that
          use OAuth need no credentials in the file. Sign in with <code>pi mcp login rtfx</code>, or
          <code>/mcp login rtfx</code> in a session, then use the code we email you. If the browser runs on another
          machine, the docs say to paste its redirected URL into the sign-in screen.</p>`,
  faqs: [
    {
      q: "Does Pi ask me to approve a publish?",
      a:
        "Pi's MCP docs don't describe a built-in approval prompt for MCP tool calls. Publishing is a write " +
        "action in rtfx, so check what the agent is about to publish.",
    },
    {
      q: "Does Pi support SSE servers?",
      a: "Pi's docs describe streamable HTTP for remote servers. rtfx serves Streamable HTTP at the address above.",
    },
  ],
  finalH: "Share what Pi built, privately.",
});

const opencode = toolTopic({
  tool: "OpenCode",
  h1: "How to share OpenCode HTML output privately",
  lead:
    "Add rtfx.pro to OpenCode as a remote MCP server in opencode.json, sign in with one command, and " +
    "publish pages to private links you can share with named people.",
  vendor: "OpenCode's MCP servers docs",
  vendorUrl: "https://opencode.ai/docs/mcp-servers",
  connect: `<p>OpenCode's docs add a remote server in <code>opencode.json</code> with <code>type</code> set to
          <code>"remote"</code>. For rtfx:</p>
        <pre><code>{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "rtfx": {
      "type": "remote",
      "url": "${MCP_URL}",
      "enabled": true
    }
  }
}</code></pre>
        <p>OpenCode handles OAuth for remote servers: it detects the 401 response, uses dynamic client
          registration if the server supports it (rtfx does), and stores the tokens. To start sign-in yourself,
          run <code>opencode mcp auth rtfx</code>; <code>opencode mcp list</code> shows each server's auth status.
          Sign in with the code we email you.</p>`,
  faqs: [
    {
      q: "Does OpenCode ask me to approve a publish?",
      a:
        "The MCP servers page doesn't describe an approval prompt for MCP tools. Publishing is a write action " +
        "in rtfx, so check what the agent is about to publish.",
    },
    {
      q: "My sign-in failed. How do I debug it?",
      a:
        "OpenCode's docs list opencode mcp debug followed by the server name, which checks connectivity and the " +
        "OAuth discovery flow when authentication fails.",
    },
  ],
  finalH: "Share what OpenCode built, privately.",
});

const hermes = toolTopic({
  tool: "Hermes Agent",
  h1: "How to share Hermes Agent HTML privately",
  lead:
    "Add rtfx.pro to Hermes Agent as a remote MCP server with OAuth, log in once, and publish pages to " +
    "private links you can share with named people.",
  vendor: "Hermes Agent's MCP docs",
  vendorUrl: "https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp",
  connect: `<p>Hermes' docs configure remote servers in <code>~/.hermes/config.yaml</code>. For rtfx:</p>
        <pre><code>mcp_servers:
  rtfx:
    url: "${MCP_URL}"
    auth: oauth</code></pre>
        <p>Then run <code>hermes mcp login rtfx</code>. The docs say Hermes handles discovery, client
          identification, PKCE, token exchange and refresh; your part is approving in the browser (Hermes never
          opens it by itself: click <b>Open in browser</b> in Desktop, or press Enter in the terminal). Sign in
          with the code we email you. On a headless host the docs list alternatives such as
          <code>hermes mcp login rtfx --flow device</code>.</p>`,
  faqs: [
    {
      q: "Does Hermes ask me to approve a publish?",
      a:
        "Hermes' docs say that on a server set to trust: untrusted, write-capable calls ask for approval. " +
        "Publishing is a write action in rtfx.",
    },
    {
      q: "I added the server from inside a running session and sign-in timed out.",
      a:
        "Hermes' docs say to run hermes mcp login from a fresh terminal after adding an entry in a session, " +
        "because the config auto-reload timeout is too short for OAuth.",
    },
  ],
  finalH: "Share what Hermes built, privately.",
});

// --- messaging channels ---------------------------------------------------------

function channelTopic(o: {
  app: string;
  h1: string;
  lead: string;
  where: string;
  faqs: readonly Faq[];
}): Topic {
  return {
    published: B3,
    modified: B3,
    h1: o.h1,
    lead: o.lead,
    sections: [
      {
        heading: "The short version",
        html: `<ol>
          <li><b>Publish the file to a private link.</b> In the browser, <a href="/signup">sign up</a> with an email
            code, open <b>Publish an artifact</b> and drop the <code>.html</code> file (or choose <b>Or paste HTML</b>).
            Or ask your AI tool to publish it with rtfx. It starts private.</li>
          <li><b>Choose who can open it.</b> Add the email addresses of the people who should see it, or create a
            named share link with an optional expiry of 1 to 365 days.</li>
          <li><b>${o.where}</b> The link is all you send.</li>
          <li><b>See who opened it.</b> The view log on the artifact's Share page shows who, when and on what device.</li>
        </ol>`,
      },
      {
        heading: "What your recipients see",
        html: `<ul>
          <li><b>Named people</b> open the link and sign in with a one-time code sent to their email. No account
            to create, and nothing to install.</li>
          <li><b>A share link</b> opens for anyone who has it, so send it only where you trust the audience. You can
            revoke it at any time without touching other people's access.</li>
          <li>A signed-in person without access sees the same “not found” page as for an artifact that doesn't exist.</li>
        </ul>
        <p>Artifact pages tell search engines not to index them and are excluded in robots.txt. If ${o.app} builds a
          preview when you paste a link, the view log records that as an attempt rather than a person.</p>`,
      },
      {
        heading: "Updating it later",
        html: `<p>Publish again to the same name and the same link shows the new version, so you never send a second
          link. Earlier versions are kept (Free keeps the last 5) and you can roll back. To stop sharing, remove a
          person, revoke a share link, or delete the artifact.</p>`,
      },
    ],
    faqs: [
      ...o.faqs,
      {
        q: "Do they need an rtfx account?",
        a:
          "No. People you add by email sign in with a one-time code. Someone holding a share link needs no " +
          "sign-in at all.",
      },
      {
        q: "Can I see who opened it?",
        a:
          "Yes. The view log records who opened it when signed in, which share link was used, when, and on what " +
          "device. You can also be emailed the first time each signed-in person opens it.",
      },
    ],
    finalH: "Send a link, not a file.",
    related:
      `Share from an AI tool instead: <a href="${SHARE_PATH}">how to share a Claude artifact privately</a>, ` +
      `or <a href="${HTML_FILE_PATH}">publish an HTML file from your browser</a>.`,
  };
}

const slack = channelTopic({
  app: "Slack",
  h1: "How to share an HTML file privately in Slack",
  lead:
    "Publish the HTML file to a private rtfx.pro link, paste the link in a Slack channel or message, and " +
    "only the people you chose can open it. They sign in with an email code, and you see who opened it.",
  where: "Paste the link in Slack.",
  faqs: [
    {
      q: "Does everyone in the channel get access?",
      a:
        "No. Access is set on the artifact, not by the channel. Only the people you added, your team workspace " +
        "members, and holders of a valid share link can open it.",
    },
  ],
});

const whatsapp = channelTopic({
  app: "WhatsApp",
  h1: "How to share an HTML file privately on WhatsApp",
  lead:
    "Publish the HTML file to a private rtfx.pro link, send the link in a WhatsApp chat, and only the " +
    "people you chose can open it. They sign in with an email code, and you see who opened it.",
  where: "Send the link in WhatsApp.",
  faqs: [
    {
      q: "What if the message is forwarded to a group?",
      a:
        "A person you added still needs to sign in with their email code, so a forwarded link doesn't open " +
        "for others. A share link is different: it opens for anyone who has it, so give it an expiry.",
    },
  ],
});

const email = channelTopic({
  app: "your email app",
  h1: "How to share an HTML file privately by email or Gmail",
  lead:
    "Publish the HTML file to a private rtfx.pro link and put the link in your Gmail or other email, instead " +
    "of attaching the file. Only the people you chose can open it, and you see who did.",
  where: "Put the link in your email.",
  faqs: [
    {
      q: "Why a link instead of an attachment?",
      a:
        "A link lets you choose who can open the page, remove one person later, set an expiry and see who " +
        "opened it. An attachment gives a copy to everyone it reaches.",
    },
  ],
});

const teams = channelTopic({
  app: "Microsoft Teams",
  h1: "How to share an HTML file privately in Microsoft Teams",
  lead:
    "Publish the HTML file to a private rtfx.pro link, paste the link in a Teams chat or channel, and only " +
    "the people you chose can open it. They sign in with an email code, and you see who opened it.",
  where: "Paste the link in Teams.",
  faqs: [
    {
      q: "Does everyone in the team or channel get access?",
      a:
        "No. Access is set on the artifact. Only the people you added, your rtfx team workspace members, and " +
        "holders of a valid share link can open it.",
    },
  ],
});

const discord = channelTopic({
  app: "Discord",
  h1: "How to share an HTML file privately on Discord",
  lead:
    "Publish the HTML file to a private rtfx.pro link, paste the link in a Discord server or direct message, " +
    "and only the people you chose can open it. They sign in with an email code, and you see who opened it.",
  where: "Paste the link in Discord.",
  faqs: [
    {
      q: "Should I post a share link in a public server?",
      a:
        "A share link opens for anyone who has it, so a public channel is the wrong place for one. Add people by " +
        "email instead, or give the share link a short expiry and revoke it when you are done.",
    },
  ],
});

// --- Claude how-tos --------------------------------------------------------------

const updateLink: Topic = {
  published: B3,
  modified: B3,
  h1: "How to update a Claude artifact without changing the link",
  lead:
    "In Claude Code, an artifact already keeps its URL when you publish again: each publish becomes a version " +
    "at the same address. rtfx.pro gives a page you publish through its MCP server the same behaviour, with " +
    "rollback, for people who don't have a Claude account.",
  sections: [
    {
      heading: "What Claude Code does",
      html: `<p>Claude Code's docs say that to update an artifact you ask Claude to revise the page, and Claude
          “edits the underlying file and publishes again to the same URL.” Anyone with the page open sees the update
          in place. Each publish becomes a version, and the <b>Share</b> control in the page header chooses which
          version viewers see. To update from a different session, give Claude the artifact's URL; without it, a
          new session creates a new artifact.</p>
        <p>Source: <a href="${CLAUDE_CODE_ARTIFACTS_URL}">Claude Code's artifacts docs</a>, read ${B3}. For
          artifacts made in a chat, <a href="${CLAUDE_SHARING_URL}">Claude's help article on sharing</a> is the
          place to check how your plan handles changes.</p>`,
    },
    {
      heading: "Updating on rtfx.pro",
      html: `<ul>
          <li><b>Publish again to the same name.</b> Ask Claude: <q>Update q3-report and publish it again.</q> The
            same link now shows the new version. Everyone you shared it with, and every share link, keeps working.</li>
          <li><b>Every publish is a version.</b> Free keeps your last 5, and paid plans keep every one.</li>
          <li><b>Roll back from chat.</b> <a href="${ANSWER_META.revert.path}">How to revert to an earlier version &rarr;</a></li>
          <li><b>Set it up once:</b> <code>claude mcp add --transport http rtfx ${MCP_URL}</code> in Claude Code, or
            <b>Customize → Connectors → Add custom connector</b> with the same address in Claude on the web.</li>
        </ul>`,
    },
    {
      heading: "When the difference matters",
      html: `<p>Use rtfx when the people opening the link should not need a Claude account, when you want to pick
          exactly who can open it, or when you want a view log and an expiry on the links you hand out.
          <a href="${SHARE_PATH}">How to share a Claude artifact privately &rarr;</a></p>`,
    },
  ],
  faqs: [
    {
      q: "Does a Claude Code artifact keep the same link when I update it?",
      a:
        "Yes, according to Claude Code's docs: Claude publishes again to the same URL, each publish becomes a " +
        "version, and the Share control chooses which version viewers see.",
    },
    {
      q: "Will my rtfx link change when I publish an update?",
      a:
        "No. Publish again to the same name and the same link shows the new version. Publishing to a new name " +
        "creates a separate artifact with its own link.",
    },
    {
      q: "Can someone else update my rtfx artifact?",
      a: "Editors you add can publish new versions and roll back, but can't change who has access or delete it.",
    },
  ],
  finalH: "Update it once, keep the link.",
};

const revert: Topic = {
  published: B3,
  modified: B3,
  h1: "How to revert a Claude artifact to an earlier version",
  lead:
    "Claude Code's docs say you pick which version viewers see from the Share control. With rtfx.pro you ask " +
    "Claude to roll the artifact back to an earlier version in chat, and the same link shows it again.",
  sections: [
    {
      heading: "In Claude Code",
      html: `<p>Claude Code's docs say each publish becomes a version, and from the <b>Share</b> control in the
          page header you can choose which version viewers see.</p>
        ${src(CLAUDE_CODE_ARTIFACTS_URL, "Claude Code's artifacts docs")}`,
    },
    {
      heading: "On rtfx.pro",
      html: `<ul>
          <li><b>Ask in chat.</b> <q>Roll q3-report back to version 2.</q> Claude uses rtfx's rollback tool, and the
            same link shows that version.</li>
          <li><b>Nothing is lost.</b> A rollback makes an earlier version the live one; the other versions stay in
            the history.</li>
          <li><b>How many versions exist.</b> Every publish is a version. Free keeps your last 5 and paid plans
            keep every one, so on Free you can only go back to a version still kept.</li>
          <li><b>Who can roll back.</b> You, and editors you added.</li>
        </ul>
        <p>Connect once with <code>claude mcp add --transport http rtfx ${MCP_URL}</code>, or in Claude on the web
          with <b>Customize → Connectors → Add custom connector</b>.</p>`,
    },
  ],
  faqs: [
    {
      q: "Can I choose which version viewers see in Claude Code?",
      a: "Yes. Claude Code's docs say the Share control in the page header lets you choose which version viewers see.",
    },
    {
      q: "Does rolling back change the link?",
      a: "No. The link stays the same and shows the version you rolled back to.",
    },
    {
      q: "Can I go forward again after a rollback?",
      a:
        "Yes, while the later version is still kept. Ask Claude to roll the artifact to that version number, or " +
        "publish again to add a new one.",
    },
  ],
  finalH: "Go back without sending a new link.",
};

const outOfGoogle: Topic = {
  published: B3,
  modified: B3,
  h1: "How to keep Claude artifacts out of Google",
  lead:
    "Claude's help article on sharing artifacts doesn't say whether shared artifacts can be indexed by search " +
    "engines. rtfx.pro artifacts are excluded in robots.txt, tell search engines not to index them, and open " +
    "only for people you allow.",
  sections: [
    {
      heading: "What Claude's docs say",
      html: `<p>Claude's help article doesn't say whether shared artifacts are indexed. It does say artifacts start
          private to you, and that a link shared with anyone who has it can be opened by anyone signed in to Claude.
          Claude Code's docs describe a public link as one that anyone on the internet can open without signing in.
          Whether a search engine would find such a link isn't covered, so the cautious reading is to not share
          anything sensitive that way.</p>
        <p>Sources: <a href="${CLAUDE_SHARING_URL}">Claude's help article on sharing artifacts</a> and
          <a href="${CLAUDE_CODE_ARTIFACTS_URL}">Claude Code's artifacts docs</a>.</p>`,
    },
    {
      heading: "What rtfx.pro does",
      html: `<ul>
          <li><b>Excluded in robots.txt.</b> Artifact pages are kept out of the paths crawlers are invited to read.</li>
          <li><b>Told not to index.</b> Every artifact response tells search engines not to index it.</li>
          <li><b>Access-gated.</b> A page opens only for people you added, members of its workspace, or holders of a
            valid share link. A signed-in person without access sees the same “not found” page as for an artifact
            that doesn't exist.</li>
          <li><b>Share links.</b> A share link opens for anyone who has it, so give it an expiry and revoke it when
            you are done; opens through it are logged.</li>
        </ul>`,
    },
  ],
  faqs: [
    {
      q: "Can Google index a Claude artifact?",
      a:
        "Claude's help article doesn't say. A published legacy chat artifact opens for anyone with the link, so " +
        "treat it as public.",
    },
    {
      q: "Is a private rtfx link guaranteed never to appear in search?",
      a:
        "Pages are excluded in robots.txt, tell search engines not to index them, and open only for allowed " +
        "people. A link you paste somewhere public is still a link, so share by name where you can.",
    },
    {
      q: "How do I make sure only the right people can open it?",
      a:
        "Add them by email: each signs in with a one-time code. You can remove one person later without " +
        "changing anything for the others, and the view log shows who opened it.",
    },
  ],
  finalH: "Keep it out of search and in the right hands.",
};

/** Page key → topic. Order within a group is the order the hub lists them. */
export const CLIENT_TOPICS = {
  updateLink,
  revert,
  outOfGoogle,
  chatgpt,
  cursor,
  vscode,
  devin,
  gemini,
  grok,
  pi,
  opencode,
  hermes,
  slack,
  whatsapp,
  email,
  teams,
  discord,
} as const;

export type ClientTopicKey = keyof typeof CLIENT_TOPICS;

export const CLIENT_GROUPS: Record<ClientTopicKey, AnswerGroup> = {
  updateLink: "claude",
  revert: "claude",
  outOfGoogle: "claude",
  chatgpt: "tools",
  cursor: "tools",
  vscode: "tools",
  devin: "tools",
  gemini: "tools",
  grok: "tools",
  pi: "tools",
  opencode: "tools",
  hermes: "tools",
  slack: "channels",
  whatsapp: "channels",
  email: "channels",
  teams: "channels",
  discord: "channels",
};
