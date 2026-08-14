import { Hono } from "hono";
import type { Env } from "./env";
import { requireUser, type AuthVars } from "./auth";
import { viewerOf, type PortalContext } from "./viewer";
import { canSeeSection, portalNotFound, type PortalViewer } from "./portal";
import { platformPage, type PlatformInfo } from "./admin";
import {
  operatorSections,
  platformAccountPage,
  type Flash,
  type OperatorData,
} from "./platform";
import { getAccount, type AccountRow } from "./accounts";
import { countAudit, listAudit, type AuditActor } from "./audit";
import {
  accountSummary,
  clearPlanOverride,
  isOverridablePlan,
  listAccountSummaries,
  listBillingEvents,
  listContactRequests,
  listMailLog,
  setAccountNotes,
  setPlanOverride,
  suspendAccount,
  unsuspendAccount,
  MAX_ACCOUNT_NOTES_LENGTH,
} from "./operator";
import { adminEmails, listUsers, superAdminEmails } from "./users";
import { listApiTokens } from "./tokens";
import { listArtifacts, allVersions } from "./db";
import { parseHostnames } from "./host";
import { siteOrigin } from "./seo";

/**
 * The operator control plane's HTTP surface: `/admin/platform` and everything
 * under it (Production SaaS plan, Phase 1).
 *
 * This module owns the whole surface, GET and POST, and it is the ONLY place
 * that decides who may reach it. src/operator.ts performs the writes and
 * deliberately authorizes nothing; src/platform.ts renders and deliberately
 * hides nothing. Concentrating the decision here means "who can suspend a
 * workspace?" has exactly one answer to read — {@link operatorViewer} — rather
 * than a policy smeared across a renderer, a route and a write helper.
 *
 * Three rules the routes hold to:
 *
 *  1. **Super admin, re-checked per request.** `role` is capped at `admin` for
 *     every non-interactive caller (see `effectiveRole` in users.ts), so an API
 *     token can never reach these routes even if its owner is a super admin.
 *     A leaked machine credential cannot comp an account or suspend one.
 *  2. **404, never 403.** Refusing with "forbidden" would confirm both that the
 *     surface exists and that the account id in the URL is real. Everything a
 *     non-operator asks for here is simply not found, exactly as the rest of the
 *     portal answers for an artifact that isn't theirs.
 *  3. **Post/Redirect/Get.** Every control POSTs and redirects to a GET, so a
 *     reload or a back button cannot re-apply a suspension. The outcome travels
 *     as a short code in the query string ({@link FLASH_MESSAGES}) rather than
 *     as text, so nothing a client can type is ever rendered back into the page.
 */

type PlatformApp = { Bindings: Env; Variables: AuthVars };

export const platformRoutes = new Hono<PlatformApp>();

const ACCOUNT_PATH = "/admin/platform/accounts/:id";

platformRoutes.use("/admin/platform", requireUser);
platformRoutes.use("/admin/platform/*", requireUser);

// --- who may be here --------------------------------------------------------

/**
 * The viewer, if they may operate this instance at all. Null means "answer 404"
 * — the caller is a member, a plain admin, or any bearer token.
 */
async function operatorViewer(c: PortalContext): Promise<PortalViewer | null> {
  const viewer = await viewerOf(c);
  return canSeeSection(viewer, "platform") ? viewer : null;
}

/** The 404 every refusal on this surface answers with. */
async function refuse(c: PortalContext, what: string) {
  return c.html(portalNotFound(await viewerOf(c), what), 404);
}

/** Who to record as the actor. `role` is the PLATFORM role, always `super_admin` here. */
function actorOf(c: PortalContext): AuditActor {
  const identity = c.get("identity");
  return { email: identity.email, role: identity.role };
}

/**
 * Refuse a POST that a browser did not send from this origin.
 *
 * The session cookie is already `SameSite=Lax`, which is what actually stops a
 * cross-site form post from carrying credentials; this is the belt to that
 * braces, and it costs one header comparison. A request with no `Origin` at all
 * (curl, an integration test, an agent) is allowed through — it has no ambient
 * credential to be abused in the first place, and refusing it would break every
 * non-browser caller for no gain.
 */
function crossOrigin(c: PortalContext): boolean {
  const origin = c.req.header("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin !== new URL(c.req.url).origin;
  } catch {
    return true;
  }
}

// --- flash messages ---------------------------------------------------------

/**
 * Outcomes an operator action can redirect with. A closed set on purpose: the
 * query string is attacker-controlled, and a code that isn't in this table
 * renders nothing at all rather than a sentence somebody else wrote.
 */
const FLASH_MESSAGES: Record<string, Flash> = {
  override_set: { kind: "ok", message: "Plan override applied. The workspace has it immediately." },
  override_cleared: {
    kind: "ok",
    message: "Override cleared — the workspace is back on the plan it is billed for.",
  },
  suspended: {
    kind: "ok",
    message: "Workspace suspended. It cannot publish, and its artifacts stop serving. Nothing was deleted.",
  },
  unsuspended: { kind: "ok", message: "Suspension lifted. Publishing and serving have resumed." },
  notes_saved: { kind: "ok", message: "Operator notes saved." },
  bad_plan: {
    kind: "error",
    message: "That is not a plan this instance can put an account on. Nothing was changed.",
  },
  bad_expiry: {
    kind: "error",
    message:
      "That expiry is not a date in the future. An override that has already expired would do nothing, so nothing was changed.",
  },
  notes_too_long: {
    kind: "error",
    message: `Notes are capped at ${MAX_ACCOUNT_NOTES_LENGTH} characters. Nothing was changed.`,
  },
  no_override: { kind: "error", message: "This workspace has no override to clear." },
  already_suspended: { kind: "error", message: "This workspace is already suspended." },
  not_suspended: { kind: "error", message: "This workspace is not suspended." },
};

function flashFrom(c: PortalContext): Flash | null {
  const code = c.req.query("ok") ?? c.req.query("err");
  return (code && FLASH_MESSAGES[code]) || null;
}

/** Back to the account page, carrying the outcome. */
function back(c: PortalContext, id: string, code: string) {
  const key = FLASH_MESSAGES[code]?.kind === "error" ? "err" : "ok";
  return c.redirect(`/admin/platform/accounts/${encodeURIComponent(id)}?${key}=${code}`, 303);
}

// --- GET /admin/platform ----------------------------------------------------

platformRoutes.get("/admin/platform", async (c) => {
  const viewer = await operatorViewer(c);
  if (!viewer) return refuse(c, "The Platform section");

  const q = (c.req.query("q") ?? "").trim();
  const now = new Date().toISOString();
  const [rows, versions, users, tokens, accounts, audit, auditTotal, contacts, billing, mail] =
    await Promise.all([
      listArtifacts(c.env),
      allVersions(c.env),
      listUsers(c.env),
      listApiTokens(c.env),
      listAccountSummaries(c.env, { q, limit: 200 }),
      listAudit(c.env, { limit: 25 }),
      countAudit(c.env),
      listContactRequests(c.env, 20),
      listBillingEvents(c.env, { limit: 20 }),
      listMailLog(c.env, 20),
    ]);

  const info: PlatformInfo = {
    origin: siteOrigin(c.env),
    accessConfigured: !!(c.env.ACCESS_AUD && c.env.ACCESS_TEAM_DOMAIN),
    accessTeamDomain: c.env.ACCESS_TEAM_DOMAIN ?? "",
    contentHosts: [...parseHostnames(c.env.CONTENT_HOSTNAMES)],
    devLogin: c.env.DEV_LOGIN === "true",
    adminCount: adminEmails(c.env).length,
    superAdminCount: superAdminEmails(c.env).length,
    serviceTokenCount: (c.env.ADMIN_SERVICE_TOKENS ?? "").split(",").filter((s) => s.trim()).length,
    totals: {
      artifacts: rows.length,
      versions: [...versions.values()].reduce((n, v) => n + v.length, 0),
      bytes: rows.reduce((n, r) => n + r.size_bytes, 0),
      people: users.length,
      tokens: tokens.length,
    },
  };

  const operator: OperatorData = { accounts, audit, auditTotal, contacts, billing, mail, q, now };
  return c.html(platformPage(viewer, info, operator));
});

// --- GET /admin/platform/accounts/:id ---------------------------------------

platformRoutes.get(ACCOUNT_PATH, async (c) => {
  const viewer = await operatorViewer(c);
  const id = c.req.param("id");
  if (!viewer) return refuse(c, "The Platform section");

  const summary = await accountSummary(c.env, id);
  if (!summary) return refuse(c, `The workspace "${id}"`);

  const [audit, billing] = await Promise.all([
    listAudit(c.env, { targetId: id, limit: 50 }),
    listBillingEvents(c.env, { accountId: id, limit: 25 }),
  ]);
  return c.html(
    platformAccountPage(viewer, {
      summary,
      audit,
      billing,
      now: new Date().toISOString(),
      flash: flashFrom(c),
    })
  );
});

// --- the controls -----------------------------------------------------------

/**
 * The account this POST is about, once the caller has been confirmed as an
 * operator and the request as same-origin. Null means the route has already
 * decided what to answer.
 */
async function target(c: PortalContext): Promise<AccountRow | null> {
  if (!(await operatorViewer(c))) return null;
  if (crossOrigin(c)) return null;
  return getAccount(c.env, c.req.param("id") ?? "");
}

/** One form field as a trimmed string, or null. `parseBody` can hand back a File. */
function field(body: Record<string, unknown>, name: string): string | null {
  const raw = body[name];
  if (typeof raw !== "string") return null;
  const clean = raw.trim();
  return clean.length ? clean : null;
}

/**
 * A submitted expiry as an ISO timestamp, or `undefined` when it is unusable.
 *
 * `<input type="date">` submits `YYYY-MM-DD`, and "until 1 September" plainly
 * means the override still works ON the first — so a bare date is taken as the
 * END of that day in UTC, not its start. A full ISO timestamp is accepted as
 * given, for anyone driving this with curl.
 *
 * An expiry that has already passed is refused rather than stored: it would
 * create an override that is inert the moment it is written, which reads to an
 * operator as "the button didn't work".
 */
export function parseExpiry(raw: string | null, now: string): string | null | undefined {
  if (!raw) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z` : raw;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  const normalized = new Date(ms).toISOString();
  return normalized > now ? normalized : undefined;
}

platformRoutes.post(`${ACCOUNT_PATH}/plan-override`, async (c) => {
  const account = await target(c);
  if (!account) return refuse(c, "That workspace");

  const body = await c.req.parseBody();
  const plan = field(body as Record<string, unknown>, "plan");
  if (!isOverridablePlan(plan)) return back(c, account.id, "bad_plan");

  const now = new Date().toISOString();
  const expiresAt = parseExpiry(field(body as Record<string, unknown>, "expires_at"), now);
  if (expiresAt === undefined) return back(c, account.id, "bad_expiry");

  await setPlanOverride(c.env, account, {
    plan,
    expiresAt,
    note: field(body as Record<string, unknown>, "note"),
    actor: actorOf(c),
    now,
  });
  return back(c, account.id, "override_set");
});

platformRoutes.post(`${ACCOUNT_PATH}/clear-plan-override`, async (c) => {
  const account = await target(c);
  if (!account) return refuse(c, "That workspace");
  if (!account.plan_override) return back(c, account.id, "no_override");

  await clearPlanOverride(c.env, account, { actor: actorOf(c), now: new Date().toISOString() });
  return back(c, account.id, "override_cleared");
});

platformRoutes.post(`${ACCOUNT_PATH}/suspend`, async (c) => {
  const account = await target(c);
  if (!account) return refuse(c, "That workspace");
  if (account.status === "suspended") return back(c, account.id, "already_suspended");

  await suspendAccount(c.env, account, {
    reason: field((await c.req.parseBody()) as Record<string, unknown>, "reason"),
    actor: actorOf(c),
    now: new Date().toISOString(),
  });
  return back(c, account.id, "suspended");
});

platformRoutes.post(`${ACCOUNT_PATH}/unsuspend`, async (c) => {
  const account = await target(c);
  if (!account) return refuse(c, "That workspace");
  if (account.status !== "suspended") return back(c, account.id, "not_suspended");

  await unsuspendAccount(c.env, account, { actor: actorOf(c), now: new Date().toISOString() });
  return back(c, account.id, "unsuspended");
});

platformRoutes.post(`${ACCOUNT_PATH}/notes`, async (c) => {
  const account = await target(c);
  if (!account) return refuse(c, "That workspace");

  const notes = field((await c.req.parseBody()) as Record<string, unknown>, "notes");
  // Refused, not truncated: silently storing half of what somebody typed is a
  // worse outcome than telling them it didn't fit.
  if (notes && notes.length > MAX_ACCOUNT_NOTES_LENGTH) return back(c, account.id, "notes_too_long");

  await setAccountNotes(c.env, account, { notes, actor: actorOf(c), now: new Date().toISOString() });
  return back(c, account.id, "notes_saved");
});
