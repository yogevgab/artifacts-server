/**
 * Claiming, changing and releasing a workspace's branded address — the `yogev`
 * in `rtfx.pro/yogev/q3-board-report`.
 *
 * Two surfaces over one decision, the same way workspace switching is split
 * (src/workspace-routes.ts): an ordinary HTML form for the person in Settings,
 * and JSON for anything scripted. Both call the same three checks in the same
 * order, and neither reimplements one:
 *
 *  1. **Membership, then role.** Owner or admin inside the workspace. A member
 *     who can publish still cannot rename the namespace every link they have
 *     already sent lives under. An account nobody may act in answers 404 rather
 *     than 403, so ids stay unprobeable — the rule every other account surface
 *     here follows.
 *  2. **Plan.** `planAllowsBrandedSlug` (src/account-slugs.ts) against the
 *     EFFECTIVE plan, so a workspace an operator comped onto Pro can claim one
 *     immediately and a lapsed subscription cannot claim a new one. Releasing
 *     an already-held address stays allowed below Pro, because letting a
 *     customer give a scarce namespace back is never an upsell gate.
 *  3. **Shape, reservation, uniqueness.** `checkAccountSlug` owns the first two
 *     and is pure; `setAccountPublicSlug` (src/accounts.ts) owns the third,
 *     because only the database can answer it.
 *
 * Releasing an address is deliberately as easy as claiming one, and deliberately
 * does NOT break anything: an artifact's real URL has always been its content
 * origin one (`a.rtfx.pro/q3-board-report/`), which is unaffected by anything in
 * this file. A branded link is a second, nicer way to reach it.
 *
 * CSRF: the session cookie is `SameSite=Lax`, so a cross-site POST arrives with
 * no session and `requireUser` refuses it before any of this runs.
 */

import { Hono, type Context } from "hono";
import type { Env } from "./env";
import { requireUser, requireScope, accountsFor, type AuthVars } from "./auth";
import { canReadAccount } from "./authz";
import {
  atLeast,
  effectivePlan,
  getAccount,
  setAccountPublicSlug,
  toPublicAccount,
  type AccountRole,
  type AccountRow,
} from "./accounts";
import {
  checkAccountSlug,
  normalizeAccountSlug,
  planAllowsBrandedSlug,
  PLAN_REQUIRED_DETAIL,
} from "./account-slugs";
import { portalNotFound } from "./portal";
import { siteOrigin } from "./seo";
import { viewerOf } from "./viewer";

type SlugApp = { Bindings: Env; Variables: AuthVars };
type SlugContext = Context<SlugApp>;

export const accountSlugRoutes = new Hono<SlugApp>();

/** The JSON surface, alongside `/api/workspace/:id/members`. */
const API_PATH = "/api/workspace/:id/slug";
/** The server-rendered one, posted by the Settings page's address form. */
const FORM_PATH = "/admin/workspace/address";

accountSlugRoutes.use(API_PATH, requireUser);
accountSlugRoutes.use(FORM_PATH, requireUser);

/** Where a branded link for this workspace starts, or null when it has no address. */
export function brandedBase(env: Env, slug: string | null | undefined): string | null {
  if (!slug) return null;
  const origin = env.PUBLIC_BASE_URL || siteOrigin(env);
  return `${origin.replace(/\/+$/, "")}/${slug}`;
}

/** Why this caller may not rename/release the address, or null when they may. */
function roleDenial(
  isPlatformAdmin: boolean,
  role: AccountRole | null
): { error: "forbidden"; detail: string } | null {
  if (isPlatformAdmin) return null;
  if (!atLeast(role, "admin")) {
    return {
      error: "forbidden",
      detail: "only an owner or admin of this workspace can change its address",
    };
  }
  return null;
}

/**
 * Why this caller may not claim/change the address, or null when they may.
 *
 * A platform admin passes the plan check — they administer the instance and
 * already reach every account — but their bypass is only of the *plan*, never of
 * the shape or the uniqueness rules below. Role is checked separately so release
 * can stay allowed after a downgrade.
 */
function planDenial(
  isPlatformAdmin: boolean,
  account: AccountRow
): { error: "plan_required"; detail: string } | null {
  if (isPlatformAdmin) return null;
  if (!planAllowsBrandedSlug(effectivePlan(account))) {
    return { error: "plan_required", detail: PLAN_REQUIRED_DETAIL };
  }
  return null;
}

/** The workspace, if this caller may at least read it. 404 for everything else. */
async function readable(
  c: SlugContext,
  id: string
): Promise<{ account: AccountRow; role: AccountRole | null } | null> {
  if (!id) return null;
  const account = await getAccount(c.env, id);
  if (!account) return null;
  const ctx = await accountsFor(c);
  if (!canReadAccount(c.get("identity"), ctx.roles, id)) return null;
  return { account, role: ctx.roles.get(id) ?? null };
}

/**
 * Apply one submitted address to one workspace.
 *
 * The single place the rules run, shared by the JSON route and the form route
 * so the two can never drift into disagreeing about who may claim what. Returns
 * a machine `code` rather than a response, because the two callers say it
 * differently: one as a status plus a detail sentence, one as a redirect the
 * Settings page reads back.
 */
type ApplyResult =
  | { code: "ok"; slug: string; account: AccountRow }
  | { code: "released"; slug: null; account: AccountRow }
  | { code: "not_found" }
  | { code: "forbidden" | "plan_required"; detail: string }
  | { code: "shape" | "reserved"; detail: string }
  | { code: "taken" | "unavailable"; detail: string };

async function applyAddress(c: SlugContext, id: string, raw: unknown): Promise<ApplyResult> {
  const found = await readable(c, id);
  if (!found) return { code: "not_found" };

  const identity = c.get("identity");
  const roleBlock = roleDenial(!!identity.isAdmin, found.role);
  if (roleBlock) return { code: "forbidden", detail: roleBlock.detail };

  const now = new Date().toISOString();

  // An empty submission releases the address. Distinct from "no field at all"
  // only in the JSON route, where `slug: null` is explicit — the form's empty
  // input means the same thing, and a person who clears the box means it.
  if (normalizeAccountSlug(raw) === "") {
    const released = await setAccountPublicSlug(c.env, id, null, now);
    if (!released.ok) {
      return { code: "unavailable", detail: "the address could not be released — try again" };
    }
    return { code: "released", slug: null, account: released.account };
  }

  const planBlock = planDenial(!!identity.isAdmin, found.account);
  if (planBlock) return { code: "plan_required", detail: planBlock.detail };

  const checked = checkAccountSlug(raw);
  if (!checked.ok) return { code: checked.reason, detail: checked.detail };

  const written = await setAccountPublicSlug(c.env, id, checked.slug, now);
  if (!written.ok) {
    return written.reason === "taken"
      ? { code: "taken", detail: `${checked.slug} is already somebody else's workspace address` }
      : { code: "unavailable", detail: "the address could not be saved — try again" };
  }
  return { code: "ok", slug: checked.slug, account: written.account };
}

// --- JSON --------------------------------------------------------------------

const API_STATUS: Record<string, 400 | 403 | 404 | 409 | 503> = {
  shape: 400,
  reserved: 400,
  forbidden: 403,
  plan_required: 403,
  not_found: 404,
  taken: 409,
  unavailable: 503,
};

function apiResponse(c: SlugContext, result: ApplyResult, id: string) {
  if (result.code === "ok" || result.code === "released") {
    return c.json({
      account: toPublicAccount(result.account, null),
      public_slug: result.slug,
      branded_base: brandedBase(c.env, result.slug),
    });
  }
  if (result.code === "not_found") return c.json({ error: "not_found" }, 404);
  const status = API_STATUS[result.code] ?? 400;
  // `shape` and `reserved` are both malformed input as far as a client is
  // concerned; the reason is in the sentence, which is the part a person reads.
  const error =
    result.code === "shape" || result.code === "reserved"
      ? "bad_request"
      : result.code === "taken"
        ? "conflict"
        : result.code === "unavailable"
          ? "unavailable"
          : result.code;
  return c.json({ error, detail: result.detail, account_id: id }, status);
}

accountSlugRoutes.put(API_PATH, requireScope("manage"), async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  return apiResponse(c, await applyAddress(c, id, body?.slug ?? ""), id);
});

accountSlugRoutes.delete(API_PATH, requireScope("manage"), async (c) => {
  const id = c.req.param("id");
  return apiResponse(c, await applyAddress(c, id, ""), id);
});

// --- the Settings form -------------------------------------------------------

/** Query codes the Settings page renders back as a sentence. */
export type AddressNoticeCode = ApplyResult["code"];

const NOTICE_TEXT: Record<string, { kind: "ok" | "error"; text: string }> = {
  ok: { kind: "ok", text: "Workspace address saved. Every artifact here now has a branded link too." },
  released: {
    kind: "ok",
    text: "Workspace address released. Artifact URLs on the content origin are unchanged.",
  },
  not_found: { kind: "error", text: "That workspace could not be found." },
  forbidden: { kind: "error", text: "Only an owner or admin of this workspace can change its address." },
  plan_required: { kind: "error", text: PLAN_REQUIRED_DETAIL },
  shape: {
    kind: "error",
    text:
      "An address is 3–63 characters: lowercase letters, numbers and hyphens, " +
      "and it cannot start or end with a hyphen.",
  },
  reserved: { kind: "error", text: "That address is reserved for the product's own pages." },
  taken: { kind: "error", text: "That address is already somebody else's workspace address." },
  unavailable: { kind: "error", text: "The address could not be saved. Try again." },
};

/** The sentence for a `?address=` code, or undefined when there is nothing to say. */
export function addressNotice(code: string | undefined | null) {
  return code ? NOTICE_TEXT[code] : undefined;
}

/**
 * The address form's target. Acts on the workspace the portal is currently in
 * rather than on an id from the request body: the page already says which
 * workspace it is acting in, and taking the id from the form would be one more
 * thing to authorize for no gain.
 *
 * 303 so a reload of Settings does not re-post the change.
 */
accountSlugRoutes.post(FORM_PATH, async (c) => {
  const ctx = await accountsFor(c);
  if (!ctx.active) return c.html(portalNotFound(await viewerOf(c), "That workspace"), 404);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  // A release is its own button, so clearing the field is never accidental.
  const raw = form.release ? "" : (form.slug ?? "");
  const result = await applyAddress(c, ctx.active.id, raw);
  if (result.code === "not_found") {
    return c.html(portalNotFound(await viewerOf(c), "That workspace"), 404);
  }
  return c.body(null, 303, { Location: `/admin/settings?address=${result.code}` });
});
