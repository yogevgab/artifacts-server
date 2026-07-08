import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";

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
}

/**
 * Resolve the caller's identity for authorization. In dev mode (DEV_LOGIN=true,
 * local/tests only) the `X-Dev-Email` header impersonates a viewer for testing;
 * absent, the first admin email is used. Returns null when unauthenticated.
 */
export async function getIdentity(c: {
  env: Env;
  req: { header(name: string): string | undefined };
}): Promise<Identity | null> {
  const env = c.env;
  if (env.DEV_LOGIN === "true") {
    const email = (c.req.header("X-Dev-Email") || adminList(env)[0] || "dev@local").toLowerCase();
    return { email, commonName: null, isAdmin: isAdmin(env, email) };
  }
  const id = await verifyAccess(c);
  if (!id) return null;
  return {
    email: id.email,
    commonName: id.commonName,
    isAdmin: resolveIsAdmin(env, id.email, id.commonName),
  };
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

/**
 * Middleware: 403 unless the caller is an admin. Accepts either a human whose
 * email is in ADMIN_EMAILS, or a service token (common_name) — both of which
 * have already been vetted by Cloudflare Access's admin-application policy
 * before the request reaches the Worker. Stashes the identity in c.get('email').
 */
export const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: { email: string } }> =
  async (c, next) => {
    const id = await getIdentity(c);
    if (id?.isAdmin) {
      c.set("email", id.email ?? (id.commonName ? `service:${id.commonName}` : "service-token"));
      return next();
    }
    return c.json({ error: "forbidden", detail: "admin access required" }, 403);
  };

function getCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}
