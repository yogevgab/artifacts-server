# Positioning: what we claim, and what we refuse to claim

Issue #38. A category formed around "share what Claude just built" faster than we expected,
and the products in it converge on one feature list. This document is the source of truth for
how rtfx.pro is described anywhere public — the landing page, `/docs`, `llms.txt`, the social
card, the README — so the same wedge is argued everywhere and nobody has to re-derive it.

The one-line version, unchanged: **Claude creates. We share.**

The second line, which is the actual differentiator: *and sharing is an access-controlled,
versioned, audited act you performed from inside the session that made the thing.*

---

## The field, as of 2026-08-13

Read from each product's own public pages. Positions move; re-read before rewriting copy.

| Product | Who they say it's for | What they lead with |
|---|---|---|
| [ShareDuo](https://www.shareduo.com/) | Anyone with a Claude artifact | Direct artifact sharing, password protection, expiry, analytics, custom domains, no-account upload, an explicit comparison against Claude's own Publish |
| [Star](https://buildwithstar.com/blog/share-claude-artifact) | People shipping AI-generated games | Instant hosting, permanent links, play tracking, leaderboards, continued AI iteration on the hosted thing |
| [Send](https://www.send.co/) | Teams publishing Claude-created sites and documents | Templates, custom domains, engagement tracking, access control, a Claude connector |
| [Shareable](https://useshareable.com/) | Anyone with an AI-made page, report or dashboard | Access control, analytics, embeds, comments/approvals/polls, versions, MCP and developer docs |

What that adds up to: hosting an AI artifact is solved, and **"upload your HTML" is no longer
a position.** Everyone offers a link. Several offer analytics, custom domains and some form of
access control. Two offer versions. One offers MCP — and as of issue #39, so do we, which is why
MCP is no longer a gap and is no longer worth leading with either. Being reachable from an agent is
converging on table stakes; what stays ours is that the agent's path is the *same* path, with the
same scoped credential and the same access rules, rather than a connector bolted onto a web form.

## Table stakes

Present here, expected everywhere, and never the argument for choosing us. Claim them plainly
and move on — a landing page that spends its hero on these reads like a 2025 product.

- Publishing with no build step (single file, folder or zip).
- A stable, permanent link at a slug.
- Re-publishing to the same address without breaking the link already sent.
- A dashboard with an inventory and per-artifact state.
- Some measure of who looked.

## Differentiators

These are the load-bearing claims. Each one is shipped, each one is defensible against every
product in the table above, and each one is enforced somewhere in the test suite.

1. **Agent-native publishing.** Claude Code, a native MCP server, a Hermes run, the CLI and the
   HTTP API take the *same* path a human takes — there is no separate, weaker agent route, and no
   connector that is really a web form. The agent holds a scoped, owner-bound, revocable token, so
   it can publish as you and can never become you. Competitors have a "Claude connector"; we have
   the publish path being the product's front door. The MCP tools are wrappers over the same
   libraries the CLI uses, so an agent cannot reach anything a person could not, and the credential
   filters that keep a `.env` out of a bundle apply identically
   ([`MCP.md`](MCP.md)). What we still do not claim: sharing through an agent is opt-in per
   operator, and no agent surface can mint a token or invite a person.
2. **Access is an identity, not a secret URL.** Every artifact is restricted until its owner
   names someone. Unauthorized and non-existent return the identical 404 — a leaked link can't
   confirm the artifact is real. This is the sharpest contrast in the field: the category norm
   is a public link with optional friction on top, and ours is a locked artifact with sharing
   as a deliberate, revocable act.
3. **Immutable versions with one-click rollback.** Every publish is a new version with its own
   preview URL. Nothing already shared is overwritten.
4. **A view log that names a person and a version.** Not a hit counter — who, when, from which
   country, and which version they saw. "Analytics" in this category usually means aggregate
   counts; ours is per-identity, which is only possible because access is per-identity.
5. **Workspace governance.** Artifacts belong to a workspace with roles (owner, admin, member,
   viewer), and instance privilege is re-derived from configuration on every request, never
   read from a table. Nobody else in the field describes a governance model at all.
6. **Content-host isolation.** Artifact files are served from a dedicated origin that hosts
   files and nothing else, so published HTML can never reach the dashboard or API that
   published it. State the limit alongside the claim: all artifacts share that one content
   origin, so it is not a per-artifact browser sandbox between mutually distrusting publishers —
   access control is what separates two artifacts. See [SECURITY.md](../SECURITY.md).
7. **No tracking, ours or anyone's.** No analytics, advertising or third-party scripts on the
   site, and none injected into what you publish.

## What we do not have, and must not imply

This list is the reason the section exists. Several competitors advertise these; copy that
borrows their vocabulary starts making claims we cannot honour.

| Not shipped | What we say instead |
|---|---|
| **Per-link passwords / shared link secrets** | "Access-protected", "shared with named people", "sign-in is passwordless (one-time email code)". Never "password-protected". |
| **Link expiry** | Access is revoked by hand. *API tokens* do support an optional expiry — that is a different object; don't blur them. |
| **Custom domains for artifacts** | Content already runs on its own origin, which is the hard part. Listed as planned. |
| **Comments, approvals, polls** | rtfx.pro publishes and controls the artifact; it is not the review tool around it. |
| **Leaderboards, game hosting, templates** | Not a goal. Star's category is not ours. |
| **A published npm package / global `artifacts` binary** | "Install the Claude Code plugin", or "run `node cli/artifacts.mjs …` from a checkout". Never `npx artifacts …`: that name is not ours on the registry. |
| **Per-artifact browser origins or sandboxing** | "Artifact content runs on its own origin, separate from the dashboard and the API." Artifacts share that origin with each other; separation between two artifacts is access control. |

**The password rule, stated once.** There is no password anywhere in this product, by design —
not for sign-in, not on a share link. "Password protection" is a table-stakes feature of the
category that we have not built. Public copy says **access-protected**. `test/positioning.test.ts`
fails the build if any public page claims password protection, so this is enforced rather than
remembered.

## Where each claim is made

| Surface | Carries |
|---|---|
| `src/landing.ts` | The wedge in four cards, the pills, and `featureList` in the JSON-LD. One screen, no stacked sections — issue #35 still holds. |
| `src/docs.ts` → `#why-rtfx` | The full split: table stakes, differentiators, not here yet. The crawlable, quotable version. |
| `src/docs.ts` → `FAQS` | "Can I put a password on a share link?" and "How is this different…" — both answers reach rich results through `FAQPage` JSON-LD. |
| `src/seo.ts` → `llmsTxt()` | The same split for answer engines, including an explicit **Not shipped yet** section. |
| `src/seo.ts` → `ogImageSvg()` | The tagline plus "Agent-native publishing. Versioned. Audited." |
| `docs/MCP.md` | The MCP surface itself, and the plugin-vs-MCP choice. Not public copy, but the thing the claim points at. |
| `README.md` | The developer-facing version of the same order of claims. |

## Changing this

Positioning changes are copy changes across six files at once, and they drift if done one file
at a time. Edit this document first, then the surfaces in the table above, then run
`npm run check` — `test/positioning.test.ts` pins the anchors, the markers and the password
rule.

See also [PUBLIC_SITE.md](PUBLIC_SITE.md) for the crawler contract and the maturity-language
rule, and [DESIGN.md](DESIGN.md) §6 for the copy voice.
