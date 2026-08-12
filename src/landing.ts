import { layout } from "./pages";

const LANDING_STYLE = `
.hero{padding:3.5rem 0 2.5rem;text-align:center}
.hero h1{font-size:2.4rem;line-height:1.15;margin:0 0 .75rem}
.hero p.lead{font-size:1.15rem;color:var(--muted);max-width:38rem;margin:0 auto 1.75rem}
.hero .cta{display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap}
.brand{font-weight:700}
.badge-row{display:flex;gap:.5rem;justify-content:center;margin-bottom:1rem;flex-wrap:wrap}
.pill{border:1px solid var(--border);border-radius:999px;padding:.3rem .85rem;font-size:.8rem;color:var(--muted)}
.features{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1rem;margin:2.5rem 0}
.feature{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.25rem}
.feature h3{margin:0 0 .4rem;font-size:1rem}
.feature p{margin:0;color:var(--muted);font-size:.9rem}
.pricing{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:2rem;text-align:center;margin:2.5rem 0}
.pricing .price{font-size:2rem;font-weight:700;margin:.25rem 0}
.pricing .price small{font-size:1rem;font-weight:400;color:var(--muted)}
.pricing p.note{color:var(--muted);max-width:32rem;margin:.5rem auto 0}
#waitlist{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:2rem;text-align:center;margin:2.5rem 0}
#waitlist h2{margin:0 0 .4rem}
#waitlist p{color:var(--muted);margin:0 0 1.25rem}
#waitlist form{display:flex;gap:.6rem;justify-content:center;flex-wrap:wrap;max-width:26rem;margin:0 auto}
#waitlist input{flex:1;min-width:14rem}
#msg{max-width:26rem;margin:.85rem auto 0}
footer.site{text-align:center;color:var(--muted);font-size:.85rem;padding:2rem 0 1rem}
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
  show('Joining…', true);
  try {
    const res = await fetch('/waitlist', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) return show('Enter a valid email address.', false);
    show(data.status === 'already' ? "You're already on the list." : "You're on the list — we'll be in touch.", true);
    e.target.reset();
  } catch (err) { show('Network error — please try again.', false); }
});
`;

export function landingPage(): string {
  const body = `
    <header class="top"><div class="brand">Artifacts</div><div><a href="/gallery">Sign in →</a></div></header>

    <section class="hero">
      <div class="badge-row"><span class="pill">Invite-only beta</span><span class="pill">Free during beta</span></div>
      <h1>Ship polished pages and interactive artifacts — privately, in seconds</h1>
      <p class="lead">Publish HTML pages and multi-file bundles behind real access control.
        Share with specific people or everyone on your team, version every change, and see
        who viewed what.</p>
      <div class="cta">
        <a href="#waitlist"><button>Join the waitlist</button></a>
        <a href="/gallery"><button class="ghost">Sign in</button></a>
      </div>
    </section>

    <section class="features">
      <div class="feature"><h3>Per-artifact permissions</h3><p>Keep pages private, share with
        specific people, or open them to everyone on your team.</p></div>
      <div class="feature"><h3>Versioning</h3><p>Every re-publish is a new immutable version —
        roll back anytime.</p></div>
      <div class="feature"><h3>Views log</h3><p>See who viewed each artifact, when, which
        version, and from where.</p></div>
      <div class="feature"><h3>CLI + dashboard</h3><p>Publish from your terminal or a web
        dashboard built for fast iteration.</p></div>
    </section>

    <section class="pricing">
      <div class="price">Free <small>during beta</small></div>
      <p class="note">We're onboarding a limited number of teams during the beta. Paid plans
        launch after — beta members get early access and a discount.</p>
    </section>

    <section id="waitlist">
      <h2>Join the waitlist</h2>
      <p>Get an invite as we open up access.</p>
      <form id="wl">
        <input id="email" name="email" type="email" required placeholder="you@example.com" autocomplete="email">
        <button type="submit">Join waitlist</button>
      </form>
      <div id="msg"></div>
    </section>

    <footer class="site">Already invited? <a href="/gallery">Sign in to your gallery →</a></footer>
    <script>${SCRIPT}</script>`;
  return layout("Artifacts — private hosting for pages and artifacts", body, LANDING_STYLE);
}
