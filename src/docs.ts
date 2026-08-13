import { layout, esc, siteHeader, siteFooter, PUBLIC_CHROME_STYLE } from "./pages";
import { cookieNotice, CONSENT_STYLE, CONSENT_SCRIPT } from "./consent";
import type { Env } from "./env";
import { SITE, canonicalUrl } from "./seo";

/**
 * `/docs` — the public product documentation page (issue #29).
 *
 * Public and crawlable on purpose. It is the page that answers "what is this,
 * how do I publish, and who can see it?" for three audiences at once: a person
 * evaluating the product, a search engine, and an AI agent asked where to host
 * something it just built. Everything here describes the *public* contract —
 * nothing on this page reveals an artifact, a person, or a token.
 *
 * The prose and the FAQ JSON-LD below are generated from the same source, so a
 * rich result can never quote an answer the page doesn't actually show.
 */

const DOCS_STYLE = `${PUBLIC_CHROME_STYLE}${CONSENT_STYLE}
.wrap{max-width:980px}
.doc-hero{padding:2.4rem 0 1.4rem;max-width:46rem}
.doc-hero p.eyebrow{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);margin:0 0 .7rem}
.doc-hero h1{font-size:clamp(2.2rem,5.5vw,3.6rem);letter-spacing:-.06em;line-height:1.02;margin:0 0 .9rem}
.doc-hero p.lede{color:var(--muted);font-size:1.08rem;line-height:1.6;margin:0}
.toc{display:flex;gap:.5rem;flex-wrap:wrap;margin:1.8rem 0 2.6rem}
.toc a{border:1px solid var(--border);border-radius:999px;padding:.36rem .82rem;font-size:.85rem;color:var(--muted);background:rgba(255,255,255,.04)}
.toc a:hover{border-color:var(--border-strong);color:var(--fg)}
article.doc section{margin:0 0 3rem;scroll-margin-top:6rem}
article.doc h2{font-size:clamp(1.5rem,3.2vw,2.1rem);letter-spacing:-.045em;margin:0 0 .8rem;line-height:1.1}
article.doc h3{font-size:1.05rem;letter-spacing:-.02em;margin:1.6rem 0 .45rem}
article.doc p{color:var(--muted);line-height:1.65;margin:0 0 .9rem}
article.doc ul,article.doc ol{color:var(--muted);line-height:1.65;padding-left:1.1rem;margin:0 0 .9rem}
article.doc li{margin:.35rem 0}
article.doc code{font-family:var(--mono);font-size:.86em;background:rgba(255,255,255,.07);border:1px solid var(--border);border-radius:6px;padding:.08em .38em;color:var(--fg)}
pre.code{background:#05070c;border:1px solid var(--border);border-radius:var(--radius);padding:1.15rem 1.25rem;overflow-x:auto;font-family:var(--mono);font-size:.85rem;line-height:1.7;color:#dfe5f0;box-shadow:var(--shadow);margin:0 0 1rem}
pre.code code{background:none;border:0;padding:0;font-size:inherit;color:inherit}
.callout{border:1px solid var(--border);border-radius:var(--radius);background:var(--card);padding:1.15rem 1.25rem;box-shadow:var(--shadow);margin:0 0 1rem}
.callout p:last-child{margin-bottom:0}
.faq{display:grid;gap:.9rem}
.faq details{border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card);padding:.95rem 1.1rem}
.faq summary{cursor:pointer;font-weight:650;letter-spacing:-.015em}
.faq summary::marker{color:var(--faint)}
.faq details p{margin:.7rem 0 0}
.doc-cta{border:1px solid var(--border);border-radius:32px;background:linear-gradient(135deg,var(--card),rgba(10,132,255,.09));padding:2.1rem;text-align:center;box-shadow:var(--shadow)}
.doc-cta h2{margin:0 0 .5rem}
.doc-cta .actions{display:flex;gap:.6rem;justify-content:center;flex-wrap:wrap;margin-top:1.3rem}
/* --- long-form sections that moved here from the landing page (issue #35) --- */
.cases{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1rem;margin:0 0 .9rem}
.case{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.4rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.case h3{margin:.15rem 0 .5rem;font-size:1.08rem;letter-spacing:-.025em}.case p{margin:0;color:var(--muted);font-size:.93rem}
.case .pill{display:inline-block;border:1px solid var(--border);border-radius:999px;padding:.28rem .72rem;font-size:.78rem;color:var(--muted);background:rgba(255,255,255,.05)}
/* A 3-column table has a min-content width no phone can honour, and a table that
   can't shrink widens the whole page. It scrolls inside its own box instead. */
.table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);box-shadow:var(--shadow);-webkit-overflow-scrolling:touch;margin:0 0 .9rem}
.compare{width:100%;min-width:34rem;border-collapse:collapse}
.compare th,.compare td{text-align:left;padding:.9rem 1.1rem;border-bottom:1px solid var(--border);font-size:.94rem}
.compare thead th{font-size:.78rem;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);font-weight:600}
.compare tbody th{font-weight:650;color:var(--fg)}.compare td{color:var(--muted)}
.compare tr:last-child th,.compare tr:last-child td{border-bottom:0}
`;

const TITLE = "Docs — publishing, access control and the API · rtfx.pro";
const DESCRIPTION =
  "How rtfx.pro works: publish HTML pages and multi-file artifacts from Claude Code, " +
  "Hermes, the CLI or the API; control who can open each one; keep every version; and " +
  "see exactly who viewed what.";

/** One question, one answer — rendered as prose *and* as FAQPage structured data. */
interface Faq {
  q: string;
  a: string;
}

const FAQS: readonly Faq[] = [
  {
    q: "Is anything I publish visible to the public web?",
    a:
      "No. Every artifact is access-controlled: a visitor without a valid identity gets a 404, " +
      "and so does a signed-in person who hasn't been granted access. Artifact origins send " +
      "X-Robots-Tag: noindex and are excluded in robots.txt, so nothing you publish is crawled " +
      "or indexed. Only the product pages — the landing page, these docs and the sign-in page — " +
      "are public.",
  },
  {
    q: "How do I publish from Claude Code or a Hermes run?",
    a:
      "Give the agent a scoped API token and let it call the same CLI or HTTP API you use. " +
      "`artifacts publish ./out --slug my-page` handles a single file, a folder or a zip, so " +
      "'publish this' becomes the last step of an ordinary agent session. A token is bound to " +
      "its owner and can be revoked at any time, so the agent never gains your account.",
  },
  {
    q: "What happens when I publish the same slug twice?",
    a:
      "You get a new immutable version at the same URL. Previous versions stay addressable for " +
      "preview, and rollback is one click — nothing you have already shared is overwritten or lost.",
  },
  {
    q: "Who can sign in to rtfx.pro?",
    a:
      "Access is by invitation. Cloudflare Access is the identity provider and sign-in is " +
      "passwordless — you get a one-time code by email. Request access from the landing page and " +
      "we'll send an invitation.",
  },
  {
    q: "Can someone I share an artifact with see my other artifacts?",
    a:
      "No. A grant applies to exactly one artifact. It never confers management rights, never " +
      "reveals your other work, and never widens who can sign in.",
  },
  {
    q: "Where does the uploaded HTML actually run?",
    a:
      "On a separate content origin (a.rtfx.pro) that serves artifact files and nothing else — " +
      "no dashboard, no API, no admin. Uploaded HTML therefore can never run in the same origin " +
      "as the app that manages it.",
  },
];

function faqHtml(): string {
  return FAQS.map(
    (f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`
  ).join("");
}

function structuredData(env: Env): unknown[] {
  const url = canonicalUrl(env, "/docs");
  return [
    {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      "@id": `${url}#article`,
      headline: "rtfx.pro documentation: publishing, access control and the API",
      description: DESCRIPTION,
      url,
      inLanguage: "en",
      isPartOf: { "@id": `${canonicalUrl(env, "/")}#website` },
      publisher: { "@id": `${canonicalUrl(env, "/")}#organization` },
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "@id": `${url}#faq`,
      mainEntity: FAQS.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: SITE.name, item: canonicalUrl(env, "/") },
        { "@type": "ListItem", position: 2, name: "Docs", item: url },
      ],
    },
  ];
}

export function docsPage(env: Env): string {
  const body = `
    ${siteHeader("docs")}

    <main id="main">
    <div class="doc-hero">
      <p class="eyebrow">Documentation</p>
      <h1>Publish it, control who opens it, keep every version.</h1>
      <p class="lede">rtfx.pro hosts the HTML pages and multi-file artifacts that come out of an
        AI session — from Claude Code, Hermes, your terminal or your browser — behind real access
        control instead of an unlisted URL.</p>
    </div>

    <nav class="toc" aria-label="On this page">
      <a href="#overview">Overview</a>
      <a href="#use-cases">Use cases</a>
      <a href="#publishing">Publishing</a>
      <a href="#agents">Claude Code &amp; Hermes</a>
      <a href="#access">Access &amp; privacy</a>
      <a href="#versions">Versions &amp; views</a>
      <a href="#why">Why not a static host</a>
      <a href="#api">API</a>
      <a href="#faq">FAQ</a>
    </nav>

    <article class="doc">
      <section id="overview">
        <h2>What rtfx.pro is</h2>
        <p>An artifact is one publishable thing: a single HTML file, or a folder/zip with its own
          assets. Publishing gives it a slug, a version and an owner. From then on the artifact has
          a stable link, a history, and an access list — the three things an unlisted URL on a
          static host never gives you.</p>
        <ul>
          <li><b>Private by default.</b> A new artifact is restricted to its owner until they share it.</li>
          <li><b>Owned.</b> The person who published it manages it; nobody else can, however they were shared with.</li>
          <li><b>Versioned.</b> Re-publishing creates the next version at the same address.</li>
          <li><b>Observable.</b> The owner sees every view: person, time, country, version.</li>
        </ul>
      </section>

      <section id="use-cases">
        <h2>Who uses it, and for what</h2>
        <p>Made for the work that comes out of an AI session: a finished page, a dashboard, a
          prototype, a report — something real, that needs a link today and shouldn't be on the
          open web.</p>
        <div class="cases">
          <div class="case"><span class="pill">Developers</span>
            <h3>Ship an agent's output without a pipeline</h3>
            <p>Claude Code just produced a working page. Publish it straight from the session —
              no repo, no build, no CDN config — and send the link before you lose the context.</p></div>
          <div class="case"><span class="pill">Consultants &amp; agencies</span>
            <h3>Client-ready links that stay off the open web</h3>
            <p>Share a deliverable with exactly the people on the account, watch who actually
              opened it, and roll back the moment a revision lands badly.</p></div>
          <div class="case"><span class="pill">Product &amp; data teams</span>
            <h3>An internal home for dashboards and prototypes</h3>
            <p>Stop mailing HTML attachments and unlisted URLs. Publish once, grant the team,
              and let the version history be the changelog.</p></div>
        </div>
      </section>

      <section id="publishing">
        <h2>Publishing</h2>
        <p>Three ways in, one behaviour. A file, a directory or a zip all work; a bundle keeps its
          relative paths, so <code>./assets/app.js</code> resolves the way it did locally.</p>
        <h3>From the terminal</h3>
        <pre class="code"><code>$ export ARTIFACTS_URL=https://rtfx.pro
$ export RTFX_API_TOKEN=rtfx_…    # dashboard → Integrations

$ artifacts publish ./index.html --slug q3-report --title "Q3 Report"
$ artifacts publish ./site --slug q3-report --note "revised charts"   # next version
$ artifacts grant q3-report alex@example.com
$ artifacts views q3-report
$ artifacts list</code></pre>
        <h3>From the dashboard</h3>
        <p>Drop a file or zip into the publish panel under <b>Artifacts</b>, set a title, and it's
          live at its slug. Each artifact then has its own page, holding version history, sharing
          and the view log.</p>
        <h3>Over HTTP</h3>
        <pre class="code"><code>$ curl -X POST https://rtfx.pro/api/artifacts \\
    -H "Authorization: Bearer $RTFX_API_TOKEN" \\
    -F slug=q3-report -F title="Q3 Report" -F file=@./dist.zip</code></pre>
      </section>

      <section id="agents">
        <h2>Claude Code &amp; Hermes</h2>
        <p>Agents publish through exactly the same CLI and API a human uses — there is no separate,
          weaker agent path. Mint an API token in the dashboard, scope it to <code>publish</code>,
          and hand it to the session:</p>
        <pre class="code"><code># in a Claude Code or Hermes session
$ artifacts publish ./out --slug prototype --title "Checkout prototype"
$ artifacts grant prototype teammate@example.com</code></pre>
        <h3>The Claude Code plugin</h3>
        <p>Installing the plugin turns that into ordinary conversation: say <i>publish this</i> and
          the session picks the build output, versions it under a slug and hands back the link.
          It ships a skill, five slash commands, and a dependency-free publisher.</p>
        <pre class="code" data-docs="claude-code-plugin"><code>/plugin marketplace add yogevgab/artifacts-server
/plugin install rtfx@rtfx

/rtfx:setup       # check the token reaches your instance
/rtfx:publish     # publish what the session just built
/rtfx:versions    # history · /rtfx:rollback to go back</code></pre>
        <div class="callout">
          <p><b>Why a token, not your login.</b> An API token is bound to its owner, carries only the
            scopes you give it (<code>read</code>, <code>publish</code>, <code>manage</code>), and can
            be revoked on its own. An agent holding one can publish as you — it can never become you,
            manage other people, or reach anyone else's artifacts.</p>
        </div>
      </section>

      <section id="access">
        <h2>Access &amp; privacy model</h2>
        <p>There are two independent layers, and both must say yes.</p>
        <ol>
          <li><b>Who may sign in at all.</b> Cloudflare Access is the identity provider; the people
            list is managed in the dashboard. Sign-in is passwordless — a one-time code by email.
            Access to rtfx.pro is by invitation.</li>
          <li><b>Who may open a given artifact.</b> Either <i>restricted</i> (the owner plus the
            people they name) or <i>everyone signed in</i>. Sharing one artifact never widens who can
            sign in, and never exposes anything else you own.</li>
        </ol>
        <p>An unauthorized request and a request for something that doesn't exist get the identical
          404, so a link can't be used to confirm that a page exists. Artifact content is served from
          a dedicated origin that hosts files only — never the dashboard or the API — so uploaded
          HTML can't reach the app it was published from.</p>
        <p>None of it is crawlable: artifacts, the dashboard and the API are excluded in
          <a href="/robots.txt">robots.txt</a>, marked <code>noindex</code>, and served with an
          <code>X-Robots-Tag: noindex</code> header. The only indexable pages are this one, the
          landing page, the sign-in page and the two legal pages.</p>
        <p>What rtfx.pro itself stores about you — and the fact that it runs no analytics,
          advertising or third-party tracking — is set out in the
          <a href="/privacy">privacy policy</a>. What you agree to by publishing here is in the
          <a href="/terms">terms of use</a>.</p>
      </section>

      <section id="versions">
        <h2>Versions &amp; view logs</h2>
        <p>Every publish to a slug creates the next immutable version. The public link always points
          at the current one; each older version keeps its own preview URL for whoever manages the
          artifact, and rollback is a single action. Nothing is overwritten, so a bad revision is a
          click to undo rather than a re-run of whatever produced it.</p>
        <p>The view log answers the question client work always ends with: who opened it, when, from
          where, and which version they saw. Views are recorded for signed-in people opening a page —
          not for asset requests or machine tokens.</p>
      </section>

      <section id="why">
        <h2>Why not a generic static host?</h2>
        <p>You could put this on any bucket or edge host. Here's what you'd then have to build
          yourself.</p>
        <div class="table-wrap"><table class="compare">
          <thead><tr><th scope="col">What you need</th><th scope="col">Generic static hosting</th><th scope="col">rtfx.pro</th></tr></thead>
          <tbody>
            <tr><th scope="row">Privacy</th><td>Public by default; an unlisted URL is the whole defence — anyone with the link is in.</td><td>Private by default. Access is per artifact, per person, and revocable.</td></tr>
            <tr><th scope="row">Identity</th><td>Bring your own auth, or bolt on a password everyone shares.</td><td>Passwordless sign-in through Cloudflare Access, with a managed people list.</td></tr>
            <tr><th scope="row">Versions</th><td>A deploy overwrites the last one; rollback means a rebuild.</td><td>Every publish is an immutable version with its own preview and one-click rollback.</td></tr>
            <tr><th scope="row">Audit</th><td>Raw request logs, if you wire up analytics.</td><td>A per-artifact view log: person, time, country, version.</td></tr>
            <tr><th scope="row">Agent workflow</th><td>Git push, build, wait, configure.</td><td>One command, or one API call, from inside the session that made the page.</td></tr>
          </tbody>
        </table></div>
      </section>

      <section id="api">
        <h2>API</h2>
        <p>Authenticate with <code>Authorization: Bearer &lt;token&gt;</code>. Every endpoint is
          scoped to what the token's owner may see; an admin sees everything they administer.</p>
        <ul>
          <li><code>GET /api/artifacts</code> — list artifacts you can manage.</li>
          <li><code>POST /api/artifacts</code> — publish (multipart: <code>title</code>,
            <code>slug</code>, <code>file</code>).</li>
          <li><code>GET /api/artifacts/:slug/versions</code> — version history.</li>
          <li><code>POST /api/artifacts/:slug/rollback</code> — restore a previous version.</li>
          <li><code>POST /api/artifacts/:slug/access</code> — set visibility and the share list.</li>
          <li><code>DELETE /api/artifacts/:slug</code> — delete an artifact and its versions.</li>
        </ul>
        <p>The API lives behind sign-in; these paths are documented here but are not public. Full
          request/response detail ships with the CLI (<code>artifacts --help</code>) and in the
          dashboard once you have access.</p>
      </section>

      <section id="faq">
        <h2>Frequently asked</h2>
        <div class="faq">${faqHtml()}</div>
      </section>

      <section class="doc-cta">
        <h2>Get an account</h2>
        <p>Access is invite-only — tell us where to send yours.</p>
        <div class="actions">
          <a class="link-button" href="/#waitlist" data-cta="request-access">Request access</a>
          <a class="ghost link-button" href="/login" data-cta="sign-in">Sign in</a>
        </div>
      </section>
    </article>
    </main>

    ${siteFooter()}
    ${cookieNotice()}
    <script>${CONSENT_SCRIPT}</script>`;
  return layout(TITLE, body, DOCS_STYLE, {
    description: DESCRIPTION,
    canonical: canonicalUrl(env, "/docs"),
    image: canonicalUrl(env, "/og.svg"),
    socialTitle: "rtfx.pro docs — publishing, access control and the API",
    jsonLd: structuredData(env),
  });
}
