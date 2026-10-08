/**
 * Browser/CLI upload for the remote MCP `create_upload_link` tool.
 *
 *   GET     /u/:token              the drop page a person opens
 *   POST    /api/uploads/:token    where the files actually go
 *   OPTIONS /api/uploads/:token    CORS preflight
 *
 * The token in the path is the whole credential: no cookie, no bearer, hence no
 * CSRF surface (a forged cross-site request would need a token the attacker was
 * never given) and `Access-Control-Allow-Origin: *` is safe. What the token
 * grants is narrow — one upload, to the one slug the creator was already allowed
 * to publish to, within 30 minutes — and everything past "who is this?" is the
 * same code REST publish runs (`resolvePublishTarget` / `storeUpload`), run as
 * the person who created the link: same screening, size cap, plan quota and
 * suspension rules.
 *
 * Mounted BEFORE `/api` in src/index.ts, because that router installs
 * `requireUser` across `/api/*`.
 */

import { Hono, type Context } from "hono";
import type { Env } from "./env";
import type { AuthVars, Identity } from "./auth";
import { clientAddress, incrementRateLimitBucket } from "./rate-limit";
import { getArtifact } from "./db";
import { getUser, isDisabled } from "./users";
import {
  MAX_UPLOAD_BYTES,
  MissingIndexError,
  UPLOAD_FILE_LIMITS,
  UploadError,
  normalizeEntryPath,
  processFiles,
  processZip,
  singleHtml,
  singlePdf,
  sniffKind,
  stripSingleTopDir,
  type ProcessedUpload,
  type UploadFile,
} from "./upload";
import { PayloadTooLargeError, artifactUrl, limitBodyBytes, resolvePublishTarget, storeUpload } from "./api";
import { claimUploadSession, lookupUploadSession, releaseUploadSession, type UploadSessionRow } from "./upload-sessions";
import { uploadGonePage, uploadPage } from "./upload-page";

type Vars = { Bindings: Env; Variables: AuthVars };

export const uploadRoutes = new Hono<Vars>();

/** Per IP, per hour. A real person needs a handful; a guesser gets nowhere against 256-bit tokens anyway. */
const UPLOADS_PER_HOUR = 60;

// Multipart framing overhead on top of the file bytes.
const MAX_BODY_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;

const TOO_BIG = `That is too big. The limit is ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB.`;
const NO_INDEX =
  "We couldn't find index.html — drop the whole site folder (the one that contains index.html), or a .zip of it.";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** Files the OS adds to a folder that nobody meant to publish. Dropped quietly, unlike a `.env`. */
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|(^|\/)__MACOSX(\/|$)/;

type FailStatus = 400 | 403 | 404 | 409 | 410 | 413 | 429 | 500;

function fail(c: Context<Vars>, status: FailStatus, error: string, detail: string) {
  return c.json({ error, detail }, status, CORS);
}

uploadRoutes.options("/api/uploads/:token", (c) => c.body(null, 204, CORS));

// --- GET /u/:token: the page --------------------------------------------------

uploadRoutes.get("/u/:token", async (c) => {
  // The token is in the URL: keep it out of Referer headers, caches and indexes.
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
  const token = c.req.param("token");
  const found = await lookupUploadSession(c.env, token);
  if (found.state === "unknown") return c.html(uploadGonePage("unknown"), 404, headers);
  if (found.state !== "ok") return c.html(uploadGonePage(found.state), 410, headers);

  const { session } = found;
  const existing = await getArtifact(c.env, session.slug);
  return c.html(
    uploadPage({
      token,
      title: session.title,
      destination: artifactUrl(c, session.slug),
      isUpdate: !!existing,
      expiresAt: session.expires_at,
    }),
    200,
    headers
  );
});

// --- POST /api/uploads/:token: the bytes --------------------------------------

/** The identity the link's creator had when they made it, pinned to the workspace they chose. */
function identityFor(session: UploadSessionRow): Identity {
  const admin = session.is_admin === 1;
  return {
    email: session.email.toLowerCase(),
    commonName: null,
    isAdmin: admin,
    role: admin ? "admin" : "member",
    // Shaped like a token identity on purpose: `accountsFor` then pins the
    // request to the session's workspace and ignores any workspace cookie.
    token: { id: `upload:${session.id}`, scopes: ["publish"] },
    accountId: session.account_id,
  };
}

const ZIP_TYPES = ["application/zip", "application/x-zip-compressed", "application/x-zip", "application/octet-stream"];

/** One loose file set (a dropped folder, several files, or a lone zip/page) as a bundle. */
function fromLooseFiles(raw: UploadFile[]): ProcessedUpload {
  if (raw.length === 0) throw new UploadError("No files arrived. Drop a .zip, a folder, or your site's files.");
  if (raw.length === 1) {
    const kind = sniffKind(raw[0].path, raw[0].bytes);
    if (kind === "zip") return processZip(raw[0].bytes);
    if (kind === "pdf") return singlePdf(raw[0].bytes);
    if (/\.html?$/i.test(raw[0].path) && !raw[0].path.includes("/")) return singleHtml(raw[0].bytes);
  }
  // Normalise first so the common-directory check sees the same paths the
  // validator will, then drop the folder's own name.
  const normalised = raw.map((f) => {
    const path = normalizeEntryPath(f.path);
    if (path === null) {
      throw new UploadError(`That folder contains a file name we can't accept: "${f.path.slice(0, 120)}"`);
    }
    return { path, bytes: f.bytes };
  });
  return processFiles(stripSingleTopDir(normalised), UPLOAD_FILE_LIMITS);
}

/** Turn whatever arrived into a bundle, or throw {@link UploadError} / {@link PayloadTooLargeError}. */
async function bundleFromRequest(c: Context<Vars>): Promise<ProcessedUpload> {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  const body = c.req.raw.body;
  if (!body) throw new UploadError("No files arrived. Drop a .zip, a folder, or your site's files.");

  if (type.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await new Request(c.req.raw, { body: limitBodyBytes(body, MAX_BODY_BYTES) } as RequestInit).formData();
    } catch (e) {
      if (e instanceof PayloadTooLargeError) throw e;
      throw new UploadError("We couldn't read that upload. Please try again.");
    }

    const bundle = form.get("bundle");
    if (bundle instanceof File && bundle.size > 0) {
      if (bundle.size > MAX_UPLOAD_BYTES) throw new PayloadTooLargeError("too large");
      return processZip(new Uint8Array(await bundle.arrayBuffer()));
    }

    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    // Paths: a parallel `path` field per file is authoritative (a multipart
    // filename may lose its directory); otherwise the filename itself.
    const paths = form.getAll("path").map((p) => String(p));
    const useFields = paths.length === files.length;
    const raw: UploadFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const path = (useFields ? paths[i] : files[i].name).replace(/^(\.\/)+/, "");
      if (JUNK.test(path)) continue;
      raw.push({ path, bytes: new Uint8Array(await files[i].arrayBuffer()) });
    }
    return fromLooseFiles(raw);
  }

  if (ZIP_TYPES.some((t) => type.startsWith(t))) {
    const bytes = new Uint8Array(await new Response(limitBodyBytes(body, MAX_BODY_BYTES)).arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new PayloadTooLargeError("too large");
    if (sniffKind("", bytes) !== "zip") throw new UploadError("That doesn't look like a .zip file.");
    return processZip(bytes);
  }

  throw new UploadError("Send a .zip (as the request body or a `bundle` field) or the site's files as multipart.");
}

uploadRoutes.post("/api/uploads/:token", async (c) => {
  const token = c.req.param("token");

  if (!(await incrementRateLimitBucket(c as any, `upload:${clientAddress(c as any)}`, UPLOADS_PER_HOUR))) {
    return fail(c, 429, "rate_limited", "Too many uploads from your connection. Please wait a little and try again.");
  }

  const found = await lookupUploadSession(c.env, token);
  if (found.state === "unknown") return fail(c, 404, "not_found", "This upload link isn't valid.");
  if (found.state === "expired") return fail(c, 410, "expired", "This link has expired — ask Claude for a new one.");
  if (found.state === "used") return fail(c, 410, "used", "This link was already used — ask Claude for a new one.");
  const { session } = found;

  // Declared size first: refuse before buffering anything. Not the guarantee —
  // `limitBodyBytes` is — just a cheap early exit.
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(c, 413, "payload_too_large", TOO_BIG);

  // Act as the person who made the link — and only while they are still allowed in.
  const identity = identityFor(session);
  if (isDisabled(c.env, identity.email, await getUser(c.env, identity.email!))) {
    return fail(c, 403, "forbidden", "This account is paused, so it can't publish.");
  }
  c.set("identity", identity);
  c.set("email", identity.email!);

  // Is the destination still publishable by them? Somebody else may have taken
  // the slug since the link was made. Checked before reading the body.
  const target = await resolvePublishTarget(c, { slug: session.slug, title: session.title });
  if (target instanceof Response) {
    const body = (await target.json().catch(() => ({}))) as { error?: string; detail?: string };
    return fail(c, target.status === 409 ? 409 : 400, body.error ?? "bad_request", body.detail ?? "That address can't be used.");
  }

  let processed: ProcessedUpload;
  try {
    processed = await bundleFromRequest(c);
  } catch (e) {
    if (e instanceof PayloadTooLargeError) return fail(c, 413, "payload_too_large", TOO_BIG);
    if (e instanceof MissingIndexError) return fail(c, 400, "no_index", NO_INDEX);
    if (e instanceof UploadError) return fail(c, 400, "bad_request", e.message);
    return fail(c, 400, "bad_request", "We couldn't read that upload. Please try again.");
  }

  // Claim the link now, so two racing uploads can't both publish; hand it back
  // if this one doesn't make it, so a refusal doesn't cost the person their link.
  if (!(await claimUploadSession(c.env, session.id))) {
    return fail(c, 410, "used", "This link was already used — ask Claude for a new one.");
  }

  let res: Response;
  try {
    res = await storeUpload(c, target, processed, {
      title: session.title,
      description: session.description ?? undefined,
      note: session.note ?? undefined,
    });
  } catch (e) {
    await releaseUploadSession(c.env, session.id);
    throw e;
  }
  if (!res.ok) {
    await releaseUploadSession(c.env, session.id);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json(body, res.status as 403 | 413 | 500, CORS);
  }
  return c.json((await res.json()) as Record<string, unknown>, 200, CORS);
});
