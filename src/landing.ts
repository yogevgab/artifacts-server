import { layout, siteHeader, siteFooter, PUBLIC_CHROME_STYLE } from "./pages";
import { cookieNotice, CONSENT_STYLE, CONSENT_SCRIPT } from "./consent";
import type { Env } from "./env";
import { SITE, canonicalUrl } from "./seo";

/**
 * The public product page (issue #29, simplified in issue #35).
 *
 * This is the only page most people will ever see, and it is served to everyone
 * — no Access application in front of it, no identity read, same bytes for a
 * crawler and a customer. Three things follow from that:
 *
 *  - **It reads like a shipped product, not a preview.** Access to rtfx.pro is
 *    by invitation, and the copy says so plainly, but "invite-only" describes
 *    *who can sign in*, never the maturity of the thing they're signing in to.
 *  - **It carries the site's metadata.** Canonical URL, OpenGraph/Twitter card
 *    and structured data all live here (see `src/seo.ts`), because this page is
 *    what gets linked, shared and quoted by an answer engine.
 *  - **It says one thing.** Issue #35: the page had grown to seven stacked
 *    sections, each arguing a slightly different case. The long-form material —
 *    use cases and the comparison against generic static hosting — moved to
 *    `/docs`, where somebody who wants the detail goes looking for it. Nothing
 *    was deleted: it is still crawlable, still internally linked, just not all
 *    of it above the fold.
 */

const LANDING_STYLE = `${PUBLIC_CHROME_STYLE}${CONSENT_STYLE}
.wrap{max-width:1180px}
.hero{position:relative;padding:5.4rem 0 3rem;text-align:center;overflow:hidden}
.hero:before{content:"";position:absolute;inset:1.2rem 8% auto;height:17rem;border-radius:999px;background:linear-gradient(90deg,rgba(10,132,255,.18),rgba(100,210,255,.13),transparent);filter:blur(18px);z-index:-1}
/* text-wrap:balance so the two sentences break between themselves rather than
   orphaning "share." on its own line; the ch cap is the fallback for browsers
   that don't have it. */
.hero h1{font-size:clamp(2.9rem,8vw,6rem);line-height:.96;margin:0 auto 1.15rem;max-width:18ch;letter-spacing:-.075em;font-weight:780;text-wrap:balance}
.hero p.lead{font-size:clamp(1.08rem,2vw,1.34rem);color:var(--muted);max-width:40rem;margin:0 auto 2rem;letter-spacing:-.015em}
.hero .cta{display:flex;gap:.72rem;justify-content:center;flex-wrap:wrap}.hero .cta a:hover{text-decoration:none}
.cta-note{color:var(--faint);font-size:.88rem;margin:.95rem auto 0;max-width:32rem}.cta-note b{color:var(--muted);font-weight:600}
#waitlist .note{margin-top:1.1rem}
.badge-row{display:flex;gap:.55rem;justify-content:center;margin-bottom:1.15rem;flex-wrap:wrap}.pill{border:1px solid var(--border);border-radius:999px;padding:.36rem .86rem;font-size:.82rem;color:var(--muted);background:rgba(255,255,255,.05);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.product-shot{margin:2.8rem auto 0;max-width:58rem;border:1px solid var(--border);border-radius:32px;background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.04));box-shadow:0 36px 110px -58px rgba(0,0,0,.85);padding:.78rem;text-align:left}.shot-bar{display:flex;gap:.42rem;padding:.45rem .55rem}.shot-dot{width:.72rem;height:.72rem;border-radius:50%;background:var(--border-strong)}.shot-body{border:1px solid var(--border);border-radius:24px;background:var(--card);padding:1rem;display:grid;grid-template-columns:1.15fr .85fr;gap:1rem}.shot-panel{border:1px solid var(--border);border-radius:20px;padding:1rem;background:rgba(255,255,255,.04)}.shot-line{height:.7rem;border-radius:999px;background:var(--border);margin:.65rem 0}.shot-line.wide{width:88%}.shot-line.mid{width:62%}.shot-line.short{width:38%}
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
#waitlist{background:var(--card);border:1px solid var(--border);border-radius:32px;padding:2.3rem;text-align:center;margin:2.6rem 0;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}#waitlist h2{margin:0 0 .45rem;font-size:clamp(1.8rem,4vw,3rem);letter-spacing:-.055em}#waitlist p{color:var(--muted);margin:0 0 1.3rem}#waitlist form{display:flex;gap:.6rem;justify-content:center;flex-wrap:wrap;max-width:31rem;margin:0 auto}#waitlist input{flex:1;min-width:15rem}#msg{max-width:31rem;margin:.85rem auto 0}
@media(max-width:760px){.hero{padding:3rem 0 1.8rem}.shot-body{grid-template-columns:1fr}.product-shot{border-radius:24px}section.band{margin:3rem 0}}
`;

const SCRIPT = `
const $ = (s)=>document.querySelector(s);
const msg = $('#msg');
/* #msg is a polite live region, so this is also what announces the result to a
   screen reader: set the text, unhide, and let the status class carry the
   colour. Colour is never the only signal — the sentence says what happened. */
function show(text, ok){ msg.textContent=text; msg.hidden=false;
  msg.className = ok ? 'is-ok' : 'is-error'; }
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
    ${siteHeader("home")}

    <main id="main">
    <section class="hero">
      <div class="badge-row"><span class="pill">Built for AI-generated work</span><span class="pill">Secure, access-protected sharing</span><span class="pill">Versioned &amp; audited</span></div>
      <h1>Claude creates. We share.</h1>
      <p class="lead">rtfx.pro is the secure, access-protected home for the pages and artifacts
        Claude just built. Publish in seconds, hand out a link only the people you name can open,
        and keep every version.</p>
      <div class="cta">
        <a class="link-button" href="#waitlist" data-cta="request-access">Request access</a>
        <a class="ghost link-button" href="/docs" data-cta="docs">See how it works</a>
      </div>
      <p class="cta-note">Access to rtfx.pro is invite-only, so every page has a known audience.
        <b>Request access</b> if you're new; <b><a href="/login" data-cta="sign-in">sign in</a></b>
        if you already have an account.</p>
      <!-- Decorative: coloured bars standing in for a screenshot. role="img"
           collapses the whole thing to one description, so a screen reader gets
           "a preview of the dashboard" instead of walking a fake UI. -->
      <div class="product-shot" role="img"
        aria-label="Preview of the rtfx.pro dashboard: an artifact published at version 4, shared with three people.">
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
      <p class="band-more">Going deeper: <a href="/docs#use-cases">who uses it and for what</a> ·
        <a href="/docs#why">why not a generic static host</a> ·
        <a href="/docs#agents">publishing from Claude Code</a> ·
        <a href="/docs#faq">FAQ</a></p>
    </section>

    <section id="waitlist">
      <h2>Request access</h2>
      <p>Access is managed on purpose — we onboard a few teams at a time, so every account has a
        real person behind it. Tell us where to send your invitation.</p>
      <form id="wl">
        <!-- A placeholder is not a label: it disappears the moment you type, and
             a screen reader may never announce it at all. -->
        <label class="sr-only" for="email">Email address</label>
        <input id="email" name="email" type="email" required placeholder="you@example.com"
          autocomplete="email" autocapitalize="off" spellcheck="false">
        <button type="submit">Request access</button>
      </form>
      <div id="msg" role="status" aria-live="polite" hidden></div>
      <p class="note">Already have an account? <a href="/login" data-cta="sign-in">Sign in instead →</a>
        We'll email you a one-time code — there's no password to set. Pricing for teams is coming;
        accounts created now keep founding pricing when it lands.</p>
      <p class="note">Submitting this stores your email address so we can send an invitation —
        nothing else. See the <a href="/privacy">privacy policy</a>.</p>
    </section>
    </main>

    ${siteFooter()}
    ${cookieNotice()}
    <script>${SCRIPT}${CONSENT_SCRIPT}</script>`;
  return layout(TITLE, body, LANDING_STYLE, {
    description: SITE.description,
    canonical: canonicalUrl(env, "/"),
    image: canonicalUrl(env, "/og.svg"),
    socialTitle: `${SITE.name} — ${SITE.tagline}`,
    jsonLd: structuredData(env),
  });
}
