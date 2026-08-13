import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, ArtifactRow } from "./env";
import { requireAdmin, requireUser, type AuthVars } from "./auth";
import { canManage } from "./authz";
import { isValidSlug, slugify, contentType } from "./util";
import { processZip, singleHtml, UploadError, MAX_UPLOAD_BYTES, type ProcessedUpload } from "./upload";
import {
  listArtifacts,
  listArtifactsOwnedBy,
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
import { firstContentHostname } from "./host";

type Vars = { Variables: AuthVars; Bindings: Env };

export const api = new Hono<Vars>();

// Every API route needs a signed-in caller; per-artifact ownership is enforced
// per route below (admins manage everything, beta users only what they own).
api.use("*", requireUser);
// Managing who can sign in to the beta stays admin-only.
api.use("/users", requireAdmin);
api.use("/users/*", requireAdmin);

/**
 * Load an artifact the caller is allowed to manage, or null. Returns null both
 * when the slug does not exist and when it belongs to somebody else, so every
 * caller answers 404 either way and a beta user can't probe for the existence
 * of another user's artifacts.
 */
async function manageable(c: Context<Vars>, slug: string): Promise<ArtifactRow | null> {
  const art = await getArtifact(c.env, slug);
  return art && canManage(c.get("identity"), art) ? art : null;
}

// Multipart overhead (boundaries/headers) is small, so a modest margin over
// the file-size cap is enough headroom for the request body as a whole.
const MAX_BODY_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;

class PayloadTooLargeError extends Error {}

/**
 * Wrap a request body so it errors once more than `maxBytes` has streamed
 * through it. A declared Content-Length can be missing, wrong, or lied about
 * (chunked transfer encoding, a misbehaving client/proxy) — this enforces the
 * cap against bytes actually read, so formData() can't be made to buffer an
 * unbounded body into memory before any size check runs.
 */
function limitBodyBytes(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(new PayloadTooLargeError(`upload exceeds the max size of ${maxBytes} bytes`));
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );
}

api.get("/artifacts", async (c) => {
  const identity = c.get("identity");
  const artifacts = identity.isAdmin
    ? await listArtifacts(c.env)
    : await listArtifactsOwnedBy(c.env, identity.email!);
  return c.json({ artifacts });
});

api.post("/artifacts", async (c) => {
  // Fast path: if the client declares an honest, oversized Content-Length, reject
  // before reading any of the body. This is purely an optimization — a missing or
  // inaccurate Content-Length (e.g. chunked transfer encoding) skips this check
  // entirely, so it must never be relied on as the actual size guarantee; the
  // streaming limit below is what enforces the cap against real bytes read.
  const contentLength = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return c.json(
      { error: "payload_too_large", detail: `upload exceeds the max size of ${MAX_UPLOAD_BYTES} bytes` },
      413
    );
  }

  let form: FormData;
  try {
    const body = c.req.raw.body;
    const req = body ? new Request(c.req.raw, { body: limitBodyBytes(body, MAX_BODY_BYTES) } as RequestInit) : c.req.raw;
    form = await req.formData();
  } catch (e) {
    if (e instanceof PayloadTooLargeError) {
      return c.json(
        { error: "payload_too_large", detail: `upload exceeds the max size of ${MAX_UPLOAD_BYTES} bytes` },
        413
      );
    }
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
  // Publishing to an existing slug adds a version to *that* artifact, so it is
  // only allowed for its owner (or an admin). Slugs are a shared namespace, so
  // "taken" is unavoidably observable — but nothing about the artifact is.
  if (existing && !canManage(c.get("identity"), existing)) {
    return c.json(
      { error: "slug_taken", detail: `the slug "${slug}" is already in use — pick another` },
      409
    );
  }

  const htmlFile = form.get("file");
  const bundleFile = form.get("bundle");

  const uploadFile = bundleFile instanceof File && bundleFile.size > 0 ? bundleFile : htmlFile;
  if (uploadFile instanceof File && uploadFile.size > MAX_UPLOAD_BYTES) {
    return c.json(
      { error: "payload_too_large", detail: `upload exceeds the max size of ${MAX_UPLOAD_BYTES} bytes` },
      413
    );
  }

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
    // Ownership is set once, at creation, and never transferred by a republish.
    // A service token (no email) creates an unowned, admin-only artifact.
    owner_email: existing?.owner_email ?? c.get("identity").email,
  };
  await upsertArtifact(c.env, row);

  const url = new URL(c.req.url);
  const publishHost = firstContentHostname(c.env) ?? url.host;
  return c.json({
    slug,
    url: `${url.protocol}//${publishHost}/${slug}/`,
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
  const art = await manageable(c, slug);
  if (!art) return c.json({ error: "not_found" }, 404);
  return c.json({ current: art.current_version, versions: await listVersions(c.env, slug) });
});

api.get("/artifacts/:slug/views", async (c) => {
  const slug = c.req.param("slug");
  const art = await manageable(c, slug);
  if (!art) return c.json({ error: "not_found" }, 404);
  const raw = Number(c.req.query("limit"));
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 200) : 50;
  return c.json(await getViews(c.env, slug, limit));
});

api.post("/artifacts/:slug/current", async (c) => {
  const slug = c.req.param("slug");
  const art = await manageable(c, slug);
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
  const art = await manageable(c, slug);
  if (!art) return c.json({ error: "not_found" }, 404);
  return c.json({ visibility: art.visibility, emails: await listGrants(c.env, slug) });
});

api.put("/artifacts/:slug/access", async (c) => {
  const slug = c.req.param("slug");
  const art = await manageable(c, slug);
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
  // Admin-only — the beta is invite-only, so an owner sharing their own artifact
  // must not be able to widen who can sign in. Their grants still apply; the
  // recipient just needs an admin to invite them first.
  let allowlistWarning: string | undefined;
  if (emails.length && isConfigured(c.env)) {
    if (!c.get("identity").isAdmin) {
      allowlistWarning = "anyone who hasn't been invited to the beta yet needs an admin to add them";
    } else {
      try {
        await addUsers(c.env, emails);
      } catch (e) {
        if (!(e instanceof AccessNotConfiguredError)) allowlistWarning = (e as Error).message;
      }
    }
  }
  return c.json({ slug, visibility, emails: await listGrants(c.env, slug), allowlistWarning });
});

api.delete("/artifacts/:slug", async (c) => {
  const slug = c.req.param("slug");
  const existing = await manageable(c, slug);
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
