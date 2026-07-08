import { Hono } from "hono";
import type { Env } from "./env";
import { api } from "./api";
import { requireAdmin, accessEmail, getIdentity } from "./auth";
import { serveArtifact } from "./serve";
import { listArtifacts, getArtifact, grantedSlugs, hasGrant, allGrants, allVersions, getVersion } from "./db";
import { canView } from "./authz";
import { getAllowlist, isConfigured } from "./access-api";
import { galleryPage, notFoundPage } from "./pages";
import { adminPage } from "./admin";

const app = new Hono<{ Bindings: Env; Variables: { email: string } }>();

app.get("/health", (c) => c.text("ok"));

app.get("/whoami", async (c) => {
  const email = await accessEmail(c);
  return c.json({ email });
});

// Admin dashboard (Access admin policy also guards this path at the edge).
app.get("/admin", requireAdmin, async (c) => {
  const [rows, grants] = await Promise.all([listArtifacts(c.env), allGrants(c.env)]);
  const admins = c.env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  let users: string[] | null = null;
  let usersError: string | null = null;
  if (isConfigured(c.env)) {
    try {
      users = await getAllowlist(c.env);
    } catch (e) {
      usersError = (e as Error).message;
    }
  }
  const versions = await allVersions(c.env);
  return c.html(adminPage(rows, grants, versions, c.get("email"), { users, admins, usersError }));
});

// JSON API for dashboard + CLI.
app.route("/api", api);

// Gallery — filtered to what the viewer may see.
app.get("/", async (c) => {
  const identity = await getIdentity(c);
  const rows = await listArtifacts(c.env);
  let visible = rows;
  if (!identity?.isAdmin) {
    const granted = identity?.email ? await grantedSlugs(c.env, identity.email) : new Set<string>();
    visible = identity
      ? rows.filter((r) => r.visibility === "everyone" || granted.has(r.slug))
      : [];
  }
  return c.html(galleryPage(visible));
});

// Admin-only version preview: /v/<slug>/<n>/<path> serves a specific version.
// Relative assets resolve within this prefix. Non-admins get 404 (hidden).
app.get("/v/*", async (c) => {
  const identity = await getIdentity(c);
  if (!identity?.isAdmin) return c.html(notFoundPage(), 404);
  const parts = c.req.path.replace(/^\/v\/+/, "").split("/");
  const slug = decodeURIComponent(parts[0] ?? "");
  const version = Number(parts[1]);
  const filePath = parts.slice(2).map(decodeURIComponent).join("/");
  if (!slug || !Number.isInteger(version) || version < 1) return c.html(notFoundPage(slug), 404);
  if (!(await getVersion(c.env, slug, version))) return c.html(notFoundPage(slug), 404);
  return serveArtifact(c, slug, version, filePath);
});

// Catch-all: serve the current version's files, subject to per-artifact
// authorization. Runs last so named routes win.
app.get("*", async (c) => {
  const rest = c.req.path.replace(/^\/+/, "");
  const idx = rest.indexOf("/");
  const slug = decodeURIComponent(idx === -1 ? rest : rest.slice(0, idx));
  const filePath = idx === -1 ? "" : decodeURIComponent(rest.slice(idx + 1));

  const identity = await getIdentity(c);
  const art = await getArtifact(c.env, slug);
  // 404 for both missing and unauthorized, so probing a slug can't reveal it exists.
  if (!art) return c.html(notFoundPage(slug), 404);
  let granted = false;
  if (art.visibility === "restricted" && !identity?.isAdmin && identity?.email) {
    granted = await hasGrant(c.env, slug, identity.email);
  }
  if (!canView(identity, art.visibility, granted)) return c.html(notFoundPage(slug), 404);

  return serveArtifact(c, slug, art.current_version, filePath);
});

export default app;
