# rtfx.pro — design system

The durable source of truth for how rtfx.pro looks, reads and behaves. When a
change and this document disagree, one of them is wrong; decide which, then fix
it here first.

Scope: the app surfaces we render — landing, `/login`, `/gallery`, `/admin`,
error pages. Uploaded artifacts are the customer's own HTML and are never
restyled by us.

---

## 1. What we're going for

The reference point is Apple's product design **language**, not Apple's brand:
premium, quiet, high-trust, spacious, crisp typography, soft gradients and glass,
restrained motion, minimal copy. We use none of Apple's marks, fonts-as-assets,
icons, photography or copy, and we never imply endorsement. `-apple-system` in
the font stack is the platform UI font, which is exactly what it's for.

Six rules, in priority order. Earlier rules win.

1. **Legible before beautiful.** No effect may cost contrast or focus visibility.
2. **One idea per screen.** Every page has a single primary action. Everything
   else is visibly secondary.
3. **Quiet by default.** Colour is reserved for state and the primary action.
   A screen at rest is greyscale plus one accent.
4. **Space is the layout.** Reach for whitespace before borders, borders before
   background fills, fills before shadows.
5. **Restrained motion.** Nothing travels more than ~2px or lasts more than
   180ms, and nothing moves at all under `prefers-reduced-motion`.
6. **Say the true thing, briefly.** Copy explains what happened and what to do
   next. No exclamation marks, no cheer, no blame.

### Anti-patterns

Spinners that outlive their request · red for anything that isn't an error ·
modal dialogs for reversible actions · "Oops!" · icon-only buttons · placeholder
text doing a label's job · a warning colour on a state that is merely uncommon.

---

## 2. Personas

Five people use this product. Each one's needs shape a surface.

| Persona | Enters at | Needs to know | Deliberately cannot |
|---|---|---|---|
| **Anonymous visitor** | `/` | What this is, that it's invite-only, which of "request access" / "sign in" applies to them | See any artifact, user or count |
| **Invited beta user** | `/login` → `/admin` | That their invite works, how to publish, what's theirs | See other people's artifacts, the People panel, or anyone's tokens |
| **Admin** | `/admin` | Who's in the beta and what state they're in; everything published | Act on another admin; disable or remove themselves |
| **Super admin / operator** | `/admin` | Everything an admin sees, plus admin-level lifecycle | Be disabled or removed — by anyone, including themselves |
| **Agent (Claude Code / Hermes / CI)** | `/api/*` with a bearer token | Machine-readable outcomes and precise error codes | Reach any user-management route at all |

Notes that matter to design:

- **The anonymous visitor is the only persona with no identity**, so `/` and
  `/login` must be complete without one. Neither may sit behind Cloudflare
  Access — a visitor meeting Cloudflare's own login screen with no context is
  the single worst first impression this product can make.
- **The invited beta user is the persona we most often get wrong.** They see a
  narrowed dashboard, and every narrowing must read as "this isn't yours" rather
  than "something is broken".
- **The agent has no eyes.** Its UI is the JSON error code — `invalid_token`,
  `insufficient_scope`, `account_disabled` are distinct on purpose, so a CLI can
  say something specific. Never collapse them into `forbidden`.
- **The super admin is a safety mechanism, not a tier.** It exists so that no
  sequence of clicks ends with nobody able to administer the instance.

---

## 3. Tokens

Defined once, in `STYLE` in `src/pages.ts`. Never hard-code a value that has a
token, and never introduce a new colour without adding it here.

**Colour.** Both schemes are first-class; light mode is not an afterthought.

| Token | Meaning |
|---|---|
| `--bg` / `--bg2` | Page gradient endpoints |
| `--elev` / `--card` | Translucent glass surfaces (need `--blur` behind them) |
| `--fg` / `--muted` / `--faint` | Text: primary / secondary / tertiary |
| `--accent` / `--accent2` | The one accent, and its gradient partner |
| `--ok` / `--danger` (+ `-weak`) | State only — success and error, never decoration |
| `--border` / `--border-strong` | Hairlines, as alpha over the surface |

Contrast floor: **4.5:1** for body text, **3:1** for large text and for the
border of any interactive control, in both schemes. A pill's colour is never its
only signal — every pill also carries its word.

**Shape.** `--radius` 24px (cards, panels, sheets) · `--radius-sm` 14px (inputs,
inline messages) · `999px` (buttons, pills, the top bar). Buttons are fully
round; containers are soft rectangles. Don't invent intermediate radii.

**Type.** Platform UI stack, `--mono` for anything a machine produced (emails,
slugs, ids, tokens). Display headings use tight tracking (`-.045em` and tighter
as they grow) and `clamp()` so they scale without breakpoints. Body stays 16px.

**Depth.** One `--shadow`, one `--blur`. Glass requires something behind it to
blur — never on a flat background, where it only costs performance.

**Motion.** 150–180ms, ease-out, transform ≤2px. All of it disabled under
`prefers-reduced-motion: reduce` (already handled globally in `pages.ts`).

---

## 4. Components

| Component | Where | Rule |
|---|---|---|
| **Sheet** (`.sheet`) | `/login`, paused, future auth states | One column, max 34rem, centred. Exactly one primary action. |
| **Panel** (`.panel`) | `/admin` sections | Glass card. `panel-head` = title + one line of hint. |
| **Stat tile** (`.stat`) | `/admin` header | Number first, label above, one hint below. No sparklines. |
| **Row** (`.row`) | Lists of people, tokens, versions | Info left, actions right, hairline between. Collapses to stacked on ≤720px. |
| **Pill** (`.badge`) | State | See the status vocabulary below. |
| **Button** | Everywhere | Filled = primary (one per view). `.ghost` = secondary. `.danger` = destructive, outline only — never a filled red button. |
| **Empty state** (`.empty`) | Any list that can be empty | Title says what's missing, body says how to fix it. Never just "No data". |

### Status vocabulary

One word means one thing product-wide. Defined in `pages.ts` so the People
panel, the token list and the sign-in page cannot drift apart.

| Pill | Class | Means |
|---|---|---|
| Active | `.is-active` | Signed in at least once, working now |
| Invited | `.is-invited` | On the allow-list, never signed in |
| Paused | `.is-disabled` | Access disabled; reversible; nothing deleted |
| No sign-in | `.is-warn` | Drift: in our directory, but Access won't let them in |
| Owner / Admin / Member | `.is-role` | Configured role (from env, never editable in-product) |
| Revoked / Expired | `.is-revoked` / `.is-locked` | Token states |

"Paused" is the user-facing word for the `disabled` status. `disabled` is the
API/database word. Don't mix them: the UI says paused, the JSON says disabled.

---

## 5. States

Every list and every action carries all five. Missing states are bugs.

1. **Empty** — a title and a next step.
2. **Loading** — the button reads its verb in progress ("Inviting…"), disabled.
   No full-page spinners; a request under ~300ms shows nothing.
3. **Partial** — the local write landed but Cloudflare Access didn't. Say both
   halves. This is why user mutations return a `warning` field.
4. **Error** — what failed, and whether their data is safe. Reuse the API's
   `detail` verbatim when it's human-readable.
5. **Success** — state visibly changes; a reload is acceptable when the server
   is the source of truth.

### The auth states

| State | Surface | Says |
|---|---|---|
| Signed out | `/login` `data-state="signed-out"` | Two paths: continue with email, or request access |
| Signed in | `/login` `data-state="signed-in"` | Who you are, and get out of the way |
| Paused | `/login` and any HTML 403 `data-state="paused"` | Reversible, nothing deleted, who to ask |

The paused page is the one to be most careful with. Somebody invited last week
being told "Forbidden" is the worst moment in this product. Name the state, say
it's reversible, say their work is intact, say who can undo it — and never imply
they did something wrong.

---

## 6. Copy

- Sentence case everywhere. No Title Case buttons.
- Buttons are verbs: "Send invite", "Pause", "Re-enable", "Remove".
- Destructive confirmations state the blast radius *and* what survives: removing
  someone takes their sign-in, grants and tokens — **not** their artifacts.
- Second person for the user, never "we" for the system.
- English for the beta. Hebrew-first copy is desirable later (issue #24) and
  nothing here should block it, but mixed-language UI is worse than consistent
  English — so switch a whole surface at a time, and add `dir="rtl"` support to
  `layout()` when we do.

---

## 7. Accessibility

Non-negotiable, and the first thing to check in review.

- Every interactive control reachable and operable by keyboard, in DOM order.
- `:focus-visible` is a 3px accent ring with 3px offset. Never remove it.
- Landmarks: `header` / `main` / `footer`, one `h1` per page, headings nested
  without skipping.
- Every input has a real `<label>` or `aria-label`. Placeholders are examples,
  never labels.
- Status messages live in the element the action owns (`[data-status]`), next to
  the control that caused them.
- Colour is never the only signal — pair every colour with a word or an icon.
- Icon-only controls need `.sr-only` text.
- Confirm dialogs use native `confirm()` deliberately: it's keyboard-accessible
  and screen-reader-announced for free, and this app ships no dialog library.
- Tap targets ≥44×44px on touch; `.small` buttons keep enough padding.
- Test with `prefers-reduced-motion` and `prefers-color-scheme` both ways.

---

## 8. Where things live

| File | Owns |
|---|---|
| `src/pages.ts` | Tokens, base elements, shared status vocabulary, `layout()` |
| `src/landing.ts` | Public marketing page and its CTAs |
| `src/login.ts` | The three auth states |
| `src/admin.ts` | Dashboard: stats, publish, artifacts, People, tokens |
| `docs/DESIGN.md` | This document |

Page-specific CSS stays in that page's module and builds on the tokens. If two
pages need the same rule, it belongs in `pages.ts` — that's how the status pills
got there.

### Test markers

Tests assert on stable `data-*` hooks, never on copy or class names, so wording
can be improved without breaking the suite. Keep these stable:

`data-page="login"` · `data-state="signed-out|signed-in|paused"` ·
`data-cta="sign-in|request-access|dashboard"` · `data-panel="users"` ·
`data-user="<email>"` · `data-user-status` · `data-user-role` ·
`data-user-action="disable|enable|remove"` · `data-badge="role|status|allowlist"` ·
`data-users-unconfigured` · `data-users-error`
