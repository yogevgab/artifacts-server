/**
 * Managing share links: `/api/artifacts/:slug/links`.
 *
 * Kept out of `src/api.ts` because that file is already large and this is a
 * self-contained surface. Authorization reuses `canManage` — the same rule that
 * decides who may change access — so there is one answer to "whose artifact is
 * this?", not two.
 */

import { Hono, type Context } from "hono";
import type { AppBindings, Env } from "./env";
import { requireUser, requireScope, accountsFor, type AuthVars } from "./auth";
import { canManage } from "./authz";
import { getArtifact } from "./db";
import { firstContentHostname } from "./host";
import { createShareLink, listShareLinks, revokeShareLink } from "./share";

type ShareApp = { Bindings: Env; Variables: AuthVars };
type ShareContext = Context<ShareApp>;

export const shareRoutes = new Hono<ShareApp>();

shareRoutes.use("/api/artifacts/:slug/links", requireUser);
shareRoutes.use("/api/artifacts/:slug/links/:id", requireUser);

/** The artifact, if this caller may manage it. 404 for both missing and not-theirs. */
async function manageable(c: ShareContext, slug: string) {
  const art = await getArtifact(c.env, slug);
  if (!art) return null;
  const identity = c.get("identity");
  return canManage(identity, art, (await accountsFor(c)).roles) ? art : null;
}

/** The URL a person actually pastes. Built from the content host, never guessed. */
function linkUrl(env: Env, slug: string, key: string): string {
  const host = firstContentHostname(env) ?? new URL(env.PUBLIC_BASE_URL ?? "https://rtfx.pro").host;
  return `https://${host}/${encodeURIComponent(slug)}/?k=${encodeURIComponent(key)}`;
}

shareRoutes.get("/api/artifacts/:slug/links", requireScope("read"), async (c) => {
  const slug = c.req.param("slug");
  if (!(await manageable(c, slug))) return c.json({ error: "not_found" }, 404);
  return c.json({ links: await listShareLinks(c.env, slug) });
});

shareRoutes.post("/api/artifacts/:slug/links", requireScope("manage"), async (c) => {
  const slug = c.req.param("slug");
  if (!(await manageable(c, slug))) return c.json({ error: "not_found" }, 404);

  const body = (await c.req.json().catch(() => null)) as { expires_in_days?: unknown } | null;
  let expiresAt: string | null = null;
  if (body?.expires_in_days !== undefined && body.expires_in_days !== null) {
    const days = Number(body.expires_in_days);
    if (!Number.isFinite(days) || days <= 0 || days > 365) {
      return c.json({ error: "bad_request", detail: "expires_in_days must be 1–365" }, 400);
    }
    expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  }

  const link = await createShareLink(c.env, {
    slug,
    createdBy: c.get("email"),
    now: new Date().toISOString(),
    expiresAt,
  });

  // The key is returned exactly once. It is not stored and cannot be shown again.
  return c.json({ id: link.id, url: linkUrl(c.env, slug, link.key), expires_at: link.expiresAt }, 201);
});

shareRoutes.delete("/api/artifacts/:slug/links/:id", requireScope("manage"), async (c) => {
  const slug = c.req.param("slug");
  if (!(await manageable(c, slug))) return c.json({ error: "not_found" }, 404);
  const ok = await revokeShareLink(c.env, slug, c.req.param("id"), new Date().toISOString());
  return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});
