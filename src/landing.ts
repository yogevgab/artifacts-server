import { layout } from "./pages";

const LANDING_STYLE = `
.wrap{max-width:1180px}
header.top{position:sticky;top:0;z-index:5;margin:-.75rem 0 2.2rem;padding:.72rem .9rem;border:1px solid var(--border);border-radius:999px;background:var(--elev);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);box-shadow:var(--shadow)}
.brand{font-weight:750;letter-spacing:-.03em;display:flex;align-items:center;gap:.45rem}.brand:before{content:"";width:.72rem;height:.72rem;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 0 0 5px var(--accent-weak)}
.nav{display:flex;gap:.9rem;align-items:center}.nav a{color:var(--muted);font-size:.9rem}.nav a.primary{color:var(--fg);border:1px solid var(--border);border-radius:999px;padding:.42rem .78rem;background:rgba(255,255,255,.05)}
.hero{position:relative;padding:5.8rem 0 3.4rem;text-align:center;overflow:hidden}.hero:before{content:"";position:absolute;inset:1.2rem 8% auto;height:17rem;border-radius:999px;background:linear-gradient(90deg,rgba(10,132,255,.18),rgba(100,210,255,.13),transparent);filter:blur(18px);z-index:-1}
.hero h1{font-size:clamp(3rem,8.5vw,6.9rem);line-height:.94;margin:0 auto 1.15rem;max-width:13ch;letter-spacing:-.075em;font-weight:780}
.hero p.lead{font-size:clamp(1.08rem,2vw,1.38rem);color:var(--muted);max-width:43rem;margin:0 auto 2rem;letter-spacing:-.015em}
.hero .cta{display:flex;gap:.72rem;justify-content:center;flex-wrap:wrap}.hero .cta a:hover{text-decoration:none}
.cta-note{color:var(--faint);font-size:.88rem;margin:.95rem auto 0;max-width:30rem}.cta-note b{color:var(--muted);font-weight:600}
#waitlist .note{margin-top:1.1rem}
.badge-row{display:flex;gap:.55rem;justify-content:center;margin-bottom:1.15rem;flex-wrap:wrap}.pill{border:1px solid var(--border);border-radius:999px;padding:.36rem .86rem;font-size:.82rem;color:var(--muted);background:rgba(255,255,255,.05);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.product-shot{margin:2.8rem auto 0;max-width:58rem;border:1px solid var(--border);border-radius:32px;background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.04));box-shadow:0 36px 110px -58px rgba(0,0,0,.85);padding:.78rem;text-align:left}.shot-bar{display:flex;gap:.42rem;padding:.45rem .55rem}.shot-dot{width:.72rem;height:.72rem;border-radius:50%;background:var(--border-strong)}.shot-body{border:1px solid var(--border);border-radius:24px;background:var(--card);padding:1rem;display:grid;grid-template-columns:1.15fr .85fr;gap:1rem}.shot-panel{border:1px solid var(--border);border-radius:20px;padding:1rem;background:rgba(255,255,255,.04)}.shot-line{height:.7rem;border-radius:999px;background:var(--border);margin:.65rem 0}.shot-line.wide{width:88%}.shot-line.mid{width:62%}.shot-line.short{width:38%}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:1rem;margin:3rem 0}.feature{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.28rem;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}.feature h3{margin:0 0 .42rem;font-size:1.04rem;letter-spacing:-.02em}.feature p{margin:0;color:var(--muted);font-size:.92rem}
.pricing{background:linear-gradient(135deg,var(--card),rgba(10,132,255,.09));border:1px solid var(--border);border-radius:32px;padding:2.35rem;text-align:center;margin:2.6rem 0;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}.pricing .price{font-size:clamp(2.2rem,4.5vw,4rem);font-weight:780;letter-spacing:-.055em;margin:.25rem 0}.pricing .price small{font-size:1rem;font-weight:500;color:var(--muted);letter-spacing:0}.pricing p.note{color:var(--muted);max-width:35rem;margin:.55rem auto 0}
#waitlist{background:var(--card);border:1px solid var(--border);border-radius:32px;padding:2.3rem;text-align:center;margin:2.6rem 0;box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}#waitlist h2{margin:0 0 .45rem;font-size:clamp(1.8rem,4vw,3rem);letter-spacing:-.055em}#waitlist p{color:var(--muted);margin:0 0 1.3rem}#waitlist form{display:flex;gap:.6rem;justify-content:center;flex-wrap:wrap;max-width:31rem;margin:0 auto}#waitlist input{flex:1;min-width:15rem}#msg{max-width:31rem;margin:.85rem auto 0}footer.site{text-align:center;color:var(--muted);font-size:.88rem;padding:2rem 0 1rem}
@media(max-width:760px){header.top{position:static;border-radius:22px}.nav{gap:.55rem}.hero{padding:3.2rem 0 2rem}.shot-body{grid-template-columns:1fr}.product-shot{border-radius:24px}}
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
    <header class="top"><div class="brand">rtfx.pro</div><nav class="nav" aria-label="Primary">
      <a href="#features">Features</a>
      <a href="#waitlist" class="primary" data-cta="request-access">Request access</a>
      <a href="/login" data-cta="sign-in">Sign in →</a>
    </nav></header>

    <section class="hero">
      <div class="badge-row"><span class="pill">Invite-only beta</span><span class="pill">Free during beta</span><span class="pill">Built for AI artifacts</span></div>
      <h1>Deploy the thing Claude just made.</h1>
      <p class="lead">A quiet, premium home for HTML pages and multi-file artifacts. Publish in seconds,
        keep client work private, version every change, and share polished links without exposing the conversation.</p>
      <div class="cta">
        <a href="#waitlist" data-cta="request-access"><button>Request access</button></a>
        <a href="/login" data-cta="sign-in"><button class="ghost">Sign in</button></a>
      </div>
      <p class="cta-note">The beta is invite-only. <b>Request access</b> if you're new;
        <b>sign in</b> if you've already been invited.</p>
      <div class="product-shot" aria-label="Product preview">
        <div class="shot-bar"><span class="shot-dot"></span><span class="shot-dot"></span><span class="shot-dot"></span></div>
        <div class="shot-body">
          <div class="shot-panel"><span class="pill">Published</span><div class="shot-line wide"></div><div class="shot-line mid"></div><div class="shot-line short"></div></div>
          <div class="shot-panel"><span class="pill">Private link</span><div class="shot-line mid"></div><div class="shot-line wide"></div><div class="shot-line short"></div></div>
        </div>
      </div>
    </section>

    <section id="features" class="features">
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
      <h2>Request access</h2>
      <p>Tell us where to send your invite. We're opening the beta a few teams at a time.</p>
      <form id="wl">
        <input id="email" name="email" type="email" required placeholder="you@example.com" autocomplete="email">
        <button type="submit">Request access</button>
      </form>
      <div id="msg"></div>
      <p class="note">Already invited? <a href="/login" data-cta="sign-in">Sign in instead →</a>
        We'll email you a one-time code — there's no password to set.</p>
    </section>

    <footer class="site">Already invited? <a href="/login" data-cta="sign-in">Sign in →</a></footer>
    <script>${SCRIPT}</script>`;
  return layout("rtfx.pro — private hosting for pages and artifacts", body, LANDING_STYLE);
}
