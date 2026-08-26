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
/* --- positioning: table stakes vs differentiators (issue #38) --- */
.stance{display:grid;gap:.7rem;margin:0 0 .9rem;padding:0;list-style:none}
.stance li{border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card);padding:.85rem 1rem;margin:0;color:var(--muted)}
.stance li b{color:var(--fg);font-weight:650;letter-spacing:-.015em}
/* The "Not built" label is real markup (span.stance-flag), not a CSS
   pseudo-element. It used to be li b:after with a content string — which meant
   the single most important word on the page existed only in the stylesheet.
   Every text extractor that matters here — Googlebot's rendered-text index,
   GPTBot, ClaudeBot, Perplexity, any readability-style scraper — and every
   screen reader read the list as four plain feature descriptions sitting under
   a heading, with nothing marking them as absent. That is precisely the
   feature-misattribution this whole section, and llms.txt, exist to prevent:
   the defence was invisible to the readers it was written for. */
.stance-flag{display:inline-block;margin-left:.55rem;border:1px solid var(--border);border-radius:999px;padding:.12rem .55rem;font-size:.7rem;font-weight:600;letter-spacing:.04em;color:var(--faint);text-transform:uppercase;white-space:nowrap;vertical-align:.05em}
`;

const TITLE = "Publish from Claude Code or MCP · rtfx.pro docs";
const DESCRIPTION =
  "How rtfx.pro works: connect Claude Code with a browser sign-in, publish pages, PDFs and " +
  "multi-file artifacts from the plugin, the MCP server, Hermes, the CLI or the API; control " +
  "who can open each one; keep every version; and see exactly who viewed what — plus what is " +
  "table stakes in this category and what actually makes rtfx.pro different.";

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
    q: "How do I publish from Claude Code, an MCP client or a Hermes run?",
    a:
      "Give the agent a scoped API token and let it call the same CLI or HTTP API you use. The " +
      "Claude Code plugin is the shortest path: install it from the project's marketplace and " +
      "'publish this' becomes the last step of an ordinary session. The same plugin ships a " +
      "native MCP server, so a client with no shell — Claude Desktop, for instance — publishes " +
      "as a tool call over the same path. From a terminal, run the CLI out of a checkout of the " +
      "project: `node cli/artifacts.mjs publish ./out --slug client-demo` handles a single file, " +
      "a folder or a zip. There is no npm package to install yet, and nothing here pretends " +
      "there is. A token is bound to its owner and can be revoked at any time, so the agent " +
      "never gains your account.",
  },
  {
    q: "Can the remote MCP endpoint at mcp.rtfx.pro publish for me?",
    a:
      "Yes, when the content is sent inside the tool call. The hosted endpoint is authorized in " +
      "the browser over OAuth and exposes publish, read tools and manage-scoped artifact lifecycle tools. Remote publish accepts an HTML page " +
      "as text, a PDF as base64, or a small explicit file list; it rejects path, folder and zip-path " +
      "arguments because a server-side endpoint cannot read the client's local filesystem. Use the " +
      "Claude Code plugin or local MCP server for large folders and build outputs that already exist " +
      "on disk.",
  },
  {
    q: "Do I still have to copy an API token to use Claude Code?",
    a:
      "Not for ordinary use. Install the plugin and run /rtfx:login: it opens a browser sign-in " +
      "and stores a renewing local credential with owner-only permissions, printing only a token " +
      "id and never the token itself. A scoped RTFX_API_TOKEN from Integrations still works and " +
      "takes priority over the browser sign-in, which is what CI and scripted automation should " +
      "use.",
  },
  {
    q: "What happens when I publish the same slug twice?",
    a:
      "You get a new immutable version at the same URL. On the free plan the five most recent "
      + "versions are kept and older ones expire; paid plans keep every version. Retained versions stay addressable for " +
      "preview, and rollback is one click — nothing you have already shared is overwritten or lost.",
  },
  {
    q: "Who can sign in to rtfx.pro?",
    a:
      "Signup is self-serve. rtfx.pro is the identity provider and sign-in is passwordless — " +
      "create an account or sign in with a one-time code or magic link by email. Every workspace " +
      "starts on Free; paid plans are optional upgrades from Settings.",
  },
  {
    q: "Can someone I share an artifact with see my other artifacts?",
    a:
      "No. A grant applies to exactly one artifact. It never confers management rights, never " +
      "reveals your other work, and never widens who can sign in.",
  },
  {
    q: "Can I put a password on a share link?",
    a:
      "Not today, and nothing here pretends otherwise. Access is by identity instead: you name " +
      "the people who may open an artifact, and everyone else — signed in or not — gets a 404. " +
      "Sign-in itself is passwordless — a one-time code or magic link by email — so there is " +
      "no shared secret to leak, rotate or forget. Per-link secrets and custom domains are " +
      "listed as not built on this page; share links with optional expiry are built.",
  },
  {
    q: "How is this different from the other tools for sharing what Claude built?",
    a:
      "Most of them start from a public link and add controls on top of it. rtfx.pro starts " +
      "locked, and sharing is a deliberate act you can see and undo. The differences that " +
      "survive a real project: publishing is agent-native — Claude Code, Hermes, a CLI and the " +
      "HTTP API all take the same path — access is an identity-backed list rather than a secret " +
      "URL, every publish is an immutable version you can roll back, the view log names the " +
      "person and the version they saw, and a workspace has roles so a team is not one shared " +
      "login.",
  },
  {
    q: "Where does the uploaded HTML actually run?",
    a:
      "On a separate content origin (a.rtfx.pro) that serves artifact files and nothing else — " +
      "no dashboard, no API, no admin. Uploaded HTML therefore can never run in the same origin " +
      "as the app that manages it. That boundary sits between your artifacts and rtfx.pro, not " +
      "between one artifact and the next: every artifact is served from the same content origin " +
      "today, so what keeps one publisher's page away from another's is the access list, not the " +
      "browser. If you need two mutually distrusting publishers isolated by the browser itself, " +
      "that is not what this origin split gives you.",
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
      <p class="lede">rtfx.pro hosts the pages, PDFs and multi-file artifacts that come out of an
        AI session — from Claude Code, Hermes, your terminal or your browser — behind real access
        control instead of an unlisted URL.</p>
    </div>

    <nav class="toc" aria-label="On this page">
      <a href="#overview">Overview</a>
      <a href="#use-cases">Use cases</a>
      <a href="#publishing">Publishing</a>
      <a href="#agents">Connectors</a>
      <a href="#access">Access &amp; privacy</a>
      <a href="#versions">Versions &amp; views</a>
      <a href="#why-rtfx">Why rtfx.pro</a>
      <a href="#why">Why not a static host</a>
      <a href="#api">API</a>
      <a href="#faq">FAQ</a>
    </nav>

    <article class="doc">
      <section id="overview">
        <h2>What rtfx.pro is</h2>
        <p>An artifact is one publishable thing: a single HTML page, a PDF, or a folder/zip with its own
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
        <p>The CLI ships in the project repository — there is no npm package yet, so you run it
          from a checkout (or from the Claude Code plugin below, which needs no checkout at all).</p>
        <pre class="code"><code>$ git clone https://github.com/yogevgab/artifacts-server
$ cd artifacts-server &amp;&amp; npm install

$ export ARTIFACTS_URL=https://rtfx.pro
$ export RTFX_API_TOKEN=rtfx_…    # dashboard → Integrations

$ node cli/artifacts.mjs publish ./index.html --slug q3-report --title "Q3 Report"
$ node cli/artifacts.mjs publish ./site --slug q3-report --note "revised charts"   # next version
$ node cli/artifacts.mjs grant q3-report alex@example.com
$ node cli/artifacts.mjs views q3-report
$ node cli/artifacts.mjs list</code></pre>
        <h3>From the dashboard</h3>
        <p>Drop a file or zip into the publish panel under <b>Artifacts</b>, set a title, and it's
          live at its slug. Each artifact then has its own page, holding version history, sharing
          and the view log.</p>
        <h3>Over HTTP</h3>
        <p>The upload field decides how the file is read, not its extension: a zip goes in
          <code>bundle</code>, a single HTML or PDF document in <code>file</code>. A bundle needs
          <code>index.html</code> at its root.</p>
        <pre class="code" data-docs="http-publish"><code>$ export RTFX_API_TOKEN=rtfx_…              # dashboard → Integrations

# a zip — zip the folder first over HTTP → bundle
$ curl -X POST https://rtfx.pro/api/machine/artifacts \\
    -H "Authorization: Bearer $RTFX_API_TOKEN" \\
    -F slug=q3-report -F title="Q3 Report" -F bundle=@./dist.zip

# one HTML document or PDF → file
$ curl -X POST https://rtfx.pro/api/machine/artifacts \
    -H "Authorization: Bearer ***" \
    -F slug=q3-report -F title="Q3 Report" -F file=@./index.html

# PDF works through the same file= field
$ curl -X POST https://rtfx.pro/api/machine/artifacts \
    -H "Authorization: Bearer ***" \
    -F slug=board-pack -F title="Board Pack" -F file=@./board-pack.pdf</code></pre>
        <p><b>One credential.</b> <code>/api/machine</code> is the machine surface: it
          authenticates the bearer token and nothing else, so the API token you minted in the
          dashboard is all a script, an agent or a CI job needs. It carries the same rules as the
          rest of the product — your scopes, your artifacts — and it deliberately does not answer
          for user management or token issuance, which need a real sign-in. The browser dashboard
          keeps using <code>/api</code>, where a session identifies you instead.</p>
        <p class="muted"><b>Self-hosting?</b> An instance that gates every path at the edge with
          Cloudflare Access can pass a service token through as well, by adding
          <code>CF-Access-Client-Id</code> and <code>CF-Access-Client-Secret</code> headers; the CLI
          and the MCP server send them automatically when <code>CF_ACCESS_CLIENT_ID</code> and
          <code>CF_ACCESS_CLIENT_SECRET</code> are set. They get a request past Access and grant
          nothing inside the app. On rtfx.pro they are not needed.</p>
      </section>

      <section id="agents">
        <h2>Connectors: Claude Code, MCP &amp; Hermes</h2>
        <p>Four ways to connect an agent, and they are not interchangeable: the local surfaces can
          publish by reading paths beside the client, while the hosted MCP surface publishes only
          content sent inside the tool call. This is the whole table before the detail:</p>
        <!-- The "Publishes?" column is the load-bearing one. mcp.rtfx.pro can
             publish content bytes supplied in the MCP call, but it must never be
             described as a remote path reader. Stated as a row rather than a footnote. -->
        <div class="table-wrap"><table class="compare" data-docs="connectors">
          <thead><tr><th scope="col">Connector</th><th scope="col">How you connect</th><th scope="col">Publishes?</th><th scope="col">Best for</th></tr></thead>
          <tbody>
            <tr data-connector="claude-code-plugin"><th scope="row">Claude Code plugin</th>
              <td><code>/rtfx:login</code> — a browser sign-in, no token to copy</td>
              <td>Yes</td>
              <td>Publishing what the session just built.</td></tr>
            <tr data-connector="local-mcp"><th scope="row">Local MCP server</th>
              <td>Ships inside the plugin; installing the plugin registers it</td>
              <td>Yes — it runs beside your files</td>
              <td>An MCP client with no shell, such as Claude Desktop.</td></tr>
            <tr data-connector="remote-mcp"><th scope="row">Remote MCP — <code>mcp.rtfx.pro</code></th>
              <td><code>claude mcp login rtfx</code> — OAuth, authorization code with PKCE</td>
              <td>Yes — content sent in the tool call, not filesystem paths</td>
              <td>Publishing an HTML page, PDF or small explicit file list from a hosted MCP client.</td></tr>
            <tr data-connector="api-cli-hermes"><th scope="row">API, CLI and Hermes</th>
              <td>A scoped <code>RTFX_API_TOKEN</code> minted in the dashboard</td>
              <td>Yes</td>
              <td>CI, scripts and automation you own.</td></tr>
          </tbody>
        </table></div>
        <p>Agents publish through exactly the same CLI and API a human uses — there is no separate,
          weaker agent path. The plugin's browser sign-in is the short path; for CI, mint an API
          token in the dashboard with the <code>read</code> and <code>publish</code> scopes and hand
          it to the session:</p>
        <!-- read *and* publish, not publish alone. /rtfx:publish looks the slug
             up before it writes, so that it can tell a new artifact from a new
             version of an existing one — and that lookup is GET /api/artifacts,
             which requires the read scope. A publish-only token fails on the
             first step of the command this page is recommending. -->
        <pre class="code"><code># in a Claude Code session, with the plugin installed
/rtfx:publish ./out client-demo

# or from any shell — Claude Code, Hermes, CI — in a checkout of the project
$ node cli/artifacts.mjs publish ./out --slug client-demo --title "Checkout prototype"</code></pre>
        <p>Sharing is deliberately not part of the agent surface: <code>grant</code> needs the
          <code>manage</code> scope and lives with the rest of access control under
          <a href="#access">Access &amp; privacy</a>. An agent publishes; a person decides who
          may read.</p>
        <h3>The Claude Code plugin</h3>
        <p>Two commands to install, one browser sign-in to connect. After that <i>publish this</i> is
          an ordinary sentence: the session picks the build output, versions it under a slug and hands
          back the link. The plugin ships a skill, seven slash commands and a dependency-free
          publisher — nothing to clone and no package to install, since it brings its own copy.</p>
        <pre class="code" data-docs="claude-code-plugin"><code>/plugin marketplace add yogevgab/artifacts-server
/plugin install rtfx@rtfx

/rtfx:login       # browser OAuth sign-in; stores a local renewing credential
/rtfx:setup       # confirm your credential reaches your instance
/rtfx:publish     # publish what the session just built
/rtfx:versions    # history · /rtfx:rollback to go back</code></pre>
        <p>The plugin's browser login stores a local credential with owner-only permissions and prints
          only a token id, never the token. For CI and advanced scripts, a scoped
          <code>RTFX_API_TOKEN</code> from Integrations still works and takes priority over the
          browser sign-in.</p>
        <h3>The Claude Desktop extension and local MCP server</h3>
        <p>For Claude Desktop, the easiest local install is <a href="https://github.com/yogevgab/artifacts-server/releases/download/v1.1.0/rtfx.dxt"><code>rtfx.dxt</code></a>: open the Desktop
          Extension package and Claude Desktop registers the rtfx MCP server for you. The same plugin
          also ships the native MCP server directly, for manual setup or any other client that speaks
          MCP. This local server publishes, lists versions and rolls back as tool calls, holding the
          same scoped token and applying the same credential filters as the CLI. Because it runs on
          your machine, it can publish local paths and folders. To wire it up by hand instead, point
          a client at the server file inside the installed plugin (or inside a checkout) — it needs
          Node and nothing else:</p>
        <pre class="code" data-docs="mcp-server"><code>{ "mcpServers": { "rtfx": {
    "command": "node",
    "args": ["/path/to/plugins/rtfx/scripts/rtfx-mcp.mjs"],
    "env": { "RTFX_API_TOKEN": "rtfx_…" } } } }

tools: publish · list_artifacts · get_versions · rollback · doctor</code></pre>
        <h3>Remote MCP, authorized in the browser</h3>
        <p>rtfx.pro also runs a hosted MCP endpoint at <code>https://mcp.rtfx.pro/mcp</code>. A
          compliant client discovers the authorization server from the endpoint's own challenge and
          takes you through an ordinary browser sign-in and consent screen — authorization code with
          PKCE, refresh and revocation, and no bearer token to paste anywhere:</p>
        <pre class="code" data-docs="remote-mcp"><code>$ claude mcp add --transport http rtfx https://mcp.rtfx.pro/mcp
$ claude mcp login rtfx

tools: publish · list_artifacts · artifact_details · artifact_statistics · share_artifact · rollback_artifact · delete_artifact · doctor</code></pre>
        <p><b>It publishes content; it does not read paths.</b> The hosted endpoint exposes
          <code>publish</code> for bytes sent inside the MCP call — an HTML page as text, a PDF as
          base64, or a small explicit file list — plus read tools for listing/details/statistics and
          manage-scoped tools for sharing, rollback and deletion. It deliberately refuses
          <code>path</code>, <code>folder</code> and similar arguments: a
          server-side endpoint asked for a path could only ever read the server's disk, not the
          client's. Large build outputs and local directories still belong to the plugin and the
          local MCP server.</p>
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
          <li><b>Who may sign in at all.</b> rtfx.pro owns the identity layer. Signup and sign-in are
            passwordless — a one-time code or magic link by email — and every new workspace starts
            on the Free plan.</li>
          <li><b>Who may open a given artifact.</b> Either <i>restricted</i> (the owner plus the
            people they name) or <i>everyone signed in</i>. Sharing one artifact never widens who can
            sign in, and never exposes anything else you own.</li>
        </ol>
        <p>An unauthorized request and a request for something that doesn't exist get the identical
          404, so a link can't be used to confirm that a page exists. Artifact content is served from
          a dedicated origin that hosts files only — never the dashboard or the API — so uploaded
          HTML can't reach the app it was published from.</p>
        <p>Worth being precise about what that origin does and doesn't do: it separates published
          content from rtfx.pro, and all artifacts share it. It is not a per-artifact browser
          sandbox, so two pages published by people who don't trust each other are kept apart by the
          access list — who may open what — rather than by the browser's origin boundary. Publish
          only what you're willing to run in the same origin as your other artifacts.</p>
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

      <!-- Issue #38. A category has formed around "share what Claude just built",
           and most of it converges on the same feature list. The honest thing to
           publish is the split: what is table stakes, what is genuinely ours, and
           what we simply do not have yet. The last list is not an apology — it is
           what stops this page from claiming a per-link password we never shipped. -->
      <section id="why-rtfx" data-docs="why-rtfx">
        <h2>Why rtfx.pro</h2>
        <p>Several tools now host the page an AI session just produced, and they mostly agree on
          the basics. So the useful question is not "does it host HTML" — it is what happens on the
          second day, when the link is out, the client asks who has seen it, and a revision lands
          badly. Here is the split, written so you can decide in one screen.</p>

        <h3>Table stakes</h3>
        <p>Present here, and expected of anything in this category. Nobody should pick a tool for
          these.</p>
        <ul class="stance" data-positioning="table-stakes">
          <li><b>Publishing with no build step.</b> A single HTML file, a PDF, a folder or a zip goes up as
            it is; relative paths keep working.</li>
          <li><b>A stable link.</b> One slug, one URL, for as long as the artifact exists.</li>
          <li><b>Re-publishing to the same address.</b> The link you already sent keeps working
            after an update.</li>
          <li><b>A dashboard.</b> Drag-and-drop publishing, an inventory, and the state of each
            artifact in one place.</li>
          <li><b>Some idea of who looked.</b> Counts at minimum.</li>
        </ul>

        <h3>What actually makes it different</h3>
        <p>These are the reasons to choose rtfx.pro over a general "share your AI output" tool.</p>
        <ul class="stance" data-positioning="differentiators">
          <li><b>Agent-native publishing, not an upload form with an API bolted on.</b> Claude Code,
            a native MCP server, a Hermes run, the CLI and the HTTP API all take the same path a
            human takes — there is no separate, weaker agent route. Connecting Claude Code is a
            browser sign-in rather than a token you copy between two windows, and what it leaves
            behind is still a scoped, owner-bound, revocable credential: an agent can publish as
            you and can never become you.</li>
          <li><b>Access is an identity, not a secret URL.</b> Every artifact is restricted until you
            name someone. An unauthorized request and a request for something that doesn't exist
            return the identical 404, so a leaked link can't even confirm the page is real. Sharing
            is revocable, per artifact, and never widens who can sign in.</li>
          <li><b>Immutable versions with one-click rollback.</b> Every publish is a new version with
            its own preview URL. Nothing you have already shared is overwritten, so a bad revision
            is an undo rather than a re-run of whatever produced it.</li>
          <li><b>A view log that names a person and a version.</b> Not a hit counter: who opened it,
            when, from which country, and which version they saw — the question every client
            project ends with.</li>
          <li><b>Workspace governance.</b> Artifacts belong to a workspace, not to one shared login.
            Members carry a role — owner, admin, member or viewer — and instance privilege is
            re-derived from configuration on every request, so no database write can escalate
            anyone.</li>
          <li><b>Uploaded HTML runs somewhere it can't reach us.</b> Artifact files are served from a
            dedicated content origin that hosts files and nothing else — no dashboard, no API, no
            admin — so a page you publish can never touch the app that published it. Artifacts share
            that one content origin, so it isolates published content from rtfx.pro rather than
            artifacts from each other.</li>
          <li><b>Nothing watches the visitor.</b> No analytics, advertising or third-party tracking
            anywhere on this site, and none injected into what you publish. The view log is ours to
            show you, not a product we resell.</li>
        </ul>

        <h3>Not here yet</h3>
        <p>Listed so you know they are deliberate gaps rather than things you failed to find. If a
          project needs one of these today, this is the honest place to find that out.</p>
        <ul class="stance" data-positioning="not-yet">
          <li><b>Per-link secrets.</b> <span class="stance-flag">Not built</span> A shared password
            on the link itself, separate from the recipient's email identity. Today the answer is an
            identity-backed access list, an optional share link, and optional expiry.</li>
          <li><b>Custom domains.</b> <span class="stance-flag">Not built</span> Serving artifacts
            from your own hostname. Content already runs on its own origin, which is the hard
            part.</li>
          <li><b>Comments, approvals and polls.</b> <span class="stance-flag">Not built</span>
            rtfx.pro publishes and controls the artifact; it is not the review tool around it.</li>
          <li><b>Approvals, polls and review workflows.</b> <span class="stance-flag">Not built</span>
            rtfx.pro can show read receipts and access requests, but it is not a review workflow
            system around the artifact yet.</li>
        </ul>
      </section>

      <section id="why">
        <h2>Why not a generic static host?</h2>
        <p>You could put this on any bucket or edge host. Here's what you'd then have to build
          yourself.</p>
        <div class="table-wrap"><table class="compare">
          <thead><tr><th scope="col">What you need</th><th scope="col">Generic static hosting</th><th scope="col">rtfx.pro</th></tr></thead>
          <tbody>
            <tr><th scope="row">Privacy</th><td>Public by default; an unlisted URL is the whole defence — anyone with the link is in.</td><td>Private by default. Access is per artifact, per person, and revocable.</td></tr>
            <tr><th scope="row">Identity</th><td>Bring your own auth, or bolt on a password everyone shares.</td><td>Passwordless rtfx.pro email sign-in, workspace members and per-artifact guests.</td></tr>
            <tr><th scope="row">Versions</th><td>A deploy overwrites the last one; rollback means a rebuild.</td><td>Every publish is an immutable version with its own preview and one-click rollback.</td></tr>
            <tr><th scope="row">Audit</th><td>Raw request logs, if you wire up analytics.</td><td>A per-artifact view log: person, time, country, version.</td></tr>
            <tr><th scope="row">Agent workflow</th><td>Git push, build, wait, configure.</td><td>One command, or one API call, from inside the session that made the page.</td></tr>
          </tbody>
        </table></div>
      </section>

      <section id="api">
        <h2>API</h2>
        <p>Authenticate with <code>Authorization: Bearer &lt;token&gt;</code> and nothing else.
          Every endpoint is scoped to what the token's owner may see; an admin sees everything they
          administer. See <a href="#publishing">Publishing</a> for a runnable call.</p>
        <ul>
          <li><code>GET /api/machine/artifacts</code> — list artifacts you can manage.</li>
          <li><code>POST /api/machine/artifacts</code> — publish (multipart: <code>title</code>,
            <code>slug</code>, and either <code>file</code> for one <code>.html</code> document or
            <code>bundle</code> for a <code>.zip</code>).</li>
          <li><code>GET /api/machine/artifacts/:slug/versions</code> — version history.</li>
          <li><code>POST /api/machine/artifacts/:slug/current</code> — make an earlier version live
            again (JSON: <code>{"version": 1}</code>).</li>
          <li><code>GET /api/machine/artifacts/:slug/views</code> — the view log.</li>
          <li><code>PUT /api/machine/artifacts/:slug/access</code> — set visibility and the share
            list (JSON: <code>visibility</code>, <code>emails</code>).</li>
          <li><code>DELETE /api/machine/artifacts/:slug</code> — delete an artifact and its
            versions.</li>
        </ul>
        <p><code>read</code> covers the listings, <code>publish</code> covers publishing and
          rollback, <code>manage</code> covers sharing and deletion — a token holds only the scopes
          you gave it. Managing people or minting tokens is not on this surface at all: those need
          a signed-in session, so a leaked token can never widen its own reach.</p>
        <p>The artifacts themselves live behind sign-in; these paths are documented here but the
          data is not public. Full request/response detail ships with the CLI
          (<code>node cli/artifacts.mjs --help</code> in a checkout) and in the dashboard once you
          have access.</p>
      </section>

      <section id="faq">
        <h2>Frequently asked</h2>
        <div class="faq">${faqHtml()}</div>
      </section>

      <section class="doc-cta">
        <h2>Get an account</h2>
        <p>Create a workspace on the Free plan, or sign in if you already have one.</p>
        <div class="actions">
          <a class="link-button" href="/signup" data-cta="signup">Start free</a>
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
    image: canonicalUrl(env, "/og.png"),
    socialTitle: "rtfx.pro docs — publishing, access control and the API",
    jsonLd: structuredData(env),
  });
}
