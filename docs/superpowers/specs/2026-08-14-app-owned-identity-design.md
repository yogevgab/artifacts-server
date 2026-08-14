# Design: rtfx owns its identity layer

**Date:** 2026-08-14
**Status:** Approved for planning
**Supersedes:** the Cloudflare Access topology in `docs/DEPLOY_RTFX.md` §5a–5e

## 1. Why

rtfx.pro currently outsources identity to Cloudflare Access. That decision is load-bearing
in three places, and all three now block the product:

1. **External viewers cannot be served.** The Access viewer application covers both
   `rtfx.pro` and `a.rtfx.pro` (`DEPLOY_RTFX.md:82`), so a request from somebody who is not
   on the Access allow-list never reaches the Worker. The per-artifact grant logic that
   already exists (`hasGrant`, `canView`) never runs. Sharing an artifact with a person
   outside the instance is impossible without making them a platform user.
2. **The sign-in experience is not ours.** The screen after `/login` and the one-time-code
   email are both hosted by Cloudflare and cannot be styled by the Worker
   (`DEPLOY_RTFX.md:267`, `:277`). The handoff reads as two unrelated products.
3. **Signing up requires a human.** Access allow-list entries are written by an admin
   through the Cloudflare API. There is no path from "stranger visits the landing page" to
   "stranger has a workspace" that does not route through the operator.

This design replaces Cloudflare Access with an identity layer inside the Worker, and uses
that to open self-service signup — metered from the first day.

## 2. Goals

- Anyone can verify an email address and get a working personal workspace, unattended.
- Free-tier usage is bounded at publish time, so open signup cannot become an unbounded
  storage or bandwidth liability.
- People who are *granted* an artifact can view it without becoming platform users.
- Owners can hand somebody a link directly, outside our email.
- Every sign-in screen and every message is ours: our wordmark, our domain, our words.
- Cloudflare Access is retired completely.

## 3. Non-goals

Out of scope, deliberately, each with its own later project:

- Billing and paid plans (P3). This spec introduces the `plan` → limits mapping that
  billing will later drive, but every account is `free`.
- Team/workspace self-service invites and seat counting (P4).
- Product analytics and lifecycle email (P5).
- SSO / SAML / social login. Email is the only factor.

## 4. Architecture

Four new modules inside the Worker, each with one job:

| Module | Responsibility | Depends on |
|---|---|---|
| `mail.ts` | Branded HTML+text transactional email over the `send_email` binding. Classifies send failures. | Cloudflare Email Sending |
| `otp.ts` | Issue and redeem sign-in challenges. A challenge is one record redeemable *either* by 6-digit code or by magic-link token. | D1, `mail.ts` |
| `session.ts` | Mint and verify signed session cookies with `jose`. | `jose` (already a dependency) |
| `quota.ts` | Resolve an account's plan limits and evaluate usage against them. | D1 |

No new npm dependencies. `jose` and `fflate` are already present; the mailer is a Workers
binding, not a package.

### 4.1 Sessions are stateless

Session cookies are signed JWTs, not database rows. There is no session table and no
per-request session read.

Revocation still works, because `getIdentity` already reads the user's status from D1 on
every request — `disabled` continues to take effect immediately, exactly as it does today.
Adding a session table would mean a second read per request to buy a revocation mechanism
that already exists.

Session lifetime is 30 days, sliding: a session older than half its life is silently
re-minted on use.

## 5. Identity model

Three kinds of caller. The distinction is carried *in the session*, not inferred at each
call site.

| Kind | Has | May reach |
|---|---|---|
| `member` | a `users` row from signup or invite | dashboard, API, own + granted artifacts |
| `guest` | only `artifact_grants` rows, no `users` row | granted artifact content, nothing else |
| `link` | a valid share-link token, no identity at all | exactly one artifact |

### 5.1 The critical check

`canUseDashboard` today returns true for any identity carrying an email
(`src/authz.ts:197`). Under this design that would hand every granted guest the dashboard.

It becomes:

```ts
export function canUseDashboard(identity: Identity | null): identity is Identity {
  if (!identity) return false;
  if (identity.isAdmin) return true;
  return identity.kind === "member" && !!identity.email;
}
```

This is the single place where an error is a privilege escalation rather than a bug. It is
written test-first, with an exhaustive table over `{kind} × {isAdmin} × {email present}`.

## 6. Flows

### 6.1 Signup (new)

```
/signup  →  email entered
         →  challenge created, branded mail sent
         →  code entered OR magic link clicked
         →  users row created (status 'active')
         →  ensurePersonalAccount()  ← already exists, idempotent, race-safe
         →  session minted  →  dashboard
```

`ensurePersonalAccount` is reused as-is. Signup and sign-in are the *same* redemption
endpoint; whether a `users` row is created or merely touched is decided by whether one
already exists. There is no separate "register" verb and therefore no way for the two paths
to diverge.

### 6.2 Sign-in

Identical to signup after the challenge is redeemed. A member lands on the dashboard.

### 6.3 Guest view

```
guest opens https://a.rtfx.pro/<slug>/
  → no content session → /view-signin?slug=<slug>
  → email entered → challenge → redeem
  → hasGrant(slug, email)?
      yes → content session for that slug → artifact renders
      no  → 404 (identical to a slug that does not exist)
```

A guest is never given a `users` row and never sees the dashboard. When an owner grants
access, we send that person a branded magic link so the first step is a click, not a
cold visit.

**Guest → member is a one-way upgrade, never automatic.** A guest who later signs up at
`/signup` with the same address gets a `users` row and a personal workspace at that point,
and their existing grants continue to apply unchanged. Nothing about viewing a shared
artifact creates an account: a person who was sent one link and never wanted an account
never gets one.

### 6.4 Share link

Owner presses **Copy share link** on the artifact's access panel. The URL carries
`?k=<id>.<secret>`; the Worker looks up `id`, hashes `secret`, compares, and mints a
content session scoped to that one slug. Revocable from the same panel. The view log
records `via link` rather than inventing a viewer identity.

## 7. Email

Cloudflare Email Sending, via the Workers binding.

```jsonc
"send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["no-reply@rtfx.pro"] }]
```

The binding is *restricted* on purpose: this Worker also serves user-uploaded HTML, so
capping the addresses it can ever send `From` is cheap defense in depth.

**Prerequisite, not yet done.** `wrangler email sending list` currently reports no sending
subdomains on the account. Before any of this works:

```bash
npx wrangler email sending enable rtfx.pro     # adds SPF + DKIM
npx wrangler email sending dns get rtfx.pro    # verify
```

Add a DMARC record (`v=DMARC1; p=quarantine; rua=…`). The recipients are overwhelmingly
Gmail addresses, which is exactly where authentication failures become silent spam-foldering.

### 7.1 Failure classification

Every send is classified, never swallowed:

| Class | Codes | Behavior |
|---|---|---|
| Config | `E_SENDER_NOT_VERIFIED`, `E_SENDER_DOMAIN_NOT_AVAILABLE` | Do not retry. Surface to the operator — this is an outage. |
| Recipient | `E_RECIPIENT_SUPPRESSED`, `E_VALIDATION_ERROR` | Do not retry. Record the reason where an admin can read it. |
| Transient | `E_RATE_LIMIT_EXCEEDED`, `E_DELIVERY_FAILED`, `E_INTERNAL_SERVER_ERROR` | Retry with exponential backoff. |

`E_RECIPIENT_SUPPRESSED` matters most: Cloudflare auto-suppresses any address that hard
bounces or reports spam, and every later send to it fails silently from the user's side.
That is precisely the failure that is currently undiagnosable without reading source.

### 7.2 Enumeration vs diagnosability

These pull in opposite directions and the resolution is explicit:

- The **user** always sees the same message: *"If that address can receive mail, a code is
  on its way."* No response distinguishes a registered address from an unregistered one, and
  timing is equalized by always doing the same work.
- The **operator** sees the real reason in an admin-visible delivery log.

All email is transactional: challenges, magic links, "someone shared an artifact with you".
No digests, no announcements — that line is not crossed on this domain.

## 8. Quotas and metering

Open signup without limits is an unbounded liability, so limits ship in this project, not
after it.

### 8.1 Plan limits

Limits live in code, keyed by `accounts.plan`, not scattered as magic numbers:

```ts
export const PLANS = {
  free: { maxArtifacts: 10, maxStorageBytes: 100 * 1024 * 1024, maxViewsPerMonth: 5_000 },
} as const;
```

Values are tunable in one place and are the seam billing (P3) later drives.

### 8.2 Where limits are enforced

At publish, before any bytes are written to R2. The check is a single D1 aggregate over the
account's artifacts; publishes are infrequent, so this needs no maintained counter and
cannot drift from reality.

Views are different — frequent, and already logged in `artifact_views`. The monthly view
count is a windowed aggregate over that table, checked on content requests and cached in
the isolate for 60 seconds. Exceeding it degrades to a friendly "this artifact is over its
plan's view limit" page rather than a 404, because the *viewer* did nothing wrong.

### 8.3 An open tension: immutable versions vs a storage cap

Versions are immutable and never deleted, so an account's storage grows monotonically with
every publish. A 100 MB free tier is therefore a cap on *lifetime publishes*, not on live
content — a user who republishes a 5 MB dashboard twenty times is at the limit with one
artifact live.

**Decision:** free-tier accounts retain the live version plus the four preceding ones.
Older versions are garbage-collected from R2, and the version list marks them
`expired` rather than hiding them, so the history stays legible and the upgrade
motivation is visible in the product. Paid plans (P3) lift the retention window.

This preserves the contract's letter — rollback is still non-destructive within the
retention window — while making a bounded free tier possible. It is a real narrowing of the
current promise, and the promise is currently made in five places that must all change in
the same release:

- `README.md` → "Contract": *"Rollback repoints the slug without deleting anything."*
- `plugins/rtfx/skills/publishing-to-rtfx/SKILL.md` → *"the newer version's files stay"*
- The MCP `publish` tool description → *"appends an immutable version"*
- `src/docs.ts` and the version-list UI
- The published explainer artifact at `a.rtfx.pro/what-is-rtfx/` → *"Nothing is deleted"*

Shipping the retention window without these edits would leave the product documenting a
guarantee it no longer honours. That is a release blocker, not a follow-up.

## 9. Data model

```sql
-- Sign-in challenges. One row serves both the 6-digit code and the magic link.
CREATE TABLE auth_challenges (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  purpose      TEXT NOT NULL,          -- 'signin' | 'guest'
  slug         TEXT,                   -- guest challenges only
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_auth_challenges_email ON auth_challenges (email, created_at DESC);

-- Bearer capability URLs.
CREATE TABLE share_links (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  expires_at  TEXT,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_share_links_slug ON share_links (slug);

-- Delivery outcomes, for answering "why didn't they get it".
CREATE TABLE mail_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL,            -- 'sent' | 'failed'
  error_code TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mail_log_email ON mail_log (email, created_at DESC);
```

Neither codes nor link secrets are stored in plaintext; only SHA-256 hashes, matching the
existing `api_tokens` treatment.

Challenges: 15-minute expiry, single use, 5 attempts before the row is burned.

## 10. Cookies, and a cross-artifact leak designed out

Every artifact shares the `a.rtfx.pro` origin. A single ambient session cookie there would
let artifact A's JavaScript `fetch("/artifact-b/")` with the viewer's credentials and
exfiltrate content they were never granted.

Two cookies, therefore, never one:

| Cookie | Scope | Flags |
|---|---|---|
| `rtfx_session` | `rtfx.pro`, host-only | `HttpOnly`, `Secure`, `SameSite=Lax` |
| `rtfx_content` | `a.rtfx.pro`, **`Path=/<slug>/`** | `HttpOnly`, `Secure`, `SameSite=Lax` |

Path scoping is the mechanism: a fetch from `/artifact-a/` to `/artifact-b/` carries no
cookie at all, because the browser will not attach a cookie whose path does not match. The
isolation is per-artifact by construction rather than by check.

This preserves the origin isolation `src/host.ts` exists to enforce. The app session is
never sent to the content host.

## 11. Rate limiting

Reuses the `waitlist_rate_limits` table and the pattern already established in
`src/waitlist.ts`. Limits are per-address and per-IP, applied to challenge creation, so
nobody can pump mail through the domain and destroy its sending reputation.

## 12. Migration off Cloudflare Access

Deliberately boring, because the cutover is all-at-once and lockout is the failure mode:

1. Ship the new stack **accepting both** an Access JWT and an app session. Nothing breaks;
   Access still guards the edge.
2. Verify sign-in through app OTP while Access is still live.
3. Remove the Access applications in Zero Trust. The Worker becomes the only gate.
4. Delete the dual-accept branch and `ACCESS_AUD` in a follow-up commit.

### 12.1 Breaking changes

- **`ADMIN_SERVICE_TOKENS`** (`wrangler.jsonc`) holds a Cloudflare Access service-token
  client id. Retiring Access invalidates it. CLI publishing is unaffected — it already uses
  `rtfx_` bearer tokens against `/api/machine` — but anything relying on the service token
  for admin rights must move to an admin-scoped API token.
- **`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `CF_API_TOKEN`, `ACCESS_VIEWER_APP_ID`,
  `ACCESS_VIEWER_POLICY_ID`** all become obsolete, along with `DEPLOY_RTFX.md` §5a–5e.
  The deploy doc must be rewritten in the same change or it will strand the next operator.
- **`src/access-api.ts`** is deleted. Its allow-list is no longer the source of truth for
  who may sign in.

## 13. Testing

Vitest with `@cloudflare/vitest-pool-workers` is already configured; 30 test files exist.
TDD throughout, per the repo's conventions.

**Pure policy first** — these are written before any implementation:

- `canUseDashboard` over `{kind} × {isAdmin} × {email}` — exhaustive.
- `canView` with the new `link` kind added.
- Plan-limit evaluation at, just under, and just over each boundary.

**Integration:**

- Challenge replay, expiry, attempt burn-through.
- Magic link is single-use; a second click fails closed.
- Path-scoped cookie isolation: a request to `/b/` carrying `/a/`'s cookie is refused.
- Share-link revocation takes effect immediately.
- Publish refused at the quota boundary, with bytes never reaching R2.
- Dual-accept: Access JWT and app session both authenticate during migration.

**Mail** is mocked at the binding. `"remote": true` never reaches production.

## 14. Decisions log

| Decision | Alternative rejected | Why |
|---|---|---|
| App-owned OTP | Second Access policy for the content host | Caps branding at a wordmark and costs a Zero Trust seat per guest |
| Retire Access entirely, at once | Guests first, platform later | Chosen by the operator with the migration risk stated |
| Stateless sessions | Session table | Revocation already exists via the per-request status read |
| Two path-scoped cookies | One ambient cookie on `.rtfx.pro` | One cookie enables cross-artifact exfiltration on a shared origin |
| Cloudflare Email Sending | Resend / Postmark | No API key, no dependency, already on the platform |
| Quotas in P1 | Quotas in P2 | Open signup without limits is an unbounded liability from day one |
| Free-tier version retention | Unbounded immutable history | A storage cap is otherwise a cap on lifetime publishes |

## 15. Open questions

1. Free-tier numbers (10 artifacts / 100 MB / 5,000 views) are placeholders chosen to be
   obviously safe. They should be set against real cost-per-account before launch.
2. Whether `no-reply@rtfx.pro` should accept replies. If yes, that is Email *Routing*,
   enabled separately and forwarded to a real inbox. If no, the address must not imply
   otherwise.
