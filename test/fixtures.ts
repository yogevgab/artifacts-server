import { env } from "cloudflare:test";
import app from "../src/index";

/**
 * Recreate the D1 schema from scratch before each test. Tables are dropped
 * rather than emptied so a stale table left over from an older run (the test
 * D1 instance is shared across files) can never mask a schema change — this
 * mirrors schema.sql, so keep the two in step.
 */
export async function initDb() {
  for (const table of [
    "artifacts",
    "artifact_grants",
    "artifact_versions",
    "artifact_views",
    "waitlist",
    "api_tokens",
    "users",
    "accounts",
    "account_members",
    "auth_challenges",
    "mail_log",
    "share_links",
  ]) {
    await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await env.DB.prepare(
    `CREATE TABLE artifacts (
      slug TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, type TEXT NOT NULL,
      entry TEXT NOT NULL DEFAULT 'index.html', file_count INTEGER NOT NULL DEFAULT 1,
      size_bytes INTEGER NOT NULL DEFAULT 0, created_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'restricted', current_version INTEGER NOT NULL DEFAULT 1,
      owner_email TEXT, account_id TEXT)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE artifact_grants (
      slug TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (slug, email))`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE artifact_versions (
      slug TEXT NOT NULL, version INTEGER NOT NULL, type TEXT NOT NULL,
      entry TEXT NOT NULL DEFAULT 'index.html', file_count INTEGER NOT NULL DEFAULT 1,
      size_bytes INTEGER NOT NULL DEFAULT 0, note TEXT, created_by TEXT,
      created_at TEXT NOT NULL, PRIMARY KEY (slug, version))`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE artifact_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, version INTEGER NOT NULL,
      email TEXT, path TEXT, country TEXT, referrer TEXT, viewed_at TEXT NOT NULL)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE waitlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE api_tokens (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      owner_email TEXT, account_id TEXT, is_admin INTEGER NOT NULL DEFAULT 0,
      scopes TEXT NOT NULL DEFAULT 'read,publish', created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT, revoked_at TEXT)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE users (
      email TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'invited', display_name TEXT, notes TEXT,
      invited_by TEXT, invited_at TEXT, created_at TEXT NOT NULL,
      last_seen_at TEXT, disabled_at TEXT)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'personal',
      status TEXT NOT NULL DEFAULT 'active', plan TEXT NOT NULL DEFAULT 'free',
      personal_email TEXT UNIQUE, created_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE account_members (
      account_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active', invited_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, email))`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE auth_challenges (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL,
      token_hash TEXT NOT NULL, purpose TEXT NOT NULL, slug TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL,
      consumed_at TEXT, created_at TEXT NOT NULL)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE share_links (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, token_hash TEXT NOT NULL,
      created_by TEXT NOT NULL, expires_at TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL, last_used_at TEXT)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, error_code TEXT, created_at TEXT NOT NULL)`
  ).run();
}

/** Drop the users table, to exercise the "directory not migrated yet" path. */
export async function dropUsersTable() {
  await env.DB.prepare("DROP TABLE IF EXISTS users").run();
}

/**
 * Drop the accounts tables, to exercise the "#27 not migrated yet" path: every
 * account helper must fail soft and every caller fall back to `owner_email`.
 */
export async function dropAccountTables() {
  await env.DB.prepare("DROP TABLE IF EXISTS account_members").run();
  await env.DB.prepare("DROP TABLE IF EXISTS accounts").run();
}

/** Drop only the new nullable account_id columns, to exercise Worker-before-0009 compatibility. */
export async function dropAccountIdColumns() {
  await env.DB.prepare("ALTER TABLE artifacts DROP COLUMN account_id").run();
  await env.DB.prepare("ALTER TABLE api_tokens DROP COLUMN account_id").run();
}

export async function clearR2() {
  const listed = await env.FILES.list();
  if (listed.objects.length) await env.FILES.delete(listed.objects.map((o) => o.key));
}

export const req = async (path: string, init?: RequestInit): Promise<Response> =>
  app.request(path, init, env as any);

/** Request as a specific signed-in person (DEV_LOGIN impersonation). */
export const as = (email: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string> | undefined), "X-Dev-Email": email },
});

/** Request authenticated with an API token instead of an Access login. */
export const withToken = (token: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: {
    ...(init.headers as Record<string, string> | undefined),
    Authorization: `Bearer ${token}`,
  },
});

export function htmlForm(
  fields: Record<string, string>,
  fileName: string,
  bytes: Uint8Array,
  field = "file"
) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.set(field, new File([bytes], fileName, { type: "text/html" }));
  return fd;
}
