/**
 * The read-receipts toggle: `/api/artifacts/:slug/receipts`.
 *
 * This is deliberately its own file rather than an addition to the existing
 * `GET/PUT /api/artifacts/:slug/access` in src/api.ts. That endpoint already
 * carries visibility and the grant list, which is where a UI would naturally
 * want this setting too — but src/api.ts is out of scope for this change, so
 * this mirrors it as a second, narrow surface instead: same auth (`requireUser`
 * + `canManage`, exactly as src/share-routes.ts does for share links), same
 * "404 for both missing and not-theirs" shape, same JSON conventions. A UI
 * can call either endpoint for the same artifact; nothing here depends on
 * src/api.ts, and nothing there needs to change for this to work.
 */

import { Hono, type Context } from "hono";
import type { AppBindings, Env } from "./env";
import { requireUser, accountsFor, type AuthVars } from "./auth";
import { canManage } from "./authz";
import { getArtifact, readReceiptsEnabled, setReadReceipts } from "./db";

type ReceiptsApp = { Bindings: Env; Variables: AuthVars };
type ReceiptsContext = Context<ReceiptsApp>;

export const receiptsRoutes = new Hono<ReceiptsApp>();

receiptsRoutes.use("/api/artifacts/:slug/receipts", requireUser);

/** The artifact, if this caller may manage it. 404 for both missing and not-theirs. */
async function manageable(c: ReceiptsContext, slug: string) {
  const art = await getArtifact(c.env, slug);
  if (!art) return null;
  const identity = c.get("identity");
  return canManage(identity, art, (await accountsFor(c)).roles) ? art : null;
}

receiptsRoutes.get("/api/artifacts/:slug/receipts", async (c) => {
  const slug = c.req.param("slug");
  const art = await manageable(c, slug);
  if (!art) return c.json({ error: "not_found" }, 404);
  return c.json({ enabled: readReceiptsEnabled(art) });
});

receiptsRoutes.put("/api/artifacts/:slug/receipts", async (c) => {
  const slug = c.req.param("slug");
  const art = await manageable(c, slug);
  if (!art) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json().catch(() => null);
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") {
    return c.json({ error: "bad_request", detail: "enabled must be a boolean" }, 400);
  }

  await setReadReceipts(c.env, slug, enabled, new Date().toISOString());
  return c.json({ enabled });
});
