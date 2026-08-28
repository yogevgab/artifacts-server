import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, ArtifactRow } from "./env";
import {
  requireAdmin,
  requireApiToken,
  requireUser,
  requireScope,
  denyApiToken,
  accountsFor,
  type AuthVars,
} from "./auth";
import {
  canManage,
  canManageMembers,
  canReadAccount,
  isPlatformAdmin,
  memberChangeDenial,
  userActionDenial,
  type UserAction,
} from "./authz";
import {
  accountIdsWithAtLeast,
  createAccount,
  effectivePlan,
  ensurePersonalAccount,
  getAccount,
  isSuspended,
  isAccountRole,
  listMembers,
  memberRole,
  ownerCount,
  removeMember,
  removeMemberEverywhere,
  toPublicAccount,
  toPublicMember,
  upsertMember,
  MANAGE_ARTIFACTS,
  MAX_ACCOUNT_NAME_LENGTH,
  type AccountRole,
  type AccountRow,
} from "./accounts";
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
import { processZip, singleHtml, singlePdf, sniffKind, UploadError, MAX_UPLOAD_BYTES, type ProcessedUpload } from "./upload";
import { exceeds, limitsFor, usageFor } from "./quota";
import { seatLimitDenial } from "./members";
import { nextPaidPlan, PLAN_LABEL, priceLabel } from "./plan-copy";
import { checkoutUrl } from "./billing";
import { num, bytes } from "./portal";
import {
  listArtifacts,
  listArtifactsForCaller,
  getArtifact,
  upsertArtifact,
  deleteArtifactRow,
  listGrants,
  setAccess,
  removeEmailFromAllGrants,
  insertNextVersion,
  applyRetention,
  deleteVersion,
  listVersions,
  getVersion,
  setCurrentVersion,
  getViews,
} from "./db";
import { firstContentHostname } from "./host";
import { brandedArtifactUrl } from "./account-slugs";
import { siteOrigin } from "./seo";
import { apiCors } from "./cors";

type Vars = { Variables: AuthVars; Bindings: Env };

export const api = new Hono<Vars>();

/**
 * The artifact surface: publish, list, versions, rollback, views, sharing and
 * delete. Kept as its own router because it is mounted twice — once at `/api`
 * for the dashboard and for Access-authenticated callers, and once at
 * `/api/machine` for bearer-token clients (see the mounts at the bottom of this
 * file). One definition, so the two can never drift apart in what they enforce.
 */
const artifactRoutes = new Hono<Vars>();

// Browser preflight and cross-origin policy, FIRST — before any authentication.
// A CORS preflight carries no credentials by definition, so authenticating one
// refuses a request that would have been authorized, and the browser reports
// that as a CORS failure on the call that follows. It grants nothing on its own:
// see the long note in src/cors.ts.
api.use("*", apiCors);

// The machine surface, FIRST — before the general gate below, so a request to
// `/api/machine/*` is authenticated by the bearer-only rule and never by an
// Access session. See `requireApiToken` in src/auth.ts for why that is stricter
// rather than looser, and the mount at the bottom of this file for what it
// covers.
api.use("/machine", requireApiToken);
api.use("/machine/*", requireApiToken);

// Every other API route needs an authenticated caller — an app session or an
// API token. Per-artifact ownership is enforced per route below (admins manage
// everything, members only what they own), and API tokens are additionally
// narrowed by scope (`requireScope`).
//
// A request the machine gate already authenticated is passed straight through:
// it has an identity, so re-running `requireUser` would only repeat the token
// lookup — and must never be able to *widen* the machine surface by resolving a
// second, session-shaped identity for it.
api.use("*", async (c, next) => (c.get("identity") ? next() : requireUser(c, next)));
// Managing who can sign in stays admin-only, and is off-limits to
// API tokens: issuing credentials always requires an interactive login.
api.use("/users", requireAdmin, denyApiToken);
api.use("/users/*", requireAdmin, denyApiToken);
// Same for the tokens themselves — a token must never be able to mint another.
api.use("/tokens", denyApiToken);
api.use("/tokens/*", denyApiToken);
// Changing who is in a workspace hands out reach over that workspace's artifacts,
// so — like inviting a user — it takes an interactive login. Reading the list is
// fine for a token, which is why only the mutating routes are covered.
api.use("/accounts", async (c, next) =>
  c.req.method === "GET" ? next() : denyApiToken(c, next)
);
api.use("/accounts/*", async (c, next) =>
  c.req.method === "GET" ? next() : denyApiToken(c, next)
);

/**
 * Load an artifact the caller is allowed to manage, or null. Returns null both
 * when the slug does not exist and when it belongs to somebody else, so every
 * caller answers 404 either way and a member can't probe for the existence
 * of another user's artifacts.
 *
 * Exported because the remote MCP tools (src/mcp.ts) have to answer exactly the
 * same question, and a second implementation of "may this caller touch that
 * slug?" is the kind of drift that only ever gets discovered from the wrong
 * side.
 */
export async function manageableArtifact(c: Context<Vars>, slug: string): Promise<ArtifactRow | null> {
  const art = await getArtifact(c.env, slug);
  if (!art) return null;
  return canManage(c.get("identity"), art, (await accountsFor(c)).roles) ? art : null;
}

/**
 * Every artifact this caller may manage — the visibility rule `GET /artifacts`
 * has always applied, in one place.
 *
 * A platform admin sees the instance; everybody else sees what they own by
 * email plus what their workspaces own (issue #27). For the personal account
 * every identity gets, those are the same rows as before.
 *
 * Exported for the same reason as `manageableArtifact`: the remote MCP
 * `doctor`, `list_artifacts` and `artifact_statistics` tools all need this
 * exact set, and it used to be restated in src/mcp.ts.
 */
export async function visibleArtifacts(c: Context<Vars>): Promise<ArtifactRow[]> {
  const identity = c.get("identity");
  return isPlatformAdmin(identity)
    ? listArtifacts(c.env)
    : listArtifactsForCaller(
        c.env,
        identity.email,
        accountIdsWithAtLeast((await accountsFor(c)).roles, MANAGE_ARTIFACTS)
      );
}

/**
 * A 403 when `accountId` names a suspended workspace, or null when the request
 * may proceed.
 *
 * Suspension is an operator control (src/operator.ts), and this is one of the
 * two places it bites — the other is content serving (`blocksOnSuspension`,
 * src/quota.ts). Returning a Response rather than a boolean keeps the wording
 * of the refusal in one place: a caller that hits this in a CLI needs to be
 * told the workspace is suspended and that nothing was deleted, not handed a
 * bare `forbidden`.
 *
 * A null `accountId` — a legacy artifact, an un-migrated instance, a platform
 * token — is never suspended, because there is no workspace to have suspended.
 * That is the same "accounts only ever widen reach" rule the rest of the
 * account layer follows.
 */
const SUSPENDED_DETAIL =
  "this workspace is suspended, so it cannot publish. Nothing has been deleted — " +
  "contact support at /contact to have it reviewed.";

const suspendedResponse = (c: Context<Vars>) =>
  c.json({ error: "account_suspended", detail: SUSPENDED_DETAIL }, 403);

export async function suspendedDenial(c: Context<Vars>, accountId: string | null): Promise<Response | null> {
  if (!accountId) return null;
  const account = await getAccount(c.env, accountId);
  if (!account || !isSuspended(account)) return null;
  return suspendedResponse(c);
}

/**
 * The origin artifacts are actually served from — the content host when one is
 * configured, otherwise whatever host this request arrived on. Every route that
 * reports a link derives it here rather than letting the client assemble one:
 * an agent that guesses `https://a.rtfx.pro/<slug>/` is right on rtfx.pro and
 * wrong on every self-hosted instance, and a wrong link is worse than none.
 */
export function contentBase(c: Context<Vars>): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${firstContentHostname(c.env) ?? url.host}`;
}

export const artifactUrl = (c: Context<Vars>, slug: string): string => `${contentBase(c)}/${slug}/`;

/**
 * The BRANDED link for an artifact — `https://rtfx.pro/yogev/q3-board-report` —
 * or null when its workspace has not claimed an address (which is most of them).
 *
 * Additive everywhere it appears, and deliberately never a replacement for
 * `url`: the content-origin URL is the one that is always correct, always
 * anonymous, and unaffected by anything the workspace later does with its
 * address. A client that only knows `url` keeps working forever.
 *
 * Resolved from the memberships already loaded for this request, so reporting
 * it costs no extra query. A caller with no membership in the artifact's
 * workspace (a platform token, an un-migrated instance) simply gets null —
 * an absent branded link is never wrong, and a guessed one would be.
 */
export function brandedUrl(
  c: Context<Vars>,
  memberships: readonly { account: AccountRow }[],
  accountId: string | null | undefined,
  slug: string
): string | null {
  if (!accountId) return null;
  const address = memberships.find((m) => m.account.id === accountId)?.account.public_slug;
  if (!address) return null;
  return brandedArtifactUrl(c.env.PUBLIC_BASE_URL || siteOrigin(c.env), address, slug);
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

artifactRoutes.get("/artifacts", requireScope("read"), async (c) => {
  const rows = await visibleArtifacts(c);
  const { memberships } = await accountsFor(c);
  // `content_base` and `branded_url` are both additive: every field a row had
  // before is still there and still means the same thing, and a machine client
  // gets the two pieces it cannot derive — where artifacts are served, and the
  // branded link when the workspace has an address.
  const artifacts = rows.map((row) => {
    const branded = brandedUrl(c, memberships, row.account_id, row.slug);
    return branded ? { ...row, branded_url: branded } : row;
  });
  return c.json({ artifacts, content_base: contentBase(c) });
});

/**
 * Where a publish is landing, resolved from the caller's metadata alone —
 * before a single byte of content is looked at.
 *
 * Extracted so the multipart route below and the remote MCP `publish` tool
 * (src/mcp.ts) share one implementation of the slug rules, the title rule and
 * the "may this caller add a version to that artifact?" check. Two transports
 * that decide *who may publish where* in two places will eventually disagree,
 * and the direction they disagree in is not knowable in advance.
 */
export type PublishTarget = {
  slug: string;
  existing: ArtifactRow | null;
  accounts: Awaited<ReturnType<typeof accountsFor>>;
};

export async function resolvePublishTarget(
  c: Context<Vars>,
  input: { slug?: string; title?: string }
): Promise<PublishTarget | Response> {
  const providedTitle = (input.title ?? "").trim();
  const slug = (input.slug ?? "").trim() || slugify(providedTitle);

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
  const accounts = await accountsFor(c);
  if (existing && !canManage(c.get("identity"), existing, accounts.roles)) {
    return c.json(
      { error: "slug_taken", detail: `the slug "${slug}" is already in use — pick another` },
      409
    );
  }
  return { slug, existing, accounts };
}

/**
 * Commit a processed upload: plan limits, then the version, then the bytes,
 * then the row. Everything after "what are we publishing?" lives here, which is
 * what lets a second transport reuse the quota check, the suspension check, the
 * retention window and the response shape without restating any of them.
 */
export async function storeUpload(
  c: Context<Vars>,
  target: PublishTarget,
  processed: ProcessedUpload,
  meta: { title?: string; description?: string; note?: string }
): Promise<Response> {
  const { slug, existing, accounts } = target;
  const providedTitle = (meta.title ?? "").trim();
  const description = (meta.description ?? "").trim();
  const note = (meta.note ?? "").trim();

  // Versions are immutable and stored under <slug>/v<N>/, so we never delete a
  // previous version's files. Reserve the version number atomically first
  // (race-safe), then write its files; roll the reservation back if storage fails.
  const now = new Date().toISOString();
  const size = processed.files.reduce((n, f) => n + f.bytes.byteLength, 0);

  // Enforce plan limits before any bytes are written to D1 or R2 (design spec
  // §8.2). Scoped to the account this artifact belongs (or will belong) to —
  // the same precedence `row.account_id` uses below — so a caller with no
  // account at all (un-migrated instance, platform token) is simply not
  // checked, matching the "accounts only ever widen reach, never narrow it"
  // rule the rest of this module follows (see accounts.ts).
  const quotaAccountId = existing?.account_id ?? accounts.active?.id ?? null;
  // Hoisted: the retention window below needs the same plan the quota check
  // used, and an artifact with no account is treated as free for both.
  let accountPlan = "free";
  if (quotaAccountId) {
    const quotaAccount = await getAccount(c.env, quotaAccountId);
    // A suspended workspace stops publishing, before any bytes are read from
    // the upload and before the version number is reserved. Checked here rather
    // than in middleware because this is the point at which the *target*
    // workspace is known — a publish to an existing slug lands in that
    // artifact's account, which is not necessarily the caller's active one.
    if (quotaAccount && isSuspended(quotaAccount)) return suspendedResponse(c);
    // The EFFECTIVE plan: an operator override outranks what billing says, so
    // a comped workspace gets the limits it was comped onto (src/accounts.ts).
    accountPlan = quotaAccount ? effectivePlan(quotaAccount) : "free";
    const limits = limitsFor(accountPlan);
    const usage = await usageFor(c.env, quotaAccountId);
    // A republish adds bytes to storage but not a new artifact; a brand-new
    // slug adds one of each. Checked against what usage would become *after*
    // this publish, so the account can never end up over either cap.
    const hit = exceeds(
      { artifacts: usage.artifacts + (existing ? 0 : 1), storageBytes: usage.storageBytes + size },
      limits
    );
    if (hit) {
      // This is the conversion moment: a refusal is the worst way to learn an
      // account is full (the dashboard warns before this, at 80% — see
      // usageWarningBanner in src/admin.ts), so when it happens anyway the
      // response says exactly which limit, what it is, and what upgrading
      // would actually buy — never just "or upgrade" with nothing to act on.
      const next = nextPaidPlan(accountPlan);
      const nextLimits = next ? limitsFor(next) : null;
      const upgrade =
        next && quotaAccountId
          ? {
              plan: next,
              label: PLAN_LABEL[next],
              price: priceLabel(next),
              url: checkoutUrl(c.env, next, { id: quotaAccountId }, c.get("email")),
            }
          : null;
      const upgradeClause = nextLimits
        ? `, or upgrade to ${PLAN_LABEL[next!]} (${priceLabel(next!)}) for ${num(nextLimits.maxArtifacts)} artifacts and ${bytes(nextLimits.maxStorageBytes)} of storage`
        : "";

      if (hit === "artifacts") {
        return c.json(
          {
            error: "quota_exceeded",
            limit: "artifacts",
            detail: `this workspace is at its ${limits.maxArtifacts}-artifact limit; delete one${upgradeClause}`,
            upgrade,
          },
          413
        );
      }
      const maxMb = Math.round(limits.maxStorageBytes / (1024 * 1024));
      return c.json(
        {
          error: "quota_exceeded",
          limit: "storage",
          detail: `this workspace is at its ${maxMb}MB storage limit; delete a version${upgradeClause}`,
          upgrade,
        },
        413
      );
    }
  }

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
    // The workspace this artifact belongs to (issue #27), also set once. Null
    // when the publisher has no account yet (un-migrated instance, or a platform
    // token) — the row then lives on `owner_email` alone, exactly as before.
    account_id: existing?.account_id ?? accounts.active?.id ?? null,
  };
  await upsertArtifact(c.env, row);

  // Free plans keep a finite window of versions. Applied only after the publish
  // has fully succeeded, so a failure in housekeeping can never cost somebody
  // the work they just published — the worst case is bytes that should have
  // gone sticking around a while.
  try {
    await applyRetention(
      c.env,
      slug,
      limitsFor(accountPlan).keepVersions,
      version,
      new Date().toISOString()
    );
  } catch {
    // Never a reason to fail a successful publish.
  }


  const branded = brandedUrl(c, accounts.memberships, row.account_id, slug);
  return c.json({
    slug,
    url: artifactUrl(c, slug),
    // Present only when the workspace has claimed an address, so a publish into
    // a workspace without one answers exactly as it did before.
    ...(branded ? { branded_url: branded } : {}),
    type: processed.type,
    file_count: processed.files.length,
    version,
  });
}

artifactRoutes.post("/artifacts", requireScope("publish"), async (c) => {
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

  const target = await resolvePublishTarget(c, {
    slug: String(form.get("slug") ?? ""),
    title: providedTitle,
  });
  if (target instanceof Response) return target;

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
      // Decided by the bytes, never the filename: a filename is a claim by the
      // uploader, magic bytes are a fact. Without this, `deck.pdf` containing
      // HTML would be served as a document with our chrome around it.
      const bytes = new Uint8Array(await htmlFile.arrayBuffer());
      processed = sniffKind(htmlFile.name, bytes) === "pdf" ? singlePdf(bytes) : singleHtml(bytes);
    } else {
      return c.json({ error: "bad_request", detail: "provide a 'file' (.html) or 'bundle' (.zip)" }, 400);
    }
  } catch (e) {
    if (e instanceof UploadError) return c.json({ error: "bad_request", detail: e.message }, 400);
    return c.json({ error: "bad_request", detail: "could not process upload" }, 400);
  }

  return storeUpload(c, target, processed, { title: providedTitle, description, note });
});

// --- User management -------------------------------------------------------
//
// Sign-in is app-owned (see src/users.ts): the `users` table IS the directory —
// who exists, their status, name, notes and timestamps — and a signed-in
// `rtfx_session` plus a non-paused row is what lets somebody in. There is no
// external allow-list layered underneath it.
//
// Every route here is admin-only and refuses API tokens (see the middleware at
// the top of this file), because inviting somebody hands out a credential.

/**
 * The full directory response. Read straight back from D1 after every mutation,
 * so the client never has to merge state itself and can't drift.
 * `focus` is the email the request acted on, echoed back as `user`.
 */
async function directory(
  env: Env,
  extra: { warning?: string; removed?: string; focus?: string } = {}
): Promise<Record<string, unknown>> {
  const { focus, ...rest } = extra;
  const rows = await listUsers(env);
  const users = describeUsers(env, rows);
  return {
    users,
    admins: privilegedEmails(env),
    super_admins: superAdminEmails(env),
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

/** Where an admin lands after re-establishing a session, if `next` is unusable. */
const REAUTH_FALLBACK = "/admin/people";

/**
 * A same-origin path safe to redirect a browser to, or the People section.
 *
 * Only a plain absolute path is accepted. `//evil.com` and `/\evil.com` are both
 * read as protocol-relative URLs by browsers, and a scheme (`javascript:`, or
 * any absolute URL) is not a path at all — so this is an allow-list of one shape
 * rather than a list of things to strip.
 */
function safeNext(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/")) return REAUTH_FALLBACK;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return REAUTH_FALLBACK;
  return raw;
}

/**
 * Bounce a browser through an edge gate for this path prefix, then go back
 * (issue #37).
 *
 * On the app-owned deployment this is inert: the `rtfx_session` cookie covers
 * the whole origin, so a dashboard write is never answered with a redirect.
 * It stays for a legacy/self-host instance that gates paths at the edge with
 * *separate* applications, where a browser holding a session for `/admin` has
 * none for `/api/users` and the first invite of a session is answered — before
 * the Worker ever sees it — with a cross-origin 302. A `fetch` cannot follow
 * that, which is what users saw as "CORS error".
 *
 * Such a redirect *can* be followed by a full-page navigation, so the dashboard
 * sends the browser here instead of failing. Being under `/api/users` is the
 * entire point: reaching this route at all means the session now exists.
 *
 * It is an ordinary admin-only route — the middleware at the top of this file
 * applies, so a member and an API token are both refused — and it discloses
 * nothing: no body, and it only ever redirects to a path on this origin.
 */
api.get("/users/reauth", (c) => c.redirect(safeNext(c.req.query("next")), 302));

/**
 * Invite somebody (or re-invite an existing person). The app owns sign-in, so the
 * directory row IS the invite — there is nothing else to write, and nothing that
 * can leave a row promising a login that does not exist.
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

  // Inviting used to write a legacy external allow-list before touching the
  // directory. The app owns sign-in now, so the directory row IS the invite,
  // and there is no second system left to warn about failing to reach.
  await upsertInvite(c.env, {
    email: target.email,
    displayName,
    notes,
    invitedBy: c.get("email"),
    role: target.role,
    now: new Date().toISOString(),
  });
  return c.json(await directory(c.env, { focus: target.email }));
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

  return c.json(await directory(c.env, { focus: target.email }));
});

/**
 * Lift a pause. Clearing the row's `disabled` status is the whole operation —
 * they can sign in again on their next one-time code. Previously revoked API
 * tokens stay revoked: re-enabling a person is not re-issuing their credentials.
 */
api.post("/users/:email/enable", async (c) => {
  const target = await targetUser(c, c.req.param("email"), "enable");
  if (target instanceof Response) return target;

  await enableUser(c.env, target.email, target.role, new Date().toISOString());
  return c.json(
    await directory(c.env, {
      warning: "re-enabled — any API tokens they had stay revoked",
      focus: target.email,
    })
  );
});

/**
 * Remove somebody from rtfx.pro entirely. Dropping the directory row is what ends
 * their sign-in — with no row and no configured role there is nothing left for a
 * one-time code to resolve to.
 *
 * Their artifacts, versions, files and view history are NOT deleted — published
 * work outlives the account. What goes is the login, the view grants, and every
 * API token issued for them.
 */
api.delete("/users/:email", async (c) => {
  const target = await targetUser(c, c.req.param("email"), "remove");
  if (target instanceof Response) return target;

  const now = new Date().toISOString();
  await removeEmailFromAllGrants(c.env, target.email);
  await revokeTokensForEmail(c.env, target.email, now);
  // Drop them from every workspace too, or a removed identity would still be
  // listed as a member (and would regain reach if the email were ever re-invited).
  // Their personal account and its artifacts survive — published work outlives
  // the account, exactly as the artifact rows do.
  await removeMemberEverywhere(c.env, target.email);
  await deleteUser(c.env, target.email);
  return c.json(await directory(c.env, { removed: target.email }));
});

// --- API tokens (bearer credentials for Hermes Cloud / CI / scripts) ---
//
// These routes are Access-only (see denyApiToken above): a token can never mint
// or revoke another token. An admin sees and manages every token; a member
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

  // A member can only ever issue a token that is *themselves*: same email, no
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

  const now = new Date().toISOString();

  // Pin the token to a workspace (issue #27). For the caller's own token that is
  // the workspace they are acting in; for a token an admin mints on somebody
  // else's behalf it is that person's personal account, provisioned if needed —
  // never the admin's own, which would hand the credential the wrong workspace.
  // An admin/platform token (no owner_email) stays account-less on purpose.
  let accountId: string | null = null;
  if (ownerEmail) {
    const ctx = await accountsFor(c);
    accountId =
      ownerEmail === identity.email
        ? (ctx.active?.id ?? (await ensurePersonalAccount(c.env, ownerEmail, now))?.id ?? null)
        : ((await ensurePersonalAccount(c.env, ownerEmail, now))?.id ?? null);
  }

  const { token, row } = await createApiToken(c.env, {
    name,
    ownerEmail,
    accountId,
    isAdmin: isAdminToken,
    scopes,
    createdBy: c.get("email"),
    expiresAt,
    now,
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

// --- Accounts / workspaces (issue #27) --------------------------------------
//
// The container that owns artifacts, tokens and — later — a plan. Roles here
// (`owner` > `admin` > `member` > `viewer`) are ACCOUNT roles: they reach one
// workspace's data and nothing else. They are stored in D1 and are therefore
// customer data; platform authority (super_admin / admin over the whole
// instance) is never read from this table and cannot be granted through these
// routes. See the note at the top of src/accounts.ts.

/** The caller's own workspaces, and which one this request acts in. */
api.get("/accounts", async (c) => {
  const ctx = await accountsFor(c);
  return c.json({
    accounts: ctx.memberships.map((m) => toPublicAccount(m.account, m.role)),
    active: ctx.active?.id ?? null,
    /** True when an API token pinned this request to one workspace. */
    pinned: ctx.pinned,
  });
});

/**
 * Create a team workspace. Platform-admin only for now: this instance is
 * invite-only, so who gets a workspace is an operator decision. The creator is
 * *not* made a member — they say who the owner is, so an operator provisioning a
 * customer's organization does not end up inside it.
 */
api.post("/accounts", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const name = String(body?.name ?? "").trim();
  if (!name || name.length > MAX_ACCOUNT_NAME_LENGTH) {
    return c.json(
      { error: "bad_request", detail: `name is required (max ${MAX_ACCOUNT_NAME_LENGTH} chars)` },
      400
    );
  }
  const ownerEmail = normalizeEmail(String(body?.owner_email ?? ""));
  if (!ownerEmail) {
    return c.json({ error: "bad_request", detail: "owner_email must be a valid email" }, 400);
  }
  const now = new Date().toISOString();
  const account = await createAccount(c.env, {
    name,
    kind: "team",
    personalEmail: null,
    createdBy: c.get("email"),
    now,
  });
  await upsertMember(c.env, {
    accountId: account.id,
    email: ownerEmail,
    role: "owner",
    invitedBy: c.get("email"),
    now,
  });
  return c.json(
    { ...toPublicAccount(account, null), members: (await listMembers(c.env, account.id)).map(toPublicMember) },
    201
  );
});

/**
 * Resolve an account the caller may at least read, or a 404. Answering 404 (not
 * 403) for a workspace they don't belong to keeps account ids unprobeable, the
 * same rule artifacts follow.
 */
async function readableAccount(c: Context<Vars>, id: string) {
  const account = await getAccount(c.env, id);
  if (!account) return null;
  const ctx = await accountsFor(c);
  return canReadAccount(c.get("identity"), ctx.roles, id) ? { account, ctx } : null;
}

api.get("/accounts/:id/members", async (c) => {
  const found = await readableAccount(c, c.req.param("id"));
  if (!found) return c.json({ error: "not_found" }, 404);
  return c.json({
    account: toPublicAccount(found.account, found.ctx.roles.get(found.account.id) ?? null),
    members: (await listMembers(c.env, found.account.id)).map(toPublicMember),
  });
});

/**
 * Add somebody to a workspace, or change the role they hold there.
 *
 * This grants reach over that workspace's artifacts, so it takes `admin` or
 * `owner` *in that account* (or platform-admin rights) — and an interactive
 * login, never an API token. It grants nothing outside the workspace: writing
 * `owner` here cannot make anybody a platform admin.
 *
 * It deliberately does NOT add anybody to the sign-in directory. Being a member
 * of a workspace is not permission to sign in; that stays an admin action through
 * /api/users, so an account owner cannot widen who reaches the instance.
 */
api.put("/accounts/:id/members/:email", async (c) => {
  const id = c.req.param("id");
  const found = await readableAccount(c, id);
  if (!found) return c.json({ error: "not_found" }, 404);
  if (!canManageMembers(c.get("identity"), found.ctx.roles, id)) {
    return c.json({ error: "forbidden", detail: "you cannot manage members of this workspace" }, 403);
  }
  const email = normalizeEmail(c.req.param("email"));
  if (!email) return c.json({ error: "bad_request", detail: "valid email required" }, 400);

  const body = await c.req.json().catch(() => null);
  const nextRole: unknown = body?.role;
  if (!isAccountRole(nextRole)) {
    return c.json(
      { error: "bad_request", detail: "role must be 'owner' | 'admin' | 'member' | 'viewer'" },
      400
    );
  }
  const currentRole = await memberRole(c.env, id, email);
  const denial = memberChangeDenial(c.get("identity"), found.ctx.roles.get(id) ?? null, {
    targetCurrentRole: currentRole,
    nextRole: nextRole as AccountRole,
    ownerCount: await ownerCount(c.env, id),
  });
  if (denial) return c.json({ error: "forbidden", detail: denial }, 403);

  // Seats. This route predates them and upserts directly, so without the same
  // check the limit enforced on the workspace route would be decorative —
  // anyone who knew this older path could add members past the cap. Only a NEW
  // member consumes a seat; changing an existing member's role must not be
  // refused just because the workspace is full.
  if (!currentRole) {
    const seatDenial = seatLimitDenial(
      // Effective plan, matching the seat check in members-routes.ts: an
      // operator comp must lift the cap on both paths or on neither.
      effectivePlan(found.account),
      (await listMembers(c.env, id)).length
    );
    if (seatDenial) return c.json({ error: "forbidden", detail: seatDenial }, 403);
  }

  await upsertMember(c.env, {
    accountId: id,
    email,
    role: nextRole as AccountRole,
    invitedBy: c.get("email"),
    now: new Date().toISOString(),
  });
  return c.json({
    account: toPublicAccount(found.account, found.ctx.roles.get(id) ?? null),
    members: (await listMembers(c.env, id)).map(toPublicMember),
  });
});

/**
 * Remove somebody from a workspace. Their identity, their artifacts and their
 * other memberships are untouched — this only ends their reach into this one
 * account. The account's last owner cannot be removed.
 */
api.delete("/accounts/:id/members/:email", async (c) => {
  const id = c.req.param("id");
  const found = await readableAccount(c, id);
  if (!found) return c.json({ error: "not_found" }, 404);
  if (!canManageMembers(c.get("identity"), found.ctx.roles, id)) {
    return c.json({ error: "forbidden", detail: "you cannot manage members of this workspace" }, 403);
  }
  const email = normalizeEmail(c.req.param("email"));
  if (!email) return c.json({ error: "bad_request", detail: "valid email required" }, 400);

  const current = await memberRole(c.env, id, email);
  if (!current) return c.json({ error: "not_found" }, 404);
  const denial = memberChangeDenial(c.get("identity"), found.ctx.roles.get(id) ?? null, {
    targetCurrentRole: current,
    nextRole: null,
    ownerCount: await ownerCount(c.env, id),
  });
  if (denial) return c.json({ error: "forbidden", detail: denial }, 403);

  await removeMember(c.env, id, email);
  return c.json({
    account: toPublicAccount(found.account, found.ctx.roles.get(id) ?? null),
    members: (await listMembers(c.env, id)).map(toPublicMember),
  });
});

artifactRoutes.get("/artifacts/:slug/versions", requireScope("read"), async (c) => {
  const slug = c.req.param("slug");
  const art = await manageableArtifact(c, slug);
  if (!art) return c.json({ error: "not_found" }, 404);
  const rows = await listVersions(c.env, slug);
  return c.json({
    current: art.current_version,
    url: artifactUrl(c, slug),
    // `expired` is surfaced rather than the raw timestamp because that is the
    // only thing a caller can act on: an expired version cannot be rolled back
    // to. Showing it identically to a live one would invite exactly that.
    versions: rows.map((v) => ({ ...v, expired: !!v.expired_at })),
  });
});

artifactRoutes.get("/artifacts/:slug/views", requireScope("read"), async (c) => {
  const slug = c.req.param("slug");
  const art = await manageableArtifact(c, slug);
  if (!art) return c.json({ error: "not_found" }, 404);
  const raw = Number(c.req.query("limit"));
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 200) : 50;
  return c.json(await getViews(c.env, slug, limit));
});

// Rollback: pointing a slug at an existing version is a publish operation —
// it changes what the world sees — so it rides on the `publish` scope.
artifactRoutes.post("/artifacts/:slug/current", requireScope("publish"), async (c) => {
  const slug = c.req.param("slug");
  const art = await manageableArtifact(c, slug);
  if (!art) return c.json({ error: "not_found" }, 404);
  // Rollback changes what the world sees, so it is a publish for the purposes
  // of suspension too. Delete and access changes deliberately still work: a
  // suspended workspace must be able to take its own content down and stop
  // sharing it, which is the opposite of the thing suspension guards against.
  const suspended = await suspendedDenial(c, art.account_id ?? null);
  if (suspended) return suspended;
  const body = await c.req.json().catch(() => null);
  const version = Number(body?.version);
  if (!Number.isInteger(version) || version < 1) {
    return c.json({ error: "bad_request", detail: "version must be a positive integer" }, 400);
  }
  const rolled = await rollbackArtifact(c.env, slug, version);
  if (!rolled.ok) return c.json({ error: rolled.error, detail: rolled.detail }, rolled.status as 404 | 409);
  return c.json({ slug, current: version, url: artifactUrl(c, slug) });
});

artifactRoutes.get("/artifacts/:slug/access", requireScope("read"), async (c) => {
  const slug = c.req.param("slug");
  const art = await manageableArtifact(c, slug);
  if (!art) return c.json({ error: "not_found" }, 404);
  return c.json({ visibility: art.visibility, emails: await listGrants(c.env, slug) });
});

artifactRoutes.put("/artifacts/:slug/access", requireScope("manage"), async (c) => {
  const slug = c.req.param("slug");
  const art = await manageableArtifact(c, slug);
  if (!art) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json().catch(() => null);
  const parsed = normalizeAccessInput({ visibility: body?.visibility, emails: body?.emails });
  if ("error" in parsed) return c.json({ error: "bad_request", detail: parsed.error }, 400);
  const { visibility, emails } = parsed;

  await setAccess(c.env, slug, visibility, emails, new Date().toISOString());

  // Granting an artifact never grants a login: sign-in is invite-only and stays
  // an admin action through /api/users, so an owner sharing their own artifact
  // cannot widen who reaches the instance. Their grants still apply; the
  // recipient just needs an admin to invite them first.
  return c.json({ slug, visibility, emails: await listGrants(c.env, slug) });
});

artifactRoutes.delete("/artifacts/:slug", requireScope("manage"), async (c) => {
  const slug = c.req.param("slug");
  const existing = await manageableArtifact(c, slug);
  if (!existing) return c.json({ error: "not_found" }, 404);
  // The counts are additive on this route (it has always answered `deleted`),
  // and load-bearing on the MCP `delete_artifact` tool, which has to be able to
  // say what actually went.
  const removed = await purgeArtifact(c.env, slug);
  return c.json({ deleted: slug, ...removed });
});

// --- Where the artifact routes are mounted ----------------------------------
//
// Twice, from the single definition above.
//
// 1. `/api/artifacts…` — the dashboard's own surface, gated by `requireUser`:
//    an app-owned `rtfx_session` or a bearer token, whichever the caller has.
//
// 2. `/api/machine/artifacts…` — the same routes, gated by `requireApiToken`
//    (registered near the top of this file, before the general one) instead of
//    `requireUser`. A bearer `rtfx_…` token is the *only* credential accepted
//    there and a browser session is refused, so a machine caller needs nothing
//    but the scoped token it minted at /admin/integrations, and the surface
//    cannot be driven by a victim's cookies from another site.
//
//    A legacy/self-hosted instance that still gates every path at the edge is
//    the one place this needs configuration: that path has to be let through
//    (an Access Bypass policy, docs/DEPLOY_RTFX.md §5f) or every machine caller
//    also needs Cloudflare service-token credentials — per-deployment secrets
//    an operator cannot hand out per user, and which grant edge entry rather
//    than product identity. rtfx.pro has no such gate.
//
// Nothing else is mounted there. User management, token issuance and workspace
// membership stay on `/api` alone: they are the routes that hand out
// credentials, they already refuse API tokens outright (`denyApiToken`), and
// there is no reason for the un-gated surface to answer for them at all.
api.route("/", artifactRoutes);
api.route("/machine", artifactRoutes);

/**
 * Anything else under `/api/machine` is not a route. Answered here — after the
 * mount above — as JSON with an explicit code, rather than falling through to
 * the framework's plain-text 404: a client can then tell "this server has no
 * such machine route" (an older deployment) from "that artifact isn't yours"
 * (`{"error":"not_found"}` from a real handler), and fall back accordingly.
 */
const noMachineRoute = (c: Context<Vars>) =>
  c.json({ error: "not_found", detail: "no such machine API route" }, 404);
api.all("/machine", noMachineRoute);
api.all("/machine/*", noMachineRoute);

/** Delete every R2 object under `<slug>/`, reporting how many bytes went. */
async function deletePrefix(env: Env, slug: string): Promise<{ files: number; bytes: number }> {
  const prefix = `${slug}/`;
  let cursor: string | undefined;
  let files = 0;
  let bytes = 0;
  do {
    const listed = await env.FILES.list({ prefix, cursor });
    if (listed.objects.length > 0) {
      files += listed.objects.length;
      for (const o of listed.objects) bytes += o.size ?? 0;
      await env.FILES.delete(listed.objects.map((o) => o.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return { files, bytes };
}

/**
 * Delete one artifact completely: its stored bytes, then every row that
 * referenced it (`deleteArtifactRow` covers grants, versions, views and share
 * links in one batch).
 *
 * The order matters and is the order the REST route has always used — bytes
 * first, rows second. A failure between the two leaves rows pointing at objects
 * that are gone, which serves 404s; the reverse leaves orphaned bytes that
 * nothing can ever reach or bill correctly.
 *
 * Returns what went, because the MCP `delete_artifact` tool has to report a
 * cleanup summary and counting it a second time after the fact is impossible.
 */
export async function purgeArtifact(
  env: Env,
  slug: string
): Promise<{ versions: number; files: number; bytes: number }> {
  const versions = (await listVersions(env, slug)).length;
  const removed = await deletePrefix(env, slug);
  await deleteArtifactRow(env, slug);
  return { versions, ...removed };
}

/**
 * Point a slug at an existing version, or say why not.
 *
 * Shared by `POST /artifacts/:slug/current` and the remote MCP
 * `rollback_artifact` tool. Authorization and suspension are the caller's job —
 * this is only the "does that version exist, and is it still serviceable?"
 * half, which is the part that would otherwise be restated.
 */
export async function rollbackArtifact(
  env: Env,
  slug: string,
  version: number
): Promise<
  | { ok: true; current: number }
  | { ok: false; error: "version_expired" | "not_found"; detail: string; status: 409 | 404 }
> {
  // An expired version still has a history row but no bytes, so rolling back to
  // it would leave the artifact serving nothing. Refused explicitly rather than
  // 404 — "that version has expired" is actionable, "not found" is confusing
  // when the version list plainly shows it.
  const target = await getVersion(env, slug, version);
  if (target?.expired_at) {
    return {
      ok: false,
      error: "version_expired",
      detail: `version ${version} is outside this plan's retention window and its files are gone`,
      status: 409,
    };
  }
  const ok = await setCurrentVersion(env, slug, version, new Date().toISOString());
  if (!ok) {
    return { ok: false, error: "not_found", detail: `version ${version} does not exist`, status: 404 };
  }
  return { ok: true, current: version };
}

/**
 * Validate and normalize an access change, in one place.
 *
 * `PUT /artifacts/:slug/access` and the remote MCP `share_artifact` tool both
 * run this, so "what counts as an email" and "what visibility values exist"
 * cannot come to mean two different things on two transports. Deliberately
 * pure: no database, no context, so it is directly testable and cannot be the
 * thing that decides *whether* the caller may do it.
 *
 * Emails are lowercased and de-duplicated. Nobody is invited and no directory
 * entry is created — a grant is a grant, and widening who may sign in stays an
 * admin action (see the note on the route).
 */
export function normalizeAccessInput(input: {
  visibility: unknown;
  emails?: unknown;
}): { visibility: "restricted" | "everyone"; emails: string[] } | { error: string } {
  const { visibility } = input;
  if (visibility !== "restricted" && visibility !== "everyone") {
    return { error: "visibility must be 'restricted' or 'everyone'" };
  }
  const rawEmails: unknown = input.emails ?? [];
  if (!Array.isArray(rawEmails) || rawEmails.some((e) => typeof e !== "string")) {
    return { error: "emails must be an array of strings" };
  }
  const emails = [
    ...new Set((rawEmails as string[]).map((e) => e.trim().toLowerCase()).filter(Boolean)),
  ];
  if (emails.some((e) => !e.includes("@"))) {
    return { error: "each email must contain '@'" };
  }
  return { visibility, emails };
}
