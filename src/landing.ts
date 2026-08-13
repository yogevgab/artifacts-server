import { layout } from "./pages";
import type { Env } from "./env";
import { SITE, canonicalUrl } from "./seo";

/**
 * The public product page (issue #29).
 *
 * This is the only page most people will ever see, and it is served to everyone
 * — no Access application in front of it, no identity read, same bytes for a
 * crawler and a customer. Two things follow from that:
 *
 *  - **It reads like a shipped product, not a preview.** Access to rtfx.pro is
 *    by invitation, and the copy says so plainly, but "invite-only" describes
 *    *who can sign in*, never the maturity of the thing they're signing in to.
 *  - **It carries the site's metadata.** Canonical URL, OpenGraph/Twitter card
 *    and structured data all live here (see `src/seo.ts`), because this page is
 *    what gets linked, shared and quoted by an answer engine.
 */

const LANDING_STYLE = `
.wrap{max-width:1180px}
header.top{position:sticky;top:0;z-index:5;margin:-.75rem 0 2.2rem;padding:.72rem .9rem;border:1px solid var(--border);border-radius:999px;background:var(--elev);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);box-shadow:var(--shadow)}
.brand{font-weight:750;letter-spacing:-.03em;display:flex;align-items:center;gap:.45rem;color:var(--fg)}.brand:before{content:"";width:.72rem;height:.72rem;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 0 0 5px var(--accent-weak)}
.nav{display:flex;gap:.9rem;align-items:center}.nav a{color:var(--muted);font-size:.9rem}.nav a.primary{color:var(--fg);border:1px solid var(--border);border-radius:999px;padding:.42rem .78rem;background:rgba(255,255,255,.05)}
.hero{position:relative;padding:5.8rem 0 3.4rem;text-align:center;overflow:hidden}.hero:before{content:"";position:absolute;inset:1.2rem 8% auto;height:17rem;border-radius:999px;background:linear-gradient(90deg,rgba(10,132,255,.18),rgba(100,210,255,.13),transparent);filter:blur(18px);z-index:-1}
.hero h1{font-size:clamp(3rem,8.5vw,6.9rem);line-height:.94;margin:0 auto 1.15rem;max-width:13ch;letter-spacing:-.075em;font-weight:780}
.hero p.lead{font-size:clamp(1.08rem,2vw,1.38rem);color:var(--muted);max-width:43rem;margin:0 auto 2rem;letter-spacing:-.015em}
.hero .cta{display:flex;gap:.72rem;justify-content:center;flex-wrap:wrap}.hero .cta a:hover{text-decoration:none}
.cta-note{color:var(--faint);font-size:.88rem;margin:.95rem auto 0;max-width:32rem}.cta-note b{color:var(--muted);font-weight:600}
#waitlist .note{margin-top:1.1rem}
.badge-row{display:flex;gap:.55rem;justify-content:center;margin-bottom:1.15rem;flex-wrap:wrap}.pill{border:1px solid var(--border);border-radius:999px;padding:.36rem .86rem;font-size:.82rem;color:var(--muted);background:rgba(255,255,255,.05);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.product-shot{margin:2.8rem auto 0;max-width:58rem;border:1px solid var(--border);border-radius:32px;background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.04));box-shadow:0 36px 110px -58px rgba(0,0,0,.85);padding:.78rem;text-align:left}.shot-bar{display:flex;gap:.42rem;padding:.45rem .55rem}.shot-dot{width:.72rem;height:.72rem;border-radius:50%;background:var(--border-strong)}.shot-body{border:1px solid var(--border);border-radius:24px;background:var(--card);padding:1rem;display:grid;grid-template-columns:1.15fr .85fr;gap:1rem}.shot-panel{border:1px solid var(--border);border-radius:20px;padding:1rem;background:rgba(255,255,255,.04)}.shot-line{height:.7rem;border-radius:999px;background:var(--border);margin:.65rem 0}.shot-line.wide{width:88%}.shot-line.mid{width:62%}.shot-line.short{width:38%}
section.band{margin:4.4rem 0}
.band-head{text-align:center;max-width:44rem;margin:0 auto 2rem}
.band-head h2{font-size:clamp(1.9rem,4.2vw,3.1rem);letter-spacing:-.055em;margin:0 0 .6rem;line-height:1.05}
.band-head p{color:var(--muted);margin:0;font-size:1.02rem}
.eyebrow-c{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);margin:0 0 .7rem}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:1rem;margin:0}.feature{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.28rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}.feature h3{margin:0 0 .42rem;font-size:1.04rem;letter-spacing:-.02em}.feature p{margin:0;color:var(--muted);font-size:.92rem}
.cases{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:1rem}
.case{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.4rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.case h3{margin:.15rem 0 .5rem;font-size:1.08rem;letter-spacing:-.025em}.case p{margin:0;color:var(--muted);font-size:.93rem}
/* min-width:0 or the terminal block's longest line becomes the column's minimum
   width, which widens the grid, which widens the page — the whole layout then
   overflows the viewport on a phone. */
.flow{display:grid;grid-template-columns:1.05fr .95fr;gap:1.6rem;align-items:center}
.flow>*{min-width:0}
.flow .copy p{color:var(--muted)}
.flow ul{list-style:none;padding:0;margin:1.1rem 0 0;display:grid;gap:.7rem}
.flow ul li{color:var(--muted);font-size:.95rem;display:flex;gap:.6rem;align-items:flex-start}
.flow ul li:before{content:"";flex:none;width:.5rem;height:.5rem;margin-top:.5rem;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2))}
pre.term{margin:0;background:#05070c;border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem 1.3rem;overflow-x:auto;box-shadow:var(--shadow);font-family:var(--mono);font-size:.86rem;line-height:1.75;color:#dfe5f0}
pre.term .c{color:#7a8496}pre.term .g{color:#30d158}pre.term .b{color:#64d2ff}
/* A 3-column table has a min-content width no phone can honour, and a table that
   can't shrink widens the whole page. It scrolls inside its own box instead. */
.table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);box-shadow:var(--shadow);-webkit-overflow-scrolling:touch}
.compare{width:100%;min-width:34rem;border-collapse:collapse}
.compare th,.compare td{text-align:left;padding:.9rem 1.1rem;border-bottom:1px solid var(--border);font-size:.94rem}
.compare thead th{font-size:.78rem;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);font-weight:600}
.compare tbody th{font-weight:650;color:var(--fg)}.compare td{color:var(--muted)}
.compare tr:last-child th,.compare tr:last-child td{border-bottom:0}
.access{background:linear-gradient(135deg,var(--card),rgba(10,132,255,.09));border:1px solid var(--border);border-radius:32px;padding:2.35rem;text-align:center;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.access h2{font-size:clamp(1.8rem,4vw,2.7rem);letter-spacing:-.055em;margin:0 0 .6rem}
.access p.note{color:var(--muted);max-width:38rem;margin:.55rem auto 0}
#waitlist{background:var(--card);border:1px solid var(--border);border-radius:32px;padding:2.3rem;text-align:center;margin:2.6rem 0;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}#waitlist h2{margin:0 0 .45rem;font-size:clamp(1.8rem,4vw,3rem);letter-spacing:-.055em}#waitlist p{color:var(--muted);margin:0 0 1.3rem}#waitlist form{display:flex;gap:.6rem;justify-content:center;flex-wrap:wrap;max-width:31rem;margin:0 auto}#waitlist input{flex:1;min-width:15rem}#msg{max-width:31rem;margin:.85rem auto 0}
footer.site{text-align:center;color:var(--muted);font-size:.88rem;padding:2.4rem 0 1rem;border-top:1px solid var(--border);margin-top:3rem}
footer.site nav{display:flex;gap:1.1rem;justify-content:center;flex-wrap:wrap;margin-bottom:.9rem}
@media(max-width:760px){header.top{position:static;border-radius:22px}.nav{gap:.55rem}.nav a[data-nav="features"],.nav a[data-nav="use-cases"]{display:none}.hero{padding:3.2rem 0 2rem}.shot-body{grid-template-columns:1fr}.product-shot{border-radius:24px}.flow{grid-template-columns:1fr}section.band{margin:3.2rem 0}}
`;

const SCRIPT = `
const $ = (s)=>document.querySelector(s);
const msg = $('#msg');
function show(text, ok){ msg.textContent=text; msg.style.display='block';
  msg.style.background = ok ? 'rgba(60,160,90,.15)' : 'rgba(200,70,70,.15)';
  msg.style.color = ok ? '#3ca05a' : '#c84646'; }
$('#wl').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const email = $('#email').value.trim();
  show('Sending…', true);
  try {
    const res = await fetch('/waitlist', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) return show('Enter a valid email address.', false);
    show(data.status === 'already' ? "You're already on the list." : "Request received — we'll be in touch.", true);
    e.target.reset();
  } catch (err) { show('Network error — please try again.', false); }
});
`;

const TITLE = "rtfx.pro — private hosting for AI-built pages and artifacts";

/** Structured data: what this site is, and what the product is. */
function structuredData(env: Env): unknown[] {
  const url = canonicalUrl(env, "/");
  const organization = {
    "@type": "Organization",
    "@id": `${url}#organization`,
    name: SITE.name,
    url,
    description: SITE.description,
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
          featureList: [
            "Per-artifact access control",
            "Immutable versions with one-click rollback",
            "View log: who opened an artifact, when, and which version",
            "Publish from the CLI, the API, Claude Code or Hermes",
            "Passwordless sign-in through Cloudflare Access",
          ],
          publisher: { "@id": `${url}#organization` },
        },
      ],
    },
  ];
}

export function landingPage(env: Env): string {
  const body = `
    <header class="top"><a class="brand" href="/">rtfx.pro</a><nav class="nav" aria-label="Primary">
      <a href="#features" data-nav="features">Features</a>
      <a href="#use-cases" data-nav="use-cases">Use cases</a>
      <a href="/docs" data-cta="docs">Docs</a>
      <a href="#waitlist" class="primary" data-cta="request-access">Request access</a>
      <a href="/login" data-cta="sign-in">Sign in →</a>
    </nav></header>

    <section class="hero">
      <div class="badge-row"><span class="pill">Built for AI-generated work</span><span class="pill">Private by default</span><span class="pill">Versioned &amp; audited</span></div>
      <h1>Deploy the thing Claude just made.</h1>
      <p class="lead">rtfx.pro is a quiet, premium home for HTML pages and multi-file artifacts.
        Publish in seconds from your agent, your terminal or your browser — keep client work
        private, version every change, and share a polished link without exposing the conversation
        behind it.</p>
      <div class="cta">
        <a href="#waitlist" data-cta="request-access"><button>Request access</button></a>
        <a href="/docs" data-cta="docs"><button class="ghost">Read the docs</button></a>
      </div>
      <p class="cta-note">Access to rtfx.pro is invite-only, so every page has a known audience.
        <b>Request access</b> if you're new; <b><a href="/login" data-cta="sign-in">sign in</a></b>
        if you already have an account.</p>
      <div class="product-shot" aria-label="Product preview">
        <div class="shot-bar"><span class="shot-dot"></span><span class="shot-dot"></span><span class="shot-dot"></span></div>
        <div class="shot-body">
          <div class="shot-panel"><span class="pill">Published · v4</span><div class="shot-line wide"></div><div class="shot-line mid"></div><div class="shot-line short"></div></div>
          <div class="shot-panel"><span class="pill">Shared with 3 people</span><div class="shot-line mid"></div><div class="shot-line wide"></div><div class="shot-line short"></div></div>
        </div>
      </div>
    </section>

    <section id="features" class="band">
      <div class="band-head">
        <p class="eyebrow-c">The product</p>
        <h2>Hosting that assumes the page is private.</h2>
        <p>Static hosts start public and make privacy your problem. rtfx.pro starts locked,
          and sharing is a deliberate act you can see and undo.</p>
      </div>
      <div class="features">
        <div class="feature"><h3>Per-artifact permissions</h3><p>Keep a page private, share it with
          named people, or open it to everyone on your team. Anyone else gets a 404 — the page
          never even admits it exists.</p></div>
        <div class="feature"><h3>Immutable versions</h3><p>Every re-publish is a new version with
          its own preview URL. Roll back in one click; nothing you shipped is ever overwritten.</p></div>
        <div class="feature"><h3>View log</h3><p>See who opened each artifact, when, from which
          country, and which version they saw — the question every client project ends with.</p></div>
        <div class="feature"><h3>CLI, API and dashboard</h3><p>Publish a file, a folder or a zip
          from your terminal, script it with a scoped API token, or drag it into the dashboard.</p></div>
      </div>
    </section>

    <section id="use-cases" class="band">
      <div class="band-head">
        <p class="eyebrow-c">Use cases</p>
        <h2>Made for the work that comes out of an AI session.</h2>
        <p>A finished page, a dashboard, a prototype, a report — something real, that needs a
          link today and shouldn't be on the open web.</p>
      </div>
      <div class="cases">
        <div class="case"><span class="pill">Developers</span>
          <h3>Ship an agent's output without a pipeline</h3>
          <p>Claude Code just produced a working page. Publish it straight from the session —
            no repo, no build, no CDN config — and send the link before you lose the context.</p></div>
        <div class="case"><span class="pill">Consultants &amp; agencies</span>
          <h3>Client-ready links that stay off the open web</h3>
          <p>Share a deliverable with exactly the people on the account, watch who actually opened
            it, and roll back the moment a revision lands badly.</p></div>
        <div class="case"><span class="pill">Product &amp; data teams</span>
          <h3>An internal home for dashboards and prototypes</h3>
          <p>Stop mailing HTML attachments and unlisted URLs. Publish once, grant the team,
            and let the version history be the changelog.</p></div>
      </div>
    </section>

    <section id="publishing" class="band">
      <div class="flow">
        <div class="copy">
          <p class="eyebrow-c">Claude Code &amp; Hermes native</p>
          <h2 style="font-size:clamp(1.8rem,3.8vw,2.7rem);letter-spacing:-.05em;margin:0 0 .7rem;line-height:1.06">Publishing is the last line of the session.</h2>
          <p>The CLI and the HTTP API are the same surface, so an agent ships exactly the way you
            do. Point Claude Code or a Hermes run at a scoped API token and "publish this" becomes
            one step at the end of the work it just finished.</p>
          <ul>
            <li>One command for a file, a folder or a zip — bundles keep their relative paths.</li>
            <li>Scoped, owner-bound API tokens: an agent can publish without gaining your account.</li>
            <li>Re-publishing the same slug creates the next version, never a second URL.</li>
            <li>Uploaded HTML is served from a separate origin, so it can never touch the dashboard.</li>
          </ul>
        </div>
        <pre class="term" aria-label="Publishing from the terminal"><span class="c"># from your terminal, or from a Claude Code session</span>
$ artifacts publish ./out --title <span class="b">"Q3 Report"</span>
<span class="g">✓</span> published <span class="b">q3-report</span> v4 · 12 files · 840 KB
  <span class="b">https://a.rtfx.pro/q3-report/</span>

$ artifacts grant q3-report alex@client.com
<span class="g">✓</span> alex@client.com can open q3-report
<span class="c"># anyone else: 404. every open: logged.</span></pre>
      </div>
    </section>

    <section id="why" class="band">
      <div class="band-head">
        <p class="eyebrow-c">Differentiators</p>
        <h2>Why not a generic static host?</h2>
        <p>You could put this on any bucket or edge host. Here's what you'd then have to build.</p>
      </div>
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

    <section class="band access">
      <h2>Access is managed, on purpose.</h2>
      <p class="note">rtfx.pro is invite-only: we add teams deliberately so every account has a
        real person behind it, which is what makes per-artifact sharing worth anything. Request
        access and we'll get you an invitation — there's nothing to install and no card to enter.</p>
      <p class="note">Pricing for teams is coming. Accounts created now keep founding pricing when
        it lands.</p>
    </section>

    <section id="waitlist">
      <h2>Request access</h2>
      <p>Tell us where to send your invitation. We onboard a few teams at a time.</p>
      <form id="wl">
        <input id="email" name="email" type="email" required placeholder="you@example.com" autocomplete="email">
        <button type="submit">Request access</button>
      </form>
      <div id="msg"></div>
      <p class="note">Already have an account? <a href="/login" data-cta="sign-in">Sign in instead →</a>
        We'll email you a one-time code — there's no password to set.</p>
    </section>

    <footer class="site">
      <nav aria-label="Footer">
        <a href="/docs" data-cta="docs">Docs</a>
        <a href="#use-cases">Use cases</a>
        <a href="/login" data-cta="sign-in">Sign in</a>
        <a href="/llms.txt">llms.txt</a>
      </nav>
      <div>rtfx.pro — private, versioned hosting for pages and artifacts.</div>
    </footer>
    <script>${SCRIPT}</script>`;
  return layout(TITLE, body, LANDING_STYLE, {
    description: SITE.description,
    canonical: canonicalUrl(env, "/"),
    image: canonicalUrl(env, "/og.svg"),
    socialTitle: `${SITE.name} — ${SITE.tagline}`,
    jsonLd: structuredData(env),
  });
}
