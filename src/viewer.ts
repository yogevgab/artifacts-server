import type { Context } from "hono";
import type { Env } from "./env";
import { accountsFor, type AuthVars } from "./auth";
import { workspaceBilling } from "./plan-copy";
import { posthogConfig } from "./posthog";
import type { PortalViewer } from "./portal";

/**
 * Who is looking at the portal — built once per request, shared by every
 * server-rendered surface.
 *
 * This used to live in src/index.ts as a private helper. It moved here the
 * moment a second module needed it (src/platform-routes.ts, which renders the
 * operator control plane inside the same shell): the alternative was either a
 * second copy that could drift from this one, or a circular import between
 * index.ts and a module index.ts mounts.
 */

/** A Hono context that has been through `requireUser`. */
export type PortalContext = Context<{ Bindings: Env; Variables: AuthVars }>;

/**
 * The two role systems are carried side by side and never merged: `role` is
 * PLATFORM authority derived from configuration, `workspace.role` is the
 * ACCOUNT role read from D1. Nothing in the workspace half can change what the
 * platform half permits — the nav, for example, still gates the Platform section
 * on `role === 'super_admin'` alone.
 */
export async function viewerOf(c: PortalContext): Promise<PortalViewer> {
  const identity = c.get("identity");
  const ctx = await accountsFor(c);
  // Costs one aggregate query, and only for a caller who actually has a
  // workspace — the dashboard is the only surface that renders it.
  const billing = ctx.active ? await workspaceBilling(c.env, ctx.active, c.get("email")) : undefined;
  return {
    email: c.get("email"),
    isAdmin: identity.isAdmin,
    role: identity.role,
    isTokenCaller: !!identity.token,
    // null unless POSTHOG_KEY is configured, which is what keeps a deployment
    // that never sets it behaving exactly as it did before the feature existed.
    posthog: posthogConfig(c.env),
    workspace:
      ctx.active && ctx.role
        ? {
            id: ctx.active.id,
            name: ctx.active.name,
            kind: ctx.active.kind,
            role: ctx.role,
            count: ctx.memberships.length,
            // Usage against the plan's limits, plus real checkout links. Absent
            // means "not computed", never "definitely free" — the UI degrades
            // to showing nothing rather than showing something wrong.
            billing,
          }
        : null,
  };
}
