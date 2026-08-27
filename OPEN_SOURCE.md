# Open source, and where the line is

This repository is [MIT-licensed](LICENSE) and public on purpose. `rtfx.pro` is a hosted service
run on top of it. Those are two different things, and this document says which is which — so that
someone evaluating the product knows what they can inspect, someone self-hosting knows what they
have to supply themselves, and someone contributing knows what does not belong in a pull request.

Nothing here restricts what the MIT licence grants. The licence is the licence; this is a
description of what is in the repository and what is not, plus two boundaries — brand and hosted
operations — that a copyright licence does not speak to either way.

## Why the code is public

The product's core claim is about access control: private by default, shared with named people,
404 for everyone else. A claim like that is worth exactly as much as the reader's ability to check
it. So the parts that decide who sees what — `src/auth.ts`, `src/authz.ts`, `src/host.ts`, the
serving path, the token model — are readable, and the tests that pin their invariants are readable
next to them. [`SECURITY.md`](SECURITY.md) documents the threat model, including the limits, in the
same repository.

The same reasoning applies to everything that runs on a user's own machine. The Claude Code
plugin, the local MCP server, the CLI and the OAuth credential store handle a user's credentials
and read a user's files; asking someone to install that and also to take its behaviour on faith
would be a poor trade. **None of it is held back, and none of it will be.**

## What is intentionally public

| | Where | Why it is public |
|---|---|---|
| The Worker | `src/`, `schema.sql`, `migrations/` | The whole product. Auth, authorization, serving, API, billing wiring, the public site and the dashboard. |
| The Claude Code plugin | `plugins/rtfx/` | It runs on your machine with your credentials. |
| Local MCP server + CLI | `plugins/rtfx/scripts/`, `cli/` | Same reason. |
| Remote MCP + OAuth server | `src/mcp.ts`, `src/oauth*.ts` | The tool allow-list and the scope checks are the security story; they should be auditable. |
| Tests | `test/` | The invariants are the claim. A claim with no test is marketing. |
| Docs | `docs/`, this file, `SECURITY.md`, `CONTRIBUTING.md` | Architecture, design notes, deployment shape, positioning rules. |
| Deployment *shape* | `wrangler.jsonc`, `scripts/`, `docs/DEPLOY_RTFX.md` | The bindings, routes, hostnames and config gates — the structure of a deployment, with no secret in it. |

`wrangler.jsonc` deliberately contains real non-secret values for the reference deployment
(hostnames, a D1 database id, admin email domains). Those are configuration, not credentials: every
actual secret is a `wrangler secret`, never a file in this tree, and `npm run validate:plugin`
fails the build if a token-shaped string is ever committed under `plugins/`.

## What stays out of this repository

These are not "closed source" so much as *not source at all* — they are the operational and
commercial residue of running a service for other people:

- **Customer and user data.** Anything derived from real accounts: emails, artifacts, view logs,
  support threads, database dumps, exports.
- **Credentials and secrets.** API tokens, Cloudflare tokens, session secrets, webhook signing
  keys, mail credentials, `.dev.vars` and every variant of it (`.gitignore` covers the pattern, not
  just the exact name).
- **Ops runbooks that carry live account detail.** `docs/DEPLOY_RTFX.md` is the deliberate
  exception: it documents the *procedure* for the reference deployment. Anything that would only
  make sense while holding the production account — dashboard-specific IDs, on-call detail, live
  incident timelines — does not belong here.
- **Production incident history and postmortems.** Useful internally; not something to publish
  with third-party detail in it.
- **Analytics and usage exports.** Aggregate or not.
- **Pricing experiments and revenue work.** The plan *shape* is in the code because the Worker
  enforces it. The reasoning behind a price, an experiment, or a forecast is not.
- **Private submission and partner notes.** Correspondence and materials prepared for third
  parties — including anything Anthropic-facing beyond the public submission checklists already in
  `docs/` — stay out.
- **Support, sales and customer pipelines.** Tickets, CRM state, contract templates.
- **Local agent scratch.** `.hermes/plans/` is one agent's working notes, not project
  documentation. It is git-ignored for that reason.

If you are contributing and unsure which side something falls on, the test is simple: *would this
still be useful to someone running their own instance, with no access to the rtfx.pro account?* If
yes, it is documentation. If it only makes sense while holding production credentials, it is ops.

## The hosted service is operated separately

`rtfx.pro` is a hosted instance of this code, operated by its maintainer. The MIT licence gives you
the code; it does not give you anything about that service. Concretely:

- **No warranty and no support commitment attach to the source.** The licence says so, and
  [`SECURITY.md`](SECURITY.md) repeats it: this is one person's project, best effort, in public.
- **Legal and commercial terms belong to the operator, not to the code.** The `/privacy` and
  `/terms` pages in `src/legal.ts` render an *operator template*, and they say so on the page. They
  are a starting point for a self-hoster, not advice, and not the hosted service's final terms.
  Anyone deploying this for other people has to supply their own legal entity, contact address,
  governing law and jurisdiction, and have a lawyer look at it. See
  [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md).
- **The name and the mark are not part of the grant.** "rtfx", "rtfx.pro", the logo and the domain
  identify the hosted service. MIT is a copyright licence and does not license trademarks, so
  running a fork under this name — in a way that suggests it *is* the hosted service, or is
  endorsed by it — is not something the licence covers. Fork it, run it, build a business on it;
  please just call it your own thing. This is a request about identity, not a restriction on use,
  and it is not a claim to any registered right.

## Reporting a problem

Security issues: [`SECURITY.md`](SECURITY.md) — GitHub Security Advisories, never a public issue.
Everything else: ordinary issues and pull requests, per [`CONTRIBUTING.md`](CONTRIBUTING.md).
