import { maxSeatsFor } from "./members";
import { layout, siteHeader, siteFooter, PUBLIC_CHROME_STYLE, SOURCE_URL } from "./pages";
import { cookieNotice, CONSENT_STYLE, CONSENT_SCRIPT } from "./consent";
import type { Env } from "./env";
import { SITE, canonicalUrl } from "./seo";
import { num, bytes } from "./portal";
import type { PlanName } from "./quota";
import {
  PUBLIC_TIERS,
  TIER_LABEL,
  isPlanName,
  planFeatures,
  tierCta,
  tierPath,
  tierPrice,
  type PublicTier,
} from "./plan-copy";

/**
 * The public product page (issue #29, simplified in issue #35).
 *
 * This is the only page most people will ever see, and it is served to everyone
 * — no Access application in front of it, no identity read, same bytes for a
 * crawler and a customer. Three things follow from that:
 *
 *  - **It reads like a shipped product, not a preview.** Signup is self-serve,
 *    every workspace starts free, and the page says so without a waitlist-shaped
 *    detour.
 *  - **It carries the site's metadata.** Canonical URL, OpenGraph/Twitter card
 *    and structured data all live here (see `src/seo.ts`), because this page is
 *    what gets linked, shared and quoted by an answer engine.
 *  - **It says one thing.** Issue #35: the page had grown to seven stacked
 *    sections, each arguing a slightly different case. The long-form material —
 *    use cases and the comparison against generic static hosting — moved to
 *    `/docs`, where somebody who wants the detail goes looking for it. Nothing
 *    was deleted: it is still crawlable, still internally linked, just not all
 *    of it above the fold.
 *
 * Issue #38 sharpened the claims without adding a section. Several tools now
 * host what an AI session produced, so the page leads with the part that is
 * ours — publishing from inside the agent session, access by identity rather
 * than a secret URL, versions, and a workspace with roles — and points at
 * `/docs#why-rtfx` for the full table-stakes-vs-differentiators split.
 */

const LANDING_STYLE = `${PUBLIC_CHROME_STYLE}${CONSENT_STYLE}
.wrap{max-width:1180px}
.hero{position:relative;padding:5.4rem 0 3rem;text-align:center;overflow:hidden}
/* A calm, symmetric wash behind the headline. The 90deg linear gradient this
   replaces ran blue → cyan → transparent across the band, which put all of its
   weight on the left and read as a smudge sitting behind the first word rather
   than as light behind the whole sentence — most visible in light mode. A
   radial ellipse centred on the headline is symmetric by construction, so it
   stays balanced at every viewport width instead of only at the one it was
   eyeballed against. */
.hero:before{content:"";position:absolute;inset:0 0 auto;height:26rem;z-index:-1;
  background:radial-gradient(60% 52% at 50% 34%,rgba(10,132,255,.20),rgba(100,210,255,.09) 45%,transparent 72%)}
/* text-wrap:balance so the two sentences break between themselves rather than
   orphaning "share." on its own line; the ch cap is the fallback for browsers
   that don't have it. */
.hero h1{font-size:clamp(2.9rem,8vw,6rem);line-height:.96;margin:0 auto 1.15rem;max-width:18ch;letter-spacing:-.075em;font-weight:780;text-wrap:balance}
.hero p.lead{font-size:clamp(1.08rem,2vw,1.34rem);color:var(--muted);max-width:40rem;margin:0 auto 2rem;letter-spacing:-.015em}
.hero .cta{display:flex;gap:.72rem;justify-content:center;flex-wrap:wrap}.hero .cta a:hover{text-decoration:none}
.cta-note{color:var(--faint);font-size:.88rem;margin:.95rem auto 0;max-width:32rem}.cta-note b{color:var(--muted);font-weight:600}
#waitlist .note{margin-top:1.1rem}
.badge-row{display:flex;gap:.55rem;justify-content:center;margin-bottom:1.15rem;flex-wrap:wrap}.pill{border:1px solid var(--border);border-radius:999px;padding:.36rem .86rem;font-size:.82rem;color:var(--muted);background:rgba(255,255,255,.05);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
/* The round trip. Two steps side by side: the command that publishes, and the
   state that exists the instant it returns. Left column is deliberately wider —
   a terminal line has a natural length and wrapping it reads as breakage. */
.roundtrip{margin:3.2rem auto 0;max-width:60rem;display:grid;grid-template-columns:1.06fr .94fr;gap:1.15rem;text-align:left}
/* Both steps stretch to the taller of the two, so the transcript and the state
   panel share a baseline instead of ending at two different heights. */
.rt-step{min-width:0;display:flex;flex-direction:column}
.rt-step>pre.code,.rt-step>.rt-state{flex:1}
.rt-label{display:flex;align-items:center;gap:.55rem;margin:0 0 .7rem;font-size:.86rem;color:var(--muted);letter-spacing:-.01em}
.rt-num{flex:none;width:1.45rem;height:1.45rem;border-radius:50%;border:1px solid var(--border-strong);display:inline-flex;align-items:center;justify-content:center;font-size:.76rem;font-weight:650;color:var(--fg)}
/* Same code surface as /docs, so the homepage and the documentation do not
   look like two products (issue #35). */
.roundtrip pre.code{background:#05070c;border:1px solid var(--border);border-radius:var(--radius);padding:1.1rem 1.2rem;overflow-x:auto;font-family:var(--mono);font-size:.83rem;line-height:1.75;color:#dfe5f0;box-shadow:var(--shadow);margin:0}
.roundtrip pre.code b{color:#fff;font-weight:650}
.rt-ok{color:#5ac8fa}
.rt-state{list-style:none;margin:0;padding:1.1rem 1.2rem;display:grid;gap:.72rem;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);font-size:.9rem;color:var(--muted)}
.rt-state li{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;line-height:1.45}
/* Spans both columns: it is the consequence of the whole round trip, not a
   footnote to the right-hand panel, and keeping it inside that column made the
   two panels stretch to different heights. */
.rt-foot{grid-column:1/-1;margin:.2rem 0 0;font-size:.88rem;color:var(--faint);line-height:1.55;text-align:center}
.launch-strip{margin:1.4rem auto 0;max-width:60rem;display:grid;grid-template-columns:repeat(3,1fr);gap:.8rem;text-align:left}
.launch-strip div{background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:18px;padding:.92rem 1rem}
.launch-strip b{display:block;color:var(--fg);font-size:.92rem;letter-spacing:-.01em;margin-bottom:.18rem}
.launch-strip span{display:block;color:var(--muted);font-size:.83rem;line-height:1.45}
section.band{margin:4rem 0}
.band-head{text-align:center;max-width:44rem;margin:0 auto 2rem}
.band-head h2{font-size:clamp(1.9rem,4.2vw,3.1rem);letter-spacing:-.055em;margin:0 0 .6rem;line-height:1.05}
.band-head p{color:var(--muted);margin:0;font-size:1.02rem}
.eyebrow-c{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);margin:0 0 .7rem}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:1rem;margin:0}.feature{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.28rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}.feature h3{margin:0 0 .42rem;font-size:1.04rem;letter-spacing:-.02em}.feature p{margin:0;color:var(--muted);font-size:.92rem}
/* The one place the page points at everything it no longer says out loud. Not a
   footnote: it is the crawlable path to the long-form pages on /docs. */
.band-more{text-align:center;color:var(--muted);font-size:.93rem;margin:1.6rem 0 0}
.band-more a{white-space:nowrap}
/* Pricing tiers (issue: free-to-paid path). Same card surface as .feature —
   this is a variant of the product band, not a second design system — with
   room for a price line and a short, literal list of what the plan actually
   allows. Three equal cards: no tier is marked "recommended", since we have
   no usage data to back a claim like that and the copy rule here is "state a
   fact", not "nudge". */
/* Connectors. The same card surface as .feature and .tier — this is a variant
   of the product band, not a second design system — with room for the literal
   command each connector is installed with. The command is the point: an agent
   surface you cannot see the first line of is indistinguishable from a promise,
   and every line here is copied from docs/CLAUDE_CODE.md and
   docs/REMOTE_MCP_OAUTH.md rather than composed for the page.
   .conn-tag is real markup, never a CSS content: string, for the same
   reason .stance-flag on /docs is (see test/positioning.test.ts): it is what
   tells a reader — and a crawler, and a screen reader — that the remote
   endpoint reports rather than publishes. */
.connectors{margin:3rem 0 0}
.conn-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(266px,1fr));gap:1rem}
.conn{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
  padding:1.35rem 1.3rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);
  -webkit-backdrop-filter:var(--blur);display:flex;flex-direction:column;gap:.72rem}
.conn h3{margin:0;font-size:1.05rem;letter-spacing:-.02em}
.conn p{margin:0;color:var(--muted);font-size:.92rem;line-height:1.55}
/* pre-wrap, not overflow-x. A card is ~230px of content and the commands here
   are real ones — claude mcp add --transport http rtfx https://mcp.rtfx.pro/mcp
   does not fit at any card width worth having. Scrolling it clipped the line
   mid-word with no visible affordance, which reads as a rendering bug rather
   than as "there is more to the right". Wrapping keeps the whole command on the
   page, and overflow-wrap:anywhere is what stops the URL widening the grid. */
.conn pre.code{background:#05070c;border:1px solid var(--border);border-radius:var(--radius-sm);
  padding:.85rem .95rem;font-family:var(--mono);font-size:.78rem;line-height:1.72;
  color:#dfe5f0;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.conn pre.code b{color:#fff;font-weight:650}
.conn-tag{align-self:flex-start;border:1px solid var(--border);border-radius:999px;
  padding:.16rem .62rem;font-size:.7rem;font-weight:600;letter-spacing:.045em;
  text-transform:uppercase;color:var(--faint);white-space:nowrap}
.conn-note{color:var(--faint);font-size:.88rem;margin:1.2rem 0 0;text-align:center}
.pricing{margin:2.6rem 0 0}
.pricing-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:1rem}
.tier{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.4rem 1.3rem;
  box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);
  display:flex;flex-direction:column;gap:.9rem}
.tier h3{margin:0;font-size:1.1rem;letter-spacing:-.02em}
.tier-price{margin:0;font-size:1.7rem;font-weight:700;letter-spacing:-.03em}
.tier-limits{list-style:none;margin:0;padding:0;display:grid;gap:.5rem;font-size:.9rem;color:var(--muted);flex:1}
.tier-limits li{padding-left:1.15rem;position:relative}
.tier-limits li:before{content:"";position:absolute;left:0;top:.5em;width:.5rem;height:.5rem;
  border-radius:50%;background:var(--accent-weak);border:1px solid rgba(10,132,255,.42)}
.tier .link-button{align-self:flex-start}
.tier-more{margin:-.3rem 0 0;font-size:.86rem}
.pricing-note{text-align:center;color:var(--faint);font-size:.88rem;margin:1.2rem 0 0}
#waitlist{background:var(--card);border:1px solid var(--border);border-radius:32px;padding:2.3rem;text-align:center;margin:2.6rem 0;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}#waitlist h2{margin:0 0 .45rem;font-size:clamp(1.8rem,4vw,3rem);letter-spacing:-.055em}#waitlist p{color:var(--muted);margin:0 0 1.3rem}#waitlist form{display:flex;gap:.6rem;justify-content:center;flex-wrap:wrap;max-width:31rem;margin:0 auto}#waitlist input{flex:1;min-width:15rem}#msg{max-width:31rem;margin:.85rem auto 0}
@media(max-width:760px){.hero{padding:3rem 0 1.8rem}.roundtrip,.launch-strip{grid-template-columns:1fr;gap:1.6rem;margin-top:2.4rem}section.band{margin:3rem 0}}
`;

const SCRIPT = `
const $ = (s)=>document.querySelector(s);
const msg = $('#msg');
const btn = $('#wl button[type=submit]');
/* #msg is a polite live region, so this is also what announces the result to a
   screen reader: set the text, unhide, and let the status class carry the
   colour. Colour is never the only signal — the sentence says what happened.

   Three states, not two. 'Sending…' used to be shown with the success class,
   which painted a green box around a request that had not happened yet —
   state as decoration, which docs/DESIGN.md forbids. It gets the neutral
   class now, and only a real answer turns the box green or red. */
function show(text, kind){ msg.textContent=text; msg.hidden=false;
  msg.className = kind === 'ok' ? 'is-ok' : kind === 'error' ? 'is-error' : ''; }
if ($('#wl')) $('#wl').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const email = $('#email').value.trim();
  /* Disabling the button is what stops an impatient double-submit from
     spending the 3-per-hour, per-address budget in src/waitlist.ts and
     turning a successful signup into a rate-limit error. */
  btn.disabled = true;
  show('Sending…', 'pending');
  try {
    const res = await fetch('/waitlist', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email })
    });
    const data = await res.json().catch(()=>({}));
    /* Every failure used to report "Enter a valid email address", including
       the 429. Somebody who submitted twice was told their own address was
       malformed, retyped a correct address, and got the same lie back. Each
       status now says what actually happened and whether retrying can help. */
    /* Two independent buckets answer 429 (src/waitlist.ts): 3 per hour per
       address, and 12 per hour per IP — and the request is rejected before the
       row is written. The per-IP bucket is shared by everyone behind that
       address, so on CGNAT, a mobile carrier or an office network this can fire
       on somebody's very first attempt, for an address that was never recorded.
       So the wording can neither say "you've tried several times" nor promise
       they are on the list: it attributes the limit to the network and makes
       list membership conditional. */
    if (res.status === 429) return show("Too many requests from your network just now — please try again in an hour. If an earlier attempt went through, you're already on the list.", 'error');
    if (res.status === 400 || data.error === 'invalid_email') return show('Enter a valid email address.', 'error');
    if (!res.ok) return show("Something went wrong on our side — please try again in a moment.", 'error');
    /* No confirmation email is sent — src/waitlist.ts records the address and
       nothing else — so this must not imply one is on its way, or the first
       thing a new person experiences is a message that never arrives. */
    show(data.status === 'already' ? "You're already on the list." : "Request recorded. A person reviews these by hand and replies by email — there's no automatic confirmation, so nothing else will arrive just yet.", 'ok');
    e.target.reset();
  } catch (err) {
    show('Network error — please try again.', 'error');
  } finally {
    btn.disabled = false;
  }
});
`;

/**
 * The title used to be "rtfx.pro — private hosting for AI-built pages and
 * artifacts": brand-first, for a brand with no search volume, and built around
 * "AI-built pages and artifacts" — a phrase nobody types. The whole addressable
 * demand here searches for *Claude* ("share claude artifact privately", "host
 * claude artifact", "publish from claude code"), and the word appeared in the
 * h1, the social card, the README and llms.txt — but in neither title tag.
 * Descriptive, nominative use of the name, which is what it has always been on
 * this site.
 */
const TITLE = "Private hosting for Claude artifacts and AI-made deliverables · rtfx.pro";

/** Structured data: what this site is, and what the product is. */
function structuredData(env: Env): unknown[] {
  const url = canonicalUrl(env, "/");
  const organization = {
    "@type": "Organization",
    "@id": `${url}#organization`,
    name: SITE.name,
    url,
    description: SITE.description,
    // A public, MIT-licensed repository is the strongest honest entity signal a
    // new domain has, and it was the one asset the graph never mentioned.
    sameAs: [SOURCE_URL],
    // The square mark, not the social card. `logo` is read as a logo — cropped
    // towards square in a knowledge panel — so the 1200×630 card, nine parts
    // headline copy to one part mark, was the wrong image to promise here.
    logo: canonicalUrl(env, "/logo.png"),
  };
  return [
    {
      "@context": "https://schema.org",
      "@graph": [
        organization,
        {
          "@type": "WebSite",
          "@id": `${url}#website`,
          name: SITE.name,
          url,
          description: SITE.description,
          publisher: { "@id": `${url}#organization` },
          inLanguage: "en",
        },
        {
          "@type": "SoftwareApplication",
          "@id": `${url}#product`,
          name: SITE.name,
          url,
          applicationCategory: "DeveloperApplication",
          applicationSubCategory: "Web hosting",
          operatingSystem: "Web",
          description: SITE.description,
          softwareVersion: "1.0.0",
          codeRepository: SOURCE_URL,
          license: "https://opensource.org/licenses/MIT",
          offers: {
            "@type": "Offer",
            price: "0",
            priceCurrency: "USD",
            availability: "https://schema.org/InStock",
            url: canonicalUrl(env, "/signup"),
          },
          featureList: [
            "Per-artifact access control by identity, not a secret link",
            "Agent-native publishing from Claude Code, a native MCP server, Hermes, the CLI or the API",
            "Claude Code plugin with browser OAuth sign-in — no API token to copy or paste",
            "Local MCP server that publishes build output from the machine it runs on",
            "Remote MCP endpoint authorized over OAuth for publishing content supplied in tool calls, listing artifacts, details, statistics, sharing, rollback and deletion",
            "Immutable versions with one-click rollback",
            "View log: who opened an artifact, when, and which version",
            "Workspaces with owner, admin, member and viewer roles",
            "Passwordless rtfx.pro email sign-in",
          ],
          publisher: { "@id": `${url}#organization` },
        },
      ],
    },
  ];
}

/**
 * One pricing tier, built from the real numbers in `PLANS` (src/quota.ts) via
 * `planFeatures` — never hand-typed, so this can't quietly drift from what
 * quota enforcement (src/api.ts) and Settings (src/admin.ts) actually apply.
 */
/** Seats are what Team actually sells; a pricing table that omits them hides it. */
function seatsLine(name: PlanName): string {
  const seats = maxSeatsFor(name);
  return seats === 1 ? "1 person" : `Up to ${seats} people`;
}

/**
 * The CTA is read from `tierCta` (src/plan-copy.ts) rather than decided here,
 * because that table encodes something this file has no business guessing: what
 * a person can actually finish on their own today. Free and Pro are a real
 * self-serve path — sign up, then a hosted checkout from Settings. Team and
 * Enterprise are not, and the button says so instead of sending somebody into a
 * flow that ends with them waiting on us anyway.
 */
function tierCard(name: PublicTier): string {
  const cta = tierCta(name);
  const detail = isPlanName(name)
    ? (() => {
        const f = planFeatures(name);
        const versions =
          f.limits.keepVersions === null
            ? "Full version history"
            : `Keeps the last ${f.limits.keepVersions} versions of each artifact`;
        return `<li>Dedicated URL for every artifact</li>
      <li>${num(f.limits.maxArtifacts)} artifacts</li>
      <li>${bytes(f.limits.maxStorageBytes)} storage</li>
      <li>${versions}</li>
      <li>${seatsLine(name)}</li>`;
      })()
    : // Enterprise has no row in PLANS to render, and inventing limits for it
      // would be the one hand-typed number in this section. What it lists
      // instead is what the conversation is about — see /enterprise, which is
      // explicit that none of it is built today.
      `<li>Dedicated URL for every artifact</li>
      <li>Everything in Team, plus a conversation</li>
      <li>SSO, SCIM and contractual SLAs — none built yet</li>
      <li>Security review, DPA, invoicing</li>
      <li>Or self-host it: the source is MIT</li>`;
  const link = tierPath(name);
  return `<div class="tier" data-tier="${name}">
    <h3>${TIER_LABEL[name]}</h3>
    <p class="tier-price">${tierPrice(name)}</p>
    <ul class="tier-limits">
      ${detail}
    </ul>
    <a class="ghost link-button" href="${cta.href}" data-cta="pricing-${name}"
      data-cta-kind="${cta.kind}">${cta.label}</a>
    ${link ? `<p class="tier-more"><a href="${link}" data-tier-page="${name}">What ${TIER_LABEL[name]} is &rarr;</a></p>` : ""}
  </div>`;
}

/**
 * One connector card: what it is, the literal first line, and — in a label a
 * reader cannot miss — whether it publishes.
 *
 * That last field is the reason this is a table of data rather than four hand
 * written blocks. The hosted endpoint publishes content bytes supplied inside
 * the MCP call, but never reads a local path from the cloud. Every card
 * therefore carries its `tag`, and the remote card says in prose what it does
 * instead — see docs/REMOTE_MCP_OAUTH.md §1.
 */
interface Connector {
  key: string;
  name: string;
  /** Publishes / Publishes content / Automation — the scannable claim. */
  tag: string;
  /** The real first line, or the tool list. Never a composed example. */
  code: string;
  body: string;
}

const CONNECTORS: readonly Connector[] = [
  {
    key: "claude-code-plugin",
    name: "The Claude Code plugin",
    tag: "Publishes",
    code: `<b>/plugin install rtfx@rtfx</b>
<b>/rtfx:login</b>
<b>/rtfx:publish</b> ./out client-demo`,
    body:
      "One browser sign-in connects the session, and there is no token to copy, paste or leave " +
      "sitting in a shell profile. After that <i>publish this</i> is an ordinary sentence: the " +
      "session picks the build output, versions it under a slug and hands back the link.",
  },
  {
    key: "local-mcp",
    name: "The local MCP server",
    tag: "Publishes",
    code: `tools: <b>publish</b>
       list_artifacts
       get_versions
       rollback · doctor`,
    body:
      "Bundled in the same plugin, so a client with no shell — Claude Desktop, or anything else " +
      "that speaks MCP — publishes as a tool call. It runs beside your files, which is exactly " +
      "why it can send the build output you point it at.",
  },
  {
    key: "remote-mcp",
    name: "Remote MCP, authorized by OAuth",
    tag: "Publishes content",
    code: `<b>claude mcp add --transport http rtfx https://mcp.rtfx.pro/mcp</b>
<b>claude mcp login rtfx</b>

tools: <b>publish</b> · doctor`,
    body:
      "A hosted endpoint your client authorizes in the browser — authorization code with PKCE, " +
      "no bearer token to paste. It publishes content sent inside the tool call — an HTML page, " +
      "a PDF, or a small explicit file list — and runs doctor for connection checks. It never " +
      "reads a filesystem path; larger folders still belong to the plugin and local server above.",
  },
  {
    key: "api-cli-hermes",
    name: "API, CLI and Hermes",
    tag: "Automation",
    code: `POST /api/machine/artifacts
  Authorization: Bearer rtfx_…`,
    body:
      "The advanced paths, for CI and scripted work: a scoped, revocable token against the HTTP " +
      "API, the CLI out of a checkout of the repository, or a Hermes run. Same endpoints and " +
      "same rules as every other route — an agent path here is never a weaker one.",
  },
];

function connectorCard(c: Connector): string {
  return `<div class="conn" data-connector="${c.key}">
      <span class="conn-tag">${c.tag}</span>
      <h3>${c.name}</h3>
      <pre class="code"><code>${c.code}</code></pre>
      <p>${c.body}</p>
    </div>`;
}


/**
 * The connector band. It sits inside the product section rather than becoming a
 * fourth one, because the landing page holds at hero + one band + waitlist
 * (issue #35, pinned in test/positioning.test.ts) — the same way the pricing
 * table is a band-head and a grid inside this section, not a section of its own.
 */
function connectorSection(): string {
  return `<div id="connectors" class="connectors" data-landing="connectors">
    <div class="band-head">
      <p class="eyebrow-c">Connectors</p>
      <h2>Connect Claude once. Publish for the rest of the project.</h2>
      <p>rtfx.pro meets an agent where it already works: a Claude Code plugin you sign into in the
        browser, an MCP server that runs beside your files, a hosted MCP endpoint authorized over
        OAuth, and the HTTP API underneath all three.</p>
    </div>
    <div class="conn-grid">
      ${CONNECTORS.map(connectorCard).join("")}
    </div>
    <p class="conn-note">Publishing happens in two ways: local connectors read files beside the
      client, while the hosted MCP endpoint publishes content bytes sent inside the tool call. It
      never reads a path on the server. <a href="/docs#agents">Every connector, side by side &rarr;</a></p>
  </div>`;
}

function pricingSection(): string {
  return `<div id="pricing" class="pricing">
    <div class="band-head">
      <p class="eyebrow-c">Pricing</p>
      <h2>Free to start. Upgrade only if you outgrow it.</h2>
      <p>Every workspace starts on Free, and Pro is a switch inside it — not a signup step. Team and
        Enterprise are set up with a person, because the parts that would make them self-serve
        aren't built yet, and a checkout button would be lying about that.</p>
    </div>
    <div class="pricing-grid">
      ${PUBLIC_TIERS.map(tierCard).join("")}
    </div>
    <p class="pricing-note">Limits are per workspace, not per person. Storage counts every version
      you've kept, which is why Free keeps your last 5 and the paid plans keep every one.</p>
  </div>`;
}

export function landingPage(env: Env): string {
  const body = `
    ${siteHeader("home")}

    <main id="main">
    <section class="hero">
      <div class="badge-row"><span class="pill">Claude creates. We share.</span><span class="pill">Private by default</span><span class="pill">Agent-native publishing</span><span class="pill">PDFs, pages &amp; dashboards</span><!-- "Versioned & audited" claimed an audit log this product does not have.
           What exists is a per-artifact view log — who opened it, when, which
           version — which is a real and specific thing, and not the same
           promise. "Audited" is the word a buyer reads as "there is a tamper-
           evident record of every administrative action", and there isn't one. -->
      </div>
      <h1>Publish AI-made work without putting it on the open web.</h1>
      <!-- "Artifact" carried the whole page and was never defined on it; the
           definition lived a click away on /docs. It costs four words here. -->
      <p class="lead">rtfx.pro gives Claude Code, Hermes and your browser a secure, professional place to
        ship artifacts: pages, PDFs, reports, dashboards and small static apps. Every link starts
        restricted, every re-publish keeps history, and sharing is a deliberate action — not an
        unlisted URL you hope nobody forwards.</p>
      <div class="cta">
        <a class="link-button" href="/signup" data-cta="signup">Start free</a>
        <a class="ghost link-button" href="/docs" data-cta="docs">See how it works</a>
      </div>
      <p class="cta-note">Create a workspace with one email code. No password, no human review,
        no card for Free. <b><a href="/login" data-cta="sign-in">Sign in</a></b> if you already
        have an account.</p>
      <!-- One round trip, as real content rather than a picture of content.
           What stood here was a rounded window with macOS traffic-light dots
           and grey bars for text — the universal signature of a landing page
           that shipped before its product did, carrying an aria-label that
           asserted specific facts ("version 4, shared with three people")
           about nothing. For a product whose whole posture is "we publish
           what we haven't overclaimed", a fake screenshot was the one element
           on the site that wasn't truthful in kind.
           Rendering it as HTML instead means it survives light mode, 200%
           zoom, a narrow screen and a screen reader — and it does the job the
           page was missing: showing the mechanism, not asserting it. The
           commands are the real ones from docs/CLAUDE_CODE.md. -->
      <div class="roundtrip">
        <div class="rt-step">
          <p class="rt-label"><span class="rt-num">1</span> Publish from the session that built it</p>
          <pre class="code" data-landing="publish"><code>&gt; publish this to rtfx.pro

<b>/rtfx:publish ./out client-demo</b>
  uploaded 6 files · 214 KB
  <span class="rt-ok">https://rtfx.pro/client-demo/  · v4</span></code></pre>
        </div>
        <div class="rt-step">
          <p class="rt-label"><span class="rt-num">2</span> What the link is, the moment it exists</p>
          <ul class="rt-state">
            <li><span class="badge is-locked">Restricted</span> private until you say otherwise</li>
            <li><span class="badge is-role">Shared with 2</span> named people, by identity</li>
            <li><span class="badge">v4</span> v1–v3 still addressable · roll back in one click</li>
            <li><span class="badge">Viewed</span> alex@example.com · 2 min ago · v4</li>
          </ul>
        </div>
        <p class="rt-foot">Everyone else gets the same 404 as a page that was never published —
          the link never admits the artifact exists.</p>
      </div>
      <div class="launch-strip" role="group" aria-label="Launch readiness">
        <div><b>Public product, private content</b><span>The marketing site is crawlable; artifacts and dashboards stay access-controlled.</span></div>
        <div><b>Real plans, honest limits</b><span>Free and Pro are self-serve; Team and Enterprise are conversation-led until invite automation is complete.</span></div>
        <div><b>Built to recover</b><span>Version history, rollback, workspace roles and view logs are part of the workflow from day one.</span></div>
      </div>
    </section>

    <section id="features" class="band">
      <div class="band-head">
        <p class="eyebrow-c">The product</p>
        <!-- The hero h1 explains the job now; this h2 carries the professional
             SaaS positioning for launch-day buyers who need the category quickly. -->
        <h2>A launch-ready publishing layer for work that should not be public.</h2>
        <p>Use it when the output is real enough to send to a client, teammate or stakeholder —
          but too sensitive, provisional or accountable to throw onto a generic static host.</p>
      </div>
      <div class="features">
        <div class="feature"><h3>Private links with an owner</h3><p>Keep an artifact restricted,
          share it with named people, or open it to your workspace. Anyone else gets the same 404
          as a page that never existed.</p></div>
        <div class="feature"><h3>Built for agent workflows</h3><p>Connect Claude Code with one
          browser sign-in — no token to copy — and “publish this” becomes the last step of the
          work. The MCP server, Hermes, the CLI and the API all publish through the same model.</p></div>
        <div class="feature"><h3>Versions you can trust</h3><p>Every re-publish creates a new immutable
          version. The link you already sent keeps working, older versions stay inspectable, and
          rollback is one click.</p></div>
        <div class="feature"><h3>Workspace control, not shared logins</h3><p>See who opened each
          artifact, when, and which version they saw. Artifacts belong to a workspace with roles,
          billing limits and operator safety controls.</p></div>
      </div>
      ${connectorSection()}
      <p class="band-more">Going deeper: <a href="/docs#why-rtfx">table stakes vs what's different</a> ·
        <a href="/docs#use-cases">who uses it and for what</a> ·
        <a href="/docs#why">why not a generic static host</a> ·
        <a href="/docs#agents">publishing from Claude Code or MCP</a> ·
        <a href="/docs#faq">FAQ</a></p>
      ${pricingSection()}
    </section>

    <section id="waitlist">
      <h2>Start free</h2>
      <p>One email code creates your workspace on the Free plan. Upgrade later only if you outgrow
        the limits.</p>
      <div class="cta">
        <a class="link-button" href="/signup" data-cta="signup-final">Create your workspace</a>
        <a class="ghost link-button" href="/login" data-cta="sign-in">Sign in instead</a>
      </div>
      <p class="note">No password and no card for Free. Paid upgrades are handled from Settings once
        you're inside. Read the <a href="/privacy">privacy policy</a> first if you want the data model.</p>
    </section>
    </main>

    ${siteFooter()}
    ${cookieNotice()}
    <script>${CONSENT_SCRIPT}</script>`;
  return layout(TITLE, body, LANDING_STYLE, {
    description: SITE.description,
    canonical: canonicalUrl(env, "/"),
    image: canonicalUrl(env, "/og.png"),
    socialTitle: `${SITE.name} — ${SITE.tagline}`,
    jsonLd: structuredData(env),
  });
}
