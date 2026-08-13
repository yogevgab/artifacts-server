import { layout, esc, siteHeader, siteFooter, PUBLIC_CHROME_STYLE, type HeadMeta } from "./pages";
import { cookieNotice, CONSENT_STYLE, CONSENT_SCRIPT } from "./consent";
import type { Env } from "./env";
import { SITE, canonicalUrl } from "./seo";

/**
 * `/privacy` and `/terms` (issue #36).
 *
 * Two rules govern what is written here, and they matter more than the prose:
 *
 *  1. **Everything on these pages is true of the code in this repository.** The
 *     data inventory below is the D1 schema and the R2 bucket, named table by
 *     table; the cookie table is the cookies that actually reach a browser. A
 *     privacy policy that describes a generic SaaS instead of this one is worse
 *     than no page at all, because it is a promise nobody checked.
 *  2. **They are operator templates, and they say so at the top.** Nothing here
 *     has been through counsel. The banner is not modesty — it is the difference
 *     between a starting point an operator adapts and a document a reader is
 *     entitled to rely on.
 *
 * Both pages are public and crawlable: they are the pages a person reads *before*
 * deciding to sign up, so putting them behind sign-in would defeat them entirely.
 * They must sit outside the Cloudflare Access application — see docs/DEPLOY_RTFX.md.
 */

/** Last substantive edit to either document, shown on both. */
const UPDATED = "13 August 2026";

/**
 * Placeholder contact. An operator forking this must point it at a mailbox that
 * exists — the template banner lists it as a fill-in for exactly that reason.
 */
const CONTACT = "privacy@rtfx.pro";

const LEGAL_STYLE = `${PUBLIC_CHROME_STYLE}${CONSENT_STYLE}
.wrap{max-width:900px}
.legal-hero{padding:2.4rem 0 1.2rem;max-width:44rem}
.legal-hero p.eyebrow{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);margin:0 0 .7rem}
.legal-hero h1{font-size:clamp(2rem,5vw,3.1rem);letter-spacing:-.055em;line-height:1.04;margin:0 0 .9rem}
.legal-hero p.lede{color:var(--muted);font-size:1.05rem;line-height:1.6;margin:0}
.legal-hero .updated{color:var(--faint);font-size:.85rem;margin:1rem 0 0}
.template{border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--card);
  padding:1.15rem 1.25rem;margin:1.8rem 0 0;box-shadow:var(--shadow)}
.template h2{font-size:.95rem;margin:0 0 .4rem;letter-spacing:-.02em}
.template p{margin:0 0 .6rem;color:var(--muted);font-size:.9rem;line-height:1.6}
.template p:last-child{margin-bottom:0}
.toc{display:flex;gap:.5rem;flex-wrap:wrap;margin:1.8rem 0 2.6rem}
.toc a{border:1px solid var(--border);border-radius:999px;padding:.36rem .82rem;font-size:.85rem;color:var(--muted);background:rgba(255,255,255,.04)}
.toc a:hover{border-color:var(--border-strong);color:var(--fg)}
article.legal section{margin:0 0 2.6rem;scroll-margin-top:6rem}
article.legal h2{font-size:clamp(1.35rem,2.8vw,1.85rem);letter-spacing:-.04em;margin:0 0 .7rem;line-height:1.15}
article.legal h3{font-size:1rem;letter-spacing:-.02em;margin:1.5rem 0 .4rem}
article.legal p{color:var(--muted);line-height:1.7;margin:0 0 .85rem}
article.legal ul,article.legal ol{color:var(--muted);line-height:1.7;padding-left:1.1rem;margin:0 0 .85rem}
article.legal li{margin:.35rem 0}
article.legal code{font-family:var(--mono);font-size:.86em;background:rgba(255,255,255,.07);border:1px solid var(--border);border-radius:6px;padding:.08em .38em;color:var(--fg)}
article.legal b{color:var(--fg)}
/* Same escape hatch the docs comparison table uses: a data table has a
   min-content width no phone can honour, so it scrolls inside its own box
   rather than widening the document. */
.table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);box-shadow:var(--shadow);-webkit-overflow-scrolling:touch;margin:0 0 .9rem}
table.data{width:100%;min-width:32rem;border-collapse:collapse}
table.data th,table.data td{text-align:left;padding:.85rem 1.05rem;border-bottom:1px solid var(--border);font-size:.9rem;vertical-align:top}
table.data thead th{font-size:.76rem;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);font-weight:600}
table.data tbody th{font-weight:650;color:var(--fg);white-space:nowrap}
table.data td{color:var(--muted)}
table.data tr:last-child th,table.data tr:last-child td{border-bottom:0}
`;

/** One entry in a page's table of contents — the anchor and its heading agree by construction. */
interface Part {
  id: string;
  heading: string;
  /** The section's body: already-trusted HTML written in this file. */
  html: string;
}

function toc(parts: readonly Part[]): string {
  return `<nav class="toc" aria-label="On this page">${parts
    .map((p) => `<a href="#${esc(p.id)}">${esc(p.heading)}</a>`)
    .join("")}</nav>`;
}

function sections(parts: readonly Part[]): string {
  return parts
    .map((p) => `<section id="${esc(p.id)}"><h2>${esc(p.heading)}</h2>${p.html}</section>`)
    .join("");
}

/**
 * The banner both documents open with. It names what an operator has to decide
 * before either page can be relied on, rather than gesturing vaguely at "consult
 * a lawyer" — the fill-ins are the contact address and the governing law.
 */
function templateNotice(kind: "privacy" | "terms"): string {
  return `<div class="template" data-legal-template role="note">
      <h2>Operator template — not legal advice</h2>
      <p>This ${kind === "privacy" ? "privacy policy" : "terms of use"} describes what the
        rtfx.pro software actually does, and it has <b>not been reviewed by a lawyer</b>. It is a
        starting point for whoever operates this deployment, not a document a reader should treat
        as final or as legal advice.</p>
      <p>Before publishing it, the operator must confirm at least: the contact address
        (<code>${esc(CONTACT)}</code> is a placeholder), the governing law and jurisdiction, the
        legal entity's name and address, and whether their jurisdiction requires anything this
        template does not carry.</p>
    </div>`;
}

function legalPage(
  env: Env,
  o: {
    current: "privacy" | "terms";
    title: string;
    eyebrow: string;
    heading: string;
    lede: string;
    description: string;
    parts: readonly Part[];
  }
): string {
  const path = `/${o.current}`;
  const body = `
    ${siteHeader(o.current)}

    <main id="main">
      <div class="legal-hero">
        <p class="eyebrow">${esc(o.eyebrow)}</p>
        <h1>${esc(o.heading)}</h1>
        <p class="lede">${o.lede}</p>
        <p class="updated">Last updated ${esc(UPDATED)}</p>
      </div>

      ${templateNotice(o.current)}
      ${toc(o.parts)}

      <article class="legal">${sections(o.parts)}</article>
    </main>

    ${siteFooter()}
    ${cookieNotice()}
    <script>${CONSENT_SCRIPT}</script>`;

  const meta: HeadMeta = {
    description: o.description,
    canonical: canonicalUrl(env, path),
    image: canonicalUrl(env, "/og.svg"),
    socialTitle: `${o.heading} · ${SITE.name}`,
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "WebPage",
        "@id": `${canonicalUrl(env, path)}#page`,
        name: o.heading,
        description: o.description,
        url: canonicalUrl(env, path),
        inLanguage: "en",
        dateModified: "2026-08-13",
        isPartOf: { "@id": `${canonicalUrl(env, "/")}#website` },
        publisher: { "@id": `${canonicalUrl(env, "/")}#organization` },
      },
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: SITE.name, item: canonicalUrl(env, "/") },
          { "@type": "ListItem", position: 2, name: o.heading, item: canonicalUrl(env, path) },
        ],
      },
    ],
  };
  return layout(o.title, body, LEGAL_STYLE, meta);
}

// --- /privacy ---------------------------------------------------------------

const PRIVACY_DESCRIPTION =
  "What rtfx.pro stores, why, and who can see it: your email address, the artifacts you " +
  "publish, and the view log their owners see. No analytics, no advertising and no " +
  "third-party tracking — only necessary Cloudflare security/sign-in cookies and first-party notice storage.";

const PRIVACY_PARTS: readonly Part[] = [
  {
    id: "summary",
    heading: "The short version",
    html: `<ul>
      <li>We identify you by <b>email address</b>, because that is what Cloudflare Access signs
        you in with. There is no password to store, and we never see one.</li>
      <li>We store <b>what you publish</b> — your files, their versions, and the access list you
        set — because hosting them is the product.</li>
      <li>We record <b>who opened each artifact</b>, and show that log to the artifact's owner.
        This is a feature of the product, and it applies to you when you open somebody else's
        artifact too.</li>
      <li>There is <b>no analytics, no advertising and no third-party tracking</b> on this site.
        Nothing you publish or view is sold, shared with advertisers, or used to profile you.</li>
    </ul>`,
  },
  {
    id: "who",
    heading: "Who is responsible",
    html: `<p>rtfx.pro is operated by the person or organisation running this deployment, who is
      the data controller for everything described below. Questions, requests and complaints go
      to <code>${esc(CONTACT)}</code>.</p>
    <p>If you reached an artifact through a link somebody sent you, they are the one who decided
      to share it with you and who sees that you opened it. We host it on their behalf.</p>`,
  },
  {
    id: "collect",
    heading: "What we collect",
    html: `<p>Everything in this table is stored in this deployment's own database or object
      storage. There is no data collection on this site beyond it.</p>
    <div class="table-wrap"><table class="data">
      <thead><tr><th scope="col">What</th><th scope="col">Where it comes from</th><th scope="col">Why</th></tr></thead>
      <tbody>
        <tr><th scope="row">Email address</th>
          <td>Cloudflare Access, when you sign in with a one-time code.</td>
          <td>It is your identity here: it decides what you can open and what you own.</td></tr>
        <tr><th scope="row">Account record</th>
          <td>Created on first sign-in; an admin may add a display name or note.</td>
          <td>Role, status (invited, active, paused) and workspace membership.</td></tr>
        <tr><th scope="row">Artifacts you publish</th>
          <td>You, through the dashboard, the CLI, the API or an agent.</td>
          <td>The files, plus their title, slug, size, versions and version notes. This is the
            thing being hosted.</td></tr>
        <tr><th scope="row">Access lists</th>
          <td>You, when you share an artifact.</td>
          <td>The email addresses you granted access to, per artifact.</td></tr>
        <tr><th scope="row">View log</th>
          <td>Recorded when a signed-in person opens an artifact page.</td>
          <td>Viewer's email, artifact and version, path, timestamp, referring page, and the
            approximate country Cloudflare reports. Shown to the artifact's owner.</td></tr>
        <tr><th scope="row">API tokens</th>
          <td>You, when you mint one.</td>
          <td>Name, scopes, owner, created/last-used timestamps. The token itself is stored only
            as a hash — we cannot show it to you again after it is created.</td></tr>
        <tr><th scope="row">Access requests</th>
          <td>The "Request access" form on the landing page.</td>
          <td>Your email address and when you submitted it, so we can send an invitation.</td></tr>
        <tr><th scope="row">Infrastructure logs</th>
          <td>Cloudflare, as the network and platform serving every request.</td>
          <td>Standard request logging and abuse prevention, under Cloudflare's own terms.</td></tr>
      </tbody>
    </table></div>
    <h3>What we do not collect</h3>
    <ul>
      <li>No passwords — sign-in is passwordless, so none exist.</li>
      <li>No payment details. There is no billing in this deployment.</li>
      <li>No analytics, advertising, fingerprinting or session-replay of any kind.</li>
      <li>The product code does not inspect your artifacts' contents for analytics, advertising
        or profiling. Operators with infrastructure access may still be able to access stored
        files when required to operate, secure or troubleshoot the service.</li>
    </ul>`,
  },
  {
    id: "cookies",
    heading: "Cookies and local storage",
    html: `<p>Three things can be stored in your browser by this site, and none of them are for
      tracking. There is no consent banner asking you to accept optional cookies because there
      are no optional cookies to accept.</p>
    <div class="table-wrap"><table class="data">
      <thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">What it is for</th></tr></thead>
      <tbody>
        <tr><th scope="row"><code>CF_Authorization</code></th>
          <td>Cookie · strictly necessary</td>
          <td>Set by Cloudflare Access when you sign in, and the reason you stay signed in. Without
            it there is no way to be authenticated, so it cannot be declined while using the
            dashboard. Cleared by signing out at <code>/cdn-cgi/access/logout</code>.</td></tr>
        <tr><th scope="row"><code>__cf_bm</code> and similar</th>
          <td>Cookie · strictly necessary</td>
          <td>Cloudflare's own bot-management and security cookies, set by the network in front of
            this service to tell automated abuse from real traffic. They are not used for
            advertising or cross-site tracking.</td></tr>
        <tr><th scope="row"><code>rtfx.cookie-notice</code></th>
          <td>Local storage · strictly necessary</td>
          <td>Remembers that you dismissed the cookie notice, so it does not reappear on every
            page. Stored locally in your browser and never sent to our server. Clearing your
            browser storage brings the notice back.</td></tr>
      </tbody>
    </table></div>
    <p>If optional cookies are ever introduced — analytics, for example — this page will say so
      before they run, and the notice will become a real choice with a real "no". Until then,
      nothing non-essential loads on this site, whether you dismiss the notice or ignore it.</p>`,
  },
  {
    id: "why",
    heading: "Why we are allowed to process it",
    html: `<p>For readers in the UK/EEA, where a lawful basis has to be named:</p>
    <ul>
      <li><b>Performance of a contract.</b> Your email address, account record, artifacts and
        access lists — we cannot host access-controlled pages for you without them.</li>
      <li><b>Legitimate interests.</b> The view log (an artifact's owner needs to know who opened
        what they shared), API token metadata, and security/abuse prevention. We keep these to
        the minimum that serves the purpose.</li>
      <li><b>Consent.</b> The access-request form: you gave us your address so we would contact
        you, and you can ask us to delete it at any time.</li>
    </ul>`,
  },
  {
    id: "sharing",
    heading: "Who can see what",
    html: `<ul>
      <li><b>An artifact's owner</b> sees its view log, including the email address of every
        signed-in person who opened it. If you open something shared with you, the person who
        shared it can see that you did.</li>
      <li><b>People you grant access to</b> see that artifact and nothing else. A grant never
        reveals your other artifacts and never confers any management rights.</li>
      <li><b>Administrators of this deployment</b> can see the people directory and administer
        artifacts. This is an operator role, not a role other members hold.</li>
      <li><b>Nobody else.</b> We do not sell personal data, we do not share it with advertisers,
        and we do not use it to train anything.</li>
    </ul>
    <h3>Processors</h3>
    <p>Cloudflare provides the whole platform: the network, the Workers runtime, Cloudflare Access
      (identity and the one-time-code emails), the D1 database and the R2 object storage holding
      your files. Data is processed on Cloudflare's global network, which means it may be handled
      outside your own country under Cloudflare's data-processing terms. We disclose data to
      anyone else only where the law requires it.</p>`,
  },
  {
    id: "retention",
    heading: "How long we keep it",
    html: `<ul>
      <li><b>Artifacts and their versions</b> — until you delete them. Deleting an artifact
        deletes its versions, its files and its access list.</li>
      <li><b>View log entries</b> — kept with the artifact, and deleted with it.</li>
      <li><b>Your account record</b> — for as long as you have access. Pausing an account keeps
        it; deletion removes it.</li>
      <li><b>API tokens</b> — until revoked or expired.</li>
      <li><b>Access requests</b> — stored as a waitlist record until the operator acts on it or
        removes it manually.</li>
    </ul>`,
  },
  {
    id: "rights",
    heading: "Your rights",
    html: `<p>You can ask for a copy of what we hold about you, ask us to correct it, ask us to
      delete it, or object to a particular use. Much of it you can do yourself: you can delete an
      artifact, revoke a token, or change who an artifact is shared with, from the dashboard.</p>
    <p>For anything else, write to <code>${esc(CONTACT)}</code>. Note that we cannot delete the
      view-log entries showing that you opened somebody else's artifact without also removing the
      record they rely on; we will explain what applies when you ask. If you are in the UK/EEA you
      also have the right to complain to your data protection authority.</p>`,
  },
  {
    id: "security",
    heading: "Security",
    html: `<ul>
      <li>Every artifact is private by default and access-controlled per artifact. An
        unauthorized request and a request for something that does not exist get the same 404.</li>
      <li>Artifact files are served from a separate origin, so uploaded HTML can never run in the
        same origin as the dashboard or the API.</li>
      <li>API tokens are stored hashed, scoped, owner-bound and revocable.</li>
      <li>Everything is served over TLS, and sign-in is handled by Cloudflare Access rather than
        by a password store of our own.</li>
    </ul>
    <p>No system is perfect. If you find a security problem, please report it rather than test it
      further — see the repository's security policy.</p>`,
  },
  {
    id: "children",
    heading: "Children",
    html: `<p>rtfx.pro is a tool for professional work and is not directed at children. Access is
      by invitation, and we do not knowingly create accounts for anyone under 16.</p>`,
  },
  {
    id: "changes",
    heading: "Changes to this policy",
    html: `<p>If this policy changes materially — new data, a new processor, a new purpose — the
      date at the top changes and the cookie notice reappears. We will not start doing something
      new with your data and tell you afterwards.</p>`,
  },
];

export function privacyPage(env: Env): string {
  return legalPage(env, {
    current: "privacy",
    title: "Privacy policy · rtfx.pro",
    eyebrow: "Privacy",
    heading: "Privacy policy",
    lede:
      "What rtfx.pro stores, why it stores it, and who can see it — written against what the " +
      "software actually does rather than what a privacy policy usually says.",
    description: PRIVACY_DESCRIPTION,
    parts: PRIVACY_PARTS,
  });
}

// --- /terms -----------------------------------------------------------------

const TERMS_DESCRIPTION =
  "The terms of use for rtfx.pro: invite-only access, what you may publish, who owns your " +
  "content, how API tokens and agents are treated, and the limits of the service.";

const TERMS_PARTS: readonly Part[] = [
  {
    id: "acceptance",
    heading: "Accepting these terms",
    html: `<p>These terms apply between you and whoever operates this rtfx.pro deployment. Using
      the service — signing in, publishing an artifact, opening one somebody shared with you, or
      calling the API — means you accept them. If you are using rtfx.pro for an employer or a
      client, you confirm you may accept them on that organisation's behalf.</p>`,
  },
  {
    id: "access",
    heading: "Access and accounts",
    html: `<ul>
      <li>Access is <b>by invitation</b>. An account exists because somebody added your address,
        and it can be paused or removed by an administrator of this deployment.</li>
      <li>Sign-in is passwordless: Cloudflare Access emails you a one-time code. Keep control of
        the mailbox behind your address — anyone with it can sign in as you.</li>
      <li>One account is one person. Do not share an account; use per-person invitations, or an
        API token for anything automated.</li>
    </ul>`,
  },
  {
    id: "content",
    heading: "Your content",
    html: `<p><b>You own what you publish.</b> Nothing here transfers ownership of your files, and
      we claim no rights in them beyond what is needed to run the service.</p>
    <p>You grant us the limited permission to store, copy, process and transmit your content for
      one purpose: hosting it and serving it to the people you allowed. That permission ends when
      you delete the content.</p>
    <p>You are responsible for what you publish — that you have the right to publish it, that it
      does not infringe anyone's rights, and that sharing it with the people you named is lawful.
      In particular, think before publishing other people's personal data: an access-controlled
      link is a control, not an exemption.</p>`,
  },
  {
    id: "acceptable-use",
    heading: "Acceptable use",
    html: `<p>Do not use rtfx.pro to:</p>
    <ul>
      <li>publish or distribute malware, phishing pages, or anything designed to deceive a visitor
        about who they are dealing with;</li>
      <li>host content that is unlawful where it is published or where it is read, or that
        infringes someone else's intellectual property;</li>
      <li>attack, probe or circumvent the access controls — yours or anybody else's — or attempt
        to reach artifacts you were not granted;</li>
      <li>scrape, resell or redistribute other people's artifacts, or automate access in a way
        that degrades the service for others;</li>
      <li>use the platform as generic file storage, a CDN for unrelated traffic, or a way to
        anonymise the origin of content.</li>
    </ul>
    <p>Publishing something is a deliberate act with your name on it. The view log records who
      opened what, and administrators of this deployment can see what is hosted here.</p>`,
  },
  {
    id: "tokens",
    heading: "API tokens and agents",
    html: `<p>An API token acts as you, within the scopes you gave it. If you hand one to an agent
      — Claude Code, Hermes, a CI job — everything it publishes is published by you and is your
      responsibility. Tokens are shown once, stored hashed, and can be revoked at any time; revoke
      one the moment you think it has leaked.</p>
    <p>A token can never exceed its owner's own access, so it cannot become an administrator, read
      other people's artifacts, or manage anybody's account.</p>`,
  },
  {
    id: "availability",
    heading: "Availability and changes to the service",
    html: `<p>The service is provided as it is, without a service-level commitment in this
      template. We may change, suspend or discontinue features, and we may impose reasonable
      limits on storage, file size or request volume. Where a change would remove something you
      rely on, we will give notice we reasonably can.</p>
    <p>Keep your own copy of anything you cannot afford to lose. rtfx.pro versions what you
      publish, but it is a hosting service, not a backup service.</p>`,
  },
  {
    id: "fees",
    heading: "Fees",
    html: `<p>There is no charge for accounts in this phase, and no billing exists in the product
      today. If paid plans are introduced, existing accounts will be told what changes before it
      applies to them, and nothing you already published will be held hostage to it.</p>`,
  },
  {
    id: "suspension",
    heading: "Suspension and termination",
    html: `<p>An administrator may pause or remove an account that breaches these terms, or where
      it is necessary to protect the service or other people using it. Where circumstances allow,
      you will be told why and given a chance to put it right.</p>
    <p>You can stop using the service at any time. Ask an administrator to remove your account,
      and delete your artifacts first if you want them gone — deletion removes the files, their
      versions and their view log.</p>`,
  },
  {
    id: "disclaimer",
    heading: "Disclaimers and liability",
    html: `<p>To the extent the law allows, the service is provided "as is" and without warranties
      of any kind, including fitness for a particular purpose and uninterrupted availability. We
      do not warrant that content you publish will always be reachable, or that access controls
      will defeat every possible attack.</p>
    <p>To the extent the law allows, the operator is not liable for indirect or consequential
      loss, lost profits, or lost data. Nothing here excludes liability that cannot lawfully be
      excluded — including for death or personal injury caused by negligence, or for fraud.</p>
    <p>You agree to cover the operator for claims arising from content you published or from your
      breach of these terms.</p>`,
  },
  {
    id: "law",
    heading: "Governing law",
    html: `<p>The governing law and the courts with jurisdiction are for the operator of this
      deployment to specify; this template deliberately leaves both blank rather than guessing at
      a jurisdiction. See the note at the top of this page.</p>`,
  },
  {
    id: "contact",
    heading: "Changes and contact",
    html: `<p>If these terms change materially, the date at the top changes. Continuing to use the
      service after that means accepting the new version; if you do not, ask for your account to
      be removed.</p>
    <p>Questions go to <code>${esc(CONTACT)}</code>. How your data is handled is a separate
      document: read the <a href="/privacy">privacy policy</a>.</p>`,
  },
];

export function termsPage(env: Env): string {
  return legalPage(env, {
    current: "terms",
    title: "Terms of use · rtfx.pro",
    eyebrow: "Terms",
    heading: "Terms of use",
    lede:
      "The agreement between you and whoever operates this deployment: how access works, what " +
      "you may publish, what you keep, and what the service does not promise.",
    description: TERMS_DESCRIPTION,
    parts: TERMS_PARTS,
  });
}
