import { Hono } from "hono";
import type { Env, ArtifactRow } from "./env";
import { requireAdmin } from "./auth";
import { isValidSlug, slugify, contentType } from "./util";
import { processZip, singleHtml, UploadError, type ProcessedUpload } from "./upload";
import {
  listArtifacts,
  getArtifact,
  upsertArtifact,
  deleteArtifactRow,
  listGrants,
  setAccess,
  removeEmailFromAllGrants,
  insertNextVersion,
  deleteVersion,
  listVersions,
  setCurrentVersion,
  getViews,
} from "./db";
import {
  getAllowlist,
  addUsers,
  removeUser,
  isConfigured,
  AccessNotConfiguredError,
  AccessApiError,
} from "./access-api";

type Vars = { Variables: { email: string }; Bindings: Env };

export const api = new Hono<Vars>();

api.use("*", requireAdmin);

api.get("/artifacts", async (c) => {
  return c.json({ artifacts: await listArtifacts(c.env) });
});

api.post("/artifacts", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "bad_request", detail: "expected multipart/form-data" }, 400);
  }

  const providedTitle = String(form.get("title") ?? "").trim();
  const description = (form.get("description") ? String(form.get("description")) : "").trim();
  const note = (form.get("note") ? String(form.get("note")) : "").trim();

  const existingSlug = String(form.get("slug") ?? "").trim();
  let slug = existingSlug || slugify(providedTitle);

  const existing = slug ? await getArtifact(c.env, slug) : null;

  // Title is required for a brand-new artifact; a new version keeps the existing title.
  if (!existing && !providedTitle) {
    return c.json({ error: "bad_request", detail: "title is required" }, 400);
  }
  if (!isValidSlug(slug)) {
    return c.json({ error: "bad_request", detail: `invalid slug "${slug}"` }, 400);
  }

  const htmlFile = form.get("file");
  const bundleFile = form.get("bundle");

  let processed: ProcessedUpload;
  try {
    if (bundleFile instanceof File && bundleFile.size > 0) {
      processed = processZip(new Uint8Array(await bundleFile.arrayBuffer()));
    } else if (htmlFile instanceof File && htmlFile.size > 0) {
      processed = singleHtml(new Uint8Array(await htmlFile.arrayBuffer()));
    } else {
      return c.json({ error: "bad_request", detail: "provide a 'file' (.html) or 'bundle' (.zip)" }, 400);
    }
  } catch (e) {
    if (e instanceof UploadError) return c.json({ error: "bad_request", detail: e.message }, 400);
    return c.json({ error: "bad_request", detail: "could not process upload" }, 400);
  }

  // Versions are immutable and stored under <slug>/v<N>/, so we never delete a
  // previous version's files. Reserve the version number atomically first
  // (race-safe), then write its files; roll the reservation back if storage fails.
  const now = new Date().toISOString();
  const size = processed.files.reduce((n, f) => n + f.bytes.byteLength, 0);

  const version = await insertNextVersion(c.env, {
    slug,
    type: processed.type,
    entry: processed.entry,
    file_count: processed.files.length,
    size_bytes: size,
    note: note || null,
    created_by: c.get("email"),
    created_at: now,
  });

  try {
    for (const f of processed.files) {
      await c.env.FILES.put(`${slug}/v${version}/${f.path}`, f.bytes, {
        httpMetadata: { contentType: contentType(f.path) },
      });
    }
  } catch {
    await deleteVersion(c.env, slug, version);
    return c.json({ error: "storage", detail: "failed to store files" }, 500);
  }

  const row: ArtifactRow = {
    slug,
    title: providedTitle || existing!.title,
    description: description || existing?.description || null,
    type: processed.type,
    entry: processed.entry,
    file_count: processed.files.length,
    size_bytes: size,
    created_by: existing?.created_by ?? c.get("email"),
    created_at: existing?.created_at ?? now,
    updated_at: now,
    // New artifacts are private; a new version preserves existing visibility.
    visibility: existing?.visibility ?? "restricted",
    current_version: version, // new upload becomes live immediately
  };
  await upsertArtifact(c.env, row);

  const url = new URL(c.req.url);
  return c.json({
    slug,
    url: `${url.protocol}//${url.host}/${slug}/`,
    type: processed.type,
    file_count: processed.files.length,
    version,
  });
});

// --- User management (login allow-list, backed by Cloudflare Access) ---

function adminEmailSet(c: { env: Env }): string[] {
  return c.env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

api.get("/users", async (c) => {
  if (!isConfigured(c.env)) {
    return c.json({ error: "not_configured", detail: "user management is not configured" }, 503);
  }
  try {
    const users = await getAllowlist(c.env);
    return c.json({ users, admins: adminEmailSet(c) });
  } catch (e) {
    return c.json({ error: "access_api", detail: (e as Error).message }, 502);
  }
});

api.post("/users", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) return c.json({ error: "bad_request", detail: "valid email required" }, 400);
  try {
    const users = await addUsers(c.env, [email]);
    return c.json({ users, admins: adminEmailSet(c) });
  } catch (e) {
    if (e instanceof AccessNotConfiguredError) return c.json({ error: "not_configured" }, 503);
    return c.json({ error: "access_api", detail: (e as Error).message }, 502);
  }
});

api.delete("/users/:email", async (c) => {
  const email = c.req.param("email").trim().toLowerCase();
  try {
    const users = await removeUser(c.env, email);
    // Also drop this user from every artifact's grant list.
    await removeEmailFromAllGrants(c.env, email);
    return c.json({ users, admins: adminEmailSet(c) });
  } catch (e) {
    if (e instanceof AccessNotConfiguredError) return c.json({ error: "not_configured" }, 503);
    return c.json({ error: "access_api", detail: (e as Error).message }, 400);
  }
});

api.get("/artifacts/:slug/versions", async (c) => {
  const slug = c.req.param("slug");
  const art = await getArtifact(c.env, slug);
  if (!art) return c.json({ error: "not_found" }, 404);
  return c.json({ current: art.current_version, versions: await listVersions(c.env, slug) });
});

api.get("/artifacts/:slug/views", async (c) => {
  const slug = c.req.param("slug");
  const art = await getArtifact(c.env, slug);
  if (!art) return c.json({ error: "not_found" }, 404);
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  return c.json(await getViews(c.env, slug, limit));
});

api.post("/artifacts/:slug/current", async (c) => {
  const slug = c.req.param("slug");
  const art = await getArtifact(c.env, slug);
  if (!art) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => null);
  const version = Number(body?.version);
  if (!Number.isInteger(version) || version < 1) {
    return c.json({ error: "bad_request", detail: "version must be a positive integer" }, 400);
  }
  const ok = await setCurrentVersion(c.env, slug, version, new Date().toISOString());
  if (!ok) return c.json({ error: "not_found", detail: `version ${version} does not exist` }, 404);
  return c.json({ slug, current: version });
});

api.get("/artifacts/:slug/access", async (c) => {
  const slug = c.req.param("slug");
  const art = await getArtifact(c.env, slug);
  if (!art) return c.json({ error: "not_found" }, 404);
  return c.json({ visibility: art.visibility, emails: await listGrants(c.env, slug) });
});

api.put("/artifacts/:slug/access", async (c) => {
  const slug = c.req.param("slug");
  const art = await getArtifact(c.env, slug);
  if (!art) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json().catch(() => null);
  const visibility = body?.visibility;
  if (visibility !== "restricted" && visibility !== "everyone") {
    return c.json({ error: "bad_request", detail: "visibility must be 'restricted' or 'everyone'" }, 400);
  }
  const rawEmails: unknown = body?.emails ?? [];
  if (!Array.isArray(rawEmails) || rawEmails.some((e) => typeof e !== "string")) {
    return c.json({ error: "bad_request", detail: "emails must be an array of strings" }, 400);
  }
  const emails = (rawEmails as string[]).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (emails.some((e) => !e.includes("@"))) {
    return c.json({ error: "bad_request", detail: "each email must contain '@'" }, 400);
  }

  await setAccess(c.env, slug, visibility, emails, new Date().toISOString());

  // Ensure granted users can actually log in: add them to the Access allow-list.
  let allowlistWarning: string | undefined;
  if (emails.length && isConfigured(c.env)) {
    try {
      await addUsers(c.env, emails);
    } catch (e) {
      if (!(e instanceof AccessNotConfiguredError)) allowlistWarning = (e as Error).message;
    }
  }
  return c.json({ slug, visibility, emails: await listGrants(c.env, slug), allowlistWarning });
});

api.delete("/artifacts/:slug", async (c) => {
  const slug = c.req.param("slug");
  const existing = await getArtifact(c.env, slug);
  if (!existing) return c.json({ error: "not_found" }, 404);
  await deletePrefix(c.env, slug);
  await deleteArtifactRow(c.env, slug);
  return c.json({ deleted: slug });
});

/** Delete every R2 object under `<slug>/`. */
async function deletePrefix(env: Env, slug: string): Promise<void> {
  const prefix = `${slug}/`;
  let cursor: string | undefined;
  do {
    const listed = await env.FILES.list({ prefix, cursor });
    if (listed.objects.length > 0) {
      await env.FILES.delete(listed.objects.map((o) => o.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
