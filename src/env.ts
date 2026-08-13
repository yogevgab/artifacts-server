/** Hono generics shared across the app (bindings + per-request variables). */
export type AppBindings = { Bindings: Env; Variables: { email: string } };

export interface Env {
  FILES: R2Bucket;
  DB: D1Database;
  /** Comma-separated list of admin emails allowed to publish/delete. */
  ADMIN_EMAILS: string;
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
  type: "single" | "bundle";
  entry: string;
  file_count: number;
  size_bytes: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  visibility: Visibility;
  current_version: number;
  /**
   * Email of the beta user who owns this artifact — the only non-admin who may
   * manage it. NULL means nobody but an admin can manage it (legacy rows, and
   * anything published by a service token, which has no email).
   */
  owner_email: string | null;
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
  type: "single" | "bundle";
  entry: string;
  file_count: number;
  size_bytes: number;
  note: string | null;
  created_by: string | null;
  created_at: string;
}
