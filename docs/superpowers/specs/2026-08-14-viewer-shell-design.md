# Design: the viewer shell

**Date:** 2026-08-14
**Status:** Approved for planning
**Depends on:** `2026-08-14-app-owned-identity-design.md` (guest identity), and the Access cutover

## 1. Why

Two requests — an in-document share control, and a chat alongside the document — both need
product UI to sit next to an artifact while it is being read. There is currently nowhere for
that UI to live.

The obvious implementation, injecting it into the served HTML, is unsafe. Artifact content is
served with `script-src * 'unsafe-inline' 'unsafe-eval'` (`src/serve.ts:40`) because AI-built
pages need CDNs and inline scripts. Uploaded HTML therefore runs arbitrary JavaScript. Putting
a share control in that document would place privileged UI same-origin with attacker-controlled
code: an artifact could read the control's state, invoke its endpoints as the viewer, or render
a convincing fake one.

So the chrome goes in a **shell** on our origin, and the artifact goes in a frame the shell's
code cannot be reached from.

## 2. Goals

- Owners and editors can share an artifact from inside it, without returning to the dashboard.
- Everyone who can open an artifact can talk about it in a chat attached to it.
- No link already shared stops working.
- Untrusted artifact HTML gains no new capability whatsoever.

## 3. Non-goals

- Online editing of artifact content (later; the chat is the seam it will arrive through).
- AI participation via OpenRouter (later; designed for, not built).
- Comment threading, reactions, file attachments in chat.

## 4. The URL contract

`https://a.rtfx.pro/<slug>/` — the address people already have — now serves the **shell**.
The artifact renders inside it. Nothing anybody has shared breaks, and every existing link
silently gains the banner and the chat.

Raw content remains addressable at `https://a.rtfx.pro/<slug>/` for direct subresource loads
(`./app.js`, `./style.css`), which the frame requests normally. The shell is served only for
navigation requests to the artifact root; asset requests are unaffected.

Distinguishing them: `Sec-Fetch-Dest: document` on a top-level navigation, plus the absence of
our frame marker query. Assets carry `Sec-Fetch-Dest: script|style|image|…`. A request with no
`Sec-Fetch-*` headers at all (curl, old clients) gets raw content, which preserves the machine
and CLI behaviour exactly.

## 5. Isolation

```
a.rtfx.pro/<slug>/                     ← shell, our code, our origin
  ┌──────────────────────────────┐
  │ banner · chat · versions     │
  │ ┌──────────────────────────┐ │
  │ │ <iframe sandbox=         │ │
  │ │   "allow-scripts         │ │  ← opaque origin
  │ │    allow-forms           │ │     no cookies
  │ │    allow-popups">        │ │     no parent access
  │ │  a.rtfx.pro/<slug>/?raw  │ │
  │ └──────────────────────────┘ │
  └──────────────────────────────┘
```

**`allow-same-origin` is deliberately absent.** Its absence is the entire security property:
the browser gives the framed document an opaque origin, so it cannot read `document.cookie`,
cannot make credentialed same-origin requests, and cannot reach `window.parent`. This is the
guarantee per-artifact subdomains would have bought, enforced by the browser instead of by DNS
and a paid certificate.

Consequences accepted:

- A framed artifact loses `localStorage` and credentialed same-origin `fetch`. Subresource
  loads (`<script src>`, `<img>`, `<link>`) are unaffected. Artifacts that fetch their own JSON
  need permissive CORS on content responses, which we add.
- `frame-ancestors 'none'` becomes `frame-ancestors 'self'` on content responses. It must not
  become `*`: that would let any site on the internet frame a viewer's authenticated artifact.

## 6. The share banner

Visible only to a caller who `canManage` the artifact. A viewer sees no banner at all — not a
disabled one, which would only advertise a control they cannot use.

Contents: current visibility, a person-per-row access list (replacing the comma-separated
textarea the replan flagged), a copy-link button, and the version indicator. It calls the same
`PUT /artifacts/:slug/access` the dashboard does; no new authorization surface is introduced,
which is deliberate — one policy path, already tested.

## 7. Chat

One **Durable Object per artifact**, keyed by slug. It holds message history in its SQLite
storage and the connected-participant set in memory, which is exactly the coordination problem
Durable Objects exist for.

**Authorization is not the DO's job.** The Worker authorizes the WebSocket upgrade using the
same `canView` path that authorizes serving the artifact, then hands the socket to the object.
The DO never sees a credential and cannot be reached directly. If you cannot open the artifact,
you cannot open its chat — one rule, not two.

Participants are members and guests alike: guests are real identities under the identity spec,
so a person a document was shared with can talk about it. Messages carry the author's email and
the artifact version current at the time, so a comment about "the chart on page 2" stays
anchored to the version it was about.

The future OpenRouter participant joins this room as another member. Nothing about the room's
design assumes its members are human, which is the point of specifying it now rather than later.

## 8. Data model

```sql
-- Chat lives in the Durable Object's own SQLite, not D1: it is per-artifact,
-- write-heavy, and never queried across artifacts.
--   messages(id, author_email, author_kind, version, body, created_at)
```

D1 gains nothing for chat. It gains one column for the shell:

```sql
ALTER TABLE artifacts ADD COLUMN chat_enabled INTEGER NOT NULL DEFAULT 1;
```

## 9. Testing

- The shell is served for navigations and **not** for asset or machine requests.
- The frame tag contains `sandbox` and never `allow-same-origin` — asserted directly on the
  rendered HTML, because this is the one line where a regression is a vulnerability.
- `frame-ancestors 'self'`, never `*`.
- A viewer without manage rights receives no banner markup at all.
- WebSocket upgrade is refused for an identity that `canView` rejects, including a guest whose
  grant is for a different slug.
- An existing shared link still renders the artifact.

## 10. Open questions

1. Whether chat should be on by default for every artifact or opt-in per artifact. The column
   defaults to on; a one-line change if that is wrong.
2. Whether guests may post or only read. Currently: post. Read-only guests would need a
   per-artifact setting, which is scope creep until somebody asks.
