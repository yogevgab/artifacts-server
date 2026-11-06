/**
 * Custom domains, phase 1 (docs/CUSTOM_DOMAINS.md): a hostname the customer owns
 * (`docs.acme.com`) that serves their WHOLE workspace at `/<artifact-slug>`.
 *
 * Everything here is inert unless `CUSTOM_DOMAINS_ENABLED` is exactly "true".
 * With the flag off nothing reads the table and nothing in the request path
 * changes, so shipping this module changes no production behaviour.
 *
 * Reads fail soft: a Worker deployed ahead of migration 0025 has no table, and
 * "no custom domains" is the correct answer to that, not a 500.
 *
 * The plan gate copies the branded-address pattern (src/account-slugs.ts).
 */

import type { Env } from "./env";
import { getAccount, effectivePlan, type AccountRow } from "./accounts";
import { auditStatement, type AuditActor } from "./audit";
import { isContentHost, firstContentHostname, parseHostnames, requestHostname } from "./host";
import { siteOrigin } from "./seo";

export type DomainStatus = "pending" | "active" | "failed" | "removed";
export const DOMAIN_STATUSES: readonly DomainStatus[] = ["pending", "active", "failed", "removed"];

export interface CustomDomainRow {
  hostname: string;
  account_id: string;
  status: DomainStatus;
  cf_hostname_id: string | null;
  ssl_status: string | null;
  verification_errors: string | null;
  is_primary: number;
  created_by: string;
  created_at: string;
  verified_at: string | null;
  updated_at: string | null;
}

/** The feature flag. Anything but the exact string "true" is off. */
export function customDomainsEnabled(env: Pick<Env, "CUSTOM_DOMAINS_ENABLED">): boolean {
  return env.CUSTOM_DOMAINS_ENABLED === "true";
}

// --- plan gate ---------------------------------------------------------------

/**
 * Domains included per plan. Team includes one; Enterprise is by agreement, so
 * it is unlimited here and an operator holds the line (a per-account override
 * lands with the commercial phase). Free and Pro get none.
 */
const CUSTOM_DOMAIN_LIMITS: Readonly<Record<string, number>> = {
  team: 1,
  enterprise: Number.POSITIVE_INFINITY,
};

/** May an account on this (effective) plan have a custom domain at all? */
export function planAllowsCustomDomain(plan: string): boolean {
  return customDomainLimit(plan) > 0;
}

/** How many (non-removed) custom domains this effective plan may hold. */
export function customDomainLimit(plan: string): number {
  return CUSTOM_DOMAIN_LIMITS[plan] ?? 0;
}

// --- hostname validation -----------------------------------------------------

export type HostnameRejection = "shape" | "reserved" | "ip" | "local";

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validate and normalise a hostname a customer wants to serve on. Rejects the
 * product's own names (apex and every subdomain of the canonical host, the
 * content hosts, APP_ORIGINS hosts), IP literals, localhost and anything that is
 * not a fully-qualified name. Returns the lower-cased hostname without a
 * trailing dot.
 */
export function checkHostname(
  env: Pick<Env, "PUBLIC_BASE_URL" | "CONTENT_HOSTNAMES" | "APP_ORIGINS">,
  raw: unknown
): { ok: true; hostname: string } | { ok: false; reason: HostnameRejection } {
  if (typeof raw !== "string") return { ok: false, reason: "shape" };
  let host = raw.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.length > 253) return { ok: false, reason: "shape" };
  // A name, not a URL: no scheme, port, path, credentials or wildcard.
  if (/[^a-z0-9.-]/.test(host)) {
    // An IPv6 literal (`::1`, `[::1]`); anything else is just malformed.
    return { ok: false, reason: /^\[?[0-9a-f]*:[0-9a-f:]*\]?$/.test(host) ? "ip" : "shape" };
  }
  const labels = host.split(".");
  if (labels.some((l) => !LABEL_RE.test(l))) return { ok: false, reason: "shape" };
  // All-numeric last label means an IPv4 address (or something no TLD can be).
  if (/^\d+$/.test(labels[labels.length - 1])) return { ok: false, reason: "ip" };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "local" };
  }
  // Fully qualified: at least two labels.
  if (labels.length < 2) return { ok: false, reason: "shape" };

  const canonicalHost = requestHostname(siteOrigin(env));
  const isOurs = (h: string) => !!h && (host === h || host.endsWith(`.${h}`));
  if (isOurs(canonicalHost) || isOurs("rtfx.pro")) return { ok: false, reason: "reserved" };
  for (const h of parseHostnames(env.CONTENT_HOSTNAMES)) if (isOurs(h)) return { ok: false, reason: "reserved" };
  for (const extra of (env.APP_ORIGINS ?? "").split(",")) {
    const h = requestHostname(extra.trim());
    if (isOurs(h)) return { ok: false, reason: "reserved" };
  }
  return { ok: true, hostname: host };
}

// --- host classification -------------------------------------------------------

export type HostClass =
  | { kind: "content" }
  | { kind: "app" }
  | { kind: "customer"; domain: CustomDomainRow }
  | { kind: "unknown" };

/** Is this request's host one of the product's own app hosts (canonical host, its subdomains, APP_ORIGINS)? */
export function isOwnAppHost(env: Env, url: string): boolean {
  const host = requestHostname(url);
  if (!host) return false;
  const own = (h: string) => !!h && (host === h || host.endsWith(`.${h}`));
  if (own(requestHostname(siteOrigin(env)))) return true;
  for (const extra of (env.APP_ORIGINS ?? "").split(",")) {
    if (own(requestHostname(extra.trim()))) return true;
  }
  return false;
}

/**
 * Which kind of host is this request for? Content host (`a.rtfx.pro`), app host
 * (`rtfx.pro`, `mcp.rtfx.pro`), customer host (an ACTIVE custom domain), or
 * unknown.
 *
 * With the flag off every host that is not a content host is an app host, i.e.
 * exactly the pre-existing behaviour. With it on, a host that is neither ours
 * nor an active domain is "unknown" on a two-host deployment (answered 404);
 * a single-host deployment (no CONTENT_HOSTNAMES: dev, self-host) keeps treating
 * it as the app so `localhost` and preview hosts still work.
 */
export async function classifyHost(env: Env, url: string): Promise<HostClass> {
  if (isContentHost(env, url)) return { kind: "content" };
  if (!customDomainsEnabled(env)) return { kind: "app" };
  if (isOwnAppHost(env, url)) return { kind: "app" };
  const domain = await getActiveDomain(env, requestHostname(url));
  if (domain) return { kind: "customer", domain };
  return firstContentHostname(env) === undefined ? { kind: "app" } : { kind: "unknown" };
}

/** The active custom domain this request arrived on, or null (flag off, app host, content host, unknown). */
export async function customerDomainOf(env: Env, url: string): Promise<CustomDomainRow | null> {
  if (!customDomainsEnabled(env)) return null;
  if (isContentHost(env, url) || isOwnAppHost(env, url)) return null;
  return getActiveDomain(env, requestHostname(url));
}

// --- reads (short in-memory cache) -------------------------------------------

/** How long an isolate trusts what it read. Bounds how stale a removal can be. */
export const DOMAIN_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 500;

const byHostname = new Map<string, { at: number; row: CustomDomainRow | null }>();
const primaryByAccount = new Map<string, { at: number; hostname: string | null }>();

/** Drop everything this isolate cached. Called on every write, and by tests. */
export function clearCustomDomainCache(): void {
  byHostname.clear();
  primaryByAccount.clear();
}

function fresh(at: number): boolean {
  return Date.now() - at < DOMAIN_CACHE_TTL_MS;
}

function remember<K, V extends { at: number }>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= MAX_CACHE_ENTRIES) map.clear();
  map.set(key, value);
}

/**
 * The ACTIVE custom domain row for a hostname, or null. Flag off, an unknown
 * hostname, a pending/failed/removed row and a missing table all answer null.
 */
export async function getActiveDomain(env: Env, hostname: string): Promise<CustomDomainRow | null> {
  if (!customDomainsEnabled(env)) return null;
  const host = hostname.trim().toLowerCase();
  if (!host) return null;
  const hit = byHostname.get(host);
  if (hit && fresh(hit.at)) return hit.row;
  let row: CustomDomainRow | null = null;
  try {
    row = await env.DB.prepare(`SELECT * FROM custom_domains WHERE hostname = ? AND status = 'active'`)
      .bind(host)
      .first<CustomDomainRow>();
  } catch {
    row = null;
  }
  remember(byHostname, host, { at: Date.now(), row: row ?? null });
  return row ?? null;
}

/**
 * The hostname (not a URL) of this workspace's ACTIVE PRIMARY domain, or null.
 * Null means "links stay on rtfx.pro", which is also what a removed or
 * deactivated domain reverts to.
 */
export async function primaryDomainFor(env: Env, accountId: string | null | undefined): Promise<string | null> {
  if (!accountId || !customDomainsEnabled(env)) return null;
  const hit = primaryByAccount.get(accountId);
  if (hit && fresh(hit.at)) return hit.hostname;
  let hostname: string | null = null;
  try {
    const row = await env.DB.prepare(
      `SELECT hostname FROM custom_domains WHERE account_id = ? AND status = 'active' AND is_primary = 1`
    )
      .bind(accountId)
      .first<{ hostname: string }>();
    hostname = row?.hostname ?? null;
  } catch {
    hostname = null;
  }
  remember(primaryByAccount, accountId, { at: Date.now(), hostname });
  return hostname;
}

/** `https://<domain>/<slug>[/rest]`, the address a customer-domain viewer serves. */
export function customDomainLink(hostname: string, slug: string, rest = ""): string {
  const tail = rest
    .split("/")
    .filter((s) => s !== "")
    .map(encodeURIComponent)
    .join("/");
  return `https://${hostname}/${encodeURIComponent(slug)}${tail ? `/${tail}` : ""}`;
}

/** Every domain row of a workspace, any status. Fails soft to empty. */
export async function listAccountDomains(env: Env, accountId: string): Promise<CustomDomainRow[]> {
  try {
    const res = await env.DB.prepare(`SELECT * FROM custom_domains WHERE account_id = ? ORDER BY created_at`)
      .bind(accountId)
      .all<CustomDomainRow>();
    return res.results ?? [];
  } catch {
    return [];
  }
}

export async function listAllDomains(env: Env): Promise<CustomDomainRow[]> {
  try {
    const res = await env.DB.prepare(`SELECT * FROM custom_domains ORDER BY created_at`).all<CustomDomainRow>();
    return res.results ?? [];
  } catch {
    return [];
  }
}

// --- the viewer's ancestor allowlist ------------------------------------------

/**
 * The origin a frame token's `anc` claim may add to `frame-ancestors`, or null.
 * Allowed only for an ACTIVE custom domain of the artifact's own workspace.
 * (The canonical origin and APP_ORIGINS are already in the static list, so a
 * token naming one of those needs nothing added.)
 */
export async function allowedFrameAncestor(
  env: Env,
  anc: string | undefined,
  artifactAccountId: string | null | undefined
): Promise<string | null> {
  if (!anc || !artifactAccountId || !customDomainsEnabled(env)) return null;
  let u: URL;
  try {
    u = new URL(anc);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.origin !== anc) return null;
  const row = await getActiveDomain(env, u.hostname);
  return row && row.account_id === artifactAccountId ? u.origin : null;
}

// --- operator writes ----------------------------------------------------------

export type RegisterFailure =
  | "bad_hostname"
  | "no_account"
  | "plan_required"
  | "limit_reached"
  | "taken"
  | "bad_status"
  | "primary_requires_active";

export interface RegisterInput {
  hostname: string;
  accountId: string;
  status: DomainStatus;
  primary: boolean;
  cfHostnameId?: string | null;
  sslStatus?: string | null;
  actor: AuditActor;
  now: string;
}

/**
 * Insert or update one domain row. An operator action: authorization is the
 * caller's (src/platform-routes.ts). The row and its audit entry are one batch.
 *
 * Enforces the rules the data cannot: a hostname belongs to one workspace, the
 * workspace's effective plan must allow custom domains, and the plan's included
 * count is not exceeded. Marking one primary clears the previous primary in the
 * same batch (the unique partial index backs this up).
 */
export async function registerDomain(
  env: Env,
  input: RegisterInput
): Promise<{ ok: true; row: CustomDomainRow } | { ok: false; reason: RegisterFailure }> {
  const checked = checkHostname(env, input.hostname);
  if (!checked.ok) return { ok: false, reason: "bad_hostname" };
  const hostname = checked.hostname;
  if (!DOMAIN_STATUSES.includes(input.status)) return { ok: false, reason: "bad_status" };
  if (input.primary && input.status !== "active") return { ok: false, reason: "primary_requires_active" };

  const account: AccountRow | null = await getAccount(env, input.accountId);
  if (!account) return { ok: false, reason: "no_account" };

  const existing = await env.DB.prepare(`SELECT * FROM custom_domains WHERE hostname = ?`)
    .bind(hostname)
    .first<CustomDomainRow>();
  // A hostname held by another workspace (in any state but removed) is taken.
  if (existing && existing.account_id !== account.id && existing.status !== "removed") {
    return { ok: false, reason: "taken" };
  }

  if (input.status !== "removed") {
    const plan = effectivePlan(account, input.now);
    if (!planAllowsCustomDomain(plan)) return { ok: false, reason: "plan_required" };
    const held = (await listAccountDomains(env, account.id)).filter(
      (d) => d.status !== "removed" && d.hostname !== hostname
    ).length;
    if (held + 1 > customDomainLimit(plan)) return { ok: false, reason: "limit_reached" };
  }

  const primary = input.primary && input.status === "active" ? 1 : 0;
  const statements: D1PreparedStatement[] = [];
  if (primary) {
    statements.push(
      env.DB.prepare(`UPDATE custom_domains SET is_primary = 0, updated_at = ? WHERE account_id = ? AND hostname <> ?`).bind(
        input.now,
        account.id,
        hostname
      )
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO custom_domains
         (hostname, account_id, status, cf_hostname_id, ssl_status, is_primary, created_by, created_at, verified_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hostname) DO UPDATE SET
         account_id = excluded.account_id,
         status = excluded.status,
         cf_hostname_id = COALESCE(excluded.cf_hostname_id, custom_domains.cf_hostname_id),
         ssl_status = COALESCE(excluded.ssl_status, custom_domains.ssl_status),
         is_primary = excluded.is_primary,
         verified_at = COALESCE(custom_domains.verified_at, excluded.verified_at),
         updated_at = excluded.updated_at`
    ).bind(
      hostname,
      account.id,
      input.status,
      input.cfHostnameId ?? null,
      input.sslStatus ?? null,
      input.status === "removed" ? 0 : primary,
      input.actor.email ?? "operator",
      input.now,
      input.status === "active" ? input.now : null,
      input.now
    ),
    auditStatement(env, {
      actor: input.actor,
      action: input.status === "removed" ? "domain.removed" : "domain.registered",
      targetType: "account",
      targetId: account.id,
      summary: `Custom domain ${hostname} ${input.status === "removed" ? "removed" : `set ${input.status}`}`,
      detail: { hostname, status: input.status, primary: !!primary },
      now: input.now,
    })
  );
  await env.DB.batch(statements);
  clearCustomDomainCache();
  const row = await env.DB.prepare(`SELECT * FROM custom_domains WHERE hostname = ?`)
    .bind(hostname)
    .first<CustomDomainRow>();
  return { ok: true, row: row! };
}

/** Mark a domain removed (and no longer primary). False when it does not exist. */
export async function removeDomain(
  env: Env,
  hostname: string,
  actor: AuditActor,
  now: string
): Promise<boolean> {
  const checked = checkHostname(env, hostname);
  if (!checked.ok) return false;
  const row = await env.DB.prepare(`SELECT * FROM custom_domains WHERE hostname = ?`)
    .bind(checked.hostname)
    .first<CustomDomainRow>();
  if (!row) return false;
  await env.DB.batch([
    env.DB.prepare(`UPDATE custom_domains SET status = 'removed', is_primary = 0, updated_at = ? WHERE hostname = ?`).bind(
      now,
      row.hostname
    ),
    auditStatement(env, {
      actor,
      action: "domain.removed",
      targetType: "account",
      targetId: row.account_id,
      summary: `Custom domain ${row.hostname} removed`,
      detail: { hostname: row.hostname },
      now,
    }),
  ]);
  clearCustomDomainCache();
  return true;
}
