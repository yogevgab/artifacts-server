import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./env";
import { canUseDashboard, hasScope } from "./authz";
import { verifySession } from "./session";
import { resolveAccountContext, type AccountContext } from "./accounts";
import {
  findApiToken,
  isTokenUsable,
  needsTouch,
  rowScopes,
  tokenId,
  touchApiToken,
  type Scope,
} from "./tokens";
import { accountPausedPage } from "./login";
import {
  configuredRole,
  effectiveRole,
  getUser,
  isDisabled,
  needsSeenTouch,
  touchLastSeen,
  type UserRole,
} from "./users";

// Cache one JWKS resolver per team domain across requests in the isolate.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(teamDomain: string) {
  let set = jwksCache.get(teamDomain);
  if (!set) {
    set = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, set);
  }
  return set;
}


function isCanonicalProductionRequest(env: Env, url?: string): boolean {
  if (!url) return false;
  const origin = (env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!origin || /localhost|127\.0\.0\.1|\.local$/i.test(origin)) return false;
  try {
    return new URL(origin).hostname.toLowerCase() === new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
}

function adminList(env: Env): string[] {
  return env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function adminServiceTokens(env: Env): string[] {
  return (env.ADMIN_SERVICE_TOKENS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether an identity has admin rights: an email in ADMIN_EMAILS or
 * SUPER_ADMIN_EMAILS, OR a service token whose common_name is explicitly
 * allow-listed in ADMIN_SERVICE_TOKENS. A service token that merely satisfies
 * some Access policy is NOT admin unless listed here — so a lower-privilege
 * (e.g. monitoring) token is not admin.
 */
export function resolveIsAdmin(
  env: Env,
  email: string | null,
  commonName: string | null
): boolean {
  const byEmail = email ? isAdmin(env, email) : false;
  const byToken = commonName ? adminServiceTokens(env).includes(commonName.toLowerCase()) : false;
  return byEmail || byToken;
}

/**
 * The role for an Access-authenticated caller. A human gets their configured
 * role; an admin service token is an `admin` and never an operator, because it
 * cannot be an interactive login.
 */
function accessRole(env: Env, email: string | null, commonName: string | null): UserRole {
  if (email) return effectiveRole(env, email);
  return commonName && adminServiceTokens(env).includes(commonName.toLowerCase())
    ? "admin"
    : "member";
}

export interface AccessIdentity {
  /** Email claim (human logins via one-time PIN / SSO). */
  email: string | null;
  /** common_name claim (service-token logins, e.g. the CLI). */
  commonName: string | null;
}

/**
 * Verify the Cloudflare Access JWT and return the caller's identity, or null.
 * Only issued/valid for the configured application AUD. Returns null when Access
 * is not configured (ACCESS_AUD empty) or the token is missing/invalid.
 */
async function verifyAccess(c: {
  env: Env;
  req: { header(name: string): string | undefined };
}): Promise<AccessIdentity | null> {
  const env = c.env;
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  // ACCESS_AUD may list multiple application AUDs (viewer,admin); accept any.
  const auds = env.ACCESS_AUD.split(",").map((a) => a.trim()).filter(Boolean);
  const token =
    c.req.header("Cf-Access-Jwt-Assertion") ||
    getCookie(c.req.header("Cookie"), "CF_Authorization");
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, jwks(env.ACCESS_TEAM_DOMAIN), {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: auds,
    });
    const p = payload as { email?: string; common_name?: string };
    return {
      email: p.email ? p.email.toLowerCase() : null,
      commonName: p.common_name ?? null,
    };
  } catch {
    return null;
  }
}

export interface Identity {
  /** Authenticated email, or null for a service-token caller. */
  email: string | null;
  /** Service-token common_name (client id), or null for a human. */
  commonName: string | null;
  /** True for admins: email in ADMIN_EMAILS/SUPER_ADMIN_EMAILS or an allow-listed service token. */
  isAdmin: boolean;
  /**
   * Effective role for this *request*. Derived from configuration, never from
   * the users table. Capped at `admin` for any non-interactive caller (API
   * token, Access service token): super-admin actions — managing another admin —
   * always require an interactive login, so a leaked credential can never reach
   * them. See `userActionDenial` in authz.ts.
   */
  role: UserRole;
  /**
   * Set only when the caller authenticated with an API token (`Authorization:
   * Bearer`). Absent/null means an Access-authenticated caller, who holds every
   * scope. See `hasScope` in authz.ts.
   */
  token?: { id: string; scopes: Scope[] } | null;
  /**
   * The account/workspace this request is pinned to (issue #27), read straight
   * off the API token's row — so it costs no extra query. Null for an
   * Access-authenticated human, whose workspaces are resolved on demand by
   * `resolveAccountContext` (src/accounts.ts) only on the surfaces that need
   * them. Account membership never confers platform authority: `isAdmin` and
   * `role` above stay config-derived.
   */
  accountId?: string | null;
  /**
   * How this caller signed in, once the app owns identity (see
   * docs/superpowers/specs/2026-08-14-app-owned-identity-design.md §5).
   *
   * - `"member"` — signed up or was invited; has a `users` row.
   * - `"guest"` — holds only `artifact_grants`; reaches granted content and
   *   nothing else. Never sees the dashboard.
   *
   * Absent means an Access-authenticated human or an API token, i.e. every
   * pre-existing caller, all of whom are members. Only our own session code
   * ever mints `"guest"`, and it always sets this explicitly.
   */
  kind?: "member" | "guest";
}

/** Minimal request shape the auth helpers need (a Hono context satisfies it). */
type AuthContext = {
  env: Env;
  req: { header(name: string): string | undefined; url?: string };
};

/** The credential from an `Authorization: Bearer <token>` header, if present. */
export function bearerToken(c: AuthContext): string | null {
  const raw = c.req.header("Authorization") ?? c.req.header("authorization");
  if (!raw) return null;
  const m = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim());
  return m ? m[1] : null;
}

/**
 * Resolve an API token into an identity, or null if it is unknown, revoked or
 * expired. The token's own owner/admin fields decide what it can reach, so a
 * token is never more privileged than the person it was issued for.
 */
async function identityFromApiToken(c: AuthContext, presented: string): Promise<Identity | null> {
  if (!c.env.DB) return null;
  // Shape check before the lookup. Every token this app has ever minted reads
  // `rtfx_<id>_<secret>` (see generateToken), so anything else cannot match a
  // stored hash — and refusing it here costs no database read. That matters on
  // the machine surface, which is reachable without Cloudflare Access in front
  // of it: a flood of junk credentials must not turn into a flood of D1 queries.
  if (tokenId(presented) === null) return null;
  let row;
  try {
    row = await findApiToken(c.env, presented);
  } catch {
    return null; // e.g. the table doesn't exist yet — fail closed, never fall back.
  }
  const now = new Date();
  if (!row || !isTokenUsable(row, now)) return null;
  // An admin token manages everything; a plain token acts as its owner. A row
  // with neither is inert by construction (the create endpoint rejects it), but
  // fail closed here too rather than minting a rights-less identity.
  const email = row.owner_email ? row.owner_email.toLowerCase() : null;
  const isAdminToken = row.is_admin === 1;
  if (!isAdminToken && !email) return null;

  if (needsTouch(row, now)) {
    const p = touchApiToken(c.env, row.id, now.toISOString());
    const ctx = executionCtx(c);
    if (ctx) ctx.waitUntil(p);
    else await p;
  }
  return {
    email,
    commonName: null,
    isAdmin: isAdminToken,
    // Capped at admin on purpose: a bearer credential is never the operator.
    role: isAdminToken ? "admin" : "member",
    token: { id: row.id, scopes: rowScopes(row) },
    // The workspace this credential was issued for. Legacy tokens have none and
    // stay on the owner_email path.
    accountId: row.account_id ?? null,
  };
}

function executionCtx(c: AuthContext): { waitUntil(p: Promise<unknown>): void } | undefined {
  try {
    return (c as { executionCtx?: { waitUntil(p: Promise<unknown>): void } }).executionCtx;
  } catch {
    return undefined;
  }
}

/** Outcome of authenticating a request. */
export interface AuthResult {
  identity: Identity | null;
  /** True when a bearer token was presented but is unknown/revoked/expired. */
  invalidToken: boolean;
  /**
   * True when the caller authenticated fine but their account is disabled in the
   * local directory. `identity` is null in that case — a disabled person is
   * nobody as far as authorization is concerned — but callers that render HTML
   * use this to explain *why* instead of showing a generic sign-in page.
   */
  disabled: boolean;
  /** Who was refused, so the HTML paused page can name them. Null otherwise. */
  disabledEmail: string | null;
}

const ANONYMOUS: AuthResult = {
  identity: null,
  invalidToken: false,
  disabled: false,
  disabledEmail: null,
};

function allowed(identity: Identity): AuthResult {
  return { identity, invalidToken: false, disabled: false, disabledEmail: null };
}

/**
 * Apply local directory state to an authenticated identity: refuse a disabled
 * account, and record presence for a human.
 *
 * This is the single choke point for `status`, which is why disabling somebody
 * works even when the Cloudflare Access allow-list write fails, and why it
 * applies to every surface at once — dashboard, API, *and* artifact viewing.
 *
 * `getUser` never throws (see users.ts): with no readable row nobody is
 * disabled. That is a deliberate fail-open on the *local* layer only — Access
 * is still the gate that decides who reaches the Worker — chosen so a D1 blip or
 * a not-yet-run migration can't lock every user, including the operator, out.
 */
async function applyDirectory(c: AuthContext, identity: Identity): Promise<AuthResult> {
  if (!identity.email) return allowed(identity);
  const row = await getUser(c.env, identity.email);
  if (isDisabled(c.env, identity.email, row)) {
    return {
      identity: null,
      invalidToken: false,
      disabled: true,
      disabledEmail: identity.email,
    };
  }
  // Presence is a human signal. A token caller's usage is already recorded on
  // the token itself (`last_used_at`), so it must not look like a sign-in.
  const now = new Date();
  if (!identity.token && needsSeenTouch(row, now)) {
    const p = touchLastSeen(c.env, identity.email, identity.role, now.toISOString());
    const ctx = executionCtx(c);
    if (ctx) ctx.waitUntil(p);
    else await p;
  }
  return allowed(identity);
}

/**
 * Authenticate a request. An `Authorization: Bearer` token wins when present —
 * and a bad one is an error, never a silent downgrade to the Access (or dev)
 * identity, so a caller can't be handed rights they didn't ask for. With no
 * bearer header the behavior is exactly as before: dev impersonation locally,
 * Cloudflare Access in production.
 *
 * Whichever path authenticated, the local user directory has the last word: a
 * disabled account resolves to no identity at all (see `applyDirectory`).
 *
 * Bearer auth does not bypass Cloudflare Access: Access still gates the
 * hostname/path at the edge. This is the second, app-layer check.
 */
/** The app-owned session cookie. Host-only on the app origin — never the content host. */
export const SESSION_COOKIE = "rtfx_session";

/** One cookie value out of a Cookie header, without pulling in a parser. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Identity from an app-owned session cookie, or null.
 *
 * A guest is never an admin, even when their address appears in ADMIN_EMAILS: a
 * guest session is a deliberately narrower credential than a sign-in, minted by
 * clicking a link in a shared artifact's invitation, and it must not silently
 * carry operator authority.
 */
async function identityFromSession(c: AuthContext): Promise<Identity | null> {
  const secret = c.env.SESSION_SECRET;
  if (!secret) return null;

  const raw = readCookie(c.req.header("Cookie") ?? c.req.header("cookie"), SESSION_COOKIE);
  if (!raw) return null;

  const claims = await verifySession(secret, raw, new Date().toISOString());
  if (!claims) return null;

  if (claims.kind === "guest") {
    return {
      email: claims.email,
      commonName: null,
      isAdmin: false,
      role: "member",
      token: null,
      kind: "guest",
    };
  }

  return {
    email: claims.email,
    commonName: null,
    isAdmin: isAdmin(c.env, claims.email),
    role: effectiveRole(c.env, claims.email),
    token: null,
    kind: "member",
  };
}

export async function resolveAuth(c: AuthContext): Promise<AuthResult> {
  const presented = bearerToken(c);
  if (presented !== null) {
    const identity = await identityFromApiToken(c, presented);
    if (!identity) {
      return { identity: null, invalidToken: true, disabled: false, disabledEmail: null };
    }
    return applyDirectory(c, identity);
  }
  const env = c.env;
  const session = await identityFromSession(c);
  if (session) return applyDirectory(c, session);

  if (env.DEV_LOGIN === "true" && !isCanonicalProductionRequest(env, c.req.url)) {
    if (c.req.header("X-Dev-Anonymous") === "true") return ANONYMOUS;
    const email = (c.req.header("X-Dev-Email") || adminList(env)[0] || "dev@local").toLowerCase();
    return applyDirectory(c, {
      email,
      commonName: null,
      isAdmin: isAdmin(env, email),
      role: effectiveRole(env, email),
      token: null,
    });
  }
  const id = await verifyAccess(c);
  if (!id) return ANONYMOUS;
  return applyDirectory(c, {
    email: id.email,
    commonName: id.commonName,
    isAdmin: resolveIsAdmin(env, id.email, id.commonName),
    role: accessRole(env, id.email, id.commonName),
    token: null,
  });
}

/**
 * Resolve the caller's identity for authorization: an API token (`Authorization:
 * Bearer`), else Cloudflare Access. In dev mode (DEV_LOGIN=true, local/tests
 * only) the `X-Dev-Email` header impersonates a viewer for testing; absent, the
 * first admin email is used. `X-Dev-Anonymous: true` simulates an
 * unauthenticated caller (for testing the public landing page / reserved-route
 * redirects) since DEV_LOGIN mode otherwise always resolves some identity.
 * Returns null when unauthenticated (including for a bad bearer token).
 */
export async function getIdentity(c: AuthContext): Promise<Identity | null> {
  return (await resolveAuth(c)).identity;
}

/**
 * The Access-authenticated email, or null. Dev mode (DEV_LOGIN=true, local/tests
 * only) returns the first admin email so the app is usable without a real gate.
 */
export async function accessEmail(c: {
  env: Env;
  req: { header(name: string): string | undefined };
}): Promise<string | null> {
  return (await getIdentity(c))?.email ?? null;
}

/** Admin by configuration: in ADMIN_EMAILS, or a super admin (who is always an admin). */
export function isAdmin(env: Env, email: string | null): boolean {
  return configuredRole(env, email) !== null;
}

/**
 * Hono per-request variables set by requireAdmin / requireUser.
 *
 * `accountCtx` is populated lazily by {@link accountsFor}, never by the auth
 * middleware: resolving workspaces costs a database read, and the surfaces that
 * need it (`/admin`, `/api`) are a small fraction of the requests this Worker
 * serves.
 */
export type AuthVars = { email: string; identity: Identity; accountCtx?: AccountContext };

/** A Hono context carrying the auth variables (both `/api` and `/admin` match). */
type AccountAwareContext = Context<{ Bindings: Env; Variables: AuthVars }>;

/**
 * The caller's account context for this request, resolved once and cached on the
 * context. Safe to call from several helpers in the same handler.
 *
 * Never throws: on an un-migrated or unavailable database this resolves to an
 * empty context, and every consumer then falls back to the legacy `owner_email`
 * authorization path (issue #27).
 */
export async function accountsFor(c: AccountAwareContext): Promise<AccountContext> {
  const cached = c.get("accountCtx");
  if (cached) return cached;
  const identity = c.get("identity") ?? null;
  const ctx = await resolveAccountContext(
    c.env,
    identity && { email: identity.email, accountId: identity.accountId, isToken: !!identity.token }
  );
  c.set("accountCtx", ctx);
  return ctx;
}

/** Display/audit name for an identity: their email, the token, or the service token. */
function displayName(id: Identity): string {
  if (id.email) return id.email;
  if (id.token) return `token:${id.token.id}`;
  return id.commonName ? `service:${id.commonName}` : "service-token";
}

type AuthApp = { Bindings: Env; Variables: AuthVars };

/** 401 for a bearer token we can't accept, with the standard challenge header. */
function invalidTokenResponse(c: Parameters<MiddlewareHandler<AuthApp>>[0]) {
  return c.json(
    { error: "invalid_token", detail: "the API token is unknown, revoked, or expired" },
    401,
    { "WWW-Authenticate": 'Bearer error="invalid_token"' }
  );
}

/**
 * 403 for a valid login whose account is paused.
 *
 * A distinct error code (rather than a generic `forbidden`) so a CLI or agent can
 * tell "you were signed out" from "your access was paused" and say something
 * useful about it. A browser gets the explanatory page instead of raw JSON —
 * `/admin` is a page, and the person hitting it is the one who most needs the
 * explanation. Machines are unaffected: no agent sends `Accept: text/html`, and
 * the status code is 403 either way.
 */
/**
 * Refused for want of an identity.
 *
 * Nobody signed in, in a browser, means "you need to sign in" — send them to
 * the sign-in page. Cloudflare Access used to do this bounce before the Worker
 * ever saw the request; once it stopped, a person typing /admin got raw JSON.
 *
 * Somebody who IS signed in and still may not be here (a guest, a non-admin
 * service token) gets 403 and stays put. Redirecting them would loop forever,
 * because signing in again changes nothing about what they may reach.
 */
function forbiddenResponse(
  c: Parameters<MiddlewareHandler<AuthApp>>[0],
  identity: Identity | null
) {
  const wantsHtml = (c.req.header("Accept") ?? "").includes("text/html");
  if (!identity && wantsHtml) return c.redirect("/login", 302);
  return c.json({ error: "forbidden", detail: "sign-in required" }, 403);
}

function disabledResponse(c: Parameters<MiddlewareHandler<AuthApp>>[0], email: string | null) {
  if ((c.req.header("Accept") ?? "").includes("text/html")) {
    return c.html(accountPausedPage(c.env, email), 403);
  }
  return c.json(
    { error: "account_disabled", detail: "this account is disabled — ask an admin to re-enable it" },
    403
  );
}

/**
 * Middleware: 403 unless the caller is an admin. Accepts a human whose email is
 * in ADMIN_EMAILS, a service token (common_name) — both of which have already
 * been vetted by Cloudflare Access's admin-application policy before the request
 * reaches the Worker — or an admin API token. Stashes the identity in
 * c.get('email') and c.get('identity').
 */
export const requireAdmin: MiddlewareHandler<AuthApp> = async (c, next) => {
  const { identity, invalidToken, disabled, disabledEmail } = await resolveAuth(c);
  if (invalidToken) return invalidTokenResponse(c);
  if (disabled) return disabledResponse(c, disabledEmail);
  if (identity?.isAdmin) {
    c.set("identity", identity);
    c.set("email", displayName(identity));
    return next();
  }
  return c.json({ error: "forbidden", detail: "admin access required" }, 403);
};

/**
 * Middleware: 403 unless the caller is an admin, or a signed-in member (a
 * human with an email), or an API token issued for one of those. Per-artifact
 * ownership is enforced downstream — this only establishes *who* is asking.
 *
 * A non-admin Access service token is rejected on purpose: ownership is keyed on
 * an email, so a token has nothing it could own and would otherwise be able to
 * publish unowned (admin-only) artifacts just by satisfying the viewer Access
 * policy. Admin service tokens (ADMIN_SERVICE_TOKENS, e.g. the CLI) still pass.
 * An API token always carries an owner email (or admin rights), so it has a
 * well-defined identity to be scoped against.
 */
export const requireUser: MiddlewareHandler<AuthApp> = async (c, next) => {
  const { identity, invalidToken, disabled, disabledEmail } = await resolveAuth(c);
  if (invalidToken) return invalidTokenResponse(c);
  if (disabled) return disabledResponse(c, disabledEmail);
  if (canUseDashboard(identity)) {
    c.set("identity", identity);
    c.set("email", displayName(identity));
    return next();
  }
  return forbiddenResponse(c, identity);
};

/**
 * Middleware: authenticate with an API token and nothing else — the gate on the
 * machine surface (`/api/machine/*`, see src/api.ts).
 *
 * That surface exists so somebody invited to the product can publish from a CLI,
 * an agent or CI with the scoped `rtfx_…` token they minted themselves, without
 * *also* being handed Cloudflare Access service-token credentials. It is
 * therefore meant to sit OUTSIDE the Access application (docs/DEPLOY_RTFX.md
 * §5e), which makes this middleware the only gate in front of it.
 *
 * So it is deliberately NARROWER than `requireUser`, not a relaxation of it:
 *
 *   • A bearer token is required. An Access session cookie is not accepted, and
 *     that is what keeps the surface immune to CSRF — a browser attaches cookies
 *     to a cross-site request by itself, but never an `Authorization` header.
 *   • Dev impersonation can't reach it either: `resolveAuth` only consults
 *     `X-Dev-Email` when no bearer is presented, and an identity carrying no
 *     `token` is refused below.
 *   • Nothing downstream changes. Ownership (`canManage`), scopes
 *     (`requireScope`) and the local directory still decide what the token may
 *     actually do, exactly as they do on `/api`.
 */
export const requireApiToken: MiddlewareHandler<AuthApp> = async (c, next) => {
  if (bearerToken(c) === null) {
    return c.json(
      {
        error: "unauthorized",
        detail: "this API needs an `Authorization: Bearer <rtfx token>` header",
      },
      401,
      { "WWW-Authenticate": 'Bearer realm="rtfx"' }
    );
  }
  const { identity, invalidToken, disabled, disabledEmail } = await resolveAuth(c);
  if (invalidToken) return invalidTokenResponse(c);
  if (disabled) return disabledResponse(c, disabledEmail);
  // `identity.token` is the proof that it was the bearer path — and not Access,
  // and not dev mode — that authenticated this request.
  if (!identity?.token || !canUseDashboard(identity)) return invalidTokenResponse(c);
  c.set("identity", identity);
  c.set("email", displayName(identity));
  return next();
};

/**
 * Middleware factory: 403 unless the caller holds `scope`. Access-authenticated
 * callers (humans, admin service tokens) hold every scope; only API tokens are
 * narrowed. Must run after requireUser/requireAdmin, which set `identity`.
 */
export function requireScope(scope: Scope): MiddlewareHandler<AuthApp> {
  return async (c, next) => {
    if (hasScope(c.get("identity"), scope)) return next();
    return c.json(
      { error: "insufficient_scope", detail: `this API token lacks the "${scope}" scope` },
      403,
      { "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${scope}"` }
    );
  };
}

/**
 * Middleware: refuse API-token callers outright. Used for the endpoints that
 * hand out credentials — the sign-in allow-list and token management itself —
 * so a leaked token can never mint another token, widen its own rights, or
 * invite a new user. Those actions require an interactive Access login.
 */
export const denyApiToken: MiddlewareHandler<AuthApp> = async (c, next) => {
  if (c.get("identity")?.token) {
    return c.json(
      { error: "forbidden", detail: "API tokens cannot manage users or tokens — sign in instead" },
      403
    );
  }
  return next();
};

function getCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}
