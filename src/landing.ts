import { maxSeatsFor } from "./members";
import { layout, siteHeader, siteFooter, PUBLIC_CHROME_STYLE, SOURCE_URL } from "./pages";
import { cookieNotice, CONSENT_STYLE, CONSENT_SCRIPT } from "./consent";
import type { Env } from "./env";
import { SITE, MCP_URL, canonicalUrl } from "./seo";
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
 * The public site: one page. A short intro, the walkthrough (connect, publish,
 * share, delete) and the pricing section. Everything else the product does is
 * learned by asking Claude, so nothing else is explained here.
 *
 * Served identically to everyone: no identity read, so crawlers and customers
 * get the same bytes. `/docs` redirects here; the section ids (`#start`,
 * `#agents`, `#publish`, `#share`, `#delete`, `#pricing`) are the anchors old
 * links land on.
 *
 * Two wording rules are pinned in tests because one careless edit makes them
 * false: a share link is a capability URL (it expires and revokes, and it is
 * never described as a password), and the hosted MCP endpoint publishes content
 * sent in the call, never a path.
 */

const CLAUDE_CODE_CMD = `claude mcp add --transport http rtfx ${MCP_URL}`;
const MCP_JSON = `{"mcpServers":{"rtfx":{"url":"${MCP_URL}"}}}`;

const LANDING_STYLE = `${PUBLIC_CHROME_STYLE}${CONSENT_STYLE}
.wrap{max-width:46rem}
.hero{padding:3.2rem 0 1rem}
.hero h1{font-size:clamp(2.2rem,6vw,3.6rem);line-height:1.02;letter-spacing:-.06em;font-weight:760;margin:0 0 1rem;text-wrap:balance}
.hero p.lead{font-size:clamp(1.05rem,2vw,1.2rem);color:var(--muted);margin:0 0 1.6rem;letter-spacing:-.01em}
.mcp-box{display:flex;align-items:center;gap:.6rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card);padding:.5rem .5rem .5rem 1rem;margin:0 0 1.2rem;min-width:0}
.mcp-box code{flex:1;min-width:0;font-family:var(--mono);font-size:.92rem;overflow-x:auto;white-space:nowrap}
.mcp-box button{flex:none}
.hero .cta{display:flex;gap:.7rem;flex-wrap:wrap;margin:0 0 .9rem}.hero .cta a:hover{text-decoration:none}
.signin-note{color:var(--faint);font-size:.88rem;margin:0}
section.band{margin:4.2rem 0}
section.band h2{font-size:clamp(1.5rem,3.4vw,2rem);letter-spacing:-.045em;line-height:1.1;margin:0 0 1rem}
section.band h3{font-size:1.02rem;letter-spacing:-.02em;margin:0 0 .6rem}
section.band p{color:var(--muted);margin:0 0 .9rem}
section.band p b,section.band li b{color:var(--fg);font-weight:600}
.panel{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.3rem 1.3rem 1.1rem;margin:0 0 1rem;box-shadow:var(--shadow)}
.panel ol{margin:0 0 .9rem;padding-left:1.25rem;color:var(--muted);display:grid;gap:.3rem}
.panel>:last-child{margin-bottom:0}
pre.code{background:#05070c;border:1px solid var(--border);border-radius:var(--radius-sm);padding:.8rem 1rem;font-family:var(--mono);font-size:.82rem;line-height:1.6;color:#dfe5f0;margin:0 0 .9rem;overflow-x:auto;white-space:pre}
.panel code,.ask-list code{font-family:var(--mono);font-size:.88em;overflow-wrap:anywhere}
.ask-list{list-style:none;margin:0 0 .9rem;padding:0;display:grid;gap:.7rem}
.ask-list li{color:var(--muted)}
.ask-list q{color:var(--fg);font-weight:600;letter-spacing:-.01em}
.pricing{margin:4.2rem 0 0}
.band-head{text-align:center;max-width:40rem;margin:0 auto 2rem}
.band-head h2{font-size:clamp(1.5rem,3.4vw,2rem);letter-spacing:-.045em;margin:0 0 .6rem;line-height:1.1}
.band-head p{color:var(--muted);margin:0}
.eyebrow-c{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);margin:0 0 .7rem}
.pricing-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1rem}
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
.final{text-align:center;margin:4.2rem 0 1rem}
.final h2{font-size:clamp(1.5rem,3.4vw,2rem);letter-spacing:-.045em;margin:0 0 1rem}
.final .cta{display:flex;gap:.7rem;justify-content:center;flex-wrap:wrap}.final .cta a:hover{text-decoration:none}
@media(max-width:760px){.hero{padding:2rem 0 .5rem}section.band{margin:3rem 0}.pricing{margin-top:3rem}}
`;

/** Copy-to-clipboard for the MCP URL. textContent only — no innerHTML. */
const COPY_SCRIPT = `(function(){var b=document.querySelector('[data-copy]');if(!b)return;
var t=b.textContent;b.addEventListener('click',function(){
var v=b.getAttribute('data-copy');
function done(ok){b.textContent=ok?'Copied':'Copy failed';setTimeout(function(){b.textContent=t},1600)}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(v).then(function(){done(true)},function(){done(false)})}
else{var r=document.createRange();var c=document.getElementById('mcp-url');r.selectNodeContents(c);var s=window.getSelection();s.removeAllRanges();s.addRange(r);var ok=false;try{ok=document.execCommand('copy')}catch(e){}done(ok)}
})})();`;

const TITLE = "Private links for work Claude makes · rtfx.pro";

/** Structured data: what this site is, and what the product is. */
function structuredData(env: Env): unknown[] {
  const url = canonicalUrl(env, "/");
  return [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          "@id": `${url}#organization`,
          name: SITE.name,
          url,
          description: SITE.description,
          sameAs: [SOURCE_URL],
          logo: canonicalUrl(env, "/logo.png"),
        },
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
            "Publish from Claude to a private link over MCP",
            "Share with named people, editors or a revocable link",
            "Immutable versions with rollback",
            "Delete an artifact permanently",
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
      <h1>Publish from Claude to a private link.</h1>
      <p class="lead">rtfx.pro is an MCP server. Connect it to Claude once, then ask Claude to
        publish, share or delete what it made — each artifact gets a private link only the people
        you choose can open.</p>
      <div class="mcp-box">
        <code id="mcp-url">${MCP_URL}</code>
        <button type="button" class="ghost" data-copy="${MCP_URL}">Copy</button>
      </div>
      <div class="cta">
        <a class="link-button" href="#start" data-cta="connect">Connect to Claude</a>
        <a class="ghost link-button" href="/signup" data-cta="signup">Start free</a>
      </div>
      <p class="signin-note">Already have an account? <a href="/login" data-cta="sign-in">Sign in</a></p>
    </section>

    <section id="start" class="band">
      <span id="agents"></span>
      <h2>1. Add rtfx to Claude</h2>
      <div class="panel">
        <h3>Claude on web, desktop and mobile</h3>
        <ol>
          <li>Open <b>Settings → Connectors</b> and choose <b>Add custom connector</b>.</li>
          <li>Name it <code>rtfx</code> and use the URL <code>${MCP_URL}</code>.</li>
          <li>Click <b>Add</b>, then <b>Connect</b>.</li>
          <li>Sign in with the code we email you, then <b>Allow</b>.</li>
        </ol>
        <p>Once added, it works in Claude on web, desktop and mobile. The consent screen lists
          “Manage access and delete artifacts” — allow it so Claude can share and delete from
          chat.</p>
      </div>
      <div class="panel">
        <h3>Other MCP clients</h3>
        <p>Any client with remote MCP and OAuth connects the same way, with nothing to paste. It
          asks for read and publish by default; it must also request <code>rtfx:manage</code> to
          share and delete from chat.</p>
        <pre class="code"><code>${CLAUDE_CODE_CMD}</code></pre>
        <pre class="code"><code>${MCP_JSON}</code></pre>
        <p>No OAuth in your client? Create a token under Settings → Integrations
          (<a href="/admin/integrations">rtfx.pro/admin/integrations</a>) and send it as
          <code>Authorization: Bearer &lt;token&gt;</code>.</p>
      </div>
    </section>

    <section id="publish" class="band">
      <h2>2. Publish</h2>
      <ul class="ask-list">
        <li><q>Publish this as a private link.</q> Claude replies with your link, like
          <code>https://rtfx.pro/your-workspace/q3-report</code>. It is private to you until you
          share it.</li>
        <li><q>Publish the fix to the same link.</q> A new version at the same URL.
          <q>Roll back to version 2.</q> The link points at the earlier version again.</li>
      </ul>
      <p>For big sites or images, Claude gives you an upload link instead.</p>
    </section>

    <section id="share" class="band">
      <h2>3. Share</h2>
      <ul class="ask-list">
        <li><q>Share it with dana@acme.com.</q> Dana signs in with her email and can open it.</li>
        <li><q>Let alex@acme.com edit it.</q> Editors can publish new versions and roll back.</li>
        <li><q>Make it visible to everyone in my workspace.</q></li>
      </ul>
      <p>For someone without an account, open the artifact's Share page on rtfx.pro and create a
        link for them. Name each link for who it's for, set an expiry, and extend or revoke it any
        time.</p>
    </section>

    <section id="delete" class="band">
      <h2>4. Delete</h2>
      <ul class="ask-list">
        <li><q>Delete q3-report.</q> Claude confirms the exact name first, then it's gone: every
          version, the link and its share links. This can't be undone.</li>
      </ul>
      <p>You can also delete it from the artifact's page on rtfx.pro.</p>
    </section>

    ${pricingSection()}

    <section class="final">
      <h2>Ready when you are.</h2>
      <div class="cta">
        <a class="link-button" href="/signup" data-cta="signup-final">Start free</a>
        <a class="ghost link-button" href="/login" data-cta="sign-in">Sign in</a>
      </div>
    </section>
    </main>

    ${siteFooter()}
    ${cookieNotice()}
    <script>${CONSENT_SCRIPT}</script>
    <script>${COPY_SCRIPT}</script>`;
  return layout(TITLE, body, LANDING_STYLE, {
    description: SITE.description,
    canonical: canonicalUrl(env, "/"),
    image: canonicalUrl(env, "/og.png"),
    socialTitle: `${SITE.name} — ${SITE.tagline}`,
    jsonLd: structuredData(env),
  });
}
