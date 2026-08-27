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
  /** Per-artifact chat rooms. Optional so dev and tests run without it. */
  CHAT?: DurableObjectNamespace;
  /**
   * Secret (>= 32 bytes) signing app-owned session cookies. Set with
   * `wrangler secret put SESSION_SECRET`. Required in production: sign-in is
   * app-owned, so with no secret no session is ever honoured and nobody can sign
   * in. Absent, requests are not failed outright — they simply resolve no session
   * identity, which is what keeps a legacy/self-host edge-gated instance working.
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
  /**
   * Legacy/self-host only: Cloudflare Access team domain, e.g.
   * "myteam.cloudflareaccess.com". Empty on rtfx.pro and in dev.
   */
  ACCESS_TEAM_DOMAIN: string;
  /** Legacy/self-host only: Cloudflare Access application AUD tag. Empty in dev. */
  ACCESS_AUD: string;
  /** "true" only in local dev/tests: skips sign-in and treats the caller as admin. */
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


  // --- Lemon Squeezy billing (src/billing.ts, src/billing-routes.ts). All
  //     optional so dev and tests run without a Lemon Squeezy store configured
  //     at all — see PLANS in quota.ts for what an account gets on each plan. ---
  /**
   * Signing secret for the Lemon Squeezy webhook (Settings → Webhooks in the
   * Lemon Squeezy dashboard). SECRET — set with `wrangler secret put
   * LEMONSQUEEZY_WEBHOOK_SECRET`, never as a plain var. This is the entire
   * authorization boundary for POST /api/billing/webhook: that route is
   * reachable with no session or API token, so an unset secret means the route
   * refuses every request rather than trusting an unverifiable body.
   */
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
  /**
   * The store's subdomain (e.g. "my-store" for my-store.lemonsqueezy.com), used
   * to build hosted checkout URLs. Despite the name, this is the subdomain
   * slug, not the numeric store id the Lemon Squeezy API also calls
   * `store_id` — the hosted checkout URL only ever addresses a store by its
   * subdomain. Plain var.
   */
  LEMONSQUEEZY_STORE_ID?: string;
  /** Variant id for the `pro` plan (Lemon Squeezy product → variant). Plain var. */
  LEMONSQUEEZY_VARIANT_PRO?: string;
  /** Variant id for the `team` plan. Plain var. */
  LEMONSQUEEZY_VARIANT_TEAM?: string;
  /**
   * Variant id for the store's free tier, if it sells one. Needed so a
   * downgrade to it writes `free` rather than resolving to null and leaving
   * the customer on the plan they just left. Plain var.
   */
  LEMONSQUEEZY_VARIANT_FREE?: string;

  // --- PostHog: session recording and error tracking, dashboard only ---
  //     See src/posthog.ts. Both optional; unset means the feature does not
  //     exist for this deployment — no script, no cookie, no consent banner,
  //     nothing different from before it existed. Self-hosted operators who
  //     never set POSTHOG_KEY get exactly today's behavior.
  /** PostHog project API key. Unset disables the feature entirely — see src/posthog.ts. */
  POSTHOG_KEY?: string;
  /** PostHog ingestion host, e.g. "https://us.i.posthog.com" or a self-hosted origin. Defaults to PostHog Cloud (US) when POSTHOG_KEY is set but this isn't. */
  POSTHOG_HOST?: string;
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
  /**
   * Read receipts (migration 0016): 1 (default) sends the owner a one-time
   * email the first time each person opens this artifact; 0 turns it off.
   * Optional/nullable so a row read before the migration ran (or in a test
   * fixture that predates it) is treated as the default — see
   * `readReceiptsEnabled` in src/db.ts, which is the only place that should
   * ever interpret this column.
   */
  read_receipts?: number | null;
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
  /** Set when the version fell outside the plan's retention window and its bytes were removed. */
  expired_at?: string | null;
}
