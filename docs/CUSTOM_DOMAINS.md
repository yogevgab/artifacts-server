# Custom domains — design (draft, 2026-11-06)

Status: **proposed, not built.** Until it ships, every public surface must keep saying custom
domains are not available (test/positioning.test.ts enforces it).

## Decisions (owner, 2026-11-06)

| Question | Decision |
|---|---|
| Which plans | **Team** (and an optional paid add-on for more domains) and **Enterprise**. Not Free, not Pro. |
| What a domain maps to | **The whole workspace**: `docs.acme.com/<artifact>` ≡ `rtfx.pro/acme/<artifact>`. |
| Private artifacts | **Same rules as rtfx.pro**: private by default, email-code sign-in, share links, view log — all on the customer's domain. |
| Included / add-on | **Team includes 1 domain; each extra domain is a US$5/month add-on.** Enterprise: by agreement (operator override). |

## How it works

### 1. Cloudflare for SaaS (infrastructure)
- Enable **Cloudflare for SaaS / Custom Hostnames** on the `rtfx.pro` zone (account
  `fac06016…`). First 100 custom hostnames are free; then ~US$0.10/hostname/month.
- Fallback origin: a proxied record `domains.rtfx.pro`, served by the Worker.
- Worker route for SaaS traffic: `*/*` on the zone (custom hostnames reach the Worker through
  it). The existing `custom_domain` routes stay.
- Customer setup: `CNAME docs.acme.com → domains.rtfx.pro`. Cloudflare issues the TLS
  certificate (HTTP DCV once the CNAME is in place; TXT records offered for pre-validation).
- The Worker creates/deletes/polls hostnames through the Cloudflare API (`custom_hostnames`),
  with a new secret `CF_SAAS_API_TOKEN` (scope: SSL and Certificates — Edit, on the zone only).

### 2. Data
Migration `0025_custom_domains.sql`:
```
custom_domains(
  hostname TEXT PRIMARY KEY,            -- lower-cased, no trailing dot
  account_id TEXT NOT NULL REFERENCES accounts(id),
  status TEXT NOT NULL,                 -- pending | active | failed | removed
  cf_hostname_id TEXT,
  ssl_status TEXT, verification_errors TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0, -- the one share links/emails use
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  verified_at TEXT, updated_at TEXT
)
```
Plan gate copies the branded-slug pattern (`planAllowsCustomDomain`, `CUSTOM_DOMAIN_LIMIT`:
Team 1 included, Enterprise via override; add-on raises the limit — phase 3).

### 3. Routing — a third host class: "customer host"
`host.ts` gains `classifyHost`: content host (a.rtfx.pro) · app host (rtfx.pro, mcp) ·
**customer host** (an `active` row in `custom_domains`, cached in memory/KV with short TTL) ·
unknown (404).

On a customer host only these are served:
- `GET /<artifact-slug>` and `/<artifact-slug>/<path>` → the existing `viewArtifact`, with the
  extra rule `artifact.account_id === domain.account_id` (else the same 404 as any missing slug).
- Sign-in: `/login` (branded, minimal), `/auth/start`, `/auth/verify`, `/auth/m/:token`,
  `/auth/guest`, `/logout`.
- `/_chat/<slug>`, `/_frame-stall`, `/robots.txt` (Disallow all), favicon.
- `/` → a small page: "This domain hosts documents shared by <workspace>" + sign-in link (no
  listing of artifacts).

Everything else — `/admin`, `/api`, `/oauth`, `/.well-known/oauth-*`, `/mcp`, `/u`,
marketing pages, `/share/<slug>` (management) — answers **404** on a customer host. The owner
manages from rtfx.pro.

### 4. Viewer + content isolation stay as they are
- The shell is served on the customer host; content stays on `a.rtfx.pro`, framed with the
  frame token. Uploaded HTML never runs on the customer's domain (or on rtfx.pro).
- **frame-ancestors becomes per-request**: the frame token gains an `anc` claim (the shell's
  origin). The content host allows `anc` only if it is `PUBLIC_BASE_URL`, an `APP_ORIGINS`
  entry, or an `active` custom domain of the artifact's workspace.
- `viewer-routes.ts:169-175` (redirect every non-canonical app host to rtfx.pro) is replaced
  by host classification; `redirectToViewer` returns to the requesting customer host.

### 5. Sign-in on the customer domain
- Cookies are already host-only, so the customer host gets its own session jar — a viewer signs
  in once per domain. That is the intended isolation (a rtfx.pro session is not readable by
  docs.acme.com and vice versa).
- `signinOrigin` accepts `active` custom domains, so magic links and codes land on the
  customer host. Guest magic links (`auth-routes.ts:350`) use the request's host when it is an
  active custom domain.
- Emails say "Sign in to view <title> on docs.acme.com" — the sender stays rtfx.pro.

### 6. Canonical URLs
- When a workspace has an `active` primary domain: `viewUrl`, share links, read-receipt and
  invite emails, `artifact_details` (MCP) and the dashboard "Copy link" use
  `https://docs.acme.com/<slug>`.
- `rtfx.pro/acme/<slug>` keeps working and 301s to the custom domain for browser requests.
- Removing a domain reverts every link to rtfx.pro immediately (old custom-domain links stop
  resolving once Cloudflare drops the hostname).

### 7. Dashboard (Settings → Custom domain, owners/admins of a Team workspace)
Add hostname → shows the CNAME (and optional TXT pre-validation) → status polls
pending → active (or the Cloudflare error in plain language) → "Make primary" / "Remove".
Replaces the existing `data-placeholder="custom-domain"` row.

### 8. Security notes
- Host header trust: Cloudflare only forwards hostnames it has validated; the Worker still
  requires an `active` DB row and ignores everything else.
- No management surface (OAuth issuer, API, MCP) is ever reachable on a customer host.
- Rate-limit hostname additions per workspace; reject apex `rtfx.pro`, its subdomains, and
  hostnames already claimed by another workspace.
- Removal: delete the Cloudflare hostname first, then mark the row `removed`.

## Phases
1. **Core** (behind `CUSTOM_DOMAINS_ENABLED`): migration, host classification + customer-host
   allowlist, viewer, per-request frame-ancestors, sign-in on custom hosts, canonical URLs.
   Operator adds a hostname by hand (CF dashboard + SQL) for the first test domain.
2. **Self-serve**: Cloudflare API automation, dashboard UI, status polling, emails.
3. **Commercial**: Team inclusion live, add-on variant in Lemon Squeezy, then update
   llms.txt / plan pages / positioning tests and publish the "host a Claude artifact on your own
   domain" answer pages.

## Owner steps (cannot be done from code)
- Enable Cloudflare for SaaS on the `rtfx.pro` zone; create the fallback record.
- Create `CF_SAAS_API_TOKEN` (zone-scoped) and set it as a Worker secret.
- Create the Lemon Squeezy add-on variant ("Extra custom domain", US$5/month) — phase 3.
- A test domain you control (e.g. `docs.<your-domain>`).

## Unrelated finding from the code read (fix separately)
`redeemCode` (src/otp.ts) does not check the challenge `purpose`, so a guest-sign-in challenge's
code would be accepted by `/auth/verify` and mint a **member** session. Guest emails only carry
the magic link (not the code), so exposure is low, but the check should be added.
