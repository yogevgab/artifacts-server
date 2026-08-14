import { Hono, type Context } from "hono";
import type { AppBindings, Env } from "./env";
import { addContactRequest } from "./db";
import { esc, layout, siteHeader, siteFooter, PUBLIC_CHROME_STYLE } from "./pages";
import { SITE, canonicalUrl } from "./seo";
import { normalizeEmail } from "./waitlist";
import { PUBLIC_TIERS, TIER_LABEL, tierCta, type PublicTier } from "./plan-copy";
import {
  incrementRateLimitBucket,
  clientAddress,
  RATE_LIMIT_WINDOW_SECONDS,
} from "./rate-limit";

/**
 * `/contact` — the one place a "Talk to us" button can land, and the product's
 * visible support route.
 *
 * It exists because two pricing buttons now say "Talk to us" (Team and
 * Enterprise — see `tierCta` in src/plan-copy.ts) and a CTA that leads nowhere
 * is worse than no CTA. It is deliberately *not* a `mailto:` link: the only
 * address this repository contains is `privacy@rtfx.pro`, which src/legal.ts
 * itself flags as a placeholder, so publishing a sales address here would be
 * inventing a mailbox nobody has promised to read.
 *
 * What it does instead is the same thing the waitlist does, with a message
 * attached: record the request, rate-limit it, and say plainly that a person
 * answers these by hand and that no automatic confirmation is coming. Every
 * sentence of that is true today, which is the bar the rest of the public copy
 * is held to.
 *
 * ⚠️ Follow-up, deliberately out of scope for this change: nothing yet *shows*
 * an operator the `contact_requests` rows — no dashboard panel, no notification
 * mail. Until that ships, requests are read with a D1 query. Do not add more
 * surfaces pointing here without closing that loop.
 */

export const contactRoutes = new Hono<AppBindings>();

/** Longest message accepted. Generous for a real enquiry, small enough not to be a payload. */
const MAX_MESSAGE_LENGTH = 4000;

const CONTACT_RATE_LIMIT_MAX = 12;
const CONTACT_EMAIL_RATE_LIMIT_MAX = 3;

/** The tiers whose CTA is "Talk to us" — the only values `plan` may carry. */
export const CONTACT_TIERS: readonly PublicTier[] = PUBLIC_TIERS.filter(
  (t) => tierCta(t).kind === "contact"
);

/**
 * The requested plan, or null. Anything not on the contact ladder is dropped
 * rather than rejected: the value arrives from a query string a person can edit,
 * and a mistyped `?plan=` should still deliver the enquiry, just without a tier
 * attached.
 */
export function normalizePlan(raw: unknown): PublicTier | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim().toLowerCase();
  return CONTACT_TIERS.find((t) => t === clean) ?? null;
}

/** Trimmed message, or null when empty. Over-long input is truncated, never refused. */
export function normalizeMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim();
  if (!clean) return null;
  return clean.slice(0, MAX_MESSAGE_LENGTH);
}

async function checkContactRateLimit(c: Context<AppBindings>, email: string): Promise<boolean> {
  const [ipOk, emailOk] = await Promise.all([
    incrementRateLimitBucket(c, `contact:ip:${clientAddress(c)}`, CONTACT_RATE_LIMIT_MAX),
    incrementRateLimitBucket(c, `contact:email:${email}`, CONTACT_EMAIL_RATE_LIMIT_MAX),
  ]);
  return ipOk && emailOk;
}

contactRoutes.post("/contact", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_email" }, 400);
  }
  const fields = (body ?? {}) as { email?: unknown; plan?: unknown; message?: unknown };
  const email = normalizeEmail(fields.email);
  if (!email) return c.json({ error: "invalid_email" }, 400);
  if (!(await checkContactRateLimit(c, email))) {
    return c.json({ error: "rate_limited" }, 429, {
      "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS),
    });
  }

  await addContactRequest(c.env, {
    email,
    plan: normalizePlan(fields.plan),
    message: normalizeMessage(fields.message),
    now: new Date().toISOString(),
  });
  return c.json({ status: "received" }, 200);
});

// --- the page ---------------------------------------------------------------

const CONTACT_STYLE = `${PUBLIC_CHROME_STYLE}
.contact-head{max-width:44rem;margin:1rem auto 2rem;text-align:center}
.contact-head h1{font-size:clamp(2.1rem,5vw,3.4rem);letter-spacing:-.055em;margin:0 0 .7rem;line-height:1.05}
.contact-head p{color:var(--muted);margin:0;font-size:1.04rem}
.contact-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
  padding:2rem 1.9rem;max-width:38rem;margin:0 auto;box-shadow:var(--shadow);
  backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.contact-card .field{margin-bottom:1.05rem}
.contact-card textarea{min-height:8rem;resize:vertical}
.contact-card .actions{display:flex;gap:.7rem;align-items:center;flex-wrap:wrap}
.contact-note{color:var(--faint);font-size:.88rem;margin:1.1rem 0 0;line-height:1.55}
#c-msg{margin-top:1rem}
.contact-else{max-width:38rem;margin:2.2rem auto 0;color:var(--muted);font-size:.93rem;text-align:center}
.contact-else ul{list-style:none;padding:0;margin:.8rem 0 0;display:grid;gap:.5rem}
`;

const CONTACT_SCRIPT = `(function(){
  var form = document.getElementById('contact-form');
  if(!form) return;
  var msg = document.getElementById('c-msg');
  var btn = form.querySelector('button[type=submit]');
  function show(text, kind){
    msg.textContent = text; msg.hidden = false;
    msg.className = kind === 'ok' ? 'is-ok' : kind === 'error' ? 'is-error' : '';
  }
  form.addEventListener('submit', function(e){
    e.preventDefault();
    /* Same reason the waitlist disables its button: a double-submit spends the
       3-per-hour, per-address budget and turns a delivered enquiry into a
       rate-limit error the sender reads as a failure. */
    btn.disabled = true;
    show('Sending…', '');
    fetch('/contact', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        email: document.getElementById('c-email').value.trim(),
        plan: document.getElementById('c-plan').value,
        message: document.getElementById('c-message').value
      })
    }).then(function(res){
      if (res.status === 429) { show("Too many requests from your network just now — please try again in an hour. If an earlier message went through, we already have it.", 'error'); return; }
      if (res.status === 400) { show('Enter a valid email address.', 'error'); return; }
      if (!res.ok) { show('Something went wrong on our side — please try again in a moment.', 'error'); return; }
      /* No mail is sent by this route, so it must not imply one is on its way. */
      show("Got it. A person reads these by hand and replies by email — there's no automatic confirmation, so nothing else will arrive just yet.", 'ok');
      form.reset();
    }).catch(function(){
      show('Network error — please try again.', 'error');
    }).finally(function(){
      btn.disabled = false;
    });
  });
})();`;

const TITLE = "Talk to us — rtfx.pro";

const DESCRIPTION =
  "Ask about a Team or Enterprise workspace on rtfx.pro, or get help with an existing one. " +
  "A person answers by email.";

/** The plan `<select>`, with `selected` on whichever tier the visitor arrived from. */
function planOptions(selected: PublicTier | null): string {
  const rows = [
    `<option value=""${selected === null ? " selected" : ""}>Something else / support</option>`,
    ...CONTACT_TIERS.map(
      (t) =>
        `<option value="${esc(t)}"${selected === t ? " selected" : ""}>${esc(TIER_LABEL[t])}</option>`
    ),
  ];
  return rows.join("");
}

export function contactPage(env: Env, plan: PublicTier | null): string {
  const body = `
    ${siteHeader("contact")}

    <main id="main">
    <div class="contact-head">
      <h1>Talk to us</h1>
      <p>Team and Enterprise workspaces are set up with a person in the loop, and this is the
        same address to write to if something is wrong with a workspace you already have.</p>
    </div>

    <div class="contact-card">
      <form id="contact-form" data-contact-form>
        <div class="field">
          <label for="c-email">Your email address</label>
          <input id="c-email" name="email" type="email" required autocomplete="email"
            placeholder="you@example.com">
        </div>
        <div class="field">
          <label for="c-plan">What is this about?</label>
          <select id="c-plan" name="plan" data-contact-plan>${planOptions(plan)}</select>
        </div>
        <div class="field">
          <label for="c-message">Anything we should know? (optional)</label>
          <textarea id="c-message" name="message" placeholder="How many people, what you publish, anything that would change the answer."></textarea>
        </div>
        <div class="actions">
          <button type="submit" data-cta="contact-send">Send</button>
          <span class="hint">No newsletter, no sales sequence.</span>
        </div>
        <div id="c-msg" role="status" aria-live="polite" hidden></div>
      </form>
      <p class="contact-note">We record your address and what you wrote so we can reply, and
        nothing else — see the <a href="/privacy">privacy policy</a>. A person answers these by
        hand, so there is no automatic confirmation email.</p>
    </div>

    <div class="contact-else">
      <p>Not what you were looking for?</p>
      <ul>
        <li><a href="/signup" data-cta="signup">Free and Pro are self-serve</a> — verify an email and
          you have a workspace; upgrade to Pro from Settings whenever you want.</li>
        <li><a href="/docs">The docs</a> cover publishing, access control, versions and the API.</li>
        <li><a href="/privacy">Privacy</a> and <a href="/terms">terms</a> answer what we hold and
          under what agreement.</li>
      </ul>
    </div>
    </main>

    ${siteFooter()}
    <script>${CONTACT_SCRIPT}</script>`;
  return layout(TITLE, body, CONTACT_STYLE, {
    description: DESCRIPTION,
    canonical: canonicalUrl(env, "/contact"),
    image: canonicalUrl(env, "/og.png"),
    socialTitle: `Talk to us — ${SITE.name}`,
  });
}
