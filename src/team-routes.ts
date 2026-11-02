/**
 * Self-serve Team: `/upgrade/team` (the public "Buy Team" button) and
 * `/admin/join/:id` (the link in a member-invite email).
 *
 * Team only makes sense on a *team* workspace — a personal workspace is one
 * person's by construction — and until now only a platform operator could make
 * one (`POST /api/accounts`, src/api.ts). So buying Team is also how a person
 * gets a team workspace: sign up if needed, name the workspace (they become
 * its owner), and land on the hosted checkout for it. Members they add from
 * Settings are emailed a link (src/members-routes.ts), which is what made this
 * safe to sell without a person in the loop.
 *
 * Guard rails, because "create a workspace" is now reachable by anyone signed in:
 *  - a person who already owns an unpaid team workspace is sent to *its*
 *    checkout instead of getting another one (see `existingTeam`);
 *  - at most MAX_OWNED_TEAMS team workspaces per owner, and MAX_CREATES_PER_HOUR
 *    creations per person;
 *  - a new team workspace starts on Free (1 seat), so it is worth nothing until
 *    it is paid for.
 *
 * CSRF: the POST rides the session cookie, which is `SameSite=Lax`, so a
 * cross-site form post arrives signed out and `requireUser` refuses it.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { AppBindings, Env } from "./env";
import { accountsFor, requireUser, resolveAuth, type AuthVars } from "./auth";
import { createAccount, memberRole, upsertMember, type AccountRow, type Membership } from "./accounts";
import { checkoutUrl } from "./billing";
import { priceLabel, UPGRADE_TEAM_PATH } from "./plan-copy";
import { teamNamePage } from "./login";
import { incrementRateLimitBucket } from "./rate-limit";
import { selectorCookie } from "./workspace-routes";

type TeamApp = { Bindings: Env; Variables: AuthVars };
type TeamContext = Context<TeamApp>;

export const teamRoutes = new Hono<TeamApp>();

export const MAX_OWNED_TEAMS = 5;
export const MAX_CREATES_PER_HOUR = 5;
export const MAX_TEAM_NAME = 60;

/**
 * Nobody signed in → send them to `dest` with `path` as where to come back to.
 * A paused account or a bad bearer token is passed on to `requireUser`, which
 * answers it properly (paused sheet / 401) — redirecting those would loop.
 */
export function signedOutTo(dest: "/signup" | "/login", path: string): MiddlewareHandler<TeamApp> {
  return async (c, next) => {
    const { identity, disabled, invalidToken } = await resolveAuth(c);
    if (!identity && !disabled && !invalidToken) {
      return c.redirect(`${dest}?next=${encodeURIComponent(path)}`, 302);
    }
    return next();
  };
}

/** An active team workspace that is not paying yet — the only kind "Buy Team" can mean. */
function unpaidTeam(m: Membership): boolean {
  return m.account.kind === "team" && m.account.status === "active" && m.account.plan === "free";
}

/**
 * Which existing team workspace "Buy Team" means for this person, if any:
 *  - the ACTIVE workspace, when it is an unpaid team they own or administer
 *    (they are explicitly in it, so an admin buying for it is what they mean);
 *  - otherwise the first unpaid team workspace they OWN — never one they merely
 *    administer, which would sell somebody else's workspace a plan on a click
 *    meant to start their own.
 * Null means "make a new one": a paid team workspace never swallows the click.
 */
function existingTeam(ctx: Awaited<ReturnType<typeof accountsFor>>): AccountRow | null {
  const active = ctx.memberships.find(
    (m) => m.account.id === ctx.active?.id && unpaidTeam(m) && (m.role === "owner" || m.role === "admin")
  );
  if (active) return active.account;
  return ctx.memberships.find((m) => unpaidTeam(m) && m.role === "owner")?.account ?? null;
}

/**
 * Checkout for `account` when it is still on the Free billed plan; Billing for
 * anything else (already paying — a second subscription is not an upgrade — or
 * checkout not configured). Either way that workspace becomes the active one,
 * so the page they land on afterwards is about it.
 */
function toCheckout(c: TeamContext, account: AccountRow, status: 302 | 303 = 302): Response {
  const url =
    account.plan === "free" ? checkoutUrl(c.env, "team", { id: account.id }, c.get("email")) : null;
  return c.body(null, status, {
    Location: url ?? "/admin/billing",
    "Set-Cookie": selectorCookie(account.id),
    "Cache-Control": "no-store",
  });
}

function namePage(c: TeamContext, opts: { error?: string; name?: string } = {}, status: 200 | 400 | 429 = 200) {
  c.header("Cache-Control", "no-store");
  return c.html(teamNamePage(c.env, { price: priceLabel("team"), ...opts }), status);
}

teamRoutes.get(UPGRADE_TEAM_PATH, signedOutTo("/signup", UPGRADE_TEAM_PATH), requireUser, async (c) => {
  // A bearer token is pinned to one workspace and must never be handed a
  // checkout prefilled with its owner's email (same rule as /admin/billing).
  if (c.get("identity").token) return c.redirect("/admin/billing", 302);
  const team = existingTeam(await accountsFor(c));
  if (team) return toCheckout(c, team);
  return namePage(c);
});

teamRoutes.post(UPGRADE_TEAM_PATH, requireUser, async (c) => {
  if (c.get("identity").token) return c.json({ error: "forbidden", detail: "sign in to buy Team" }, 403);
  const email = c.get("identity").email;
  if (!email) return c.redirect("/admin/billing", 303);

  const ctx = await accountsFor(c);
  // A double submit, or a second tab: reuse the workspace rather than mint another.
  const team = existingTeam(ctx);
  if (team) return toCheckout(c, team, 303);

  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const name = String((form as Record<string, unknown>).name ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return namePage(c, { error: "Give the workspace a name." }, 400);
  if (name.length > MAX_TEAM_NAME) {
    return namePage(c, { error: `Keep it under ${MAX_TEAM_NAME} characters.`, name }, 400);
  }

  const owned = ctx.memberships.filter((m) => m.account.kind === "team" && m.role === "owner").length;
  if (owned >= MAX_OWNED_TEAMS) {
    return namePage(c, { error: "You already own several team workspaces — talk to us for more.", name }, 400);
  }
  const allowed = await incrementRateLimitBucket(
    c as unknown as Context<AppBindings>,
    `team-create:email:${email}`,
    MAX_CREATES_PER_HOUR
  );
  if (!allowed) return namePage(c, { error: "Too many workspaces created just now — try again later.", name }, 429);

  const now = new Date().toISOString();
  const account = await createAccount(c.env, {
    name,
    kind: "team",
    personalEmail: null,
    createdBy: email,
    now,
  });
  await upsertMember(c.env, { accountId: account.id, email, role: "owner", invitedBy: null, now });
  return toCheckout(c, account, 303);
});

/**
 * The link in a member-invite email. Signs the person in if needed (coming back
 * here), then opens that workspace if they belong to it. Anybody else lands on
 * their dashboard with nothing changed, and nothing says whether the id exists.
 */
const JOIN_PATH = "/admin/join/:id";
teamRoutes.get(
  JOIN_PATH,
  async (c, next) => signedOutTo("/login", `/admin/join/${encodeURIComponent(c.req.param("id"))}`)(c, next),
  requireUser,
  async (c) => {
    const identity = c.get("identity");
    const id = c.req.param("id");
    if (identity.token || !identity.email || !(await memberRole(c.env, id, identity.email))) {
      return c.redirect("/admin", 302);
    }
    return c.body(null, 302, { Location: "/admin", "Set-Cookie": selectorCookie(id), "Cache-Control": "no-store" });
  }
);
