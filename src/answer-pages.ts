import { layout, siteHeader, siteFooter, PUBLIC_CHROME_STYLE, esc } from "./pages";
import { cookieNotice, CONSENT_STYLE, CONSENT_SCRIPT } from "./consent";
import { GUIDE_IMAGES } from "./guide-images";
import { GUIDE_PARTS } from "./guide";
import type { Env } from "./env";
import { SITE, MCP_URL, ANSWER_META, TOPIC_KEYS, canonicalUrl, siteOrigin } from "./seo";
import type { TopicKey } from "./seo";
import { htmlToMarkdown } from "./html-text";
import type { Faq } from "./home-content";
import { priceLabel } from "./plan-copy";

/**
 * Short "answer" pages for the searches people actually type: the two below,
 * the TOPICS pages further down (one question each, TOPIC_KEYS in src/seo.ts),
 * and the /answers hub that lists them all:
 *
 *  - `/share-claude-artifacts-privately`: how to share a Claude artifact privately.
 *  - `/claude-publish-vs-private-link`: Claude's built-in Publish vs an rtfx private link.
 *
 * All copy is data in this file. The pages, their JSON-LD (Article, FAQPage,
 * BreadcrumbList) and the matching sections of `/llms-full.txt`
 * (`answerPagesMarkdown`) read the same arrays, so none of them can drift.
 *
 * Claims about Claude's own sharing are limited to what Anthropic's help
 * article "Share artifacts" (CLAUDE_SHARING_URL) states, re-checked 2026-11-06:
 * artifacts start private; Pro/Max/Ultra can choose "Only you", "Anyone with
 * the link" or email invitations (beta); Team/Enterprise add organization-wide
 * sharing; "Most artifacts shared with 'Anyone with the link' open without a
 * Claude account or sign-in" — but docs need sign-in, some artifacts show
 * content only after sign-in, link-only visitors can't use the parts that use
 * Claude or connected apps and can't see or add comments; people invited by
 * email (or shared with in an organization) sign in to Claude, and an invitee
 * needs a Claude account with that address; pending invitations expire after 30 days;
 * unpublishing a legacy published artifact revokes it for good. Where the
 * article says nothing (passwords, view analytics, link expiry) the copy says
 * "the help article doesn't describe" — never "Claude can't". Do not add more
 * without a source, and bump MODIFIED when this changes.
 */

const PUBLISHED = "2026-10-26";
const MODIFIED = "2026-11-06";
const CLAUDE_SHARING_URL = "https://support.claude.com/en/articles/9547008-share-artifacts";
/**
 * Claude Code's own artifacts documentation. Claims about artifacts made in
 * Claude Code stop at what this page says (re-checked 2026-11-03): private at
 * first; shared within the organization on Team and Enterprise; a public link
 * anyone can open without signing in (an Owner enables it on Team/Enterprise);
 * each publish is a version and the Share control picks which one viewers see;
 * one self-contained page; not available to API-key, gateway-token or
 * cloud-provider sessions, nor by default with -p or the Agent SDK.
 *
 * The help article was also re-checked 2026-11-03 for the batch-2 topic pages.
 * (2026-11-06: the article no longer says everyone needs a Claude account — see
 * above; the copy was updated to match.) Facts used there: access levels Can view / Commenter / Can edit; up to 50
 * outside invitees per artifact; on Pro, Max and Ultra, switching to "Only you"
 * leaves invited people their access; sharing settings can't be changed in the
 * iOS/Android apps; Team/Enterprise chat artifacts expose that chat's
 * attachments; some artifacts use shared storage; published chat artifacts can
 * be embedded on allowed domains; unpublishing deletes storage and can't be undone.
 */
const CLAUDE_CODE_ARTIFACTS_URL = "https://code.claude.com/docs/en/artifacts";
/** Topic pages added after the first four carry their own publish date. */
const BATCH_2 = "2026-11-03";

// --- shared bits --------------------------------------------------------------

interface ShotRef {
  name: string;
  width: number;
  height: number;
  alt: string;
}

/** Look a guide screenshot up by name, so size and alt text come from the guide's own data. */
function shot(name: string): ShotRef {
  for (const part of GUIDE_PARTS) {
    const s = part.shots.find((x) => x.name === name);
    if (s) return { name, width: s.width, height: s.height, alt: s.alt };
  }
  throw new Error(`unknown guide screenshot: ${name}`);
}

const imgPath = (name: string) => `/guide/${name}.webp?v=${GUIDE_IMAGES[name]!.hash}`;

// --- page 1: share privately --------------------------------------------------

const SHARE_H1 = "How to share a Claude artifact privately";

const SHARE_LEAD =
  "Add the rtfx.pro MCP server to Claude once, ask Claude to publish your artifact to a private " +
  "link, then choose exactly who can open it — they sign in with an email code and don't need a " +
  "Claude account — and see who opened it. (Claude artifacts start private too. Claude's " +
  "“Anyone with the link” opens for anyone who gets the link, while sharing with specific " +
  "people means each one needs a Claude account; Claude's help article doesn't describe " +
  "passwords, expiring links or a view log.)";

interface AnswerStep {
  name: string;
  /** Step text, HTML subset understood by htmlToMarkdown. */
  html: string;
  guide: { href: string; label: string };
  image?: string;
}

const SHARE_STEPS: readonly AnswerStep[] = [
  {
    name: "Add rtfx to Claude",
    html:
      `In Claude, open <b>Customize → Connectors</b>, click <b>+ Add</b>, then <b>Add custom connector</b>, ` +
      `and use the URL <code>${MCP_URL}</code>. Sign in with the code we email you; there is nothing to ` +
      `paste. Added on the web or in Claude Desktop, it works on mobile too. In Claude Code, run ` +
      `<code>claude mcp add --transport http rtfx ${MCP_URL}</code>.`,
    guide: { href: "/guide#connect", label: "Connect, with screenshots" },
    image: "02-connector-details",
  },
  {
    name: "Ask Claude to publish it",
    html:
      `Say <em>publish it with rtfx as a private link</em>. Claude replies with your link, and only you ` +
      `(plus members of your team workspace, if you publish to one) can open it until you share it. ` +
      `Publish again to the same name and the same link shows the new ` +
      `version; you can roll back from chat.`,
    guide: { href: "/guide#publish", label: "Publish, with screenshots" },
  },
  {
    name: "Share it with the people you choose",
    html:
      `Ask Claude: <q>Share it with dana@acme.com.</q> You can add viewers, editors, or everyone in ` +
      `your workspace. For someone without an account, open the artifact's Share page on rtfx.pro and ` +
      `create a named share link for them, with an optional expiry that you can extend or revoke any time.`,
    guide: { href: "/guide#share", label: "Share, with screenshots" },
    image: "10-share",
  },
  {
    name: "See who opened it",
    html:
      `Ask Claude who has opened it, or look at the view log on the Share page: who opened it, when, ` +
      `and on what device.`,
    guide: { href: "/guide#views", label: "See who opened it, with screenshots" },
    image: "11-views",
  },
];

const PRICE_LINE =
  `There is a Free plan. Pro is ${priceLabel("pro")} and Team is ${priceLabel("team")}, bought on the ` +
  `site, for more artifacts, storage and people. rtfx staff (operators) see metadata only, never ` +
  `artifact content.`;

const SHARE_FAQS: readonly Faq[] = [
  {
    q: "Can I put a password on a Claude artifact?",
    a:
      "Claude's help article describes sharing an artifact with only you, anyone with the link, " +
      "people invited by email or (on Team and Enterprise) your organization; it doesn't describe a " +
      "password option. rtfx doesn't use a shared " +
      "password either: each person you add signs in with a one-time code sent to their email, so " +
      "you can remove one person without changing anything for the others, and the view log shows " +
      "who actually opened it.",
  },
  {
    q: "Can someone without a Claude account open it?",
    a:
      "With rtfx, yes — viewers never need a Claude account. People you add by email sign in with a " +
      "one-time code we send them. For someone you don't want to add, create a named share link on " +
      "the artifact's Share page: they open the page with no sign-in, and you can set an expiry, " +
      "extend it or revoke it at any time. (In Claude, people you invite by name need a Claude " +
      "account; “Anyone with the link” skips that but opens for anyone who has the link.)",
  },
  {
    q: "Can I see who viewed my Claude artifact?",
    a:
      "Claude's help article doesn't describe view analytics. With rtfx, every artifact has a view " +
      "log on its Share page — who opened it, when, and on what device — and you can ask Claude " +
      "who has opened it.",
  },
  {
    q: "Can anyone with the link open an artifact I share from Claude?",
    a:
      "Only if you choose \u201cAnyone with the link\u201d in Claude's Share menu; artifacts start " +
      "private. On Team and Enterprise an owner has to allow that kind of sharing. Once you do, " +
      "Claude's help article says most such artifacts open for anyone who has the link without " +
      "signing in (docs, and parts that use Claude or connected apps, still need sign-in) — so " +
      "anyone the link is forwarded to can open it too.",
  },
  {
    q: "What does it cost?",
    a: PRICE_LINE,
  },
];

// --- page 2: Publish vs private link ------------------------------------------

const COMPARE_H1 = "Claude artifact sharing vs a private link";

const COMPARE_LEAD =
  "Claude can share an artifact from its Share menu, and rtfx.pro adds private links to Claude as an " +
  "MCP server. Claude gives you two kinds of sharing: “Anyone with the link”, which opens for " +
  "whoever has the link, and invitations to specific people, who each need a Claude account. A " +
  "private link is for sharing with exactly the people you choose, whether or not they use Claude, " +
  "with a record of who opened it. Here is how they differ.";

interface CompareRow {
  label: string;
  /** Claude's built-in Publish (HTML subset). */
  claude: string;
  /** rtfx private link (HTML subset). */
  rtfx: string;
}

const COMPARE_ROWS: readonly CompareRow[] = [
  {
    label: "Who can open it",
    claude:
      "Starts private. Pro, Max and Ultra: only you, anyone with the link, or people you invite by " +
      "email. Team and Enterprise: invited people, your organization, or anyone with the link; an " +
      "Owner controls link sharing and invitations outside the organization.",
    rtfx:
      "Private by default. You, people you add as viewers or editors, everyone in your workspace, " +
      "or anyone holding a named share link you created.",
  },
  {
    label: "Sign-in for viewers",
    claude:
      "People you invite (or share with in your organization) sign in to Claude; an invitee needs a " +
      "Claude account. Most “Anyone with the link” artifacts open without signing in, except " +
      "docs and parts that use Claude or connected apps.",
    rtfx:
      "People you add sign in with a one-time email code. Someone with a share link needs no " +
      "account and no sign-in.",
  },
  {
    label: "Updating and versions",
    claude: "Unpublishing a legacy published artifact revokes it, and it can't be republished.",
    rtfx:
      "Publish again to the same name and the same link shows the new version. Every publish is a " +
      "version, and you can roll back from chat.",
  },
  {
    label: "Expiry and revoking",
    claude: "Change who has access in the Share menu. Pending email invitations expire after 30 days; the help article doesn't describe expiring links.",
    rtfx:
      "Named share links with an optional expiry that you can extend or revoke. You can also " +
      "delete the artifact, with every version and share link.",
  },
  {
    label: "Who opened it",
    claude: "Not described in Claude's help article.",
    rtfx: "A view log on the artifact's Share page: who opened it, when, and on what device. You can also ask Claude.",
  },
  {
    label: "Cost",
    claude: `Built into Claude; see <a href="${CLAUDE_SHARING_URL}">Claude's help article on sharing</a> for plan details.`,
    rtfx: `Free plan. Pro ${priceLabel("pro")}, Team ${priceLabel("team")}. Operators see metadata only, never your content.`,
  },
];

const COMPARE_NOTE =
  "The Claude column only states what Anthropic's help article on sharing artifacts says (checked " +
  "2026-11-02). Where it says nothing, we say so rather than guess.";

const WHEN_CLAUDE: readonly string[] = [
  "Everyone who should open it already uses Claude.",
  "Anyone may see it: a demo, a public write-up, something you would post openly.",
  "You do not need to know who opened it.",
  "You want no setup beyond Claude's Share menu.",
];

const WHEN_RTFX: readonly string[] = [
  "Only chosen people should open it — including people who don't use Claude: a client draft, an internal report, a prototype under review.",
  "You want to see who opened it.",
  "You will keep updating it and want the same link to show the latest version, with rollback.",
  "You want a link that expires, or one you can revoke without deleting the work.",
];

// --- topic pages: one question, answered first ----------------------------------

/**
 * Short answer pages for questions people actually search ("can I see who viewed
 * my Claude artifact?", "can I put a password on one?"). Same rules as the two
 * pages above: claims about Claude stop at what its help article says; claims
 * about rtfx are what the code does (view fields: src/db.ts logView/logLinkEvent;
 * read notices: src/read-receipts.ts; chat access to the log: artifact_details in
 * src/mcp.ts returns the recent views).
 */
interface TopicSection {
  heading: string;
  /** Trusted HTML written in this file. */
  html: string;
}

interface Topic {
  /** datePublished of the Article node; defaults to PUBLISHED. */
  published?: string;
  /** dateModified and the visible "Updated" line; defaults to MODIFIED. */
  modified?: string;
  h1: string;
  lead: string;
  sections: readonly TopicSection[];
  faqs: readonly Faq[];
  finalH: string;
}

const TOPICS: Record<TopicKey, Topic> = {
  views: {
    h1: "Can you see who viewed a Claude artifact?",
    lead:
      "Claude's help article on sharing artifacts doesn't describe view analytics. Publish the artifact " +
      "to an rtfx.pro private link and it gets a view log: who opened it if they were signed in, which " +
      "share link was used if not, when, and on what device.",
    sections: [
      {
        heading: "What the view log records",
        html: `<ul>
          <li><b>Who</b> — the email address of anyone who opened it while signed in, including people
            who came through a share link while signed in.</li>
          <li><b>Which link</b> — opens through a share link are labelled with the link's name, so you
            can tell “Board preview” from “Client copy” even when the person isn't signed in.</li>
          <li><b>When, and on what</b> — the time, device type, operating system and browser, the
            approximate location, and which version they saw.</li>
          <li><b>Attempts</b> — someone trying an expired or revoked link, and the previews chat apps
            build when a link is pasted.</li>
        </ul>
        <p>Opens of the same share link from the same IP address within five minutes are recorded once,
          so a reload doesn't add an entry (two people on one office network can merge, too). Signed-in
          opens are each recorded.</p>`,
      },
      {
        heading: "How to see it",
        html: `<ul>
          <li><b>Ask Claude.</b> <q>Who has opened q3-report?</q> Claude reads the recent views for you.</li>
          <li><b>Open the artifact's Share page</b> on rtfx.pro for the full log. <a href="/guide#views">See it in the guide &rarr;</a></li>
          <li><b>Get an email.</b> As the owner, you can be emailed the first time each signed-in person other
            than you opens it (share-link opens don't send these). Turn read notices off per artifact.</li>
        </ul>`,
      },
      {
        heading: "What it can't tell you",
        html: `<ul>
          <li>That someone <em>read</em> it. A log entry means the page was loaded.</li>
          <li>Who a share link was forwarded to. A share link opens for anyone who has it; the log names
            the link, not the person, unless they were signed in. Share by name when you need names.</li>
          <li>Old IP addresses. They stop being shown after 90 days.</li>
        </ul>`,
      },
    ],
    faqs: [
      {
        q: "Can I see who viewed my Claude artifact?",
        a:
          "Claude's help article on sharing artifacts doesn't describe view analytics. If you publish the " +
          "artifact to an rtfx.pro private link, its view log shows who opened it (when they were signed " +
          "in), when, on what device and through which share link.",
      },
      {
        q: "Can I get notified when someone opens it?",
        a:
          "Yes. The first time each signed-in person other than you opens the artifact (not through a share " +
          "link), rtfx.pro can email you. Read notices can be turned off for each artifact.",
      },
      {
        q: "Who else can see the view log?",
        a:
          "You, and members of the workspace the artifact belongs to who can manage it. Viewers can't, " +
          "and rtfx staff can't — they see metadata only, never content or who viewed it.",
      },
    ],
    finalH: "Know who opened it.",
  },
  password: {
    h1: "Can you put a password on a Claude artifact?",
    lead:
      "Claude's help article doesn't describe a password option: you share an artifact with only you, " +
      "anyone with the link, or people you invite by email (who need a Claude account). rtfx.pro " +
      "doesn't use passwords either — each person you choose signs in with a one-time email code, " +
      "you can remove one person without affecting the others, and you see who opened it.",
    sections: [
      {
        heading: "Why a shared password is weak",
        html: `<ul>
          <li>It can be forwarded, and nothing records who it was forwarded to.</li>
          <li>Shutting one person out means changing it for everyone.</li>
          <li>On its own, a shared password doesn't identify who opened the page.</li>
        </ul>`,
      },
      {
        heading: "What rtfx.pro does instead",
        html: `<ul>
          <li><b>Named people.</b> <q>Share it with dana@acme.com.</q> Dana signs in with a code sent to
            that address — no password, no Claude account — and you can remove her at any time.</li>
          <li><b>Share links, when names aren't practical.</b> A share link opens for anyone who has it.
            Each one has a name, can expire, can be revoked on its own without touching the others, and
            opens through it are logged.</li>
          <li><b>Your workspace.</b> Members of the workspace you publish to can always open it — on a
            personal workspace that's just you.</li>
        </ul>
        <p>Every artifact is private when it is published: only you, and members of its workspace if it
          belongs to a team, can open it until you share it.</p>`,
      },
    ],
    faqs: [
      {
        q: "Can I put a password on a Claude artifact?",
        a:
          "Claude's help article on sharing artifacts doesn't describe a password option. With rtfx.pro you " +
          "don't need one: the people you choose sign in with a one-time email code. Only they, members of " +
          "the artifact's workspace and holders of a valid share link you created can open it.",
      },
      {
        q: "Does rtfx.pro use passwords on links?",
        a:
          "No. It has named access (email-code sign-in for each person) and share links that anyone holding " +
          "them can open, with an optional expiry and immediate revocation.",
      },
      {
        q: "Do the people I share with need a Claude account?",
        a: "No. They sign in with a one-time code sent to their email, or open a share link with no sign-in.",
      },
    ],
    finalH: "Share without a password.",
  },
  noAccount: {
    published: BATCH_2,
    modified: "2026-11-06",
    h1: "Can someone open a Claude artifact without a Claude account?",
    lead:
      "It depends how you share it. Claude's help article says most artifacts shared with “Anyone " +
      "with the link” open without a Claude account — but then anyone who gets the link can open " +
      "it. To share with specific people instead, each one needs a Claude account. To share privately " +
      "with chosen people who don't use Claude, publish to an rtfx.pro private link: they sign in with " +
      "a one-time email code, or open a share link you made for them.",
    sections: [
      {
        heading: "What Claude's own sharing allows",
        html: `<ul>
          <li><b>&ldquo;Anyone with the link.&rdquo;</b> <q>Most artifacts shared with &lsquo;Anyone with the
            link&rsquo; open without a Claude account or sign-in,</q> says <a href="${CLAUDE_SHARING_URL}">Claude's
            help article</a>. Docs open only for people signed in to Claude, some artifacts show their content
            only after sign-in, and link-only visitors can't use the parts that use Claude or connected apps.
            Anyone the link reaches can open it.</li>
          <li><b>Specific people.</b> People you invite by email sign in to Claude with the address you
            invited, and each needs a Claude account with that address.</li>
          <li><b>Legacy artifacts published from a chat.</b> Anyone with the link can view and use them
            without a Claude account (they're asked to sign up only for features that use Claude). That makes
            them public: there is no list of who may open one.</li>
          <li><b>Claude Code artifacts.</b> <a href="${CLAUDE_CODE_ARTIFACTS_URL}">Claude Code's docs</a>
            describe a public link that anyone on the internet can open with no sign-in, and, on Team and
            Enterprise plans, sharing within your organization.</li>
        </ul>`,
      },
      {
        heading: "Private, without a Claude account",
        html: `<ul>
          <li><b>By name.</b> Ask Claude: <q>Share it with dana@acme.com.</q> Send Dana the link; she signs in
            with a one-time code sent to that address. No Claude account and no password.</li>
          <li><b>By share link.</b> For someone you'd rather not add by email, create a named share link on
            the artifact's Share page on rtfx.pro. It opens with no sign-in, can expire after 1 to 365 days,
            and can be revoked on its own.</li>
          <li><b>Either way, you see who opened it</b> — the person's email if they were signed in, or which
            share link was used if not. <a href="${ANSWER_META.views.path}">What the view log records &rarr;</a></li>
        </ul>
        <p>You add rtfx.pro to Claude once, as an MCP server. The people you share with don't need Claude
          or anything installed: they open the link in a browser.</p>`,
      },
    ],
    faqs: [
      {
        q: "Do people need a Claude account to open a shared Claude artifact?",
        a:
          "Not for “Anyone with the link”: Claude's help article says most such artifacts open " +
          "without a Claude account or sign-in (docs need sign-in). People you invite by email do need a " +
          "Claude account. Claude Code's docs describe public links that open without signing in.",
      },
      {
        q: "How can someone without Claude open my artifact privately?",
        a:
          "Publish it to an rtfx.pro private link and share it with their email address: they sign in " +
          "with a one-time code sent to that address. Or create a named share link for them, which opens " +
          "with no sign-in and can expire or be revoked.",
      },
      {
        q: "Isn't a public link good enough?",
        a:
          "A public link opens for anyone who gets it, including people it was forwarded to. If only " +
          "certain people should see the artifact, share it with them by name so each one signs in, and " +
          "the view log shows who opened it.",
      },
    ],
    finalH: "Share with people who don't use Claude.",
  },
  htmlFile: {
    published: BATCH_2,
    modified: BATCH_2,
    h1: "How to share a Claude artifact's HTML file privately",
    lead:
      "You don't have to connect anything to Claude. Sign up for rtfx.pro with your email, then drop " +
      "the HTML file Claude made into the dashboard — or paste its HTML — and you get a private link. " +
      "Add the people who should see it; they sign in with a one-time email code and need no Claude " +
      "account. It's free to start.",
    sections: [
      {
        heading: "Three steps in your browser",
        html: `<ul>
          <li><b>Get the HTML.</b> Save the page Claude made as an <code>.html</code> file, or copy its
            code. If Claude wrote a React component rather than a full page, ask it for <q>a single
            self-contained HTML file</q> first.</li>
          <li><b>Publish it.</b> <a href="/signup">Sign up</a> with an email code, open <b>Publish an
            artifact</b>, and drop the file (a <code>.html</code> page, a <code>.pdf</code>, or a
            <code>.zip</code> with <code>index.html</code> at its root, up to 50 MB) or choose
            <b>Or paste HTML</b>. Give it a title and publish. It starts private.</li>
          <li><b>Share it.</b> Open the artifact and choose <b>Share</b>: add the email addresses of the
            people who should open it, or create a named share link that can expire. The view log shows
            who opened it.</li>
        </ul>`,
      },
      {
        heading: "Updating it later",
        html: `<ul>
          <li>Publish again to the same slug and the same link shows the new version. Earlier versions are
            kept, and you can roll back.</li>
          <li>Tired of downloading and uploading? Add rtfx to Claude once as a connector and ask Claude to
            publish for you. <a href="${ANSWER_META.share.path}">How to share from Claude directly &rarr;</a></li>
        </ul>
        <p>For what Claude's own Share menu offers, see <a href="${CLAUDE_SHARING_URL}">Claude's help
          article on sharing artifacts</a>.</p>`,
      },
    ],
    faqs: [
      {
        q: "Do I need to connect rtfx to Claude?",
        a:
          "No. You can publish from the rtfx.pro dashboard in your browser by dropping an HTML file or " +
          "pasting HTML. Connecting rtfx to Claude as an MCP server is optional; it lets Claude publish " +
          "and share for you from the chat.",
      },
      {
        q: "What files can I upload?",
        a:
          "A single .html page, a .pdf document, or a .zip with index.html at its root, up to 50 MB. You " +
          "can also paste a complete HTML page.",
      },
      {
        q: "Do the people I share with need an account?",
        a:
          "They don't need a Claude account. People you add by email sign in with a one-time code sent to " +
          "that address; someone with a share link you created opens it with no sign-in.",
      },
    ],
    finalH: "Publish an HTML file privately, free.",
  },
  public: {
    published: BATCH_2,
    modified: "2026-11-06",
    h1: "Are Claude artifacts public?",
    lead:
      "Not by default. Claude's help article says artifacts start private to you, and nothing is shared " +
      "until you share it. One becomes visible to others when you choose “Anyone with the link”, " +
      "invite people, share it in your organization, publish a legacy chat artifact, or share a Claude " +
      "Code artifact publicly. Most “Anyone with the link” artifacts then open for whoever has the " +
      "link, without signing in.",
    sections: [
      {
        heading: "What each sharing choice lets in",
        html: `<ul>
          <li><b>Only you</b> (Pro, Max, Ultra) or <b>Only people invited</b> (Team, Enterprise) — private.</li>
          <li><b>Anyone with the link</b> — anyone who has the link, and for most artifacts without signing in
            (docs need sign-in; link-only visitors can't use Claude-powered parts or comments). On Team and
            Enterprise plans an Owner has to turn on external sharing first.</li>
          <li><b>Invited by email</b> — only the invited address, signed in to Claude, with Can view, Commenter
            or Can edit access. Up to 50 people outside your organization per artifact.</li>
          <li><b>Anyone at your organization</b> (Team, Enterprise) — people signed in to your organization.</li>
          <li><b>A published legacy chat artifact</b> — anyone with the link, no Claude account needed. It can
            also be embedded on websites you allow.</li>
          <li><b>A Claude Code artifact shared publicly</b> — anyone on the internet, no sign-in, according to
            <a href="${CLAUDE_CODE_ARTIFACTS_URL}">Claude Code's docs</a>.</li>
        </ul>
        <p>Source: <a href="${CLAUDE_SHARING_URL}">Claude's help article on sharing artifacts</a>, checked 2026-11-06.</p>`,
      },
      {
        heading: "Check before you share",
        html: `<ul>
          <li><b>Chat attachments.</b> On Team and Enterprise, sharing an artifact made in a chat with
            Share &amp; copy link also gives viewers access to the attachments and files in that chat.</li>
          <li><b>Shared storage.</b> Some artifacts save information that everyone who opens them can see,
            such as items in a shared tracker.</li>
          <li><b>Invitees stay.</b> On Pro, Max and Ultra, switching back to “Only you” leaves people
            you invited by email with their access. <a href="${ANSWER_META.stopSharing.path}">How to remove them &rarr;</a></li>
          <li><b>Search engines.</b> Claude's help article doesn't say whether shared artifacts can be indexed.</li>
        </ul>`,
      },
      {
        heading: "Keeping it private on rtfx.pro",
        html: `<ul>
          <li>Every artifact is private when it is published: only you, and members of its workspace if it
            belongs to a team. A signed-in person without access sees the same “not found” page as for
            an artifact that doesn't exist.</li>
          <li>Artifact pages are kept out of search engines: excluded in robots.txt, and every artifact
            response tells search engines not to index it.</li>
          <li>You choose who opens it: named people, everyone in your workspace, or named share links that
            can expire and be revoked — and the view log shows who did.</li>
        </ul>`,
      },
    ],
    faqs: [
      {
        q: "Are Claude artifacts public by default?",
        a:
          "No. Claude's help article says artifacts start private to you, and nothing is shared until " +
          "you share it.",
      },
      {
        q: "If I choose “Anyone with the link”, can anyone open it?",
        a:
          "Yes — anyone who has the link, including people outside your organization. Claude's help " +
          "article says most such artifacts open without a Claude account or sign-in; docs need sign-in, " +
          "and link-only visitors can't use the parts that use Claude or connected apps.",
      },
      {
        q: "Can Google index a Claude artifact?",
        a:
          "Claude's help article doesn't say. A published legacy chat artifact opens for anyone with the " +
          "link, so treat it as public. rtfx.pro artifacts are excluded in robots.txt, tell search " +
          "engines not to index them, and open only for people you gave access to.",
      },
    ],
    finalH: "Keep it private when you share it.",
  },
  expiry: {
    published: BATCH_2,
    modified: BATCH_2,
    h1: "Can a shared Claude artifact link expire?",
    lead:
      "Claude's help article doesn't describe links that expire on their own. It says pending email " +
      "invitations expire after 30 days, accepted ones don't, and you stop sharing by changing who has " +
      "access. On rtfx.pro, each share link can be set to expire after 1 to 365 days, extended later, " +
      "or revoked at any time.",
    sections: [
      {
        heading: "What expires in Claude's own sharing",
        html: `<ul>
          <li><b>Pending invitations</b> expire after 30 days. Accepted invitations don't expire.</li>
          <li><b>“Anyone with the link”</b> stays on until you change who has access. On Team and
            Enterprise, an Owner turning off external sharing stops those links until it's turned back on.</li>
          <li><b>Legacy published artifacts</b> stay public until you unpublish them — and an unpublished
            artifact can't be published again.</li>
        </ul>
        <p>Source: <a href="${CLAUDE_SHARING_URL}">Claude's help article on sharing artifacts</a>, checked 2026-11-03.</p>`,
      },
      {
        heading: "Expiring links on rtfx.pro",
        html: `<ul>
          <li><b>Set it when you create the link</b> on the artifact's Share page: 1 to 365 days, or no expiry.</li>
          <li><b>Extend it</b> whenever you like. The new expiry counts from today.</li>
          <li><b>Revoke one link</b> without touching the others or the people you shared with by name.</li>
          <li><b>See attempts.</b> Someone trying an expired or revoked link shows up in the view log.</li>
        </ul>
        <p>Access you give people by email doesn't expire; remove a person when they should no longer see it.</p>`,
      },
    ],
    faqs: [
      {
        q: "Do Claude artifact links expire?",
        a:
          "Claude's help article doesn't describe expiring links. Pending email invitations expire after " +
          "30 days; accepted invitations and “Anyone with the link” sharing stay until you change them.",
      },
      {
        q: "Can I change an rtfx.pro link's expiry later?",
        a:
          "Yes. Extend it from the artifact's Share page (the new expiry counts from today), or revoke " +
          "the link to stop it immediately.",
      },
      {
        q: "Does an expired link delete the artifact?",
        a:
          "No. Only that link stops working. The artifact, its other share links and the people you " +
          "shared it with by name are unaffected.",
      },
    ],
    finalH: "Share a link that expires.",
  },
  people: {
    published: BATCH_2,
    modified: BATCH_2,
    h1: "How to share a Claude artifact with specific people",
    lead:
      "In Claude, open the artifact, click Share and invite people by email (Pro, Max, Ultra, Team and " +
      "Enterprise; on Team and Enterprise, inviting people outside your organization is an Owner " +
      "setting); each person needs a Claude account with that address. With the rtfx.pro MCP server, " +
      "ask Claude to share the artifact with their email addresses: they sign in with a one-time code, " +
      "need no Claude account, and you can see who opened it.",
    sections: [
      {
        heading: "With Claude's Share menu",
        html: `<ul>
          <li>Open the artifact and click <b>Share</b>. Type the person's email address and pick the
            Invite option.</li>
          <li>Choose <b>Can view</b>, <b>Commenter</b> or <b>Can edit</b>, then <b>Invite</b>.</li>
          <li>They need a Claude account with that address, and Claude doesn't tell you whether they have one.</li>
          <li>Up to 50 people outside your organization per artifact. If the artifact is also shared with
            “Anyone with the link”, invitees get the same access as the link.</li>
          <li>Some artifacts can't be shared by invitation, such as Claude Docs documents and artifacts that
            connect to other websites. Sharing settings can't be changed in the iOS or Android apps.</li>
        </ul>
        <p>Source: <a href="${CLAUDE_SHARING_URL}">Claude's help article on sharing artifacts</a>, checked 2026-11-03.</p>`,
      },
      {
        heading: "With rtfx.pro",
        html: `<ul>
          <li><b>Ask Claude.</b> <q>Share q3-report with dana@acme.com and lee@acme.com.</q> The list you give
            is the full list: anyone you had added who is left out loses access. Members of the artifact's
            workspace always keep theirs — on a personal workspace, that's just you.</li>
          <li><b>Send them the link.</b> Sharing doesn't email anyone. They sign in with a one-time code sent
            to their address — no Claude account, no password.</li>
          <li><b>Viewers or editors.</b> Viewers can open it. Editors can also publish new versions and roll
            back — they need their own rtfx account for that, since an email code alone is enough to view,
            not to edit — but can't change sharing, manage links, see the view log or delete it.</li>
          <li><b>Or your whole workspace.</b> Share with everyone in the workspace instead of a list.</li>
          <li><b>See who opened it</b> in the view log, or ask Claude.</li>
        </ul>
        <p>Someone you didn't add who opens the link can ask you for access, and you get an email.</p>`,
      },
    ],
    faqs: [
      {
        q: "Do the people I invite need a Claude account?",
        a:
          "With Claude's email invitations, yes: they sign in to Claude with the invited address. With " +
          "rtfx.pro, no: they sign in with a one-time code sent to their email.",
      },
      {
        q: "Can I let someone edit it?",
        a:
          "In Claude, give them Can edit access. On rtfx.pro, add them as an editor: with their own rtfx " +
          "account they can publish new versions and roll back, but can't change who has access or delete it.",
      },
      {
        q: "How do I remove one person?",
        a:
          "In Claude, open their access level in the Share menu and choose Remove. On rtfx.pro, ask Claude " +
          "to share the artifact with the list minus that person. A member of the artifact's workspace " +
          "keeps access until they leave the workspace.",
      },
    ],
    finalH: "Share with exactly the people you choose.",
  },
  stopSharing: {
    published: BATCH_2,
    modified: BATCH_2,
    h1: "How to stop sharing a Claude artifact",
    lead:
      "Open the artifact, click Share, and under Who has access choose “Only you” (Pro, Max, " +
      "Ultra) or “Only people invited” (Team, Enterprise). To remove one person, open their access " +
      "level and choose Remove. On Pro, Max and Ultra, people you invited by email keep their access " +
      "after you switch to “Only you”, so remove them one by one.",
    sections: [
      {
        heading: "In Claude",
        html: `<ul>
          <li><b>Stop link sharing</b> in the Share menu, as above. Do it on the web or in Claude Desktop:
            the iOS and Android apps can't change sharing settings.</li>
          <li><b>Remove an invitee</b> from their access level. Removing someone takes away their access right away.</li>
          <li><b>Delete the artifact</b> and everyone you invited loses access.</li>
          <li><b>Legacy published artifact:</b> click Unpublish. You can't publish it again afterwards, and its
            stored data is deleted. On Team and Enterprise, a legacy chat artifact is unshared from
            Share &rarr; Unshare.</li>
        </ul>
        <p>Source: <a href="${CLAUDE_SHARING_URL}">Claude's help article on sharing artifacts</a>, checked 2026-11-03.</p>`,
      },
      {
        heading: "On rtfx.pro",
        html: `<ul>
          <li><b>Remove a person:</b> ask Claude to share the artifact with the list minus that person. An
            empty list removes everyone you had added.</li>
          <li><b>Revoke a share link</b> on the artifact's Share page. Only that link stops working.</li>
          <li><b>Workspace members</b> can always open what's in their workspace. To keep something to named
            people only, publish it to your personal workspace, where that's just you.</li>
          <li><b>Delete it:</b> ask Claude to delete the artifact. Every version, the link and its share links
            go, permanently.</li>
        </ul>
        <p>Updating doesn't need unsharing: publish again to the same name and the same link shows the new
          version, so you never have to send a fresh link.</p>`,
      },
    ],
    faqs: [
      {
        q: "If I switch a Claude artifact back to “Only you”, do invited people lose access?",
        a:
          "On Team and Enterprise, people invited from outside your organization lose access. On Pro, Max " +
          "and Ultra they keep it, so remove each one from the Share menu.",
      },
      {
        q: "Can I republish a Claude artifact after unpublishing it?",
        a:
          "No. Claude's help article says you can't publish an artifact again after you unpublish it; " +
          "you'd need to create a new one.",
      },
      {
        q: "Can I revoke access without deleting the artifact?",
        a:
          "Yes, in both. On rtfx.pro you can remove one person or revoke one share link and keep the " +
          "artifact, its versions and everyone else's access.",
      },
    ],
    finalH: "Stay in control after you share.",
  },
  claudeCode: {
    published: BATCH_2,
    modified: BATCH_2,
    h1: "How to share a Claude Code page privately",
    lead:
      "Claude Code can publish a page as an artifact on claude.ai. Its docs describe two ways to share " +
      "one: within your organization on Team and Enterprise plans, or as a public link anyone can open. " +
      "To share with chosen people outside your organization, or from a session that can't publish " +
      "artifacts, add the rtfx.pro MCP server and ask Claude Code to publish to a private link.",
    sections: [
      {
        heading: "What Claude Code artifacts offer",
        html: `<ul>
          <li>A new artifact is private to you. On Team and Enterprise you can share it with specific people
            in your organization or with everyone in it.</li>
          <li>A public link opens for anyone on the internet without signing in. On Team and Enterprise an
            Owner has to enable public sharing.</li>
          <li>Each publish is a version, and the Share control chooses which version viewers see.</li>
          <li>An artifact is one self-contained page; relative links don't resolve.</li>
          <li>Sessions using an API key, a gateway token or a cloud-provider credential can't publish
            artifacts, and they are off by default with <code>-p</code> and the Agent SDK.</li>
        </ul>
        <p>Source: <a href="${CLAUDE_CODE_ARTIFACTS_URL}">Claude Code's artifacts documentation</a>, checked 2026-11-03.</p>`,
      },
      {
        heading: "Publish from Claude Code to a private link",
        html: `<ul>
          <li><b>Add rtfx once:</b> <code>claude mcp add --transport http rtfx ${MCP_URL}</code>, then sign in
            with the code we email you.</li>
          <li><b>Ask:</b> <q>Publish this report with rtfx as a private link.</q> Then <q>Share it with
            dana@acme.com.</q> Dana signs in with an email code; she needs no Claude account.</li>
          <li><b>Whole sites:</b> the rtfx Claude Code plugin publishes a built folder or a zip from disk —
            <code>/plugin marketplace add yogevgab/artifacts-server</code>, then
            <code>/plugin install rtfx@rtfx</code>.</li>
          <li><b>Same link, new versions:</b> publish again to the same name; roll back from chat.</li>
        </ul>
        <p>rtfx is an MCP server with its own sign-in, so it works however Claude Code itself is signed in.</p>`,
      },
    ],
    faqs: [
      {
        q: "Can I share a Claude Code artifact with someone outside my organization?",
        a:
          "Claude Code's docs describe a public link for that, which anyone who has it can open. They don't " +
          "describe inviting one specific outside person. With rtfx.pro you share by email address, and " +
          "that person signs in with a one-time code.",
      },
      {
        q: "Can I publish a multi-page site from Claude Code?",
        a:
          "A Claude Code artifact is one self-contained page. With the rtfx Claude Code plugin you can " +
          "publish a built folder (index.html at its root) or a zip, served at one private link.",
      },
      {
        q: "Does rtfx work when Claude Code uses an API key?",
        a:
          "Yes. rtfx is an MCP server with its own sign-in (an email code, or an API token for clients " +
          "without OAuth), so it doesn't depend on how Claude Code is authenticated.",
      },
    ],
    finalH: "Publish from Claude Code to a private link.",
  },
};

export function topicPage(env: Env, key: keyof typeof TOPICS): string {
  const t = TOPICS[key];
  const meta = ANSWER_META[key];
  const sections = t.sections
    .map((s, i) => `<section class="topic" aria-labelledby="t${i}-h"><h2 class="sec" id="t${i}-h">${esc(s.heading)}</h2>${s.html}</section>`)
    .join("\n    ");
  const main = `
    ${sections}

    <section id="faq" aria-labelledby="faq-h">
      <h2 class="sec" id="faq-h">Questions</h2>
      <div class="faq-list">
        ${t.faqs.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("\n        ")}
      </div>
    </section>

    <p class="related">Set it up: <a href="${ANSWER_META.share.path}">how to share a Claude artifact privately</a>,
      or compare <a href="${ANSWER_META.compare.path}">Claude's own sharing with a private link</a>.</p>

    ${moreAnswers(meta.path)}

    <section class="final">
      <h2>${esc(t.finalH)}</h2>
      <div class="cta">
        <a class="link-button" href="/signup" data-cta="signup-final">Start free</a>
        <a class="ghost link-button" href="/guide" data-cta="guide">See the guide</a>
      </div>
    </section>`;
  const dates = { published: t.published ?? PUBLISHED, modified: t.modified ?? MODIFIED };
  return layout(
    meta.title,
    wrapPage(esc(t.h1), t.lead, main, dates.modified),
    STYLE,
    head(env, meta, t.h1, [faqPage(env, meta.path, t.faqs)], dates)
  );
}

/** Every answer page, hub order: the two how-to pages first, then each topic. */
function answerIndex(): { path: string; h1: string; summary: string }[] {
  return [
    { path: ANSWER_META.share.path, h1: SHARE_H1, summary: ANSWER_META.share.description },
    { path: ANSWER_META.compare.path, h1: COMPARE_H1, summary: ANSWER_META.compare.description },
    ...TOPIC_KEYS.map((k) => ({ path: ANSWER_META[k].path, h1: TOPICS[k].h1, summary: ANSWER_META[k].description })),
  ];
}

/**
 * Links to the other answer pages, so every page is one click from every other
 * and from the hub — the cluster is what tells a search engine the site covers
 * the topic, not any single page.
 */
function moreAnswers(current: string): string {
  const items = answerIndex()
    .filter((a) => a.path !== current)
    .map((a) => `<li><a href="${a.path}">${esc(a.h1)}</a></li>`)
    .join("");
  return `<nav class="more-answers" aria-labelledby="more-h">
      <h2 class="sec" id="more-h">More answers</h2>
      <ul>${items}</ul>
      <p><a href="${ANSWER_META.answers.path}">All answers &rarr;</a></p>
    </nav>`;
}

/** `/answers`: the hub listing every answer page. */
export function answersHubPage(env: Env): string {
  const meta = ANSWER_META.answers;
  const list = answerIndex();
  const main = `
    <section aria-labelledby="list-h">
      <h2 class="sec" id="list-h">Questions about sharing Claude artifacts</h2>
      <ul class="hub">
        ${list.map((a) => `<li><a href="${a.path}"><b>${esc(a.h1)}</b></a><p>${esc(a.summary)}</p></li>`).join("\n        ")}
      </ul>
    </section>

    <section class="final">
      <h2>Share your next artifact privately.</h2>
      <div class="cta">
        <a class="link-button" href="/signup" data-cta="signup-final">Start free</a>
        <a class="ghost link-button" href="/guide" data-cta="guide">See the guide</a>
      </div>
    </section>`;
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${canonicalUrl(env, meta.path)}#list`,
    itemListElement: list.map((a, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: a.h1,
      url: canonicalUrl(env, a.path),
    })),
  };
  const lead =
    "Each answer says what Claude's own sharing does, quoting Anthropic's help article or Claude Code's " +
    "docs, and where it says nothing we say so. Then it shows how an rtfx.pro private link handles the same question.";
  return layout(
    meta.title,
    wrapPage("Answers about sharing Claude artifacts", lead, main, BATCH_2),
    STYLE,
    {
      description: meta.description,
      canonical: canonicalUrl(env, meta.path),
      image: canonicalUrl(env, "/og.png"),
      socialTitle: meta.title,
      jsonLd: [itemList, breadcrumb(env, meta.path, "Answers")],
    }
  );
}

// --- structured data ----------------------------------------------------------

function organization(env: Env): Record<string, unknown> {
  return {
    "@type": "Organization",
    name: SITE.name,
    url: canonicalUrl(env, "/"),
    logo: { "@type": "ImageObject", url: canonicalUrl(env, "/logo.png"), width: 512, height: 512 },
  };
}

interface PageDates {
  published: string;
  modified: string;
}

function article(env: Env, path: string, headline: string, description: string, dates: PageDates): Record<string, unknown> {
  const url = canonicalUrl(env, path);
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    "@id": `${url}#article`,
    headline,
    description,
    inLanguage: "en",
    datePublished: dates.published,
    dateModified: dates.modified,
    image: [canonicalUrl(env, "/og.png")],
    mainEntityOfPage: url,
    author: organization(env),
    publisher: organization(env),
  };
}

function breadcrumb(env: Env, path: string, name: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: SITE.name, item: canonicalUrl(env, "/") },
      { "@type": "ListItem", position: 2, name, item: canonicalUrl(env, path) },
    ],
  };
}

/** FAQPage built from the SAME array the visible FAQ renders from. */
function faqPage(env: Env, path: string, faqs: readonly Faq[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${canonicalUrl(env, path)}#faq`,
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

// --- rendering ----------------------------------------------------------------

const STYLE = `${PUBLIC_CHROME_STYLE}${CONSENT_STYLE}
.wrap{max-width:47.5rem}
.hero{padding:3.2rem 0 1rem}
.hero h1{font-size:clamp(2rem,5.6vw,3.2rem);line-height:1.04;letter-spacing:-.055em;font-weight:760;margin:0 0 1rem;text-wrap:balance}
.hero p.lead{font-size:clamp(1.02rem,2vw,1.18rem);color:var(--fg);margin:0 0 1.2rem;letter-spacing:-.01em}
.hero p.meta{margin:0;color:var(--faint);font-size:.88rem}
h2.sec{font-size:clamp(1.4rem,3.2vw,1.8rem);letter-spacing:-.045em;line-height:1.1;margin:3rem 0 1.2rem}
ol.steps{list-style:none;margin:0;padding:0;display:grid;gap:2.2rem}
ol.steps li{margin:0;min-width:0}
.step-head{display:flex;gap:.8rem;align-items:flex-start;margin:0 0 .7rem}
.step-n{flex:none;width:1.9rem;height:1.9rem;border-radius:50%;background:var(--accent-weak);border:1px solid var(--border-strong);color:var(--fg);font-weight:700;font-size:.9rem;display:inline-flex;align-items:center;justify-content:center;margin-top:.05rem}
.step-head h3{margin:0 0 .3rem;font-size:1.1rem;letter-spacing:-.02em}
.step-head p{margin:0 0 .4rem;color:var(--muted);font-size:1.02rem}
.step-head p b{color:var(--fg);font-weight:600}
.step-head code{font-family:var(--mono);font-size:.88em;overflow-wrap:anywhere;color:var(--fg)}
.step-body{min-width:0}
.more{font-size:.92rem}
figure{margin:.4rem 0 0}
figure img{display:block;width:100%;height:auto;border:1px solid var(--border-strong);border-radius:var(--radius-sm);box-shadow:var(--shadow);background:var(--card)}
.faq-list{display:grid;gap:.6rem}
.faq-list details{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:.15rem 1rem}
.faq-list summary{cursor:pointer;font-weight:600;letter-spacing:-.01em;padding:.75rem 0;min-height:44px;display:flex;align-items:center;gap:.75rem;list-style:none}
.faq-list summary::-webkit-details-marker{display:none}
.faq-list summary::after{content:"+";margin-left:auto;flex:none;font-weight:500;font-size:1.2rem;color:var(--muted)}
.faq-list details[open]>summary::after{content:"\\2212"}
.faq-list details p{margin:0 0 .9rem;color:var(--muted)}
table.cmp{width:100%;border-collapse:collapse;font-size:.96rem}
table.cmp th,table.cmp td{text-align:left;vertical-align:top;padding:.8rem .8rem;border-bottom:1px solid var(--border);overflow-wrap:anywhere}
table.cmp thead th{font-size:.82rem;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);font-weight:600}
table.cmp tbody th{font-weight:600;width:22%;color:var(--fg)}
table.cmp td{color:var(--muted)}
.note{color:var(--faint);font-size:.9rem;margin:.9rem 0 0}
.when{display:grid;gap:1rem;grid-template-columns:1fr 1fr}
.when>div{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:1rem 1.1rem;min-width:0}
.when h3{margin:0 0 .5rem;font-size:1.05rem;letter-spacing:-.02em}
.when ul{margin:0;padding-left:1.1rem;color:var(--muted)}
.when li{margin:.3rem 0}
.final{text-align:center;margin:3.6rem 0 1rem}
.final h2{font-size:clamp(1.4rem,3.2vw,1.8rem);letter-spacing:-.045em;margin:0 0 1rem}
.final .cta{display:flex;gap:.7rem;justify-content:center;flex-wrap:wrap}.final .cta a:hover{text-decoration:none}
.related{margin:2.4rem 0 0;color:var(--muted);font-size:.96rem}
.more-answers ul{margin:0 0 .8rem;padding-left:1.15rem;display:grid;gap:.45rem}
.more-answers p{margin:0;font-size:.96rem}
ul.hub{list-style:none;margin:0;padding:0;display:grid;gap:.8rem}
ul.hub li{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:.9rem 1.1rem}
ul.hub li p{margin:.3rem 0 0;color:var(--muted);font-size:.96rem}
section.topic ul{margin:0 0 .9rem;padding-left:1.15rem;color:var(--muted);display:grid;gap:.55rem}
section.topic p{color:var(--muted);margin:0 0 .9rem}
section.topic b,section.topic q{color:var(--fg);font-weight:600}
.cell-label{display:none}
@media(max-width:760px){.hero{padding:2rem 0 .5rem}h2.sec{margin-top:2.4rem}.when{grid-template-columns:1fr}
table.cmp,table.cmp tbody,table.cmp tr,table.cmp th,table.cmp td{display:block;width:auto}
table.cmp thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
table.cmp tbody th{width:auto;border:0;padding:.9rem 0 .2rem}
table.cmp td{border:0;padding:.2rem 0 .3rem}
table.cmp .cell-label{display:block;font-size:.76rem;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);font-weight:600}
table.cmp tr{border-bottom:1px solid var(--border);padding-bottom:.6rem}}
`;

function head(
  env: Env,
  meta: { path: string; title: string; description: string },
  name: string,
  extra: unknown[],
  dates: PageDates = { published: PUBLISHED, modified: MODIFIED }
) {
  return {
    description: meta.description,
    canonical: canonicalUrl(env, meta.path),
    image: canonicalUrl(env, "/og.png"),
    socialTitle: meta.title,
    jsonLd: [article(env, meta.path, meta.title, meta.description, dates), ...extra, breadcrumb(env, meta.path, name)],
  };
}

function wrapPage(h1: string, lead: string, main: string, modified: string = MODIFIED): string {
  return `
    ${siteHeader("answer")}

    <main id="main">
    <section class="hero">
      <h1>${h1}</h1>
      <p class="lead">${esc(lead)}</p>
      <p class="meta">Updated ${modified}</p>
    </section>
    ${main}
    </main>

    ${siteFooter()}
    ${cookieNotice()}
    <script>${CONSENT_SCRIPT}</script>`;
}

function stepItem(n: number, s: AnswerStep): string {
  const img = s.image ? shot(s.image) : undefined;
  const fig = img
    ? `<figure><img src="${imgPath(img.name)}" width="${img.width}" height="${img.height}" alt="${esc(img.alt)}" loading="lazy" decoding="async"></figure>`
    : "";
  return `<li id="step-${n}">
        <div class="step-head"><span class="step-n" aria-hidden="true">${n}</span>
          <div class="step-body"><h3><span class="sr-only">Step ${n}. </span>${esc(s.name)}</h3>
          <p>${s.html}</p>
          <p class="more"><a href="${s.guide.href}">${esc(s.guide.label)} &rarr;</a></p></div></div>
        ${fig}
      </li>`;
}

export function sharePrivatelyPage(env: Env): string {
  const meta = ANSWER_META.share;
  const main = `
    <section aria-labelledby="steps-h">
      <h2 class="sec" id="steps-h">Four steps to a private link</h2>
      <ol class="steps">
      ${SHARE_STEPS.map((s, i) => stepItem(i + 1, s)).join("\n      ")}
      </ol>
    </section>

    <section id="faq" aria-labelledby="faq-h">
      <h2 class="sec" id="faq-h">Questions</h2>
      <div class="faq-list">
        ${SHARE_FAQS.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("\n        ")}
      </div>
    </section>

    <p class="related">Not sure you need this? <a href="${ANSWER_META.compare.path}">Claude artifact sharing vs a private link</a> compares the two. Every screenshot is in the <a href="/guide">full guide</a>.</p>

    ${moreAnswers(meta.path)}

    <section class="final">
      <h2>Make your next artifact private.</h2>
      <div class="cta">
        <a class="link-button" href="/signup" data-cta="signup-final">Start free</a>
        <a class="ghost link-button" href="/guide" data-cta="guide">See the guide</a>
      </div>
    </section>`;
  return layout(
    meta.title,
    wrapPage(SHARE_H1, SHARE_LEAD, main),
    STYLE,
    head(env, meta, "Share a Claude artifact privately", [faqPage(env, meta.path, SHARE_FAQS)])
  );
}

export function comparePage(env: Env): string {
  const meta = ANSWER_META.compare;
  const rows = COMPARE_ROWS.map(
    (r) =>
      `<tr role="row"><th scope="row" role="rowheader">${esc(r.label)}</th>` +
      `<td role="cell"><span class="cell-label" aria-hidden="true">Claude's own sharing</span>${r.claude}</td>` +
      `<td role="cell"><span class="cell-label" aria-hidden="true">rtfx private link</span>${r.rtfx}</td></tr>`
  ).join("\n        ");
  const main = `
    <section aria-labelledby="when-h">
      <h2 class="sec" id="when-h">When to use which</h2>
      <div class="when">
        <div><h3>Claude's own sharing is fine when</h3><ul>${WHEN_CLAUDE.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
        <div><h3>Use a private link when</h3><ul>${WHEN_RTFX.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
      </div>
    </section>

    <section aria-labelledby="cmp-h">
      <h2 class="sec" id="cmp-h">Side by side</h2>
      <table class="cmp" role="table">
        <caption class="sr-only">Claude's own artifact sharing compared with an rtfx private link</caption>
        <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader"><span class="sr-only">Topic</span></th><th scope="col" role="columnheader">Claude's own sharing</th><th scope="col" role="columnheader">rtfx private link</th></tr></thead>
        <tbody role="rowgroup">
        ${rows}
        </tbody>
      </table>
      <p class="note">${esc(COMPARE_NOTE)}</p>
    </section>


    <p class="related">To set it up, follow <a href="${ANSWER_META.share.path}">how to share a Claude artifact privately</a> or the <a href="/guide">screenshot guide</a>.</p>

    ${moreAnswers(meta.path)}

    <section class="final">
      <h2>Try a private link, free.</h2>
      <div class="cta">
        <a class="link-button" href="/signup" data-cta="signup-final">Start free</a>
        <a class="ghost link-button" href="${ANSWER_META.share.path}" data-cta="share-privately">How to share privately</a>
      </div>
    </section>`;
  return layout(
    meta.title,
    wrapPage(COMPARE_H1, COMPARE_LEAD, main),
    STYLE,
    head(env, meta, "Claude artifact sharing vs a private link", [])
  );
}

// --- llms-full.txt ------------------------------------------------------------

/** The two pages as markdown sections, generated from the arrays above. */
export function answerPagesMarkdown(env: Pick<Env, "PUBLIC_BASE_URL">): string[] {
  const origin = siteOrigin(env);
  const abs = (p: string) => canonicalUrl(env, p);
  const md = (html: string) => htmlToMarkdown(html, origin);
  const out: string[] = [];

  out.push(`## ${SHARE_H1} (${abs(ANSWER_META.share.path)})`, "", SHARE_LEAD, "");
  SHARE_STEPS.forEach((s, i) => {
    out.push(`${i + 1}. **${s.name}.** ${md(s.html)} [${s.guide.label}](${abs(s.guide.href)})`);
  });
  out.push("");
  for (const f of SHARE_FAQS) out.push(`### ${f.q}`, "", f.a, "");

  out.push(`## ${COMPARE_H1} (${abs(ANSWER_META.compare.path)})`, "", COMPARE_LEAD, "");
  for (const r of COMPARE_ROWS) {
    out.push(`### ${r.label}`, "", `- Claude's own sharing: ${md(r.claude)}`, `- rtfx private link: ${md(r.rtfx)}`, "");
  }
  out.push(COMPARE_NOTE, "", "### Claude's own sharing is fine when", "");
  for (const x of WHEN_CLAUDE) out.push(`- ${x}`);
  out.push("", "### Use a private link when", "");
  for (const x of WHEN_RTFX) out.push(`- ${x}`);
  out.push("");

  for (const key of TOPIC_KEYS) {
    const t = TOPICS[key];
    out.push(`## ${t.h1} (${abs(ANSWER_META[key].path)})`, "", t.lead, "");
    for (const s of t.sections) out.push(`### ${s.heading}`, "", md(s.html), "");
    for (const f of t.faqs) out.push(`### ${f.q}`, "", f.a, "");
  }
  return out;
}
