import { layout, siteHeader, siteFooter, PUBLIC_CHROME_STYLE, esc } from "./pages";
import { cookieNotice, CONSENT_STYLE, CONSENT_SCRIPT } from "./consent";
import { GUIDE_IMAGES } from "./guide-images";
import { GUIDE_PARTS } from "./guide";
import type { Env } from "./env";
import { SITE, MCP_URL, ANSWER_META, canonicalUrl, siteOrigin } from "./seo";
import { htmlToMarkdown } from "./html-text";
import type { Faq } from "./home-content";
import { priceLabel } from "./plan-copy";

/**
 * Two short "answer" pages for the searches people actually type:
 *
 *  - `/share-claude-artifacts-privately`: how to share a Claude artifact privately.
 *  - `/claude-publish-vs-private-link`: Claude's built-in Publish vs an rtfx private link.
 *
 * All copy is data in this file. The pages, their JSON-LD (Article, FAQPage,
 * BreadcrumbList) and the matching sections of `/llms-full.txt`
 * (`answerPagesMarkdown`) read the same arrays, so none of them can drift.
 *
 * Claims about Claude's own Publish are limited to what Anthropic's support
 * article states: public to anyone with the link on Free, Pro and Max; inside
 * the organization on Team and Enterprise (viewers must be logged in to it);
 * unpublishing deletes the artifact and it cannot be republished at the same link.
 * Do not add more without a source.
 */

const PUBLISHED = "2026-10-26";
const CLAUDE_SUPPORT_URL = "https://support.claude.com";

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
  "Claude's own Publish makes an artifact public to anyone with the link on the Free, Pro and Max " +
  "plans; on Team and Enterprise it stays inside your organization. To share with only the people " +
  "you choose, publish to a private link instead: add the rtfx.pro MCP server to Claude once, then " +
  "ask Claude to publish and share from chat.";

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
      `can open it until you share it. Publish again to the same name and the same link shows the new ` +
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
  `There is a Free plan. Pro is ${priceLabel("pro")} and Team is ${priceLabel("team")}, for more ` +
  `artifacts, storage and people. rtfx staff (operators) see metadata only, never artifact content.`;

const SHARE_FAQS: readonly Faq[] = [
  {
    q: "Can anyone with the link open an artifact I publish with Claude?",
    a:
      "On the Free, Pro and Max plans, yes: Claude's own Publish makes the artifact public to " +
      "anyone with the link. On Team and Enterprise, sharing stays inside your organization and " +
      "viewers must be logged in to it.",
  },
  {
    q: "Do the people I share with need an account?",
    a:
      "People you add by email sign in with a one-time code we email them. For someone without an " +
      "account, create a named share link on the artifact's Share page: they open the page with no " +
      "sign-in, and you can set an expiry or revoke the link at any time.",
  },
  {
    q: "What does it cost?",
    a: PRICE_LINE,
  },
];

// --- page 2: Publish vs private link ------------------------------------------

const COMPARE_H1 = "Claude Publish vs a private link";

const COMPARE_LEAD =
  "Claude has a built-in Publish button, and rtfx.pro adds private links to Claude as an MCP " +
  "server. They solve different problems: Publish is for sharing with anyone, a private link is for " +
  "sharing with only the people you choose. Here is how they differ.";

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
      "Free, Pro and Max: anyone with the link. Team and Enterprise: people in your organization.",
    rtfx:
      "Private by default. You, people you add as viewers or editors, everyone in your workspace, " +
      "or anyone holding a named share link you created.",
  },
  {
    label: "Sign-in for viewers",
    claude:
      "Free, Pro and Max: none needed, since it is public. Team and Enterprise: viewers must be " +
      "logged in to your organization.",
    rtfx:
      "People you add sign in with a one-time email code. Someone with a share link needs no " +
      "account and no sign-in.",
  },
  {
    label: "Updating and versions",
    claude: "Unpublishing deletes the artifact, and it can't be republished at the same link.",
    rtfx:
      "Publish again to the same name and the same link shows the new version. Every publish is a " +
      "version, and you can roll back from chat.",
  },
  {
    label: "Expiry and revoking",
    claude: "Unpublishing takes it down, and that deletes it.",
    rtfx:
      "Named share links with an optional expiry that you can extend or revoke. You can also " +
      "delete the artifact, with every version and share link.",
  },
  {
    label: "Cost",
    claude: `Built into Claude; see <a href="${CLAUDE_SUPPORT_URL}" rel="noopener">Claude's support site</a> for plan details.`,
    rtfx: `Free plan. Pro ${priceLabel("pro")}, Team ${priceLabel("team")}. Operators see metadata only, never your content.`,
  },
];

const COMPARE_NOTE =
  "This table only covers what Claude's support documentation states about Publish, so it has no " +
  "row for features we could not confirm. The rtfx view log (who opened it, when, on what device) " +
  "is described in the private-sharing steps.";

const WHEN_CLAUDE: readonly string[] = [
  "Anyone may see it: a demo, a public write-up, something you would post openly.",
  "You do not need to know who opened it or control who can.",
  "You want no setup beyond the Publish button.",
];

const WHEN_RTFX: readonly string[] = [
  "Only chosen people should open it: a client draft, an internal report, a prototype under review.",
  "You want to see who opened it.",
  "You will keep updating it and want the same link to show the latest version, with rollback.",
  "You want a link that expires, or one you can revoke without deleting the work.",
];

// --- structured data ----------------------------------------------------------

function organization(env: Env): Record<string, unknown> {
  return {
    "@type": "Organization",
    name: SITE.name,
    url: canonicalUrl(env, "/"),
    logo: { "@type": "ImageObject", url: canonicalUrl(env, "/logo.png"), width: 512, height: 512 },
  };
}

function article(env: Env, path: string, headline: string, description: string): Record<string, unknown> {
  const url = canonicalUrl(env, path);
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    "@id": `${url}#article`,
    headline,
    description,
    inLanguage: "en",
    datePublished: PUBLISHED,
    dateModified: PUBLISHED,
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
@media(max-width:760px){.hero{padding:2rem 0 .5rem}h2.sec{margin-top:2.4rem}.when{grid-template-columns:1fr}
table.cmp,table.cmp tbody,table.cmp tr,table.cmp th,table.cmp td{display:block;width:auto}
table.cmp thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
table.cmp tbody th{width:auto;border:0;padding:.9rem 0 .2rem}
table.cmp td{border:0;padding:.2rem 0 .3rem}
table.cmp td::before{content:attr(data-label);display:block;font-size:.76rem;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);font-weight:600}
table.cmp tr{border-bottom:1px solid var(--border);padding-bottom:.6rem}}
`;

function head(env: Env, meta: { path: string; title: string; description: string }, name: string, extra: unknown[]) {
  return {
    description: meta.description,
    canonical: canonicalUrl(env, meta.path),
    image: canonicalUrl(env, "/og.png"),
    socialTitle: meta.title,
    jsonLd: [article(env, meta.path, meta.title, meta.description), ...extra, breadcrumb(env, meta.path, name)],
  };
}

function wrapPage(h1: string, lead: string, main: string): string {
  return `
    ${siteHeader("answer")}

    <main id="main">
    <section class="hero">
      <h1>${h1}</h1>
      <p class="lead">${esc(lead)}</p>
      <p class="meta">Updated ${PUBLISHED}</p>
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

    <p class="related">Not sure you need this? <a href="${ANSWER_META.compare.path}">Claude Publish vs a private link</a> compares the two. Every screenshot is in the <a href="/guide">full guide</a>.</p>

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
      `<tr><th scope="row">${esc(r.label)}</th><td data-label="Claude's built-in Publish">${r.claude}</td><td data-label="rtfx private link">${r.rtfx}</td></tr>`
  ).join("\n        ");
  const main = `
    <section aria-labelledby="cmp-h">
      <h2 class="sec" id="cmp-h">Side by side</h2>
      <table class="cmp">
        <caption class="sr-only">Claude's built-in Publish compared with an rtfx private link</caption>
        <thead><tr><th scope="col">&nbsp;</th><th scope="col">Claude's built-in Publish</th><th scope="col">rtfx private link</th></tr></thead>
        <tbody>
        ${rows}
        </tbody>
      </table>
      <p class="note">${esc(COMPARE_NOTE)}</p>
    </section>

    <section aria-labelledby="when-h">
      <h2 class="sec" id="when-h">When to use which</h2>
      <div class="when">
        <div><h3>Claude Publish is fine when</h3><ul>${WHEN_CLAUDE.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
        <div><h3>Use a private link when</h3><ul>${WHEN_RTFX.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
      </div>
    </section>

    <p class="related">To set it up, follow <a href="${ANSWER_META.share.path}">how to share a Claude artifact privately</a> or the <a href="/guide">screenshot guide</a>.</p>

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
    head(env, meta, "Claude Publish vs a private link", [])
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
    out.push(`### ${r.label}`, "", `- Claude's built-in Publish: ${md(r.claude)}`, `- rtfx private link: ${md(r.rtfx)}`, "");
  }
  out.push(COMPARE_NOTE, "", "### Claude Publish is fine when", "");
  for (const x of WHEN_CLAUDE) out.push(`- ${x}`);
  out.push("", "### Use a private link when", "");
  for (const x of WHEN_RTFX) out.push(`- ${x}`);
  out.push("");
  return out;
}
