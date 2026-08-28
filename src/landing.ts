import { maxSeatsFor } from "./members";
import { layout, siteHeader, siteFooter, PUBLIC_CHROME_STYLE, SOURCE_URL, DXT_URL } from "./pages";
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
 * ours — publishing from inside the agent session, identity-first access with
 * separate revocable share links for accountless recipients, versions, and a workspace with roles — and points at
 * `/docs#why-rtfx` for the full table-stakes-vs-differentiators split.
 *
 * A previous pass rebuilt the *reading order* without touching that stance.
 * Every claim above was true and every one of them was written for somebody who
 * already knew what an artifact, an MCP server and agent-native publishing are
 * — so a consultant who wanted to send a client a private preview met four
 * paragraphs of infrastructure first and left. That pass put the two install
 * cards second, immediately under the hero, which fixed the vocabulary problem
 * and introduced a different one: the page still argued *installation* before it
 * argued *desire*. A reader met a marketplace command and a `.dxt` download
 * before a single sentence about what any of it is worth, which reads as "here
 * is a developer tool to set up" rather than "here is what happens to the work
 * you just made".
 *
 * The current pass moves the install path below the value, and nowhere else.
 * Setup is still one anchor away (`#setup`, linked from the hero and from the
 * final CTA) — the rule is only that nothing on this page asks somebody to
 * install anything before it has told them why they would want to:
 *
 *  1. **Hero** — one plain sentence, then the four beats of the real round trip
 *     in the words a person would use: ask Claude to make it, ask Claude to
 *     publish it, send the link, see who read it.
 *  2. **What you'd send** — six concrete deliverables, none of them a build
 *     output: proposals, reports, client previews, research dashboards,
 *     prototypes, and the update-in-place story.
 *  3. **Inside the session** — the literal sentences you say to Claude and what
 *     each one does. This is the product's actual surface for most people, and
 *     it was previously visible only as a terminal transcript inside an install
 *     card.
 *  4. **Control and evidence** — who can open it, what expires, what you can
 *     see, and what happens when you change it — beside the state panel that
 *     used to sit above the fold arguing for itself.
 *  5. **Setup** — the two ways somebody adds this to the Claude they already
 *     run, as literal steps, now that they have a reason to.
 *  6. **Under the hood** — the connector grid, the pricing table, and the links
 *     into /docs, in that order, for a reader who is still going.
 *
 * Nothing was deleted to achieve it. Every constraint the older copy protected —
 * that the hosted endpoint publishes content and not paths, that there is no
 * password anywhere, that Team and Enterprise are not self-serve — is still on
 * the page.
 *
 * Two shipped mechanics that the page used to leave unsaid are now stated, and
 * both are pinned in test/positioning.test.ts because both are one careless
 * edit away from becoming a false claim:
 *
 *  - **Share links expire and revoke.** `share_links.expires_at` is enforced in
 *    `redeemShareLink` (src/share.ts), created with a 1–365 day expiry through
 *    `POST /api/artifacts/:slug/links` (src/share-routes.ts) and offered as a
 *    preset in the viewer's own share panel (src/shell.ts). That is a real
 *    feature and the page was underclaiming it. It is *not* a password, and no
 *    wording here may drift into implying one.
 *  - **Read receipts.** `recordViewAndMaybeNotify` (src/read-receipts.ts) mails
 *    the owner the first time each named person opens an artifact, on by
 *    default. Named people only — a share-link viewer holds no identity, so the
 *    copy says "each person you named", never "everyone who opens it".
 */

const LANDING_STYLE = `${PUBLIC_CHROME_STYLE}${CONSENT_STYLE}
.wrap{max-width:1180px}
.hero{position:relative;padding:3.8rem 0 2.6rem;text-align:center;overflow:hidden}
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
.hero h1{font-size:clamp(2.45rem,6.2vw,4.9rem);line-height:.98;margin:0 auto 1rem;max-width:19ch;letter-spacing:-.075em;font-weight:780;text-wrap:balance}
.hero p.lead{font-size:clamp(1.08rem,2vw,1.34rem);color:var(--muted);max-width:40rem;margin:0 auto 2rem;letter-spacing:-.015em}
.hero .cta{display:flex;gap:.72rem;justify-content:center;flex-wrap:wrap}.hero .cta a:hover{text-decoration:none}
/* The one place installation is mentioned above the value: a single line of
   text pointing at #setup. Deliberately not a card, not a command and not a
   download — see the file header. */
.setup-hint{color:var(--faint);font-size:.86rem;margin:.55rem auto 0;max-width:32rem}
.quick-add{margin:0 auto 1.4rem;max-width:48rem;display:grid;grid-template-columns:1fr 1fr;gap:.7rem;text-align:left}
.quick-add a,.quick-add div{display:block;border:1px solid var(--border);border-radius:16px;background:rgba(255,255,255,.045);padding:.82rem .95rem;color:var(--muted);font-size:.86rem;line-height:1.42}
.quick-add a:hover{text-decoration:none;border-color:var(--border-strong)}
.quick-add b{display:block;color:var(--fg);font-size:.92rem;margin-bottom:.18rem}
.quick-add code{font-family:var(--mono);font-size:.82em;color:var(--fg)}
.cta-note{color:var(--faint);font-size:.86rem;margin:.8rem auto 0;max-width:32rem}.cta-note b{color:var(--muted);font-weight:600}
#waitlist .note{margin-top:1.1rem}
.badge-row{display:flex;gap:.55rem;justify-content:center;margin-bottom:1.15rem;flex-wrap:wrap}.pill{border:1px solid var(--border);border-radius:999px;padding:.36rem .86rem;font-size:.82rem;color:var(--muted);background:rgba(255,255,255,.05);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
/* The three-step path, in the plainest markup available: a number, a heading and
   one sentence each. What stood here was a terminal transcript beside a state
   panel — accurate, and the first thing a non-developer bounced off, because the
   page opened by asking them to read a shell. The transcript still exists; it
   moved down into the Claude Code install card, where a reader has already
   self-selected into a terminal. */
.steps{margin:2.8rem auto 0;max-width:72rem;display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;text-align:left}
.step{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem 1.3rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.step-num{display:inline-flex;align-items:center;justify-content:center;width:1.6rem;height:1.6rem;border-radius:50%;border:1px solid var(--border-strong);font-size:.8rem;font-weight:650;color:var(--fg);margin-bottom:.7rem}
.step h3{margin:0 0 .35rem;font-size:1.02rem;letter-spacing:-.02em}
.step p{margin:0;color:var(--muted);font-size:.92rem;line-height:1.5}
/* What you actually say in the session. For most people this *is* the product
   surface — they will never open a terminal, and the only interface they have
   is a sentence — so it gets its own band rather than living as a transcript
   inside an install card that a non-developer never reaches. */
.says{display:grid;grid-template-columns:repeat(auto-fit,minmax(248px,1fr));gap:1rem}
.say{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
  padding:1.25rem 1.3rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);
  -webkit-backdrop-filter:var(--blur)}
.say q{display:block;font-size:1.02rem;color:var(--fg);letter-spacing:-.02em;font-weight:620;
  line-height:1.35;margin:0 0 .45rem}
.say p{margin:0;color:var(--muted);font-size:.92rem;line-height:1.5}
/* The two install paths, side by side. They used to sit second on the page,
   directly under the hero — which answered "can I add this to the Claude I
   already use?" quickly and, in doing so, made installation the first thing the
   product asked for. They now open the #setup band, after the reader has a
   reason to want them, and the hero carries one line of text pointing here. */
.installs{margin:0 auto;max-width:62rem;display:grid;grid-template-columns:1fr 1fr;gap:1rem;text-align:left}
.install{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.4rem 1.35rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);display:flex;flex-direction:column;gap:.85rem}
.install h3{margin:0;font-size:1.08rem;letter-spacing:-.02em}
.install ol{margin:0;padding-left:1.2rem;color:var(--muted);font-size:.93rem;line-height:1.55;display:grid;gap:.35rem}
.install ol b{color:var(--fg);font-weight:600}
.install>p{margin:0;color:var(--faint);font-size:.87rem;line-height:1.5}
/* pre-wrap, not overflow-x: the marketplace line is longer than any card width
   worth having, and a clipped command reads as a rendering bug. */
.install pre.code{background:#05070c;border:1px solid var(--border);border-radius:var(--radius-sm);padding:.9rem 1rem;font-family:var(--mono);font-size:.79rem;line-height:1.72;color:#dfe5f0;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.install pre.code b{color:#fff;font-weight:650}
.rt-ok{color:#5ac8fa}
/* What the link is, the moment it exists — real markup rather than a
   screenshot, so it survives light mode, 200% zoom, a narrow screen and a
   screen reader. It sits beside the privacy explanation now instead of above
   the fold: it is the illustration of a claim, not the claim itself. */
.rt-state{list-style:none;margin:0;padding:1.1rem 1.2rem;display:grid;gap:.72rem;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);font-size:.9rem;color:var(--muted)}
.rt-state li{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;line-height:1.45}
.plain{display:grid;grid-template-columns:1.08fr .92fr;gap:1.4rem;align-items:start}
.plain p{margin:0 0 .9rem;color:var(--muted);font-size:.96rem;line-height:1.62}
.plain p:last-child{margin-bottom:0}
.plain p b{color:var(--fg);font-weight:650}
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
   are real ones — the hosted MCP setup line is long enough not to fit at any
   card width worth having. Scrolling it clipped the line
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
#waitlist{background:var(--card);border:1px solid var(--border);border-radius:32px;padding:2.3rem;text-align:center;margin:2.6rem 0;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}#waitlist h2{margin:0 0 .45rem;font-size:clamp(1.8rem,4vw,3rem);letter-spacing:-.055em}#waitlist p{color:var(--muted);margin:0 0 1.3rem}
/* Four steps do not fit four abreast much below a laptop, and three-plus-one is
   worse than two-by-two: it reads as a ragged list rather than a sequence. */
@media(max-width:1040px){.steps{grid-template-columns:1fr 1fr}}
@media(max-width:760px){.hero{padding:3rem 0 1.8rem}.quick-add,.steps,.installs{grid-template-columns:1fr;gap:1rem}.steps{margin-top:1.4rem}.plain{grid-template-columns:1fr;gap:1.2rem}section.band{margin:3rem 0}}
`;

/**
 * There is no script on this page beyond the consent notice's own. The waitlist
 * form it used to drive was replaced by self-serve signup, and the handler sat
 * here unreferenced afterwards — dead code that test/accessibility.test.ts
 * explicitly forbids from ever reaching the page again.
 */

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
const TITLE = "Private links for work Claude makes · rtfx.pro";

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
            "Per-artifact access control by identity for named recipients, plus revocable share links for accountless recipients",
            "Agent-native publishing from Claude Code, a native MCP server, Hermes, the CLI or the API",
            "Claude Code plugin with browser OAuth sign-in — no API token to copy or paste",
            "Local MCP server that publishes build output from the machine it runs on",
            "Remote MCP endpoint authorized over OAuth for publishing content supplied in tool calls, listing artifacts, details, statistics, sharing, rollback and deletion",
            "Immutable versions with one-click rollback",
            "Revocable share links with an optional expiry date, for recipients without an account",
            "Read receipts: an email the first time each named recipient opens an artifact",
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
        // The branded workspace address (rtfx.pro/yogev/q3-board-report) is the
        // one feature the paid plans unlock rather than merely widen, so it is
        // named on the card that unlocks it and nowhere else.
        const address = name === "free" ? "" : `<li>Branded workspace address</li>\n      `;
        return `<li>Dedicated URL for every artifact</li>
      ${address}<li>${num(f.limits.maxArtifacts)} artifacts</li>
      <li>${bytes(f.limits.maxStorageBytes)} storage</li>
      <li>${versions}</li>
      <li>${seatsLine(name)}</li>`;
      })()
    : // Enterprise has no row in PLANS to render, and inventing limits for it
      // would be the one hand-typed number in this section. What it lists
      // instead is what the conversation is about — see /enterprise, which is
      // explicit that none of it is built today.
      `<li>Dedicated URL for every artifact</li>
      <li>Branded workspace address</li>
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
      <p class="eyebrow-c">Under the hood</p>
      <h2>Connect Claude once. Publish for the rest of the project.</h2>
      <p>Four ways in, for whichever Claude you work in. The first three are the two cards above
        plus a hosted endpoint that needs no install; the API is there for CI.</p>
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
      <p>Every workspace starts on Free, and Pro is a switch inside Settings. Team and Enterprise
        are set up with a person, because the parts that would make them self-serve aren't built
        yet.</p>
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
      <div class="badge-row"><span class="pill">Claude creates. We share.</span><span class="pill">Private by default</span><span class="pill">No coding needed</span><!-- "Versioned & audited" claimed an audit log this product does not have.
           What exists is a per-artifact view log — who opened it, when, which
           version — which is a real and specific thing, and not the same
           promise. "Audited" is the word a buyer reads as "there is a tamper-
           evident record of every administrative action", and there isn't one. -->
      </div>
      <!-- The h1 used to be "Publish AI-made work without putting it on the open
           web": three abstractions and a negation, in a sentence nobody outside
           this category speaks. The job is concrete — you made a thing, you need
           to send it to somebody, and you don't want the whole internet reading
           it — so the headline says that in words a client or a designer already
           uses. Everything more precise ("artifact", "access-protected",
           "immutable version") still appears further down, where somebody has
           already decided they care. -->
      <h1>Turn Claude's work into a private link you can send.</h1>
      <!-- The lead is the one sentence most visitors will read, so it carries
           the whole round trip rather than only the first half of it: what you
           made, who can open it, and the two things that happen afterwards —
           you can change it in place, and you find out when it was read. Both
           of those are shipped (src/share.ts, src/read-receipts.ts); see the
           file header for why they are stated here and how far. -->
      <p class="lead">You asked Claude for the proposal, the report, the dashboard. Ask it to
        publish, and you get back one secure link only the people you name can open — kept up to
        date as you change it, with an email the first time each named person reads it.</p>
      <div class="cta">
        <a class="link-button" href="/signup" data-cta="signup">Start free</a>
        <a class="ghost link-button" href="/docs" data-cta="docs">See how it works</a>
      </div>
      <p class="cta-note">One email code creates your workspace. No password, no card for Free.
        <b><a href="/login" data-cta="sign-in">Sign in</a></b> if you already have an account.</p>
      <p class="setup-hint">Already know you want it? <a href="#setup" data-cta="jump-setup">Setup
        takes about two minutes &rarr;</a></p>

      <div class="steps">
        <div class="step"><span class="step-num" aria-hidden="true">1</span>
          <h3>Ask Claude to make it</h3>
          <p>A proposal, a board report, a research dashboard, a working prototype — whatever you
            were going to send anyway.</p></div>
        <div class="step"><span class="step-num" aria-hidden="true">2</span>
          <h3>Ask Claude to publish it</h3>
          <p>One sentence, in the same session that made it. Nothing to build, deploy or set
            up.</p></div>
        <div class="step"><span class="step-num" aria-hidden="true">3</span>
          <h3>Send one link</h3>
          <p>Only the people you name can open it. To everyone else the page simply doesn't
            exist.</p></div>
        <div class="step"><span class="step-num" aria-hidden="true">4</span>
          <h3>Watch it land</h3>
          <p>You're told the first time each person opens it — and when you publish a change, the
            link you already sent shows it.</p></div>
      </div>
    </section>

    <section id="features" class="band">
      <div class="band-head">
        <p class="eyebrow-c">What people send with it</p>
        <h2>For the things you'd otherwise email as an attachment.</h2>
        <p>You don't have to be a developer. If Claude can make it, rtfx.pro can put it behind a
          link that belongs to you.</p>
      </div>
      <div class="features">
        <div class="feature"><h3>Send a client a private preview</h3><p>A proposal, a mockup, a
          draft page. One link, opened only by the people on that account — not by whoever it gets
          forwarded to.</p></div>
        <div class="feature"><h3>Share a report or a PDF</h3><p>Board packs, analyses, monthly
          numbers. They live at a real address instead of in an inbox, and you can see who actually
          read them.</p></div>
        <div class="feature"><h3>Hand over a research dashboard</h3><p>The chart-heavy page Claude
          built out of your data. It stays live at its link for the people who need it, instead of
          being a screenshot in a deck.</p></div>
        <div class="feature"><h3>Show an app prototype</h3><p>A one-page site, a working demo, a
          clickable flow. It runs at its link straight away — no hosting account, no deploy, no
          domain to buy.</p></div>
        <div class="feature"><h3>Update it without resending</h3><p>Publish again and the link you
          already sent shows the new version. Nobody needs a new URL, and nothing you shared before
          is lost.</p></div>
        <div class="feature"><h3>Know it was read</h3><p>The first time each person you named opens
          it, you get an email. The rest — when, how often, which version they saw — is on the
          artifact's own page.</p></div>
      </div>

      <!-- The sentences, not the commands. Everything on this page happens
           inside a Claude session for most customers, and until now that was
           only visible as a terminal transcript inside an install card — which
           is exactly the audience that never scrolls into an install card.
           Every line here is a real capability: publish and re-publish are the
           plugin/MCP publish tool, link retrieval is the returned artifact URL,
           and rollback is the rollback tool. Access decisions stay explicit in
           rtfx unless a manage-scoped connector is deliberately enabled. -->
      <div class="connectors" data-landing="in-claude">
        <div class="band-head">
          <p class="eyebrow-c">Inside the session</p>
          <h2>You don't learn a tool. You finish the sentence.</h2>
          <p>Once Claude is connected, publishing, updating and rolling back are things you ask for
            in the same conversation that produced the work.</p>
        </div>
        <div class="says">
          <div class="say"><q>Publish this as a private link.</q>
            <p>Claude puts it on rtfx.pro and hands back the link. It's restricted to you until you
              say otherwise.</p></div>
          <div class="say"><q>Give me the link for Dana.</q>
            <p>Claude hands back the artifact link; you decide access from rtfx so only the right
              person can open it.</p></div>
          <div class="say"><q>Publish the fix to the same link.</q>
            <p>A new version at the address you already sent. The old ones stay, so a bad revision
              is an undo.</p></div>
          <div class="say"><q>Roll it back to version 2.</q>
            <p>The link points at the earlier version again — no re-export, no second URL, no email
              that starts “ignore the last one”.</p></div>
        </div>
      </div>

      <div class="connectors" data-landing="privacy">
        <div class="band-head">
          <p class="eyebrow-c">Control &amp; evidence</p>
          <h2>A link that stays yours.</h2>
        </div>
        <div class="plain">
          <div>
            <p><b>Who can open it.</b> Every artifact is access-protected from the moment it
              exists. You share it with named people, by identity — they open it with their own
              email sign-in, so there's no password to pass around. Everyone else gets the same 404
              as a page that was never published, so a forwarded link gives nothing away.</p>
            <!-- Share links are a capability URL, and the copy has to stay on the
                 right side of a line: it expires and it revokes, and it is not a
                 password. See the file header. -->
            <p><b>For someone who'll never have an account.</b> Create a share link instead. Whoever
              holds that URL can open this one artifact with no sign-in; you can expire it on a date
              you choose, and revoke it the second the project ends.</p>
            <p><b>What you can see.</b> You're emailed the first time each person you named opens
              it. The view log has the rest: who, when, from which country, and which version they
              were looking at.</p>
            <p><b>What happens when you change it.</b> Publishing again keeps the same link and
              adds a version. The version history stays, so going back is one click.</p>
            <p><b>Where it lives.</b> Your work belongs to a workspace you can add people to, and
              nothing you publish is indexed by a search engine.</p>
          </div>
          <ul class="rt-state">
            <li><span class="badge is-locked">Restricted</span> private until you say otherwise</li>
            <li><span class="badge is-role">Shared with 2</span> named people, by identity</li>
            <li><span class="badge">Share link</span> expires in 30 days · revoke any time</li>
            <li><span class="badge">v4</span> v1–v3 still there · roll back in one click</li>
            <li><span class="badge">Viewed</span> alex@example.com · 2 min ago · v4</li>
          </ul>
        </div>
      </div>

      <!-- Setup, after the value and not before it. The cards themselves are
           unchanged: both are the literal steps from docs/CLAUDE_DESKTOP.md and
           docs/CLAUDE_CODE.md, because a card that paraphrases an install is a
           card a reader cannot follow. -->
      <div id="setup" class="connectors" data-landing="setup">
        <div class="band-head">
          <p class="eyebrow-c">Setup</p>
          <h2>Two clicks, or two commands. Once.</h2>
          <p>Add rtfx to the Claude you already use, sign in the one time, and every session after
            this one can publish.</p>
        </div>
        <div class="quick-add" role="group" aria-label="Add rtfx to Claude">
          <a href="${DXT_URL}" data-cta="hero-dxt"><b>Add to Claude Desktop</b>Download <code>rtfx.dxt</code>, open it, sign in once.</a>
          <div><b>Add to Claude Code</b><code>/plugin install rtfx@rtfx</code> then <code>/rtfx:login</code>.</div>
        </div>
        <div class="installs">
          <div class="install" data-install="claude-desktop">
            <span class="conn-tag">Claude Desktop</span>
            <h3>Add it in a few clicks</h3>
            <ol>
              <li>Download <a href="${DXT_URL}" data-cta="download-dxt"><b>rtfx.dxt</b></a>.</li>
              <li>Open the file — Claude Desktop installs the rtfx connector.</li>
              <li>Connect your account once: a browser sign-in, nothing to paste.</li>
              <li>Ask Claude: <b>“publish this as a private link.”</b></li>
            </ol>
            <p>It runs on your own computer, so Claude can publish a file or folder you point it at.
              <a href="/docs#start">Full Claude Desktop steps &rarr;</a></p>
          </div>
          <div class="install" data-install="claude-code">
            <span class="conn-tag">Claude Code</span>
            <h3>Two commands in the terminal</h3>
            <pre class="code" data-landing="publish"><code><b>/plugin marketplace add yogevgab/artifacts-server</b>
<b>/plugin install rtfx@rtfx</b>

<b>/rtfx:login</b>     browser sign-in — no token to copy
<b>/rtfx:publish</b> ./out client-demo
  <span class="rt-ok">https://rtfx.pro/client-demo/ · v1</span></code></pre>
            <p>After that, <i>publish this</i> is an ordinary sentence in the session.
              <a href="/docs#start">Full Claude Code steps &rarr;</a></p>
          </div>
        </div>
      </div>

      ${connectorSection()}
      <p class="band-more">Going deeper: <a href="/docs#use-cases">who uses it and for what</a> ·
        <a href="/docs#why-rtfx">what agent-native publishing means</a> ·
        <a href="/docs#why">why not a generic static host</a> ·
        <a href="/docs#agents">every way to connect</a> ·
        <a href="/docs#faq">FAQ</a></p>
      ${pricingSection()}
    </section>

    <section id="waitlist">
      <h2>Start free</h2>
      <p>One email code creates your workspace. Upgrade later only if you outgrow the free
        limits.</p>
      <div class="cta">
        <a class="link-button" href="/signup" data-cta="signup-final">Create your workspace</a>
        <a class="ghost link-button" href="/login" data-cta="sign-in">Sign in instead</a>
      </div>
      <p class="note">No password and no card for Free. Paid upgrades happen in Settings once
        you're inside. <a href="#setup" data-cta="final-setup">Setup takes about two minutes</a>,
        and the <a href="/privacy">privacy policy</a> has the data model.</p>
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
