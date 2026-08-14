/** Hono generics shared across the app (bindings + per-request variables). */
export type AppBindings = { Bindings: Env; Variables: { email: string } };

export interface Env {
  FILES: R2Bucket;
  DB: D1Database;
  /**
   * Cloudflare Email Sending. Restricted in wrangler.jsonc to the single
   * `no-reply@rtfx.pro` sender: this Worker also serves user-uploaded HTML from
   * the content host, so capping what it can ever send From limits the blast
   * radius of any future bug. Optional so dev and tests run without it.
   */
  EMAIL?: { send(message: unknown): Promise<{ messageId?: string }> };
  /** Envelope sender for transactional mail. Defaults to "no-reply@rtfx.pro". */
  MAIL_FROM?: string;
  /**
   * Secret (>= 32 bytes) signing app-owned session cookies. Set with
   * `wrangler secret put SESSION_SECRET`. Absent means app sessions are simply
   * not honoured — during the Cloudflare Access migration that degrades to the
   * previous behaviour rather than failing the request.
   */
  SESSION_SECRET?: string;
  /** Comma-separated list of admin emails allowed to publish/delete. */
  ADMIN_EMAILS: string;
  /**
   * Comma-separated super-admin (operator/owner) emails. A super admin is an
   * admin who additionally may manage other admins, and who can never be
   * disabled or removed from rtfx.pro — the anti-lockout invariant. Defaults to
   * the first `ADMIN_EMAILS` entry when unset, so every deployment has one.
   */
  SUPER_ADMIN_EMAILS?: string;
  /** Comma-separated service-token common_names (client ids) with admin rights. */
  ADMIN_SERVICE_TOKENS?: string;
  /** Cloudflare Access team domain, e.g. "myteam.cloudflareaccess.com". Empty in dev. */
  ACCESS_TEAM_DOMAIN: string;
  /** Cloudflare Access application AUD tag. Empty in dev. */
  ACCESS_AUD: string;
  /** "true" only in local dev/tests: bypasses Access and treats caller as admin. */
  DEV_LOGIN?: string;
  /**
   * Comma-separated hostnames (e.g. "a.rtfx.pro" or "a.rtfx.pro,a-staging.rtfx.pro")
   * that serve artifact content ONLY — no /admin, /api, /whoami, /health, /v,
   * /waitlist, /gallery, or "/".
   * Leave unset to keep everything on a single origin (current behavior).
   */
  CONTENT_HOSTNAMES?: string;
  /**
   * Canonical public origin of the app host, e.g. "https://rtfx.pro". Used for
   * canonical links, OpenGraph URLs, sitemap.xml and llms.txt. Defaults to
   * `SITE.origin` (src/seo.ts); set it when deploying under another domain so a
   * preview/staging host never competes with production in a search index.
   */
  PUBLIC_BASE_URL?: string;
  /**
   * Comma-separated *extra* origins ("https://ops.example.com") the dashboard
   * may be served from, for the browser CORS policy on `/api` (issue #37). Almost
   * nobody needs this: the origin a request arrives on and `PUBLIC_BASE_URL` are
   * both trusted automatically, which covers the single-origin and preview cases.
   * A content host listed here is ignored — see `appOrigins` in src/cors.ts.
   */
  APP_ORIGINS?: string;

  // --- User management: the app reads/writes the Cloudflare Access viewer
  //     policy directly, so Cloudflare Access is the source of truth for the
  //     login allow-list. All optional so dev/tests run without CF access. ---
  /** Cloudflare API token (secret) with Access: Apps and Policies — Edit. */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  /** The viewer Access application id and its human (email) policy id. */
  ACCESS_VIEWER_APP_ID?: string;
  ACCESS_VIEWER_POLICY_ID?: string;
}

export type Visibility = "restricted" | "everyone";

export interface ArtifactRow {
  slug: string;
  title: string;
  description: string | null;
  /** "pdf" is a single document rather than a site; see src/upload.ts. */
  type: "single" | "bundle" | "pdf";
  entry: string;
  file_count: number;
  size_bytes: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  visibility: Visibility;
  current_version: number;
  /**
   * Email of the member who owns this artifact — the only non-admin who may
   * manage it. NULL means nobody but an admin can manage it (legacy rows, and
   * anything published by a service token, which has no email).
   *
   * Retained as the primary authorization key even after #27: `account_id` is
   * additive, and a row that only has `owner_email` behaves exactly as it always
   * has. See `canManage` in src/authz.ts.
   */
  owner_email: string | null;
  /**
   * The account/workspace that owns this artifact (issue #27). NULL on legacy
   * rows that migration 0010 has not adopted, and on anything published before
   * the publisher had an account — those stay on the `owner_email` path.
   */
  account_id?: string | null;
}

export interface ViewRow {
  slug: string;
  version: number;
  email: string | null;
  path: string | null;
  country: string | null;
  referrer: string | null;
  viewed_at: string;
}

export interface VersionRow {
  slug: string;
  version: number;
  /** "pdf" is a single document rather than a site; see src/upload.ts. */
  type: "single" | "bundle" | "pdf";
  entry: string;
  file_count: number;
  size_bytes: number;
  note: string | null;
  created_by: string | null;
  created_at: string;
}
