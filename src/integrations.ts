import { esc } from "./pages";
import { isTokenUsable, MAX_TOKEN_NAME_LENGTH, type PublicApiToken } from "./tokens";
import { portalShell, stamp, plural, type PortalViewer } from "./portal";

/**
 * Integrations: the credentials and the setup that let something other than a
 * browser publish here — the CLI, Claude Code, Hermes and CI. It is deliberately
 * one section: a token with nowhere to be pasted is a dead end, and setup
 * instructions with no token to paste are worse.
 */

type TokenState = "active" | "expired" | "revoked";

/** Revoked wins over expired, so a revoked row never reads as merely stale. */
export function tokenState(t: PublicApiToken, now: Date): TokenState {
  if (t.revoked_at) return "revoked";
  return isTokenUsable(t, now) ? "active" : "expired";
}

function tokenRow(t: PublicApiToken, now: Date, showOwner: boolean): string {
  const state = tokenState(t, now);
  const stateBadge =
    state === "revoked"
      ? `<span class="badge is-revoked" data-badge="token-state">Revoked</span>`
      : state === "expired"
        ? `<span class="badge is-locked" data-badge="token-state">Expired</span>`
        : `<span class="badge is-open" data-badge="token-state">Active</span>`;
  // An admin token manages every artifact, so it is worth calling out even in a
  // member's own list (an admin may have issued one on their behalf).
  const adminBadge = t.is_admin ? `<span class="badge" data-badge="token-admin">admin</span>` : "";
  const meta = [
    `<span class="mono">${esc(t.id)}</span>`,
    esc(t.scopes.join(" · ")),
    // Only an admin sees other people's tokens, so only they need the owner.
    showOwner ? esc(t.owner_email ?? "no owner") : "",
    `created ${stamp(t.created_at)}`,
    t.last_used_at ? `last used ${stamp(t.last_used_at)}` : "never used",
    t.revoked_at
      ? `revoked ${stamp(t.revoked_at)}`
      : t.expires_at
        ? `expires ${stamp(t.expires_at)}`
        : "no expiry",
  ]
    .filter(Boolean)
    .join(" · ");
  // Revoking is a tombstone, so an already-revoked token has no action left —
  // the badge and the meta line already say so.
  const action =
    state === "revoked"
      ? ""
      : `<button class="ghost small" data-revoke="${esc(t.id)}">Revoke</button>`;
  return `<div class="row" data-token="${esc(t.id)}" data-token-state="${state}" data-token-name="${esc(t.name)}">
    <div class="info"><b>${esc(t.name)} ${stateBadge}${adminBadge}</b>
      <span class="hint">${meta}</span></div>
    <div class="row-actions">${action}<span class="status" data-status hidden></span></div>
  </div>`;
}

/**
 * Token management. The secret is shown exactly once, right after creation —
 * the list can only ever render metadata, because that is all the API returns.
 * A member may only mint tokens that act as themselves, so the owner/admin
 * controls are rendered for admins only (the API enforces this regardless).
 */
function tokensPanel(tokens: PublicApiToken[], isAdmin: boolean): string {
  const now = new Date();
  const active = tokens.filter((t) => tokenState(t, now) === "active").length;
  const rows = tokens.map((t) => tokenRow(t, now, isAdmin)).join("");

  const scopeBox = (value: string, hint: string, checked: boolean) =>
    `<label class="check"><input type="checkbox" name="scope" value="${value}"${checked ? " checked" : ""}>
      <span><b>${value}</b> <span class="faint">— ${esc(hint)}</span></span></label>`;

  const adminFields = isAdmin
    ? `<div class="field-grid" data-token-admin-fields>
        <div><label for="tok-owner">Owner email <span class="faint">(the member it acts as)</span></label>
          <input id="tok-owner" name="owner_email" type="email" placeholder="person@example.com" autocomplete="off"></div>
        <div><span class="field-label">Admin token</span>
          <label class="check"><input type="checkbox" id="tok-admin" name="is_admin">
            <span>Manages every artifact <span class="faint">— admin reach wins even when an owner is set</span></span></label></div>
      </div>`
    : `<p class="note" data-token-self-only>Tokens you create act as you — same artifacts, never more.
        Ask an admin if you need a token for someone else.</p>`;

  return `<section class="panel" data-panel="tokens" aria-labelledby="tokens-h">
    <div class="panel-head"><div>
      <h2 id="tokens-h">API tokens <span class="hint" data-token-active-count="${active}">${plural(active, "active token")}</span></h2>
      <p class="hint">Bearer credentials for the CLI, Hermes Cloud and CI. A token publishes as its
        owner and can be narrowed by scope — it can never manage tokens or team members.</p>
    </div></div>

    <form id="tokenform" data-token-form>
      <div class="field-grid">
        <div><label for="tok-name">Name *</label>
          <input id="tok-name" name="name" required maxlength="${MAX_TOKEN_NAME_LENGTH}"
            placeholder="hermes-cloud" autocomplete="off"></div>
        <div><label for="tok-expires">Expires</label>
          <select id="tok-expires" name="expires_in_days">
            <option value="30">In 30 days</option>
            <option value="90" selected>In 90 days</option>
            <option value="365">In 365 days</option>
            <option value="">Never — until revoked</option>
          </select></div>
      </div>
      <fieldset class="scopes" data-token-scopes>
        <legend>Scopes</legend>
        ${scopeBox("read", "list artifacts, versions and views", true)}
        ${scopeBox("publish", "upload new artifacts and versions, roll back", true)}
        ${scopeBox("manage", "change who can open an artifact, delete artifacts", false)}
      </fieldset>
      ${adminFields}
      <div class="row-actions"><button type="submit" class="small">Create token</button>
        <span class="status" id="token-status" data-status hidden></span></div>
    </form>

    <div class="token-secret" data-token-secret hidden>
      <div class="published-head"><span class="tick" aria-hidden="true">✓</span>
        <div><b data-secret-title>Token created</b>
          <div class="hint">Copy it now — only a hash is stored, so this is the only time it can be
            shown. Store it as <span class="mono">RTFX_API_TOKEN</span>.</div></div>
      </div>
      <label for="token-value">Token</label>
      <div class="linkrow">
        <input id="token-value" data-token-value readonly spellcheck="false" aria-label="New API token">
        <button type="button" data-copy-token>Copy token</button>
      </div>
      <div class="published-actions">
        <button type="button" class="ghost" data-token-another>Create another</button>
        <button type="button" class="ghost" data-token-refresh>Refresh list</button>
      </div>
    </div>

    <div class="token-list" data-token-list>
      ${rows || `<p class="note" data-empty="tokens">No API tokens yet — create one above to publish from the CLI or CI.</p>`}
    </div>
  </section>`;
}

/** A copyable command block. The `<code>` id is what the copy button reads. */
function snippet(id: string, label: string, code: string): string {
  return `<div class="snippet" data-snippet="${esc(id)}">
    <div class="snippet-head">
      <span class="field-label">${esc(label)}</span>
      <button type="button" class="ghost small" data-copy-text="${esc(id)}">Copy</button>
    </div>
    <pre class="code"><code id="${esc(id)}">${esc(code)}</code></pre>
  </div>`;
}

/**
 * Setup, in the order somebody actually does it: point a tool at this instance,
 * give it a token, publish. Identical for a human at a terminal and for an agent
 * session — there is no separate, weaker agent path, and saying so here is the
 * point of the section.
 */
function setupPanel(origin: string): string {
  return `<section class="panel" data-panel="agent-setup" aria-labelledby="setup-h">
    <div class="panel-head"><div>
      <h2 id="setup-h">Claude Code, Hermes &amp; the CLI</h2>
      <p class="hint">Every tool uses the same two environment variables and the same API. Mint a
        token above, scope it to what the tool actually needs, and hand it over.</p>
    </div></div>

    ${snippet(
      "setup-env",
      "1 · Point a session at this instance",
      `export ARTIFACTS_URL=${origin}\nexport RTFX_API_TOKEN=rtfx_…   # from the panel above`
    )}
    ${snippet(
      "setup-cli",
      "2 · Publish from a terminal, Claude Code or a Hermes run",
      `npx artifacts publish ./index.html --slug q3-report --title "Q3 Report"\nnpx artifacts publish ./site --slug q3-report --note "revised charts"\nnpx artifacts grant q3-report alex@example.com\nnpx artifacts views q3-report`
    )}
    ${snippet(
      "setup-plugin",
      "3 · Or install the Claude Code plugin, and just say “publish this”",
      `/plugin marketplace add yogevgab/artifacts-server\n/plugin install rtfx@rtfx\n/rtfx:setup   # confirms the token above reaches this instance`
    )}
    ${snippet(
      "setup-mcp",
      "4 · Or connect the MCP server, for a client with no shell (Claude Desktop)",
      `{ "mcpServers": { "rtfx": {\n    "command": "node",\n    "args": ["/path/to/plugins/rtfx/scripts/rtfx-mcp.mjs"],\n    "env": { "RTFX_API_TOKEN": "rtfx_…" } } } }\n\ntools: publish · list_artifacts · get_versions · rollback · doctor`
    )}
    ${snippet(
      "setup-http",
      "5 · Or straight over HTTP, from CI",
      `curl -X POST ${origin}/api/artifacts \\\n  -H "Authorization: Bearer $RTFX_API_TOKEN" \\\n  -F slug=q3-report -F title="Q3 Report" -F file=@./dist.zip`
    )}

    <p class="note" data-setup-note><b>Why a token and not your login.</b> A token is bound to its
      owner, carries only the scopes you gave it, and can be revoked on its own. An agent holding one
      publishes as you — it can never become you, manage people, or reach anyone else's artifacts.
      Full reference lives in the <a href="/docs">product docs</a>.</p>
  </section>`;
}

const TOKENS_SCRIPT = `
/* ---- API tokens ---- */
var tokenForm = $('#tokenform');
var tokenSecret = $('[data-token-secret]');
function showToken(data){
  if(!tokenSecret) return;
  $('[data-token-value]', tokenSecret).value = data.token;
  $('[data-secret-title]', tokenSecret).textContent =
    'Created "' + data.name + '" · ' + data.id + ' · ' + (data.scopes || []).join(', ');
  setStatus($('#token-status'), '');
  tokenForm.hidden = true;
  tokenSecret.hidden = false;
  $('[data-copy-token]', tokenSecret).focus();
}
if(tokenForm){
  tokenForm.addEventListener('submit', async function(e){
    e.preventDefault();
    var status = $('#token-status');
    var name = $('#tok-name').value.trim();
    if(!name){ setStatus(status, 'Give the token a name so you can recognise it later.', 'error'); return; }
    var scopes = $$('input[name=scope]:checked', tokenForm).map(function(i){ return i.value; });
    if(!scopes.length){ setStatus(status, 'Pick at least one scope.', 'error'); return; }
    var payload = { name: name, scopes: scopes };
    var days = $('#tok-expires').value;
    if(days) payload.expires_in_days = Number(days);
    /* Owner/admin controls exist for admins only; the API enforces the same rule. */
    var ownerInput = $('#tok-owner'), adminBox = $('#tok-admin');
    if(ownerInput){
      var owner = ownerInput.value.trim();
      var wantsAdmin = !!(adminBox && adminBox.checked);
      if(!owner && !wantsAdmin){
        setStatus(status, 'Enter an owner email, or tick the admin-token box.', 'error');
        return;
      }
      if(owner) payload.owner_email = owner;
      if(wantsAdmin) payload.is_admin = true;
    }
    var btn = $('button[type=submit]', tokenForm);
    btn.disabled = true;
    setStatus(status, 'Creating…');
    try {
      var res = await fetch('/api/tokens', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
      });
      if(!res.ok){
        setStatus(status, (await detail(res)) || 'Could not create that token.', 'error');
        return;
      }
      showToken(await res.json());
    } catch(err){ setStatus(status, 'Network error — try again.', 'error'); }
    finally { btn.disabled = false; }
  });
}
if(tokenSecret){
  wireCopy($('[data-copy-token]', tokenSecret), function(){ return $('[data-token-value]', tokenSecret).value; });
  $('[data-token-value]', tokenSecret).addEventListener('focus', function(e){ e.target.select(); });
  $('[data-token-another]', tokenSecret).addEventListener('click', function(){
    /* Drop the secret from the DOM as soon as the user is done with it. */
    $('[data-token-value]', tokenSecret).value = '';
    tokenForm.reset();
    tokenSecret.hidden = true; tokenForm.hidden = false;
    var n = $('#tok-name'); if(n) n.focus();
  });
  $('[data-token-refresh]', tokenSecret).addEventListener('click', function(){ location.reload(); });
}
$$('button[data-revoke]').forEach(function(b){
  b.addEventListener('click', async function(){
    var id = b.getAttribute('data-revoke');
    var row = $('[data-token="' + id + '"]');
    var name = (row && row.getAttribute('data-token-name')) || id;
    if(!confirm('Revoke "' + name + '"? Anything using this token stops working immediately. This cannot be undone.')) return;
    var status = row ? $('[data-status]', row) : null;
    b.disabled = true;
    setStatus(status, 'Revoking…');
    try {
      var res = await fetch('/api/tokens/' + encodeURIComponent(id), { method:'DELETE' });
      if(!res.ok){
        b.disabled = false;
        setStatus(status, (await detail(res)) || 'Could not revoke that token.', 'error');
        return;
      }
      /* Update in place rather than reloading — a just-created secret may still
         be on screen, and a reload would take it away for good. */
      if(row){
        row.setAttribute('data-token-state', 'revoked');
        var badge = $('[data-badge=token-state]', row);
        if(badge){ badge.textContent = 'Revoked'; badge.className = 'badge is-revoked'; }
        var count = $('[data-token-active-count]');
        if(count){
          var n = Math.max(0, Number(count.getAttribute('data-token-active-count') || '0') - 1);
          count.setAttribute('data-token-active-count', String(n));
          count.textContent = n + ' active token' + (n === 1 ? '' : 's');
        }
      }
      b.remove();
      setStatus(status, 'Revoked — it no longer works.', 'ok');
    } catch(err){
      b.disabled = false;
      setStatus(status, 'Network error — try again.', 'error');
    }
  });
});
`;

const INTEGRATIONS_STYLE = `
#tokenform{display:grid;gap:.95rem;margin-bottom:.5rem}
.badge.is-revoked{color:var(--danger);border-color:var(--danger);background:var(--danger-weak)}
fieldset.scopes{border:1px solid var(--border);border-radius:18px;padding:.82rem .95rem;margin:0;display:grid;gap:.45rem;background:rgba(255,255,255,.03)}
fieldset.scopes legend{font-size:.85rem;color:var(--muted);padding:0 .35rem}
label.check{display:flex;align-items:flex-start;gap:.5rem;margin:0;font-size:.88rem;color:var(--fg)}
label.check input{width:auto;flex:none;margin-top:.2rem}
.field-label{display:block;font-size:.85rem;color:var(--muted);margin-bottom:.25rem}
.snippet-head .field-label{margin-bottom:0}
.token-secret{border:1px solid rgba(48,209,88,.55);background:var(--ok-weak);border-radius:22px;padding:1.15rem;margin-bottom:1rem}
.token-secret .linkrow input{font-family:var(--mono);font-size:.85rem;background:rgba(255,255,255,.05)}
.token-list .row .info b{display:flex;align-items:center;gap:.35rem;flex-wrap:wrap}
.token-list .hint{overflow-wrap:anywhere}
.published-head{display:flex;align-items:center;gap:.65rem;margin-bottom:.9rem}
.tick{width:1.7rem;height:1.7rem;flex:none;border-radius:999px;background:var(--ok);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:.85rem;font-weight:750}
.linkrow{display:flex;gap:.5rem;align-items:center}
.linkrow input{font-family:var(--mono);font-size:.85rem;background:rgba(255,255,255,.05)}
.linkrow button{flex:none}
.linkrow button.is-copied{background:var(--ok)}
.published-actions{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.9rem}

.snippet{margin-bottom:1rem}
.snippet-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:.4rem}
pre.code{margin:0;padding:.9rem 1rem;border:1px solid var(--border);border-radius:18px;
  background:rgba(255,255,255,.04);overflow-x:auto;font-family:var(--mono);font-size:.82rem;
  line-height:1.65;color:var(--fg)}
pre.code code{font:inherit;white-space:pre}
@media(max-width:720px){.linkrow{align-items:stretch;flex-direction:column}}
`;

export function integrationsPage(
  viewer: PortalViewer,
  tokens: PublicApiToken[] | null,
  origin: string
): string {
  // `tokens === null` means the caller may not manage tokens at all — an API
  // bearer token. It still gets the setup instructions, which are public
  // knowledge, but never a list of credentials.
  const deniedNote = `<p class="note" data-token-denied>Token management needs an interactive
    sign-in. This session is authenticated with an API token, which can never read, create or
    revoke credentials — open the portal in a browser to manage them.</p>`;

  return portalShell({
    viewer,
    section: "integrations",
    title: "Integrations",
    heading: "Integrations",
    lede: `Credentials and setup for everything that publishes here without a browser — the CLI,
      Claude Code, Hermes and CI.`,
    body: `${tokens ? tokensPanel(tokens, viewer.isAdmin) : deniedNote}${setupPanel(origin)}`,
    style: INTEGRATIONS_STYLE,
    script: tokens ? TOKENS_SCRIPT : "",
  });
}
