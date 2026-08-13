import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, ArtifactRow } from "./env";
import { requireAdmin, requireUser, requireScope, denyApiToken, type AuthVars } from "./auth";
import { canManage, userActionDenial, type UserAction } from "./authz";
import {
  cleanText,
  deleteUser,
  describeUsers,
  disableUser,
  effectiveRole,
  enableUser,
  getUser,
  listUsers,
  normalize,
  updateProfile,
  upsertInvite,
  privilegedEmails,
  superAdminEmails,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  type UserRole,
  type UserRow,
} from "./users";
import { normalizeEmail } from "./waitlist";
import {
  createApiToken,
  getApiToken,
  listApiTokens,
  revokeApiToken,
  revokeTokensForEmail,
  parseScopes,
  toPublicToken,
  DEFAULT_SCOPES,
  MAX_TOKEN_NAME_LENGTH,
  MAX_EXPIRES_IN_DAYS,
} from "./tokens";
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
  addUsers,
  removeUser,
  isConfigured,
  allowlistView,
  AccessNotConfiguredError,
  AccessApiError,
} from "./access-api";
import { firstContentHostname } from "./host";

type Vars = { Variables: AuthVars; Bindings: Env };

export const api = new Hono<Vars>();

// Every API route needs an authenticated caller — an Access login or an API
// token. Per-artifact ownership is enforced per route below (admins manage
// everything, beta users only what they own), and API tokens are additionally
// narrowed by scope (`requireScope`).
api.use("*", requireUser);
// Managing who can sign in to the beta stays admin-only, and is off-limits to
// API tokens: issuing credentials always requires an interactive login.
api.use("/users", requireAdmin, denyApiToken);
api.use("/users/*", requireAdmin, denyApiToken);
// Same for the tokens themselves — a token must never be able to mint another.
api.use("/tokens", denyApiToken);
api.use("/tokens/*", denyApiToken);

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

api.get("/artifacts", requireScope("read"), async (c) => {
  const identity = c.get("identity");
  const artifacts = identity.isAdmin
    ? await listArtifacts(c.env)
    : await listArtifactsOwnedBy(c.env, identity.email!);
  return c.json({ artifacts });
});

api.post("/artifacts", requireScope("publish"), async (c) => {
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

// --- User management -------------------------------------------------------
//
// Two layers, deliberately separate (see src/users.ts):
//   • Cloudflare Access holds the login allow-list — who can authenticate at all.
//   • The local `users` table holds product state: status, name, notes, timestamps.
//
// Every route here is admin-only and refuses API tokens (see the middleware at
// the top of this file), because inviting somebody hands out a credential.

/**
 * The full directory response. Read straight back from D1 and Cloudflare after
 * every mutation, so the client never has to merge state itself and can't drift.
 * `focus` is the email the request acted on, echoed back as `user`.
 */
async function directory(
  env: Env,
  extra: { warning?: string; removed?: string; focus?: string } = {}
): Promise<Record<string, unknown>> {
  const { focus, ...rest } = extra;
  const [rows, allowlist] = await Promise.all([listUsers(env), allowlistView(env)]);
  const users = describeUsers(env, rows, allowlist.emails);
  return {
    users,
    admins: privilegedEmails(env),
    super_admins: superAdminEmails(env),
    allowlist,
    ...(focus ? { user: users.find((u) => u.email === normalize(focus)) ?? null } : {}),
    ...rest,
  };
}

/**
 * Resolve the target of a user-management action and check the policy for it.
 * Returns either a Response to send (403 with the reason) or the target's
 * current row and configured role.
 */
async function targetUser(
  c: Context<Vars>,
  rawEmail: string,
  action: UserAction
): Promise<{ email: string; row: UserRow | null; role: UserRole } | Response> {
  const email = normalizeEmail(rawEmail);
  if (!email) {
    return c.json({ error: "bad_request", detail: "valid email required" }, 400);
  }
  const role = effectiveRole(c.env, email);
  const denial = userActionDenial(c.get("identity"), { email, role }, action);
  if (denial) return c.json({ error: "forbidden", detail: denial }, 403);
  return { email, row: await getUser(c.env, email), role };
}

api.get("/users", async (c) => c.json(await directory(c.env)));

/**
 * Invite somebody (or re-invite an existing person). The Access allow-list is
 * written *first*: if that fails we have handed out nothing, so there is no
 * directory row promising a login that does not exist.
 */
api.post("/users", async (c) => {
  const body = await c.req.json().catch(() => null);
  const target = await targetUser(c, String(body?.email ?? ""), "invite");
  if (target instanceof Response) return target;

  const displayName = cleanText(body?.display_name, MAX_DISPLAY_NAME_LENGTH);
  if (displayName === undefined && body?.display_name !== undefined) {
    return c.json(
      { error: "bad_request", detail: `display_name must be a string of at most ${MAX_DISPLAY_NAME_LENGTH} chars` },
      400
    );
  }
  const notes = cleanText(body?.notes, MAX_NOTES_LENGTH);
  if (notes === undefined && body?.notes !== undefined) {
    return c.json(
      { error: "bad_request", detail: `notes must be a string of at most ${MAX_NOTES_LENGTH} chars` },
      400
    );
  }

  let warning: string | undefined;
  if (isConfigured(c.env)) {
    try {
      await addUsers(c.env, [target.email]);
    } catch (e) {
      if (e instanceof AccessNotConfiguredError) return c.json({ error: "not_configured" }, 503);
      return c.json({ error: "access_api", detail: (e as Error).message }, 502);
    }
  } else {
    warning =
      "Cloudflare Access isn't configured, so this only records them locally — they can't sign in yet";
  }

  await upsertInvite(c.env, {
    email: target.email,
    displayName,
    notes,
    invitedBy: c.get("email"),
    role: target.role,
    now: new Date().toISOString(),
  });
  return c.json(await directory(c.env, { warning, focus: target.email }));
});

/** Edit the human-facing metadata (display name, notes). Never role or status. */
api.patch("/users/:email", async (c) => {
  const target = await targetUser(c, c.req.param("email"), "edit");
  if (target instanceof Response) return target;
  const body = await c.req.json().catch(() => null);

  const displayName = cleanText(body?.display_name, MAX_DISPLAY_NAME_LENGTH);
  const notes = cleanText(body?.notes, MAX_NOTES_LENGTH);
  if (
    (body?.display_name !== undefined && displayName === undefined) ||
    (body?.notes !== undefined && notes === undefined)
  ) {
    return c.json({ error: "bad_request", detail: "display_name / notes must be short strings" }, 400);
  }
  if (displayName === undefined && notes === undefined) {
    return c.json({ error: "bad_request", detail: "nothing to update" }, 400);
  }
  const row = await updateProfile(c.env, target.email, { displayName, notes });
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(await directory(c.env, { focus: target.email }));
});

/**
 * Pause somebody's access. The local status is written *first* — that is what
 * actually stops them (`resolveAuth` refuses a disabled account on every
 * surface), so it must not be contingent on the Cloudflare API succeeding. Their
 * API tokens are revoked in the same breath, otherwise a paused person would keep
 * a working bearer credential.
 *
 * Artifacts, versions, files, views and grants are all left alone: disabling is
 * reversible, and re-enabling restores exactly what they had.
 */
api.post("/users/:email/disable", async (c) => {
  const target = await targetUser(c, c.req.param("email"), "disable");
  if (target instanceof Response) return target;
  const now = new Date().toISOString();

  await disableUser(c.env, target.email, target.role, now);
  await revokeTokensForEmail(c.env, target.email, now);

  let warning: string | undefined;
  if (isConfigured(c.env)) {
    try {
      await removeUser(c.env, target.email);
    } catch (e) {
      if (!(e instanceof AccessNotConfiguredError)) {
        warning = `disabled here, but the Cloudflare Access allow-list still lists them (${(e as Error).message}) — this app refuses them either way`;
      }
    }
  }
  return c.json(await directory(c.env, { warning, focus: target.email }));
});

/**
 * Lift a pause. Allow-list first, mirroring invite: granting access must not be
 * recorded locally unless the login it implies actually exists. Previously
 * revoked API tokens stay revoked — re-enabling a person is not re-issuing
 * their credentials.
 */
api.post("/users/:email/enable", async (c) => {
  const target = await targetUser(c, c.req.param("email"), "enable");
  if (target instanceof Response) return target;

  let warning: string | undefined;
  if (isConfigured(c.env)) {
    try {
      await addUsers(c.env, [target.email]);
    } catch (e) {
      if (e instanceof AccessNotConfiguredError) return c.json({ error: "not_configured" }, 503);
      return c.json({ error: "access_api", detail: (e as Error).message }, 502);
    }
  } else {
    warning = "Cloudflare Access isn't configured, so they still can't sign in";
  }
  await enableUser(c.env, target.email, target.role, new Date().toISOString());
  return c.json(
    await directory(c.env, {
      warning: warning ?? "re-enabled — any API tokens they had stay revoked",
      focus: target.email,
    })
  );
});

/**
 * Remove somebody from the beta entirely. The Access allow-list is written first
 * and a failure aborts: deleting the local row while Access still lets them in
 * would leave a signed-in stranger with no directory entry at all.
 *
 * Their artifacts, versions, files and view history are NOT deleted — published
 * work outlives the account. What goes is the login, the view grants, and every
 * API token issued for them.
 */
api.delete("/users/:email", async (c) => {
  const target = await targetUser(c, c.req.param("email"), "remove");
  if (target instanceof Response) return target;

  let warning: string | undefined;
  if (isConfigured(c.env)) {
    try {
      await removeUser(c.env, target.email);
    } catch (e) {
      if (e instanceof AccessNotConfiguredError) return c.json({ error: "not_configured" }, 503);
      return c.json({ error: "access_api", detail: (e as Error).message }, 502);
    }
  } else {
    warning = "Cloudflare Access isn't configured — removed locally only";
  }
  const now = new Date().toISOString();
  await removeEmailFromAllGrants(c.env, target.email);
  await revokeTokensForEmail(c.env, target.email, now);
  await deleteUser(c.env, target.email);
  return c.json(await directory(c.env, { warning, removed: target.email }));
});

// --- API tokens (bearer credentials for Hermes Cloud / CI / scripts) ---
//
// These routes are Access-only (see denyApiToken above): a token can never mint
// or revoke another token. An admin sees and manages every token; a beta user
// only their own, and may only issue tokens that act as themselves.

api.get("/tokens", async (c) => {
  const identity = c.get("identity");
  const rows = identity.isAdmin
    ? await listApiTokens(c.env)
    : await listApiTokens(c.env, identity.email!);
  return c.json({ tokens: rows.map(toPublicToken) });
});

api.post("/tokens", async (c) => {
  const identity = c.get("identity");
  const body = await c.req.json().catch(() => null);

  const name = String(body?.name ?? "").trim();
  if (!name || name.length > MAX_TOKEN_NAME_LENGTH) {
    return c.json(
      { error: "bad_request", detail: `name is required (max ${MAX_TOKEN_NAME_LENGTH} chars)` },
      400
    );
  }

  const scopes = body?.scopes === undefined ? DEFAULT_SCOPES : parseScopes(body.scopes);
  if (!scopes) {
    return c.json(
      { error: "bad_request", detail: "scopes must be a non-empty array of 'read' | 'publish' | 'manage'" },
      400
    );
  }

  const wantsAdmin = body?.is_admin === true;
  const requestedOwner = String(body?.owner_email ?? "").trim().toLowerCase();

  // A beta user can only ever issue a token that is *themselves*: same email, no
  // admin bit. Otherwise a token would be a privilege-escalation primitive.
  let ownerEmail: string | null;
  let isAdminToken: boolean;
  if (identity.isAdmin) {
    ownerEmail = requestedOwner || null;
    isAdminToken = wantsAdmin;
    if (ownerEmail && !ownerEmail.includes("@")) {
      return c.json({ error: "bad_request", detail: "owner_email must be a valid email" }, 400);
    }
    // A token with no owner and no admin bit could never own or reach anything.
    if (!ownerEmail && !isAdminToken) {
      return c.json(
        { error: "bad_request", detail: "provide owner_email, or set is_admin for an admin token" },
        400
      );
    }
  } else {
    if (wantsAdmin || (requestedOwner && requestedOwner !== identity.email)) {
      return c.json(
        { error: "forbidden", detail: "you can only create tokens that act as you" },
        403
      );
    }
    ownerEmail = identity.email;
    isAdminToken = false;
  }

  let expiresAt: string | null = null;
  if (body?.expires_in_days !== undefined && body?.expires_in_days !== null) {
    const days = Number(body.expires_in_days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRES_IN_DAYS) {
      return c.json(
        { error: "bad_request", detail: `expires_in_days must be an integer 1–${MAX_EXPIRES_IN_DAYS}` },
        400
      );
    }
    expiresAt = new Date(Date.now() + days * 86400_000).toISOString();
  }

  const { token, row } = await createApiToken(c.env, {
    name,
    ownerEmail,
    isAdmin: isAdminToken,
    scopes,
    createdBy: c.get("email"),
    expiresAt,
    now: new Date().toISOString(),
  });
  // `token` is shown exactly once — only its hash is stored.
  return c.json({ token, ...toPublicToken(row) }, 201);
});

api.delete("/tokens/:id", async (c) => {
  const identity = c.get("identity");
  const id = c.req.param("id");
  const row = await getApiToken(c.env, id);
  // Someone else's token is not yours to revoke, and its existence stays hidden.
  const mine =
    row &&
    (identity.isAdmin ||
      (!!row.owner_email && row.owner_email.toLowerCase() === identity.email?.toLowerCase()));
  if (!mine) return c.json({ error: "not_found" }, 404);
  const revoked = await revokeApiToken(c.env, id, new Date().toISOString());
  return c.json({ revoked: id, already_revoked: !revoked });
});

api.get("/artifacts/:slug/versions", requireScope("read"), async (c) => {
  const slug = c.req.param("slug");
  const art = await manageable(c, slug);
  if (!art) return c.json({ error: "not_found" }, 404);
  return c.json({ current: art.current_version, versions: await listVersions(c.env, slug) });
});

api.get("/artifacts/:slug/views", requireScope("read"), async (c) => {
  const slug = c.req.param("slug");
  const art = await manageable(c, slug);
  if (!art) return c.json({ error: "not_found" }, 404);
  const raw = Number(c.req.query("limit"));
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 200) : 50;
  return c.json(await getViews(c.env, slug, limit));
});

// Rollback: pointing a slug at an existing version is a publish operation —
// it changes what the world sees — so it rides on the `publish` scope.
api.post("/artifacts/:slug/current", requireScope("publish"), async (c) => {
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

api.get("/artifacts/:slug/access", requireScope("read"), async (c) => {
  const slug = c.req.param("slug");
  const art = await manageable(c, slug);
  if (!art) return c.json({ error: "not_found" }, 404);
  return c.json({ visibility: art.visibility, emails: await listGrants(c.env, slug) });
});

api.put("/artifacts/:slug/access", requireScope("manage"), async (c) => {
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

api.delete("/artifacts/:slug", requireScope("manage"), async (c) => {
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
