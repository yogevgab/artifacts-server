import { layout, siteHeader, siteFooter, PUBLIC_CHROME_STYLE, SOURCE_URL } from "./pages";
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
@media(max-width:760px){.hero{padding:3rem 0 1.8rem}.roundtrip{grid-template-columns:1fr;gap:1.6rem;margin-top:2.4rem}section.band{margin:3rem 0}}
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
$('#wl').addEventListener('submit', async (e)=>{
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
const TITLE = "Private hosting for Claude artifacts and AI-built pages · rtfx.pro";

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
          /* Deliberately no `offers` and no `aggregateRating`. Google wants one
             of them before it will render a SoftwareApplication rich result, and
             we have neither to give: there is no billing, so `price: "0"` would
             advertise a free self-serve tier that does not exist, and a rating
             we invented is the one SEO tactic that earns a manual penalty. The
             lost rich result is the correct trade. */
          featureList: [
            "Per-artifact access control by identity, not a secret link",
            "Agent-native publishing from Claude Code, a native MCP server, Hermes, the CLI or the API",
            "Immutable versions with one-click rollback",
            "View log: who opened an artifact, when, and which version",
            "Workspaces with owner, admin, member and viewer roles",
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
      <div class="badge-row"><span class="pill">Agent-native publishing</span><span class="pill">Secure, access-protected sharing</span><span class="pill">Versioned &amp; audited</span><span class="pill">Workspaces &amp; roles</span></div>
      <h1>Claude creates. We share.</h1>
      <!-- "Artifact" carried the whole page and was never defined on it; the
           definition lived a click away on /docs. It costs four words here. -->
      <p class="lead">rtfx.pro is the secure, access-protected home for the artifacts Claude just
        built — a single HTML page, or a whole folder of them. Publish straight from the session
        that made it, hand out a link only the people you name can open, and keep every version.</p>
      <div class="cta">
        <a class="link-button" href="#waitlist" data-cta="request-access">Request access</a>
        <a class="ghost link-button" href="/docs" data-cta="docs">See how it works</a>
      </div>
      <p class="cta-note">Access to rtfx.pro is invite-only, so every page has a known audience.
        <b>Request access</b> if you're new; <b><a href="/login" data-cta="sign-in">sign in</a></b>
        if you already have an account.</p>
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
  <span class="rt-ok">https://a.rtfx.pro/client-demo/  · v4</span></code></pre>
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
    </section>

    <section id="features" class="band">
      <div class="band-head">
        <p class="eyebrow-c">The product</p>
        <!-- The h1 is the tagline and stays the tagline (pinned in
             test/positioning.test.ts), so the h2 is the only heading free to
             carry the language people actually search for. -->
        <h2>Private hosting for Claude artifacts and AI-built pages.</h2>
        <p>Everyone can host what Claude built. rtfx.pro starts locked, publishes from inside the
          agent session, and makes sharing a deliberate act you can see, version and undo.</p>
      </div>
      <div class="features">
        <div class="feature"><h3>Access by identity, not a secret link</h3><p>Keep a page private,
          share it with named people, or open it to every signed-in user on the instance. Anyone
          else gets a 404 — the page never even admits it exists.</p></div>
        <div class="feature"><h3>Agent-native publishing</h3><p>Claude Code, MCP, Hermes, the CLI
          and the API all take the same path. Hand a session a scoped, revocable token and "publish
          this" becomes the last step of the work.</p></div>
        <div class="feature"><h3>Immutable versions</h3><p>Every re-publish is a new version with
          its own preview URL. Roll back in one click; nothing you shipped is ever overwritten.</p></div>
        <div class="feature"><h3>View log &amp; workspace roles</h3><p>See who opened each artifact,
          when, and which version they saw. Artifacts belong to a workspace with real roles, not to
          one shared login.</p></div>
      </div>
      <p class="band-more">Going deeper: <a href="/docs#why-rtfx">table stakes vs what's different</a> ·
        <a href="/docs#use-cases">who uses it and for what</a> ·
        <a href="/docs#why">why not a generic static host</a> ·
        <a href="/docs#agents">publishing from Claude Code or MCP</a> ·
        <a href="/docs#faq">FAQ</a></p>
    </section>

    <section id="waitlist">
      <h2>Request access</h2>
      <!-- "We onboard a few teams at a time" asserted an operating cadence that
           nothing in the product enforces or measures. What is actually true is
           narrower and reads better: invitations are granted by a person. -->
      <p>Access is granted by hand, so every account has a real person behind it. Tell us where to
        send your invitation and what you'd publish.</p>
      <form id="wl">
        <!-- A placeholder is not a label: it disappears the moment you type, and
             a screen reader may never announce it at all. -->
        <label class="sr-only" for="email">Email address</label>
        <input id="email" name="email" type="email" required placeholder="you@example.com"
          autocomplete="email" autocapitalize="off" spellcheck="false">
        <button type="submit">Request access</button>
      </form>
      <div id="msg" role="status" aria-live="polite" hidden></div>
      <!-- What it costs is a question every reader forms in the first ten seconds,
           and the page used to answer it only with a hedge about the future
           ("if paid plans arrive…"), which reads as "we might bill you later".
           There is no billing in the product, so the present tense is both the
           more useful answer and the more honest one. The notice promise stays. -->
      <p class="note">Already have an account? <a href="/login" data-cta="sign-in">Sign in instead →</a>
        We'll email you a one-time code — there's no password to set. There is no billing in
        rtfx.pro today and nothing to pay while access is invited; if paid plans arrive, existing
        accounts will get notice before any pricing change applies.</p>
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
    image: canonicalUrl(env, "/og.png"),
    socialTitle: `${SITE.name} — ${SITE.tagline}`,
    jsonLd: structuredData(env),
  });
}
