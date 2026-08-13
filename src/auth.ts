import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";
import { canUseDashboard, hasScope } from "./authz";
import {
  findApiToken,
  isTokenUsable,
  needsTouch,
  rowScopes,
  touchApiToken,
  type Scope,
} from "./tokens";

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
 * Whether an identity has admin rights: an email in ADMIN_EMAILS, OR a service
 * token whose common_name is explicitly allow-listed in ADMIN_SERVICE_TOKENS.
 * A service token that merely satisfies some Access policy is NOT admin unless
 * listed here — so a lower-privilege (e.g. monitoring) token is not admin.
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
  /** True for admins: email in ADMIN_EMAILS or an allow-listed service token. */
  isAdmin: boolean;
  /**
   * Set only when the caller authenticated with an API token (`Authorization:
   * Bearer`). Absent/null means an Access-authenticated caller, who holds every
   * scope. See `hasScope` in authz.ts.
   */
  token?: { id: string; scopes: Scope[] } | null;
}

/** Minimal request shape the auth helpers need (a Hono context satisfies it). */
type AuthContext = {
  env: Env;
  req: { header(name: string): string | undefined };
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
    token: { id: row.id, scopes: rowScopes(row) },
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
}

/**
 * Authenticate a request. An `Authorization: Bearer` token wins when present —
 * and a bad one is an error, never a silent downgrade to the Access (or dev)
 * identity, so a caller can't be handed rights they didn't ask for. With no
 * bearer header the behavior is exactly as before: dev impersonation locally,
 * Cloudflare Access in production.
 *
 * Bearer auth does not bypass Cloudflare Access: Access still gates the
 * hostname/path at the edge. This is the second, app-layer check.
 */
export async function resolveAuth(c: AuthContext): Promise<AuthResult> {
  const presented = bearerToken(c);
  if (presented !== null) {
    const identity = await identityFromApiToken(c, presented);
    return { identity, invalidToken: identity === null };
  }
  const env = c.env;
  if (env.DEV_LOGIN === "true") {
    if (c.req.header("X-Dev-Anonymous") === "true") return { identity: null, invalidToken: false };
    const email = (c.req.header("X-Dev-Email") || adminList(env)[0] || "dev@local").toLowerCase();
    return {
      identity: { email, commonName: null, isAdmin: isAdmin(env, email), token: null },
      invalidToken: false,
    };
  }
  const id = await verifyAccess(c);
  if (!id) return { identity: null, invalidToken: false };
  return {
    identity: {
      email: id.email,
      commonName: id.commonName,
      isAdmin: resolveIsAdmin(env, id.email, id.commonName),
      token: null,
    },
    invalidToken: false,
  };
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

export function isAdmin(env: Env, email: string | null): boolean {
  return !!email && adminList(env).includes(email.toLowerCase());
}

/** Hono per-request variables set by requireAdmin / requireUser. */
export type AuthVars = { email: string; identity: Identity };

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
 * Middleware: 403 unless the caller is an admin. Accepts a human whose email is
 * in ADMIN_EMAILS, a service token (common_name) — both of which have already
 * been vetted by Cloudflare Access's admin-application policy before the request
 * reaches the Worker — or an admin API token. Stashes the identity in
 * c.get('email') and c.get('identity').
 */
export const requireAdmin: MiddlewareHandler<AuthApp> = async (c, next) => {
  const { identity, invalidToken } = await resolveAuth(c);
  if (invalidToken) return invalidTokenResponse(c);
  if (identity?.isAdmin) {
    c.set("identity", identity);
    c.set("email", displayName(identity));
    return next();
  }
  return c.json({ error: "forbidden", detail: "admin access required" }, 403);
};

/**
 * Middleware: 403 unless the caller is an admin, or a signed-in beta user (a
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
  const { identity, invalidToken } = await resolveAuth(c);
  if (invalidToken) return invalidTokenResponse(c);
  if (canUseDashboard(identity)) {
    c.set("identity", identity);
    c.set("email", displayName(identity));
    return next();
  }
  return c.json({ error: "forbidden", detail: "sign-in required" }, 403);
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
