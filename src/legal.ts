import { layout, esc, siteHeader, siteFooter, PUBLIC_CHROME_STYLE, type HeadMeta } from "./pages";
import { cookieNotice, CONSENT_STYLE, CONSENT_SCRIPT } from "./consent";
import type { Env } from "./env";
import { posthogConfig } from "./posthog";
import { SITE, canonicalUrl } from "./seo";
import { PLAN_PRICE } from "./plan-copy";

/**
 * `/privacy` and `/terms` (issue #36).
 *
 * Rules, in order of importance:
 *
 *  1. **Everything on these pages is true of the code in this repository** and
 *     of the production configuration. The data inventory is the D1 schema, the
 *     R2 bucket, the chat Durable Object and the email log; the cookie table is
 *     the cookies the Worker sets (checked against production responses
 *     2026-11-02). Where the code does something weaker than a reader would
 *     assume — IP erasure is opportunistic, removing a user does not delete
 *     their workspace — the page says so rather than promising the stronger
 *     thing. Change the code or change the page; never let them drift.
 *  2. **Who operates the service is configuration, not copy.** `LEGAL_OPERATOR`
 *     (and friends, see `operatorOf`) name the operator, the governing law and
 *     the courts. rtfx.pro sets them in wrangler.jsonc. A self-hosted deployment
 *     that has not set them renders the "operator template" notice instead of
 *     presenting this text as somebody's finished legal document.
 *  3. These pages are not a lawyer's work product. Items that need one are
 *     tracked outside the page (EU representative, Israeli consumer disclosures,
 *     a customer DPA); the page must not imply they are done.
 *
 * Both pages are public and crawlable: they are what a person reads *before*
 * deciding to sign up.
 */

/** Last substantive edit to either document, shown on both and in JSON-LD. */
const UPDATED = "2 November 2026";
const UPDATED_ISO = "2026-11-02";

const DEFAULT_CONTACT = "privacy@rtfx.pro";

interface Operator {
  /** Display name of the operator, or null when this deployment has not configured one. */
  name: string | null;
  /** "an individual sole proprietor based in Israel" — reads after the name. */
  detail: string | null;
  contact: string;
  /** "the State of Israel" */
  law: string | null;
  /** "the competent courts of the Tel Aviv district, Israel" */
  courts: string | null;
}

function operatorOf(env: Env): Operator {
  const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
  return {
    name: clean(env.LEGAL_OPERATOR),
    detail: clean(env.LEGAL_OPERATOR_DETAIL),
    contact: clean(env.LEGAL_CONTACT) ?? DEFAULT_CONTACT,
    law: clean(env.LEGAL_GOVERNING_LAW),
    courts: clean(env.LEGAL_COURTS),
  };
}

/** True when this deployment has said who it is — the template notice disappears. */
const isConfigured = (op: Operator) => !!(op.name && op.law);

/** "Yogev Gabrielovitch, an individual sole proprietor based in Israel" / "the operator of this deployment". */
function operatorPhrase(op: Operator): string {
  if (!op.name) return "the operator of this deployment";
  return op.detail ? `${esc(op.name)}, ${esc(op.detail)}` : esc(op.name);
}

const mail = (op: Operator) => `<a href="mailto:${esc(op.contact)}">${esc(op.contact)}</a>`;

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
 * Shown only when this deployment has not configured an operator (see
 * `operatorOf`): the software's legal text is a starting point for whoever runs
 * it, and must not pass as their finished document.
 */
function templateNotice(kind: "privacy" | "terms", op: Operator): string {
  return `<div class="template" data-legal-template role="note">
      <h2>Operator template — not legal advice</h2>
      <p>This ${kind === "privacy" ? "privacy policy" : "terms of use"} describes what the
        rtfx.pro software does. Whoever operates this deployment has not yet said who they are,
        so treat it as a starting point, not as a final document.</p>
      <p>The operator must set at least: their name, a working contact address
        (<code>${esc(op.contact)}</code> is the software's default), the governing law and courts,
        and anything else their jurisdiction requires.</p>
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
  const op = operatorOf(env);
  const path = `/${o.current}`;
  const operatedBy = isConfigured(op)
    ? `<p class="updated" data-legal-operator>Operated by ${operatorPhrase(op)}. Contact: ${mail(op)}
        (a postal address is available on request).</p>`
    : "";
  const body = `
    ${siteHeader(o.current)}

    <main id="main">
      <div class="legal-hero">
        <p class="eyebrow">${esc(o.eyebrow)}</p>
        <h1>${esc(o.heading)}</h1>
        <p class="lede">${o.lede}</p>
        <p class="updated">Last updated ${esc(UPDATED)}, and in effect from that date.</p>
        ${operatedBy}
      </div>

      ${isConfigured(op) ? "" : templateNotice(o.current, op)}
      ${toc(o.parts)}

      <article class="legal">${sections(o.parts)}</article>
    </main>

    ${siteFooter()}
    ${cookieNotice()}
    <script>${CONSENT_SCRIPT}</script>`;

  const meta: HeadMeta = {
    description: o.description,
    canonical: canonicalUrl(env, path),
    image: canonicalUrl(env, "/og.png"),
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
        dateModified: UPDATED_ISO,
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

const PRIVACY_DESCRIPTION_BASE =
  "What rtfx.pro stores and who can see it: your email, the artifacts you publish, and the " +
  "view log their owners see.";

const privacyDescription = (analytics: boolean): string =>
  analytics
    ? `${PRIVACY_DESCRIPTION_BASE} No ads; dashboard session recording only if you accept it.`
    : `${PRIVACY_DESCRIPTION_BASE} No analytics, ads or third-party tracking.`;

/**
 * `analytics`: whether this deployment can record dashboard sessions at all
 * (POSTHOG_KEY set). `resend`: whether the Resend fallback sender is configured.
 * Neither is described when it is off — naming a processor an instance does not
 * use is as inaccurate as hiding one it does.
 */
const privacyParts = (op: Operator, analytics: boolean, resend: boolean): readonly Part[] => [
  {
    id: "summary",
    heading: "The short version",
    html: `<ul>
      <li>rtfx.pro hosts pages and files that you (usually through Claude) publish, and lets you
        decide who can open them: named people, your workspace, or share links you create.</li>
      <li>We use <b>email addresses</b> for accounts, invitations and passwordless sign-in. There
        are no passwords.</li>
      <li>We store <b>what you publish</b> — files, versions, sharing settings — because hosting it
        is the product.</li>
      <li>We keep an <b>activity log</b> for every artifact (who opened it when we know who they are,
        when, from roughly where, on what device). People who manage the artifact can see it. This
        is a feature, and it applies to you when you open somebody else's artifact too.</li>
      <li>The public pages and the artifact viewer run <b>no analytics, no advertising and no
        third-party tracking</b>.${
          analytics
            ? " The dashboard records sessions only if you accept it — see below."
            : " Neither does the dashboard."
        } An artifact somebody publishes can contain its own scripts; that is up to its publisher.</li>
      <li>We do not sell personal data, share it with advertisers, or use it to train AI models.</li>
    </ul>`,
  },
  {
    id: "who",
    heading: "Who is responsible",
    html: `<p>rtfx.pro is operated by ${operatorPhrase(op)}. Write to ${mail(op)}
      with any privacy question, request or complaint. A postal address is available on request.</p>
    <p>For your account, sign-in, security, billing and support we decide how and why data is
      processed (we are the "controller"). For the content customers publish — and the personal
      data inside it — the customer who publishes it decides what goes in and who sees it; we host
      it on their instructions. If you reached an artifact through somebody's link, they chose to
      share it with you, and they can see that you opened it.</p>
    <p>This policy covers the hosted service at rtfx.pro. Self-hosted copies of the open-source
      software are run by their own operators under their own policies.</p>`,
  },
  {
    id: "collect",
    heading: "What we collect",
    html: `<div class="table-wrap"><table class="data">
      <thead><tr><th scope="col">What</th><th scope="col">Details</th></tr></thead>
      <tbody>
        <tr><th scope="row">Identity and workspaces</th>
          <td>Email address; optional display name; role and status; the workspaces you belong to,
            their names and addresses; who invited you and when; when you were last active. It
            comes from you — or from a workspace owner who adds you, or somebody who shares an
            artifact with your address before you ever sign in.</td></tr>
        <tr><th scope="row">What you publish</th>
          <td>The files and their contents (stored in Cloudflare R2); title, description, address,
            size, version notes and who published each version and when.</td></tr>
        <tr><th scope="row">Sharing settings</th>
          <td>The email addresses an artifact is shared with and their role (viewer or editor);
            share links — stored only as a hash — with their name, creator, expiry, revocation and
            last use.</td></tr>
        <tr><th scope="row">Activity log (view log)</th>
          <td>For each open of an artifact: the artifact, version and file; time and outcome; your
            email if you are signed in (including when you came through a share link); which share
            link was used; IP address; the approximate country, region and city Cloudflare derives
            from it; device type, operating system and browser, and the browser's User-Agent text
            (up to 300 characters); the referring page (up to 500 characters). Link previews built
            by chat and social apps, and attempts to use an expired or revoked link, are logged too.
            Repeated opens of the same share link from the same IP address within a few minutes
            produce one entry. A log entry shows
            that a page was loaded — not that a person read it.</td></tr>
        <tr><th scope="row">Chat</th>
          <td>Messages written in an artifact's chat, with the author's email where known, their
            role and the version they were viewing.</td></tr>
        <tr><th scope="row">Sign-in and integrations</th>
          <td>One-time codes and magic links (stored hashed), attempts and expiry; API tokens
            (stored hashed) with their name, scopes and dates; the apps you connect over OAuth
            (such as Claude) and their authorisations; short-lived upload links.</td></tr>
        <tr><th scope="row">Email delivery log</th>
          <td>For every email we send — sign-in codes, invitations, share and read notices, access
            requests — the recipient, the kind of message, whether the sending provider accepted it or
            the send failed, and when. Not the message itself.</td></tr>
        <tr><th scope="row">Billing</th>
          <td>When you buy a plan we send your email and workspace id to Lemon Squeezy's checkout.
            From its notifications we store the resulting plan and a record that the notification
            was processed. We do not store card details, or Lemon Squeezy's customer or subscription
            ids.</td></tr>
        <tr><th scope="row">Contact and operations</th>
          <td>Messages you send through the contact form or by email; notes and an audit trail of
            actions taken by our administrators; rate-limit counters (hourly counts keyed by a hash
            of an email or IP address); and short technical logs from the platform.</td></tr>
      </tbody>
    </table></div>
    <p>We do not collect passwords (there are none) or payment-card details (Lemon Squeezy handles
      payment). The product does not read your artifacts' contents for analytics, advertising or
      profiling; people with infrastructure access could technically reach stored files when that
      is needed to operate, secure or troubleshoot the service.</p>`,
  },
  {
    id: "dashboard-analytics",
    heading: "Session recording and error tracking",
    html: `<p>The dashboard at <code>/admin</code> — and only the dashboard; never the public pages,
      sign-in, or an artifact you open — can use <a href="https://posthog.com" rel="noopener">PostHog</a>
      to record what a session looked like and to catch errors. It is off until you say yes.</p>
    <h3>What it asks, and when</h3>
    <p>The first time you open the dashboard, a banner asks you to accept or decline. Decline, and
      nothing loads. If your browser sends Do Not Track or Global Privacy Control, you are not asked:
      every visit behaves as if you had declined.</p>
    <h3>What is recorded</h3>
    <ul>
      <li>Mouse movement, clicks, scrolling and navigation inside the dashboard, as a session replay.</li>
      <li>Unhandled JavaScript errors and unhandled promise rejections.</li>
    </ul>
    <p>Every input value and every piece of on-page text is masked before it leaves your browser: a
      recording shows shapes, motion and layout, never what any of it says. PostHog processes this data
      as our sub-processor, under its own <a href="https://posthog.com/privacy" rel="noopener">privacy
      policy</a>.</p>`,
  },
  {
    id: "cookies",
    heading: "Cookies and browser storage",
    html: `<p>rtfx.pro sets no advertising cookies${analytics ? ", and its only analytics cookie is PostHog's optional one, below" : " and no analytics cookies"}. The
      cookies are strictly necessary for signing in and for shared access; the local-storage items only
      remember preferences.</p>
    <div class="table-wrap"><table class="data">
      <thead><tr><th scope="col">Name</th><th scope="col">What it is for</th><th scope="col">Lasts</th></tr></thead>
      <tbody>
        <tr><th scope="row"><code>rtfx_session</code></th>
          <td>Keeps you signed in after you verify your email.</td><td>30 days from sign-in</td></tr>
        <tr><th scope="row"><code>rtfx_guest</code></th>
          <td>Lets a person you shared one artifact with open it after verifying their email.</td><td>30 days</td></tr>
        <tr><th scope="row"><code>rtfx_link_&lt;artifact&gt;</code></th>
          <td>Remembers a share link you opened, so the page keeps working; the link's own expiry
            and revocation still apply.</td><td>1 day</td></tr>
        <tr><th scope="row"><code>rtfx_next</code></th>
          <td>Remembers where to send you after sign-in.</td><td>30 minutes</td></tr>
        <tr><th scope="row"><code>rtfx_oauth_csrf</code></th>
          <td>Protects the screen where you connect an app (such as Claude) against forged requests.</td><td>10 minutes</td></tr>
        <tr><th scope="row"><code>rtfx_account</code></th>
          <td>Remembers which workspace you last switched to.</td><td>1 year</td></tr>
        <tr><th scope="row"><code>rtfx.cookie-notice</code>, <code>rtfx.bar</code></th>
          <td>Local storage in your browser (never sent to us): that you dismissed the cookie notice,
            and how you like the artifact toolbar.</td><td>Until you clear it</td></tr>
        ${
          analytics
            ? `<tr><th scope="row"><code>rtfx.dashboard-analytics</code></th>
          <td>Local storage: your accept/decline choice for dashboard session recording.</td><td>Until you clear it</td></tr>
        <tr><th scope="row"><code>ph_&lt;project-key&gt;_posthog</code></th>
          <td>Cookie + local storage · optional, dashboard only: PostHog's anonymous session id, set
            only after you accept session recording.</td><td>Set by PostHog</td></tr>`
            : ""
        }
      </tbody>
    </table></div>
    <p>Cloudflare, which runs the network in front of rtfx.pro, may set its own security cookies
      (such as <code>__cf_bm</code> or <code>cf_clearance</code>) if it needs to check whether traffic
      is automated. Signing out clears <code>rtfx_session</code> and <code>rtfx_guest</code>; it does
      not revoke share links. Blocking these cookies stops sign-in and shared access from working.</p>`,
  },
  {
    id: "why",
    heading: "Why we process it",
    html: `<p>Where EU or UK data-protection law applies, these are our legal bases:</p>
    <ul>
      <li><b>To provide the service you signed up for</b> (contract): your account, hosting what you
        publish, sharing it as you instruct, workspaces, and the plan you bought.</li>
      <li><b>Legitimate interests</b>: verifying and admitting the people an artifact is shared with,
        sending them the invitations and notices that sharing involves, the activity log (people who
        share something need to know who opened it and to spot a leaked link), keeping accounts and
        the service secure, preventing abuse, fixing problems, and answering messages. We keep the
        activity log's IP addresses out of view after 90 days (see retention) because location and
        device are rarely needed after that.</li>
      <li><b>Legal obligations</b>: where a law requires us to keep or disclose something.</li>
      ${analytics ? "<li><b>Consent</b>: dashboard session recording, only if you accept it.</li>" : ""}
    </ul>
    <p>Where we host personal data inside a customer's content, we act on that customer's
      instructions, and the customer is responsible for having a lawful basis to publish and share
      it.</p>`,
  },
  {
    id: "provision",
    heading: "What you have to give us",
    html: `<p>An email address is needed to have an account or to open something shared with you by
      name; without it we cannot sign you in. Content is needed only if you want us to host it.
      Display names, chat messages and contact-form messages are optional. Payment details go to
      Lemon Squeezy, not to us. Some technical data (such as your IP address) is unavoidable when
      your browser talks to any website.</p>`,
  },
  {
    id: "sharing",
    heading: "Who can see what",
    html: `<ul>
      <li><b>People an artifact is shared with</b> — by name, through the workspace, or by holding a
        share link — can open it. A viewer can only read. An editor signed in with a full account can
        also publish new versions and roll back. A share link works for whoever has it, so it can be forwarded.</li>
      <li><b>People who manage an artifact</b> — its owner and members (not viewers) of the workspace
        it belongs to — see its activity log and sharing settings. The first time a signed-in person
        other than the owner opens an artifact (not through a share link), the owner may get an email
        saying so, unless read notices are turned off.</li>
      <li><b>Chat</b> messages, with their author's email where known, are visible to everyone who
        can open the artifact.</li>
      <li><b>Chat and social apps</b> that fetch a valid share link to build a preview receive the
        artifact's title and description.</li>
      <li><b>Apps you connect</b>, such as Claude, receive what you ask them to do through rtfx.pro,
        under their own terms and privacy policies.</li>
      <li><b>Our administrators</b> can see accounts, workspaces and artifact metadata (owner, title,
        size, dates, counts) to run the service, and can manage workspace memberships. Being an
        administrator does not change what they can see: as administrators they
        cannot open your artifacts, read your files or see who has viewed them — they get that only the way anyone does,
        if you share it with them. An administrator who deletes
        an artifact for abuse leaves an entry in an audit trail.</li>
    </ul>
    <h3>Service providers</h3>
    <ul>
      <li><a href="https://www.cloudflare.com/privacypolicy/" rel="noopener">Cloudflare</a> runs the
        network, servers, databases, file storage (R2), chat and email sending.</li>
      ${resend ? `<li><a href="https://resend.com/legal/privacy-policy" rel="noopener">Resend</a> sends our emails if Cloudflare cannot deliver them.</li>` : ""}
      <li><a href="https://www.lemonsqueezy.com/privacy" rel="noopener">Lemon Squeezy</a> is the
        merchant of record for paid plans: it takes payment, handles sales tax and VAT, issues
        receipts and processes refunds, as a controller under its own policy.</li>
      ${analytics ? `<li><a href="https://posthog.com/privacy" rel="noopener">PostHog</a> records dashboard sessions for people who accepted that.</li>` : ""}
    </ul>
    <p>Email providers see the messages they deliver, including sign-in codes. We do not sell or rent
      personal data, and we disclose it to anyone else only where the law requires it or where it is
      necessary to protect people, rights or the service.</p>`,
  },
  {
    id: "transfers",
    heading: "Where data is processed",
    html: `<p>The operator is in Israel, which the European Commission recognises as providing adequate
      protection for personal data. Our service providers are based in the United States and process
      data on their global networks, so your data may be handled in the US and other countries. Where
      EU or UK law requires it, those transfers rely on the safeguards in the providers'
      data-processing terms, such as standard contractual clauses. Write to ${mail(op)} for details of the safeguards that apply.</p>`,
  },
  {
    id: "retention",
    heading: "How long we keep it",
    html: `<ul>
      <li><b>Artifacts</b> stay until they are deleted. On the Free plan, each new publish keeps the
        files of the latest five versions and removes older versions' files (their notes and dates
        stay). Pro and Team keep every version.</li>
      <li><b>Deleting an artifact</b> removes its files, versions, sharing settings, share links and
        activity log, and then erases its chat (if that last step fails, the chat can remain until we
        clear it). It does not remove entries about it in the email delivery log or the administrators'
        audit trail.</li>
      <li><b>Activity log</b> entries stay until the artifact is deleted. IP addresses older than 90
        days are no longer shown to anyone and are erased from storage in batches as the artifact keeps
        being used — so on an artifact nobody opens any more, an old IP address can stay in storage
        (unseen) until the artifact is deleted.</li>
      <li><b>Removing you from one workspace</b> removes only that membership. <b>Removing you from the
        service</b> removes all your memberships and the artifacts shared with you by name, and revokes
        your API tokens. Neither does by itself delete your personal workspace, what you published or
        past activity — ask us at ${mail(op)} to close your account and delete those.</li>
      <li><b>Sign-in codes</b> work for 15 minutes; <b>upload links</b> for 30 minutes; connected-app
        access for an hour at a time, renewable for 30 days. Expired or revoked credentials stop working
        immediately, but their records are kept.</li>
      <li><b>Email delivery log, contact messages, audit trail and billing records</b> are kept while
        the service runs, for security, support, accounting and disputes. Rate-limit counters expire
        after their hour and are removed during later checks.</li>
    </ul>
    <p>Cloudflare and our other providers keep their own operational logs under their own terms.</p>`,
  },
  {
    id: "rights",
    heading: "Your rights",
    html: `<p>Depending on where you live, you can ask us for a copy of your personal data, to correct it,
      to delete it, to restrict or object to how we use it, or for a portable copy. Israeli law gives
      you rights to see and correct information held about you. Much of it you can do yourself:
      delete an artifact, revoke a token, or change who something is shared with.</p>
    <p>For anything else, write to ${mail(op)}. We may need to confirm it is you, and we will explain
      any legal reason we cannot do all of what you ask. If the data is inside content another customer
      published, we may need to involve them. You can also complain to Israel's Privacy Protection
      Authority or, in the EU or UK, to your local data-protection authority.</p>`,
  },
  {
    id: "security",
    heading: "Security",
    html: `<ul>
      <li>Every artifact is private when published, and access is checked on every request.</li>
      <li>Artifact files are served from a separate address (<code>a.rtfx.pro</code>), so uploaded
        HTML cannot run alongside the dashboard or the API.</li>
      <li>Sign-in uses one-time email codes instead of passwords; API tokens, share links and
        sign-in codes are stored only as hashes; connections use HTTPS.</li>
    </ul>
    <p>No system is perfectly secure. Report a security problem to ${mail(op)} (see also the
      repository's security policy) rather than testing it further. If a breach affects your personal
      data, we will notify you and the authorities where the law requires it.</p>`,
  },
  {
    id: "children",
    heading: "Age",
    html: `<p>rtfx.pro is a tool for work and is not meant for children. You must be at least 16 to
      create an account. We do not verify ages; if you believe a child has an account, tell us at
      ${mail(op)} and we will remove it.</p>`,
  },
  {
    id: "automated",
    heading: "Automated decisions",
    html: `<p>The service automatically checks sign-in, permissions, rate limits and plan limits — for
      example, refusing a publish over your plan's limit. We do not use automated decision-making or
      profiling that has legal or similarly significant effects on you.</p>`,
  },
  {
    id: "changes",
    heading: "Changes to this policy",
    html: `<p>The date at the top shows when this policy last changed. Before a material change — new kinds
      of data, a new purpose or a new provider — takes effect, we will tell account holders by email or
      in the dashboard. We will not start using your data for something new and tell you afterwards.</p>`,
  },
];

export function privacyPage(env: Env): string {
  const op = operatorOf(env);
  const analytics = !!posthogConfig(env);
  const resend = !!env.RESEND_API_KEY;
  const parts = privacyParts(op, analytics, resend).filter(
    (part) => analytics || part.id !== "dashboard-analytics"
  );

  return legalPage(env, {
    current: "privacy",
    title: "Privacy policy · rtfx.pro",
    eyebrow: "Privacy",
    heading: "Privacy policy",
    lede:
      "What rtfx.pro stores, why, who can see it and for how long — written against what the " +
      "software actually does.",
    description: privacyDescription(analytics),
    parts,
  });
}

// --- /terms -----------------------------------------------------------------

const TERMS_DESCRIPTION =
  "Terms of use for rtfx.pro: accounts, plans and billing, cancellation, what you may publish, " +
  "who owns your content, API and agent use, and service limits.";

const termsParts = (op: Operator): readonly Part[] => [
  {
    id: "acceptance",
    heading: "The service and these terms",
    html: `<p>These terms are an agreement between you and ${operatorPhrase(op)} ("we") for the hosted
      service at rtfx.pro: publishing pages and files to private links, the dashboard, and the API and
      MCP server. By creating an account, buying a plan or otherwise using the service, you agree to
      them. If you use rtfx.pro for an organisation, you confirm you may agree on its behalf.</p>
    <p>The rtfx.pro software is open source under the MIT licence. That licence covers the source code;
      these terms cover the hosted service. Nothing here takes away rights you have under laws that
      cannot be overridden by contract.</p>`,
  },
  {
    id: "access",
    heading: "Who can use it, and accounts",
    html: `<ul>
      <li>You must be at least 16 and able to enter into a binding agreement.</li>
      <li>You sign in by proving you control an email address — there is no password. Keep that mailbox
        secure: anyone who controls it can sign in as you. Tell us at ${mail(op)} if you think someone
        else has access.</li>
      <li>An account is for one person. Use workspace members or sharing for other people, and API
        tokens for automation.</li>
      <li>Only add people to a workspace, or share with them, if you are entitled to use their email
        address and to show them the content. Adding someone sends them an email; they get access the
        moment they sign in with that address.</li>
      <li>You are responsible for what happens through your account, except where it is our fault.</li>
    </ul>`,
  },
  {
    id: "fees",
    heading: "Plans, billing and cancellation",
    html: `<ul>
      <li><b>Plans.</b> Free costs nothing. Pro is US$${PLAN_PRICE.pro} per month and Team is US$${PLAN_PRICE.team} per month,
        per workspace. Enterprise is arranged with us directly. The limits of each plan (artifacts,
        storage, people, monthly views, version history) are shown on the pricing page before you buy.</li>
      <li><b>Payment.</b> Paid plans are sold through Lemon Squeezy, which acts as merchant of record: it
        charges you, handles any sales tax or VAT, and issues receipts. The total, including tax, is
        shown at checkout, and Lemon Squeezy's buyer terms also apply to the purchase.</li>
      <li><b>Renewal.</b> Subscriptions renew automatically every month until cancelled.</li>
      <li><b>Cancelling.</b> You can cancel at any time, through the link in your Lemon Squeezy receipt
        or by writing to ${mail(op)}. Your plan stays active until the end of the period you have already
        paid for, then the workspace returns to Free.</li>
      <li><b>Refunds.</b> We do not refund or credit partial periods, except where the law requires it —
        for example, a statutory right to cancel a distance purchase. Those rights always take priority
        over this paragraph.</li>
      <li><b>Moving to a lower plan</b> never deletes your artifacts, but the lower limits apply: you may
        not be able to publish more until you are within them, viewers may be turned away if the monthly
        view limit is reached, and on Free each new publish keeps the files of only the latest five
        versions.</li>
      <li><b>Price changes</b> apply from your next billing period after we have told you about them.</li>
    </ul>`,
  },
  {
    id: "content",
    heading: "Your content",
    html: `<p><b>You keep ownership of what you publish.</b> You give us a limited permission to store,
      copy, process, transmit and display it only as needed to run the service: hosting it, serving it to
      the people you allow, building link previews and notifications you ask for, and keeping the
      service secure. That permission ends when the content is deleted, apart from what we must keep to
      complete the deletion, comply with the law or resolve a dispute.</p>
    <p>You are responsible for what you publish: that you have the right to publish it, that it does not
      infringe anyone's rights, and that sharing it with the people you choose is lawful. Think before
      publishing other people's personal data — a private link is a control, not a legal basis.</p>`,
  },
  {
    id: "acceptable-use",
    heading: "Acceptable use and reporting abuse",
    html: `<p>Do not use rtfx.pro to:</p>
    <ul>
      <li>publish malware, phishing pages, or anything meant to deceive people about who they are
        dealing with;</li>
      <li>publish unlawful content, or content that infringes someone else's rights;</li>
      <li>get around access controls, or try to open artifacts that were not shared with you;</li>
      <li>send unwanted invitations or messages, or use the service to harass anyone;</li>
      <li>scrape or redistribute other people's artifacts, or overload the service;</li>
      <li>use it as general file storage or a content-delivery network for unrelated traffic.</li>
    </ul>
    <p>A share link works for anyone who has it. You choose who gets it, and you can revoke it.</p>
    <p>To report abuse or an infringement, write to ${mail(op)} with the artifact's address and what is
      wrong. We may investigate, restrict access to or remove content, or suspend an account, where that
      is reasonably necessary to enforce these terms or the law, and we will tell the publisher where we
      can.</p>`,
  },
  {
    id: "tokens",
    heading: "API, MCP and AI agents",
    html: `<p>API tokens and connected apps (such as Claude, connected over OAuth) act as you, within the
      permissions you grant. An agent can publish, change sharing and delete content if you let it, and
      what it does is your responsibility. Keep tokens and share links secret and revoke them as soon as
      you think one has leaked. A token never has more access than its owner.</p>
    <p>rtfx.pro is an independent service and is not affiliated with or endorsed by Anthropic. Claude
      and other apps you connect are governed by their own terms and privacy policies.</p>`,
  },
  {
    id: "availability",
    heading: "Availability and changes to the service",
    html: `<p>We work to keep rtfx.pro available but do not promise any particular uptime unless we agree a
      service level with you in writing. We may change, add or remove features. If a change materially
      reduces what a paid plan includes, we will tell you in advance, and you can cancel.</p>
    <p>Keep your own copies of anything important. Version history depends on your plan and is not a
      backup.</p>`,
  },
  {
    id: "suspension",
    heading: "Suspension, closing your account and your data",
    html: `<p>We may suspend an account or remove content where it seriously or repeatedly breaches these
      terms, where the law requires it, or to protect the service or other people. Where we lawfully can,
      we will tell you why and give you a chance to fix it.</p>
    <p>You can stop using rtfx.pro at any time. To close your account and delete what you published,
      write to ${mail(op)}; cancelling a subscription and deleting content are separate steps. Download
      anything you want to keep first. What happens to your data afterwards is described in the
      <a href="/privacy#retention">privacy policy</a>.</p>`,
  },
  {
    id: "disclaimer",
    heading: "Warranties and liability",
    html: `<p>To the extent the law allows, the service is provided "as is" and "as available", without
      implied warranties of fitness for a particular purpose or of uninterrupted availability. We do not
      guarantee that access controls will stop every possible attack.</p>
    <p>If you use rtfx.pro for business, then to the extent the law allows: we are not liable for
      indirect or consequential loss, lost profits or lost data, and our total liability for any claim is
      limited to the amount you paid us in the 12 months before it arose (or US$100 if you paid
      nothing).</p>
    <p>Nothing in these terms limits liability that cannot lawfully be limited, including for fraud or for
      death or personal injury caused by negligence, or the rights consumers have under mandatory
      consumer-protection law.</p>`,
  },
  {
    id: "indemnity",
    heading: "Claims about your content",
    html: `<p>If you use rtfx.pro for business, you agree to cover our reasonable costs of third-party claims
      that arise from content you published unlawfully or from your serious breach of these terms, to the
      extent you caused them. We will tell you promptly about such a claim and let you take part in
      responding to it. This does not apply to consumers, or to anything we caused.</p>`,
  },
  {
    id: "law",
    heading: "Governing law",
    html: op.law
      ? `<p>These terms are governed by the laws of ${esc(op.law)}${op.courts ? `, and disputes will be heard by ${esc(op.courts)}` : ""}.
      If you are a consumer, this does not take away the protection of the mandatory laws of the country
      you live in, or your right to bring proceedings there. It also does not limit your data-protection
      rights or your right to complain to a data-protection authority.</p>
    <p>Please write to ${mail(op)} first — most problems are quicker to solve directly.</p>`
      : `<p>The operator of this deployment has not stated which law governs these terms. Contact
      ${mail(op)} for details.</p>`,
  },
  {
    id: "contact",
    heading: "Changes and contact",
    html: `<p>If we change these terms materially, we will tell account holders by email or in the dashboard
      before the change takes effect, and the date at the top will change. Changes apply from then on, not
      backwards. If you do not accept them, you can stop using the service and cancel.</p>
    <p>Questions about these terms, billing, support or abuse go to ${mail(op)}; a postal address is
      available on request. How we handle personal data is described in the
      <a href="/privacy">privacy policy</a>.</p>`,
  },
  {
    id: "general",
    heading: "General",
    html: `<p>If part of these terms turns out to be unenforceable, the rest still applies. Not enforcing a
      term is not giving it up. These terms, the plan details shown when you buy, and anything we agree
      with you in writing are the whole agreement; a written agreement signed by both of us wins where it
      expressly differs. We may transfer this agreement to someone who takes over the service, and will
      tell you if that happens; it will not reduce your rights.</p>`,
  },
];

export function termsPage(env: Env): string {
  return legalPage(env, {
    current: "terms",
    title: "Terms of use · rtfx.pro",
    eyebrow: "Terms",
    heading: "Terms of use",
    lede:
      "The agreement for using rtfx.pro: accounts, plans and cancellation, what you may publish, what " +
      "you keep, and what the service does not promise.",
    description: TERMS_DESCRIPTION,
    parts: termsParts(operatorOf(env)),
  });
}
