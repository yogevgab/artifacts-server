# Self-hosting artifacts-server

Everything needed to run your own instance is in this repository. Nothing needed to run
**`rtfx.pro`** is — see [`OPEN_SOURCE.md`](../OPEN_SOURCE.md) for where that line sits and why.

This page is deliberately short. It is not a second deployment guide: the mechanics are in
[`README.md`](../README.md) (quick deploy + manual deployment) and a worked multi-hostname runbook
is in [`DEPLOY_RTFX.md`](DEPLOY_RTFX.md). What this page covers is the part those two assume you
already have — **your own accounts, your own secrets, and your own legal values.**

## What you have to supply

Nothing below ships in this repository, and nothing below is shared with the hosted service.

| | What you need | Notes |
|---|---|---|
| **Cloudflare** | An account, a zone (domain), Workers, R2 and D1 | `npx wrangler login`, then `npm run setup` or the manual steps in the README. |
| **A content hostname** | A second hostname routed to the same Worker | `CONTENT_HOSTNAMES` + a matching `routes[]` entry. Not optional — see below. |
| **Email** | A Cloudflare Email Sending binding (`EMAIL`) and a verified sender | Sign-in is a one-time code by email; with no mail path, nobody can log in. `MAIL_FROM` must be in `allowed_sender_addresses`. |
| **Session secret** | `npx wrangler secret put SESSION_SECRET` | Signs the `rtfx_session` cookie. |
| **Billing** *(only for paid plans)* | A Lemon Squeezy store, variants and a webhook secret | `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_FREE/PRO/TEAM`, plus `wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET`. Leave unset to run free-plan-only. |
| **Analytics** *(optional)* | A PostHog project key | `POSTHOG_KEY` / `POSTHOG_HOST`. Unset means no analytics anywhere, which is the default. Public pages never load analytics regardless; the dashboard only does after an explicit accept. |
| **Legal values** | Your entity, address, contact, governing law | See below. |

`npm run validate:deploy` checks `wrangler.jsonc` before a deploy — but note it is written for the
**reference deployment** and asserts the `rtfx.pro` / `a.rtfx.pro` / `mcp.rtfx.pro` hostnames by
name (`scripts/validate-deploy-config.lib.mjs`). On your own domain it will report those as errors.
The checks worth carrying across are the generic ones: `CONTENT_HOSTNAMES` non-empty and routed,
the `FILES` and `DB` bindings present, `EMAIL` restricted to senders you control, and real
`ADMIN_EMAILS`.

## The one setting that is a security boundary, not a preference

`CONTENT_HOSTNAMES` must name a hostname that is **also routed to the Worker** and is **not** your
app hostname. Leave it empty and artifact files are served from the app origin itself — uploaded
HTML then runs same-origin with your dashboard and API, and the isolation described in
[`SECURITY.md`](../SECURITY.md) is simply not true of that deployment. `/admin/platform` reports
the same thing on a running instance. Treat either warning as a deploy blocker.

## Legal pages are a template, and they say so

`/privacy` and `/terms` are rendered from `src/legal.ts` and open with an **"Operator template —
not legal advice"** banner. That banner is unconditional — it shows on `rtfx.pro` too, because the
entity, address and governing law are genuinely not filled in yet — and it is not decoration. The
pages ship with placeholders that only you can fill:

- the **contact address** (`privacy@rtfx.pro` is a placeholder — `CONTACT` in `src/legal.ts`),
- the **governing law and jurisdiction**,
- your **legal entity's name and registered address**,
- anything your jurisdiction requires that the template does not carry (a DPA, a named DPO, a
  representative, a specific retention statement).

The privacy inventory is written against this codebase's D1 schema and R2 bucket, so it is accurate
about *what the software stores*. It cannot be accurate about *who is storing it* until you say so.
Have a lawyer review the result before you serve real users, and do not remove the banner until you
have.

The same applies to sub-processors: the template names the ones this code actually calls
(Cloudflare, your mail path, Lemon Squeezy and PostHog if you enable them). If your deployment adds
one, the page is wrong until you add it too.

## What is not here

The hosted `rtfx.pro` service is operated separately from this source. Its customer data, live
account configuration, support and billing pipelines, incident history and commercial materials are
not in this repository and are not part of the MIT grant. Neither is the name or the mark — run
your instance under your own. Details in [`OPEN_SOURCE.md`](../OPEN_SOURCE.md).
