/**
 * Switching the workspace an interactive session acts in.
 *
 * `POST /admin/workspace` is the real one: an ordinary HTML form, server
 * rendered by the portal shell's switcher, which works with JavaScript switched
 * off exactly like every other navigation in the portal.
 * `POST /api/workspace/active` is the same decision for a scripted caller.
 *
 * Three rules hold both routes together, and each one is re-checked here rather
 * than trusted from the request:
 *
 *  1. **Membership, not readability.** Switching means *acting inside* a
 *     workspace, so it takes a row in `account_members` — a platform admin who
 *     may read every account still cannot make one active for themselves. An
 *     account id nobody may switch to answers 404, never 403, so ids stay
 *     unprobeable (the same rule artifacts and `/api/accounts/:id` follow).
 *  2. **Token callers are refused outright.** A bearer credential is issued for
 *     one workspace; letting a request move it would defeat the pinning that
 *     `resolveAccountContext` exists to enforce.
 *  3. **`next` is a same-site path under /admin or nothing.** See {@link safeNext}.
 *
 * CSRF: the cookie carrying the session is `SameSite=Lax`, so a cross-site POST
 * arrives with no session at all and `requireUser` refuses it before any of this
 * runs. The selector cookie this route writes is `SameSite=Lax` for the same
 * reason.
 */

import { Hono, type Context } from "hono";
import type { Env } from "./env";
import { accountsFor, requireUser, WORKSPACE_COOKIE, type AuthVars } from "./auth";
import { memberRole, toPublicAccount, type AccountRole } from "./accounts";
import { portalNotFound } from "./portal";
import { viewerOf } from "./viewer";

type WorkspaceApp = { Bindings: Env; Variables: AuthVars };
type WorkspaceContext = Context<WorkspaceApp>;

export const workspaceRoutes = new Hono<WorkspaceApp>();

/** The server-rendered switch, and its `/switch` alias. */
const SWITCH_PATH = "/admin/workspace";
const SWITCH_ALIAS = "/admin/workspace/switch";
/** The JSON equivalent, for anything scripted against the portal. */
const ACTIVE_PATH = "/api/workspace/active";

for (const path of [SWITCH_PATH, SWITCH_ALIAS, ACTIVE_PATH]) {
  workspaceRoutes.use(path, requireUser);
}

/** A year. The selection is a preference, not a credential — see WORKSPACE_COOKIE. */
const SELECTOR_MAX_AGE = 365 * 24 * 60 * 60;

function selectorCookie(accountId: string): string {
  return [
    `${WORKSPACE_COOKIE}=${encodeURIComponent(accountId)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SELECTOR_MAX_AGE}`,
  ].join("; ");
}

/**
 * Where to send a browser after a switch — a relative, same-site path under
 * `/admin`, or `/admin` when it is anything else.
 *
 * The allow-list is deliberately a shape test rather than a blocklist of known
 * bad prefixes: `//evil.example`, `https://evil.example`, `/adminfoo`,
 * `\\evil.example` and a path with a smuggled newline all fail the *same* rule
 * ("starts with /admin, is a path, has no traversal"), so there is no ordering
 * between checks to get wrong. Query and fragment survive, because a switch
 * from a filtered list should land back on the same filtered list.
 */
export function safeNext(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > 512) return "/admin";
  // A control character (CR/LF above all) has no business in a Location header.
  if (/[\u0000-\u001f\u007f]/.test(value)) return "/admin";
  // Backslashes are path separators to some clients, which is how `/\evil.com`
  // becomes a protocol-relative URL in practice.
  if (value.includes("\\")) return "/admin";
  const path = value.split(/[?#]/)[0];
  if (!/^\/admin(\/.*)?$/.test(path)) return "/admin";
  if (path.split("/").includes("..")) return "/admin";
  return value;
}

/**
 * The account this caller may switch into, or null.
 *
 * `memberRole` is the whole check: it reads `account_members` for this exact
 * identity, so an id the caller has no row for — unknown, deleted, or one they
 * were removed from — is indistinguishable from any other stranger's.
 */
async function switchableTo(
  c: WorkspaceContext,
  accountId: string
): Promise<AccountRole | null> {
  const identity = c.get("identity");
  if (identity.token) return null;
  if (!accountId) return null;
  return memberRole(c.env, accountId, identity.email);
}

async function requestedAccountId(c: WorkspaceContext): Promise<{ id: string; next: string }> {
  const type = c.req.header("Content-Type") ?? "";
  if (type.includes("application/json")) {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    return {
      id: String(body?.account_id ?? "").trim(),
      next: safeNext(body?.next),
    };
  }
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  return { id: String(form.account_id ?? "").trim(), next: safeNext(form.next) };
}

/**
 * Server-rendered switch. 303 on success so the browser re-issues a GET —
 * without it, a reload of the destination would re-POST the switch.
 */
async function handleSwitch(c: WorkspaceContext) {
  const { id, next } = await requestedAccountId(c);
  const role = await switchableTo(c, id);
  if (!role) {
    // Rendered inside the shell rather than as bare JSON: whoever hit this is
    // holding a page, and 404 keeps a workspace they don't belong to as silent
    // as one that never existed.
    return c.html(await notFoundPage(c), 404);
  }
  return c.body(null, 303, { Location: next, "Set-Cookie": selectorCookie(id) });
}

async function notFoundPage(c: WorkspaceContext): Promise<string> {
  return portalNotFound(await viewerOf(c), "That workspace");
}

workspaceRoutes.post(SWITCH_PATH, handleSwitch);
workspaceRoutes.post(SWITCH_ALIAS, handleSwitch);

/**
 * The same switch for a scripted caller. Answers with the context the caller
 * would next have read from `GET /api/accounts`, so a client needs one round
 * trip rather than two.
 */
workspaceRoutes.post(ACTIVE_PATH, async (c) => {
  if (c.get("identity").token) {
    return c.json(
      {
        error: "forbidden",
        detail: "an API token is pinned to the workspace it was issued for and cannot switch",
      },
      403
    );
  }
  const { id } = await requestedAccountId(c);
  if (!id) return c.json({ error: "bad_request", detail: "account_id is required" }, 400);
  const role = await switchableTo(c, id);
  if (!role) return c.json({ error: "not_found" }, 404);

  // Re-resolve with the selection applied rather than echoing the request back,
  // so the response says what the *next* request will actually see.
  const ctx = await accountsFor(c);
  const chosen = ctx.memberships.find((m) => m.account.id === id);
  return c.json(
    {
      active: id,
      accounts: ctx.memberships.map((m) => toPublicAccount(m.account, m.role)),
      your_role: chosen?.role ?? role,
      pinned: false,
    },
    200,
    { "Set-Cookie": selectorCookie(id) }
  );
});
