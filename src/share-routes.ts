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
import {
  createShareLink,
  listShareLinks,
  normalizeLinkName,
  revokeShareLink,
  shareLinkStats,
  updateShareLink,
} from "./share";

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

/**
 * `expires_in_days`: undefined/null mean "no expiry"; otherwise a number of
 * days from now, 1–365 (fractions allowed, as on create since it shipped).
 * Returns `{ expiresAt }` where null = never expires.
 */
function parseExpiryDays(raw: unknown): { expiresAt: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { expiresAt: null };
  const days = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  if (raw === "" || !Number.isFinite(days) || days <= 0 || days > 365) {
    return { error: "expires_in_days must be 1–365" };
  }
  return { expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() };
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

  const body = (await c.req.json().catch(() => null)) as { name?: unknown; expires_in_days?: unknown } | null;
  const expiry = parseExpiryDays(body?.expires_in_days);
  if ("error" in expiry) return c.json({ error: "bad_request", detail: expiry.error }, 400);
  const label = normalizeLinkName(body?.name);
  if ("error" in label) return c.json({ error: "bad_request", detail: label.error }, 400);

  // Any number of links per artifact: one per recipient is the point of the
  // name, so the owner can tell in the view log which of them was used.
  const link = await createShareLink(c.env, {
    slug,
    createdBy: c.get("email"),
    now: new Date().toISOString(),
    expiresAt: expiry.expiresAt ?? null,
    name: label.name,
  });

  // The key is returned exactly once. It is not stored and cannot be shown again.
  return c.json(
    { id: link.id, name: link.name, url: await linkUrl(c, art, link.key), expires_at: link.expiresAt },
    201
  );
});

/**
 * Rename and/or extend a link. Both fields are optional but at least one must be
 * present. `expires_in_days` counts from NOW (not from the old expiry): the
 * owner is saying "this should work for N more days", which is also the only
 * reading that makes sense for a link that has already lapsed. `null` removes
 * the expiry. A revoked link answers 409 `link_revoked` and stays revoked.
 */
shareRoutes.patch("/api/artifacts/:slug/links/:id", requireScope("manage"), async (c) => {
  const slug = c.req.param("slug");
  if (!(await manageable(c, slug))) return c.json({ error: "not_found" }, 404);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "bad_request", detail: "expected a JSON object" }, 400);
  }
  const patch: { name?: string | null; expiresAt?: string | null } = {};
  if ("name" in body) {
    const label = normalizeLinkName(body.name);
    if ("error" in label) return c.json({ error: "bad_request", detail: label.error }, 400);
    patch.name = label.name;
  }
  if ("expires_in_days" in body) {
    const expiry = parseExpiryDays(body.expires_in_days);
    if ("error" in expiry) return c.json({ error: "bad_request", detail: expiry.error }, 400);
    patch.expiresAt = expiry.expiresAt ?? null;
  }
  if (!("name" in patch) && !("expiresAt" in patch)) {
    return c.json({ error: "bad_request", detail: "send name and/or expires_in_days" }, 400);
  }

  const updated = await updateShareLink(c.env, slug, c.req.param("id"), patch);
  if (updated === "not_found") return c.json({ error: "not_found" }, 404);
  if (updated === "revoked") {
    return c.json({ error: "link_revoked", detail: "a revoked link cannot be changed — create a new one" }, 409);
  }
  const stats = (await shareLinkStats(c.env, slug)).get(updated.id);
  return c.json({
    id: updated.id,
    name: updated.name,
    expiresAt: updated.expiresAt,
    revokedAt: updated.revokedAt,
    createdAt: updated.createdAt,
    lastUsedAt: updated.lastUsedAt,
    views: stats?.views ?? 0,
    lastViewedAt: stats?.lastViewedAt ?? null,
    expiredAttempts: stats?.expiredAttempts ?? 0,
  });
});

shareRoutes.delete("/api/artifacts/:slug/links/:id", requireScope("manage"), async (c) => {
  const slug = c.req.param("slug");
  if (!(await manageable(c, slug))) return c.json({ error: "not_found" }, 404);
  const ok = await revokeShareLink(c.env, slug, c.req.param("id"), new Date().toISOString());
  return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});
