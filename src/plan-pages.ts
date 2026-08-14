import type { Env } from "./env";
import { esc, layout, siteHeader, siteFooter, PUBLIC_CHROME_STYLE } from "./pages";
import { SITE, canonicalUrl } from "./seo";
import { num, bytes } from "./portal";
import { PLANS } from "./quota";
import { TIER_LABEL, tierCta, tierPrice, type PublicTier } from "./plan-copy";

/**
 * A page per paid tier: `/pro`, `/team`, `/enterprise`.
 *
 * The landing page's pricing grid answers "which one?" in four cards. These
 * answer the question a card has no room for — *what is actually true about
 * this tier today* — and they are the destination a "Talk to us" button needs
 * in order not to be a dead end.
 *
 * Three rules, and every sentence on these pages is downstream of them:
 *
 *  1. **Numbers come from `PLANS`, never from prose.** Same
 *     rule the pricing grid already follows (src/landing.ts): a marketing page
 *     that hand-types "50 GB" is a page that will still say 50 GB the day the
 *     limit changes.
 *  2. **The CTA is whatever `tierCta` says it is** — self-serve or a
 *     conversation — because that table is derived from what the product can
 *     actually complete without a human. Pro is a checkout; Team is not, and
 *     the page says why rather than hiding it (see `tierCta`'s note: invites
 *     write a row and send no mail).
 *  3. **Enterprise names what is missing, in the markup.** SSO, SCIM and a
 *     contractual SLA are the four words every enterprise page in this category
 *     carries, and we have none of them. They appear here under an explicit
 *     `Not built` flag — the same real-markup flag `/docs#why-rtfx` uses, for
 *     the same reason: a CSS pseudo-element is invisible to the crawlers and
 *     answer engines the disclaimer is written for.
 */

const PLAN_PAGE_STYLE = `${PUBLIC_CHROME_STYLE}
.plan-hero{text-align:center;max-width:46rem;margin:1.4rem auto 2.6rem}
.plan-eyebrow{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);margin:0 0 .7rem}
.plan-hero h1{font-size:clamp(2.2rem,5.4vw,3.7rem);letter-spacing:-.06em;line-height:1.04;margin:0 0 .8rem;text-wrap:balance}
.plan-hero .lead{color:var(--muted);font-size:clamp(1.02rem,1.8vw,1.2rem);margin:0 auto 1.5rem;max-width:38rem}
.plan-price{font-size:1.9rem;font-weight:700;letter-spacing:-.03em;margin:0 0 1.4rem}
.plan-price .per{font-size:.95rem;font-weight:500;color:var(--muted);letter-spacing:-.01em}
.plan-cta{display:flex;gap:.72rem;justify-content:center;flex-wrap:wrap}
.plan-cta a:hover{text-decoration:none}
.plan-cta-note{color:var(--faint);font-size:.88rem;margin:1rem auto 0;max-width:34rem;line-height:1.55}
.plan-section{max-width:52rem;margin:0 auto 2.8rem}
.plan-section h2{font-size:clamp(1.4rem,3vw,1.9rem);letter-spacing:-.04em;margin:0 0 .5rem}
.plan-section > p{color:var(--muted);margin:0 0 1.1rem}
.plan-list{display:grid;gap:.7rem;margin:0;padding:0;list-style:none}
.plan-list li{border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card);
  padding:.85rem 1rem;margin:0;color:var(--muted);box-shadow:var(--shadow);
  backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.plan-list li b{color:var(--fg);font-weight:650;letter-spacing:-.015em}
/* Same real-markup flag as /docs#why-rtfx — never a CSS pseudo-element, or the
   one word that keeps this page honest exists only in the stylesheet. */
.plan-flag{display:inline-block;margin-left:.55rem;border:1px solid var(--border);border-radius:999px;
  padding:.12rem .55rem;font-size:.7rem;font-weight:600;letter-spacing:.04em;color:var(--faint);
  text-transform:uppercase;white-space:nowrap;vertical-align:.05em}
.plan-callout{border:1px solid var(--border-strong);border-radius:var(--radius);padding:1.3rem 1.4rem;
  background:var(--card);box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.plan-callout h2{margin-top:0}
.plan-callout p:last-child{margin-bottom:0}
.plan-foot{max-width:52rem;margin:0 auto;text-align:center;color:var(--muted);font-size:.93rem}
.plan-foot a{white-space:nowrap}
`;

/** One `<li>` of a plan page's fact list. `flag` marks a thing that does not exist. */
interface PlanFact {
  title: string;
  detail: string;
  flag?: string;
}

function factList(facts: readonly PlanFact[], marker: string): string {
  const items = facts
    .map(
      (f) =>
        `<li><b>${f.title}</b>${
          f.flag ? ` <span class="plan-flag">${esc(f.flag)}</span>` : ""
        } ${f.detail}</li>`
    )
    .join("\n        ");
  return `<ul class="plan-list" data-plan-facts="${esc(marker)}">
        ${items}
      </ul>`;
}

/** The tier's own call to action, rendered from `tierCta` rather than from copy. */
function ctaBlock(tier: PublicTier, secondary: { href: string; label: string }): string {
  const cta = tierCta(tier);
  return `<div class="plan-cta">
        <a class="link-button" href="${esc(cta.href)}" data-cta="${esc(tier)}-primary"
          data-cta-kind="${esc(cta.kind)}">${esc(cta.label)}</a>
        <a class="ghost link-button" href="${esc(secondary.href)}"
          data-cta="${esc(tier)}-secondary">${esc(secondary.label)}</a>
      </div>`;
}

interface PlanPageInput {
  tier: PublicTier;
  eyebrow: string;
  heading: string;
  lead: string;
  priceNote: string;
  secondary: { href: string; label: string };
  ctaNote: string;
  sections: string;
}

function planPage(env: Env, page: PlanPageInput, title: string, description: string): string {
  const body = `
    ${siteHeader(page.tier as "pro" | "team" | "enterprise")}

    <main id="main" data-plan-page="${esc(page.tier)}">
    <div class="plan-hero">
      <p class="plan-eyebrow">${esc(page.eyebrow)}</p>
      <h1>${esc(page.heading)}</h1>
      <p class="lead">${page.lead}</p>
      <p class="plan-price" data-plan-price>${esc(tierPrice(page.tier))}<span class="per">${
        page.priceNote ? ` ${esc(page.priceNote)}` : ""
      }</span></p>
      ${ctaBlock(page.tier, page.secondary)}
      <p class="plan-cta-note">${page.ctaNote}</p>
    </div>

    ${page.sections}

    <p class="plan-foot">Compare every tier on the <a href="/#pricing">pricing table</a> ·
      <a href="/docs">how publishing works</a> ·
      <a href="/docs#why-rtfx">what is and isn't built</a></p>
    </main>

    ${siteFooter()}`;
  return layout(title, body, PLAN_PAGE_STYLE, {
    description,
    canonical: canonicalUrl(env, `/${page.tier}`),
    image: canonicalUrl(env, "/og.png"),
    socialTitle: `${TIER_LABEL[page.tier]} — ${SITE.name}`,
  });
}

// --- /pro --------------------------------------------------------------------

const PRO_FACTS: readonly PlanFact[] = [
  {
    title: `${num(PLANS.pro.maxArtifacts)} artifacts, ${bytes(PLANS.pro.maxStorageBytes)} of storage.`,
    detail:
      "Per workspace, not per person, and enforced at publish time — you are told which limit " +
      "you hit and what the next plan up allows, rather than finding out from a failed upload.",
  },
  {
    title: "Full version history.",
    detail:
      `Free keeps the last ${PLANS.free.keepVersions} versions of each artifact because storage ` +
      "counts every one of them. Pro keeps all of them, and every version keeps its own URL, so " +
      "rolling back never breaks a link you already sent.",
  },
  {
    title: `Up to ${PLANS.pro.maxSeats} people in the workspace.`,
    detail:
      "Enough for you and a couple of collaborators. Each carries a role — owner, admin, member " +
      "or viewer — and a viewer can open what the workspace owns without being able to change it.",
  },
  {
    title: "Everything the product does, unchanged.",
    detail:
      "Publishing from Claude Code, the MCP server, Hermes, the CLI and the API; access by named " +
      "identity; the view log; share links with an expiry. None of that is gated behind a plan — " +
      "Pro raises limits, it does not unlock features.",
  },
];

const PRO_NOT_INCLUDED: readonly PlanFact[] = [
  {
    title: "Single sign-on, SCIM or a contractual SLA.",
    flag: "Not built",
    detail:
      "No plan has these today. If they are what you need, they are the conversation " +
      `<a href="/enterprise">Enterprise</a> exists for.`,
  },
  {
    title: "Custom domains for artifacts.",
    flag: "Not built",
    detail: "Artifacts are served from the shared content origin on every plan.",
  },
  {
    title: "Usage-based pricing.",
    flag: "Not built",
    detail: "Plans are flat monthly tiers. Going over a limit blocks the publish; it never bills you.",
  },
];

export function proPage(env: Env): string {
  const sections = `<section class="plan-section" data-plan-section="included">
      <h2>What Pro is</h2>
      <p>The same product as Free with the limits lifted, priced so one person or a small team can
        keep publishing without thinking about it.</p>
      ${factList(PRO_FACTS, "included")}
    </section>

    <section class="plan-section" data-plan-section="how">
      <h2>How you get it</h2>
      <p>Self-serve, start to finish, with nobody in the loop.</p>
      <ol class="plan-list" data-plan-facts="how">
        <li><b>Create a workspace.</b> <a href="/signup">Sign up</a> with one emailed code. No
          password, no card, no review — every workspace starts on Free.</li>
        <li><b>Upgrade from Settings.</b> The Pro upgrade link inside your workspace goes to a
          hosted checkout; the plan changes as soon as it completes.</li>
        <li><b>Nothing you published changes.</b> Upgrading never alters who can see or open an
          existing artifact — it only raises what you may publish next.</li>
      </ol>
    </section>

    <section class="plan-section" data-plan-section="not-included">
      <h2>What Pro does not add</h2>
      <p>Worth saying out loud, because every other plan page in this category implies otherwise.</p>
      ${factList(PRO_NOT_INCLUDED, "not-included")}
    </section>`;

  return planPage(
    env,
    {
      tier: "pro",
      eyebrow: "Pro",
      heading: "Pro — the same product, without the ceiling",
      lead:
        `${num(PLANS.pro.maxArtifacts)} artifacts, ${bytes(PLANS.pro.maxStorageBytes)} of storage and ` +
        "every version kept, for one person or a handful. Start free and upgrade from Settings when " +
        "you outgrow the free limits.",
      priceNote: "per workspace",
      secondary: { href: "/signup", label: "Start free" },
      ctaNote:
        "Pro is self-serve: create the workspace first, then upgrade from Settings. Checkout needs " +
        "an account to attach the subscription to, which is why the button starts you free.",
      sections,
    },
    `Pro — ${bytes(PLANS.pro.maxStorageBytes)} and full version history · ${SITE.name}`,
    `rtfx.pro Pro: ${num(PLANS.pro.maxArtifacts)} artifacts, ${bytes(PLANS.pro.maxStorageBytes)} storage, ` +
      `full version history and up to ${PLANS.pro.maxSeats} people. Start free, upgrade from Settings.`
  );
}

// --- /team -------------------------------------------------------------------

const TEAM_FACTS: readonly PlanFact[] = [
  {
    title: `Up to ${PLANS.team.maxSeats} people in one workspace.`,
    detail:
      "Everyone carries a role — owner, admin, member or viewer. A member publishes and manages; " +
      "a viewer opens what the workspace owns and can change none of it. Artifacts belong to the " +
      "workspace, not to whichever person happened to publish them.",
  },
  {
    title: `${num(PLANS.team.maxArtifacts)} artifacts, ${bytes(PLANS.team.maxStorageBytes)} of storage.`,
    detail: "Per workspace, shared across everybody in it, with full version history on every artifact.",
  },
  {
    title: "Access still by identity, never by a secret link.",
    detail:
      "Set an artifact to the people you name, or to everyone in your workspace. Anybody else " +
      "gets the same 404 as a page that was never published.",
  },
  {
    title: "One view log for the whole workspace.",
    detail: "Who opened which artifact, when, and which version they saw — not a hit counter.",
  },
];

export function teamPage(env: Env): string {
  const sections = `<section class="plan-section" data-plan-section="included">
      <h2>What Team is</h2>
      <p>One workspace several people work inside, with roles that mean something and artifacts that
        outlive whoever published them.</p>
      ${factList(TEAM_FACTS, "included")}
    </section>

    <section class="plan-section" data-plan-section="why-contact">
      <div class="plan-callout" data-plan-callout="team-honesty">
        <h2>Why this is "talk to us" and not a checkout button</h2>
        <p>The Team plan itself is real and enforced — the limits above are the ones the product
          applies. What is not finished is the part that would let you set it up entirely alone:
          <b>inviting somebody adds them to the workspace but does not email them</b>. They get
          access the next time they sign in, and nothing tells them to.</p>
        <p>A checkout button here would sell you a plan whose first action strands four colleagues
          waiting for a message that never arrives. So until invite mail ships, we set Team
          workspaces up together — usually the same day — and you are not paying for a queue.</p>
      </div>
    </section>

    <section class="plan-section" data-plan-section="meanwhile">
      <h2>In the meantime</h2>
      <p>Nothing about Team is a prerequisite for starting.</p>
      <ul class="plan-list" data-plan-facts="meanwhile">
        <li><b>Start free today.</b> <a href="/signup">Create a workspace</a> and publish. Moving it
          onto Team later changes nothing about what you have already published or shared.</li>
        <li><b>Or start on <a href="/pro">Pro</a>.</b> Self-serve, and it already covers
          ${PLANS.pro.maxSeats} people — enough for a lot of what gets called a team.</li>
      </ul>
    </section>`;

  return planPage(
    env,
    {
      tier: "team",
      eyebrow: "Team",
      heading: `Team — one workspace, up to ${PLANS.team.maxSeats} people`,
      lead:
        `${num(PLANS.team.maxArtifacts)} artifacts and ${bytes(PLANS.team.maxStorageBytes)} shared ` +
        "across a workspace with real roles. Set up with a person, because the invite email that " +
        "would make it self-serve is not built yet.",
      priceNote: "per workspace",
      secondary: { href: "/signup", label: "Start free instead" },
      ctaNote:
        "Tell us how many people and what you publish, and we will set the workspace up with you. " +
        "A person answers by email — there is no queue and no automatic reply.",
      sections,
    },
    `Team — a shared workspace for up to ${PLANS.team.maxSeats} people · ${SITE.name}`,
    `rtfx.pro Team: ${bytes(PLANS.team.maxStorageBytes)} and up to ${PLANS.team.maxSeats} people in one ` +
      "workspace with owner, admin, member and viewer roles. Set up with us — talk to us."
  );
}

// --- /enterprise -------------------------------------------------------------

/**
 * The list this page exists to be honest about. Every item carries a `Not built`
 * flag in the markup — not because the page is apologising, but because
 * "Enterprise" is the one word that gives a reader (and an answer engine)
 * licence to assume SSO and SCIM without being told. Nothing here is a promise,
 * a roadmap date, or a "coming soon": it is a list of things worth talking about
 * that the product cannot do today.
 */
const ENTERPRISE_ASKS: readonly PlanFact[] = [
  {
    title: "Single sign-on (SAML or OIDC).",
    flag: "Not built",
    detail:
      "Sign-in today is a passwordless one-time code or magic link to an email address, for " +
      "everybody. There is no identity-provider integration in the product.",
  },
  {
    title: "SCIM or directory-driven provisioning.",
    flag: "Not built",
    detail:
      "Workspace membership is managed by hand in the dashboard. Nothing syncs from a directory, " +
      "and there is no automatic deprovisioning when somebody leaves yours.",
  },
  {
    title: "A contractual uptime SLA.",
    flag: "Not built",
    detail:
      "The terms offer no availability commitment. If you need one in writing, that is a contract " +
      "to negotiate, not a checkbox to tick.",
  },
  {
    title: "A negotiated DPA, security review or data residency.",
    flag: "Not built",
    detail:
      "The published <a href=\"/privacy\">privacy policy</a> is what exists today. Anything beyond " +
      "it — your paper, your reviewer's questionnaire, a region commitment — is a conversation.",
  },
  {
    title: "Invoicing, purchase orders or annual terms.",
    flag: "Not built",
    detail: "Billing is a card on a hosted monthly checkout. Anything else has to be arranged.",
  },
];

const ENTERPRISE_TODAY: readonly PlanFact[] = [
  {
    title: "The whole product, source-available and MIT-licensed.",
    detail:
      "Read the implementation and the threat model before you talk to anybody — that is the " +
      "strongest thing a small vendor can offer a security reviewer, and it costs you nothing.",
  },
  {
    title: "Self-hosting on your own Cloudflare account.",
    detail:
      "The repository deploys as a Worker with your own D1 and R2. Some of what people mean by " +
      "\"enterprise\" — our data on our infrastructure — you can simply have, today, without us.",
  },
  {
    title: "Workspaces, roles and a per-artifact access list.",
    detail:
      "Owner, admin, member and viewer inside a workspace; access to each artifact by named " +
      "identity. Unauthorized and non-existent answer the same 404.",
  },
  {
    title: "Immutable versions and a per-artifact view log.",
    detail:
      "Every re-publish is a new version with its own URL, rollback is one click, and the log " +
      "names who opened what, when and which version.",
  },
];

export function enterprisePage(env: Env): string {
  const sections = `<section class="plan-section" data-plan-section="asks">
      <h2>Talk to us about</h2>
      <p>Every item below is flagged for a reason: <b>none of it exists in the product today</b>.
        This page is here so you find that out in one minute rather than three meetings.</p>
      ${factList(ENTERPRISE_ASKS, "asks")}
    </section>

    <section class="plan-section" data-plan-section="today">
      <h2>What you can have today</h2>
      <p>Some of what "enterprise" usually means is already here, and some of it you can take
        without asking.</p>
      ${factList(ENTERPRISE_TODAY, "today")}
    </section>

    <section class="plan-section" data-plan-section="how">
      <div class="plan-callout" data-plan-callout="enterprise-honesty">
        <h2>How the conversation goes</h2>
        <p>Tell us what you actually need and roughly how many people. If the product already does
          it, we will say so and point you at <a href="/#pricing">a plan you can buy yourself</a>.
          If it does not, we will tell you that too rather than sell you a roadmap — and if it is
          something we were going to build anyway, knowing you need it moves it up.</p>
        <p>A person answers by email. There is no sales sequence and no automatic reply.</p>
      </div>
    </section>`;

  return planPage(
    env,
    {
      tier: "enterprise",
      eyebrow: "Enterprise",
      heading: "Enterprise — talk to us",
      lead:
        "There is no Enterprise plan to buy, and no list of features waiting behind a form. There " +
        "is a product that does a specific thing well, published limits you can read, and a person " +
        "who will tell you honestly whether it fits.",
      priceNote: "",
      secondary: { href: "/#pricing", label: "See the plans that exist" },
      ctaNote:
        "Nothing on this page is sold today. Say what you need and we will tell you whether the " +
        "product does it, could do it, or does not.",
      sections,
    },
    `Enterprise — talk to us · ${SITE.name}`,
    "rtfx.pro for larger organisations: what exists today (workspaces, roles, view logs, " +
      "MIT-licensed self-hosting) and what does not (SSO, SCIM, contractual SLAs). Talk to us."
  );
}
