import { maxSeatsFor } from "./members";
import { esc, layout, siteHeader, siteFooter, PUBLIC_CHROME_STYLE, SOURCE_URL } from "./pages";
import { cookieNotice, CONSENT_STYLE, CONSENT_SCRIPT } from "./consent";
import type { Env } from "./env";
import { SITE, MCP_URL, canonicalUrl } from "./seo";
import { mediaUrl } from "./media";
import {
  CLAUDE_CODE_CMD,
  CONNECT_NOTE,
  CONNECT_STEPS,
  ENTERPRISE_LINES,
  FAQS,
  MCP_JSON,
  OTHER_CLIENTS_NOTE,
  VIDEO,
  WALKTHROUGH,
} from "./home-content";
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

/** Styles for guideVideo(), shared with /guide (src/guide.ts). */
export const GUIDE_VIDEO_STYLE = `.guide-video{margin:2rem 0 0}.guide-video video{display:block;width:100%;height:auto;border-radius:var(--radius-sm);border:1px solid var(--border-strong);box-shadow:var(--shadow);background:var(--card)}
.guide-video figcaption{margin-top:.6rem;color:var(--muted);font-size:.92rem}`;

const LANDING_STYLE = `${PUBLIC_CHROME_STYLE}${CONSENT_STYLE}
.wrap{max-width:46rem}
.hero{padding:3.2rem 0 1rem}
${GUIDE_VIDEO_STYLE}
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
.guide-link{font-weight:600;font-size:1.02rem}
.faq-list{display:grid;gap:.6rem}
.faq-list details{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:.15rem 1rem}
.faq-list summary{cursor:pointer;font-weight:600;letter-spacing:-.01em;padding:.75rem 0;min-height:44px;display:flex;align-items:center;gap:.75rem;list-style:none}
.faq-list summary::-webkit-details-marker{display:none}
.faq-list summary::after{content:"+";margin-left:auto;flex:none;font-weight:500;font-size:1.2rem;color:var(--muted)}
.faq-list details[open]>summary::after{content:"\\2212"}
.faq-list details[open] summary{color:var(--fg)}
.faq-list details p{margin:0 0 .9rem;color:var(--muted)}
.pricing{margin:4.2rem 0 0}
.band-head{text-align:center;max-width:40rem;margin:0 auto 2rem}
.band-head h2{font-size:clamp(1.5rem,3.4vw,2rem);letter-spacing:-.045em;margin:0 0 .6rem;line-height:1.1}
.band-head p{color:var(--muted);margin:0}
.eyebrow-c{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);margin:0 0 .7rem}
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
.final{text-align:center;margin:4.2rem 0 1rem}
.final h2{font-size:clamp(1.5rem,3.4vw,2rem);letter-spacing:-.045em;margin:0 0 1rem}
.final .cta{display:flex;gap:.7rem;justify-content:center;flex-wrap:wrap}.final .cta a:hover{text-decoration:none}
@media(max-width:760px){.hero{padding:2rem 0 .5rem}section.band{margin:3rem 0}.pricing{margin-top:3rem}}
`;

/** Copy-to-clipboard for the MCP URL. textContent only — no innerHTML. */
export const COPY_SCRIPT = `(function(){var b=document.querySelector('[data-copy]');if(!b)return;
var t=b.textContent;b.addEventListener('click',function(){
var v=b.getAttribute('data-copy');
function done(ok){b.textContent=ok?'Copied':'Copy failed';setTimeout(function(){b.textContent=t},1600)}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(v).then(function(){done(true)},function(){done(false)})}
else{var r=document.createRange();var c=document.getElementById('mcp-url');r.selectNodeContents(c);var s=window.getSelection();s.removeAllRanges();s.addRange(r);var ok=false;try{ok=document.execCommand('copy')}catch(e){}done(ok)}
})})();`;

const TITLE = SITE.homeTitle;

/**
 * The walkthrough video as schema.org `VideoObject`. Shared with /guide, which
 * embeds the same player, so both pages describe the one video the same way.
 */
export function videoObject(env: Env): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    "@id": `${canonicalUrl(env, "/")}#video`,
    name: VIDEO.name,
    description: VIDEO.description,
    thumbnailUrl: canonicalUrl(env, mediaUrl(VIDEO.poster)),
    contentUrl: canonicalUrl(env, mediaUrl(VIDEO.file)),
    uploadDate: VIDEO.uploadDate,
    duration: VIDEO.duration,
    width: VIDEO.width,
    height: VIDEO.height,
    encodingFormat: "video/mp4",
    inLanguage: "en",
  };
}

/** FAQPage built from the SAME array the visible FAQ renders from. */
function faqPage(env: Env): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${canonicalUrl(env, "/")}#faq`,
    mainEntity: FAQS.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

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
          name: "rtfx.pro MCP server for Claude (private links)",
          url,
          applicationCategory: "DeveloperApplication",
          applicationSubCategory: "Web hosting",
          operatingSystem: "Web",
          description: SITE.description,
          isAccessibleForFree: true,
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
            "Publish a Claude artifact to a private link over MCP",
            "Publish new versions at the same link and roll back",
            "Share with viewers, editors or everyone in the workspace",
            "Named share links that expire and can be extended or revoked",
            "Delete an artifact",
            "See who opened it with the view log",
          ],
          publisher: { "@id": `${url}#organization` },
        },
      ],
    },
    videoObject(env),
    faqPage(env),
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
/** Plain-text lines of a plan's card — the card renders them, `/llms-full.txt` prints them. */
export function tierLimitLines(name: PlanName): string[] {
  const f = planFeatures(name);
  const versions =
    f.limits.keepVersions === null
      ? "Full version history"
      : `Keeps the last ${f.limits.keepVersions} versions of each artifact`;
  return [
    "Dedicated URL for every artifact",
    // The branded workspace address (rtfx.pro/yogev/q3-board-report) is the one
    // feature the paid plans unlock rather than merely widen, so it is named on
    // the cards that unlock it and nowhere else.
    ...(name === "free" ? [] : ["Branded workspace address"]),
    `${num(f.limits.maxArtifacts)} artifacts`,
    `${bytes(f.limits.maxStorageBytes)} storage`,
    versions,
    seatsLine(name),
  ];
}

function tierCard(name: PublicTier): string {
  const cta = tierCta(name);
  // Enterprise has no row in PLANS to render, and inventing limits for it would
  // be the one hand-typed number in this section; its lines are what the
  // conversation is about — see /enterprise, which is explicit that none of it
  // is built today.
  const lines = isPlanName(name) ? tierLimitLines(name) : ENTERPRISE_LINES;
  const detail = lines.map((l) => `<li>${l}</li>`).join("\n      ");
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

/**
 * The one-minute walkthrough video (rendered from the /guide screenshots,
 * served from R2 by src/media.ts). No autoplay and preload="none": nobody
 * downloads 5 MB they did not ask for.
 */
export function guideVideo(): string {
  return `<figure class="guide-video" data-landing="video">
        <video controls playsinline preload="none" width="${VIDEO.width}" height="${VIDEO.height}"
          poster="${mediaUrl(VIDEO.poster)}"
          aria-label="One-minute walkthrough: add rtfx to Claude, publish, share and see who opened it">
          <source src="${mediaUrl(VIDEO.file)}" type="video/mp4">
        </video>
        <figcaption>One minute: connect, publish, share, see who opened it.
          <a href="/guide">Step by step with screenshots &rarr;</a></figcaption>
      </figure>`;
}

function walkthroughSection(w: (typeof WALKTHROUGH)[number]): string {
  return `<section id="${w.id}" class="band">
      <h2>${w.heading}</h2>
      <ul class="ask-list">
        ${w.asks.map((a) => `<li>${a}</li>`).join("\n        ")}
      </ul>
      <p>${w.note}</p>
    </section>`;
}

/** The visible FAQ; `faqPage()` (JSON-LD) is built from the same `FAQS`. */
function faqSection(): string {
  return `<section id="faq" class="band">
      <h2>Questions</h2>
      <div class="faq-list">
        ${FAQS.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}${f.more ? ` <a href="${f.more.href}" data-cta="faq-more">${f.more.label} &rarr;</a>` : ""}</p></details>`).join("\n        ")}
      </div>
    </section>`;
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
      ${guideVideo()}
    </section>

    <section id="start" class="band">
      <span id="agents"></span>
      <h2>1. Add rtfx to Claude</h2>
      <div class="panel">
        <h3>Claude on web, desktop and mobile</h3>
        <ol>
          ${CONNECT_STEPS.map((l) => `<li>${l}</li>`).join("\n          ")}
        </ol>
        <p>${CONNECT_NOTE}</p>
        <p class="guide-link"><a href="/guide" data-cta="guide">See every step with screenshots &rarr;</a></p>
      </div>
      <div class="panel">
        <h3>Other MCP clients</h3>
        <p>${OTHER_CLIENTS_NOTE}</p>
        <pre class="code"><code>${CLAUDE_CODE_CMD}</code></pre>
        <pre class="code"><code>${MCP_JSON}</code></pre>
        <p>No OAuth in your client? Create a token under Settings → Integrations
          (<a href="/admin/integrations">rtfx.pro/admin/integrations</a>) and send it as
          <code>Authorization: Bearer &lt;token&gt;</code>.</p>
      </div>
    </section>

    ${WALKTHROUGH.map(walkthroughSection).join("\n\n    ")}

    ${faqSection()}

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
    socialTitle: TITLE,
    jsonLd: structuredData(env),
  });
}
