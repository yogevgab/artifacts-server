/**
 * Managing share links: `/api/artifacts/:slug/links`.
 *
 * Kept out of `src/api.ts` because that file is already large and this is a
 * self-contained surface. Authorization reuses `canManage` — the same rule that
 * decides who may change access — so there is one answer to "whose artifact is
 * this?", not two.
 */

import { Hono, type Context } from "hono";
import type { AppBindings, ArtifactRow, Env } from "./env";
import { requireUser, requireScope, accountsFor, type AuthVars } from "./auth";
import { canManage } from "./authz";
import { getArtifact } from "./db";
import { viewUrl } from "./api";
import { createShareLink, listShareLinks, revokeShareLink, shareLinkStats } from "./share";

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

/**
 * The URL a person actually pastes: the artifact's canonical address with the
 * key in `?k=`. Never the content host — that origin is not an address.
 */
async function linkUrl(c: ShareContext, art: ArtifactRow, key: string): Promise<string> {
  return `${await viewUrl(c, art.account_id, art.slug)}?k=${encodeURIComponent(key)}`;
}

shareRoutes.get("/api/artifacts/:slug/links", requireScope("read"), async (c) => {
  const slug = c.req.param("slug");
  if (!(await manageable(c, slug))) return c.json({ error: "not_found" }, 404);
  const [links, stats] = await Promise.all([listShareLinks(c.env, slug), shareLinkStats(c.env, slug)]);
  return c.json({
    links: links.map((l) => ({
      ...l,
      views: stats.get(l.id)?.views ?? 0,
      lastViewedAt: stats.get(l.id)?.lastViewedAt ?? null,
      expiredAttempts: stats.get(l.id)?.expiredAttempts ?? 0,
    })),
  });
});

shareRoutes.post("/api/artifacts/:slug/links", requireScope("manage"), async (c) => {
  const slug = c.req.param("slug");
  const art = await manageable(c, slug);
  if (!art) return c.json({ error: "not_found" }, 404);

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
  return c.json({ id: link.id, url: await linkUrl(c, art, link.key), expires_at: link.expiresAt }, 201);
});

shareRoutes.delete("/api/artifacts/:slug/links/:id", requireScope("manage"), async (c) => {
  const slug = c.req.param("slug");
  if (!(await manageable(c, slug))) return c.json({ error: "not_found" }, 404);
  const ok = await revokeShareLink(c.env, slug, c.req.param("id"), new Date().toISOString());
  return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});
