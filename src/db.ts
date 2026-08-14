import type { Env, ArtifactRow, VersionRow, ViewRow } from "./env";

function isMissingAccountColumn(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /no such column: account_id|table artifacts has no column named account_id/i.test(message);
}

export async function listArtifacts(env: Env): Promise<ArtifactRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM artifacts ORDER BY created_at DESC"
  ).all<ArtifactRow>();
  return results ?? [];
}

/** Artifacts owned by one member — everything their dashboard may manage. */
export async function listArtifactsOwnedBy(env: Env, email: string): Promise<ArtifactRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM artifacts WHERE lower(owner_email) = ? ORDER BY created_at DESC"
  )
    .bind(email.trim().toLowerCase())
    .all<ArtifactRow>();
  return results ?? [];
}

/**
 * Everything a non-platform-admin caller may reach: artifacts they own by
 * `owner_email` (the legacy path, unchanged) **plus** artifacts belonging to any
 * account they are a member of (issue #27).
 *
 * The union is inclusive on purpose. A row that migration 0010 never adopted has
 * `account_id IS NULL` and is still returned via `owner_email`; a row in a team
 * account the caller joined is returned via `account_id` even though its
 * `owner_email` is somebody else's. Neither path can hide a row the other would
 * have shown, so this can only ever widen the pre-#27 result set — and for a
 * personal account, which has exactly one member who is also every row's
 * `owner_email`, it returns precisely the same rows as before.
 *
 * `accountIds` is inlined as bound placeholders rather than a join, so this stays
 * one indexed query and works identically on a database where the accounts
 * tables do not exist yet (the list is simply empty).
 */
export async function listArtifactsForCaller(
  env: Env,
  email: string | null,
  accountIds: readonly string[]
): Promise<ArtifactRow[]> {
  const ids = [...new Set(accountIds)];
  if (!email && !ids.length) return [];
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (email) {
    clauses.push("lower(owner_email) = ?");
    binds.push(email.trim().toLowerCase());
  }
  if (ids.length) {
    clauses.push(`account_id IN (${ids.map(() => "?").join(", ")})`);
    binds.push(...ids);
  }
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM artifacts WHERE ${clauses.join(" OR ")} ORDER BY created_at DESC`
    )
      .bind(...binds)
      .all<ArtifactRow>();
    return results ?? [];
  } catch (e) {
    if (ids.length && isMissingAccountColumn(e)) {
      // Worker deployed before 0009: fall back to the exact pre-account query.
      return email ? listArtifactsOwnedBy(env, email) : [];
    }
    throw e;
  }
}

export async function getArtifact(env: Env, slug: string): Promise<ArtifactRow | null> {
  return env.DB.prepare("SELECT * FROM artifacts WHERE slug = ?").bind(slug).first<ArtifactRow>();
}

export async function upsertArtifact(env: Env, row: ArtifactRow): Promise<void> {
  // visibility, owner_email and account_id are set on INSERT but intentionally
  // NOT in DO UPDATE SET, so publishing a new version preserves the artifact's
  // existing access setting and can never re-home it — to whoever uploaded last,
  // or into whichever workspace they happened to be acting in.
  try {
    await env.DB.prepare(
      `INSERT INTO artifacts
         (slug, title, description, type, entry, file_count, size_bytes, created_by, created_at, updated_at, visibility, current_version, owner_email, account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         title=excluded.title, description=excluded.description, type=excluded.type,
         entry=excluded.entry, file_count=excluded.file_count, size_bytes=excluded.size_bytes,
         updated_at=excluded.updated_at, current_version=excluded.current_version`
    )
      .bind(
        row.slug,
        row.title,
        row.description,
        row.type,
        row.entry,
        row.file_count,
        row.size_bytes,
        row.created_by,
        row.created_at,
        row.updated_at,
        row.visibility,
        row.current_version,
        row.owner_email,
        row.account_id ?? null
      )
      .run();
  } catch (e) {
    if (!isMissingAccountColumn(e)) throw e;
    await env.DB.prepare(
      `INSERT INTO artifacts
         (slug, title, description, type, entry, file_count, size_bytes, created_by, created_at, updated_at, visibility, current_version, owner_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         title=excluded.title, description=excluded.description, type=excluded.type,
         entry=excluded.entry, file_count=excluded.file_count, size_bytes=excluded.size_bytes,
         updated_at=excluded.updated_at, current_version=excluded.current_version`
    )
      .bind(
        row.slug,
        row.title,
        row.description,
        row.type,
        row.entry,
        row.file_count,
        row.size_bytes,
        row.created_by,
        row.created_at,
        row.updated_at,
        row.visibility,
        row.current_version,
        row.owner_email
      )
      .run();
  }
}

/**
 * Atomically reserve and insert the next version number for a slug, returning it.
 * The version is computed inside the INSERT via a subquery, so concurrent
 * publishes to the same slug get distinct numbers (SQLite serializes writers) —
 * no read-then-write race, no primary-key collision.
 */
export async function insertNextVersion(env: Env, v: Omit<VersionRow, "version">): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO artifact_versions
       (slug, version, type, entry, file_count, size_bytes, note, created_by, created_at)
     VALUES (?, (SELECT COALESCE(MAX(version), 0) + 1 FROM artifact_versions WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?)
     RETURNING version`
  )
    .bind(v.slug, v.slug, v.type, v.entry, v.file_count, v.size_bytes, v.note, v.created_by, v.created_at)
    .first<{ version: number }>();
  return row!.version;
}

export async function deleteVersion(env: Env, slug: string, version: number): Promise<void> {
  await env.DB.prepare("DELETE FROM artifact_versions WHERE slug = ? AND version = ?")
    .bind(slug, version)
    .run();
}

export async function listVersions(env: Env, slug: string): Promise<VersionRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM artifact_versions WHERE slug = ? ORDER BY version DESC"
  )
    .bind(slug)
    .all<VersionRow>();
  return results ?? [];
}

export async function getVersion(env: Env, slug: string, version: number): Promise<VersionRow | null> {
  return env.DB.prepare("SELECT * FROM artifact_versions WHERE slug = ? AND version = ?")
    .bind(slug, version)
    .first<VersionRow>();
}

/** All versions grouped by slug (for the admin dashboard). */
export async function allVersions(env: Env): Promise<Map<string, VersionRow[]>> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM artifact_versions ORDER BY slug, version DESC"
  ).all<VersionRow>();
  const map = new Map<string, VersionRow[]>();
  for (const v of results ?? []) {
    const list = map.get(v.slug) ?? [];
    list.push(v);
    map.set(v.slug, list);
  }
  return map;
}

/** Point an artifact at a given version and sync its denormalized metadata. */
export async function setCurrentVersion(env: Env, slug: string, version: number, now: string): Promise<boolean> {
  const v = await getVersion(env, slug, version);
  if (!v) return false;
  await env.DB.prepare(
    `UPDATE artifacts SET current_version = ?, type = ?, entry = ?, file_count = ?, size_bytes = ?, updated_at = ?
     WHERE slug = ?`
  )
    .bind(version, v.type, v.entry, v.file_count, v.size_bytes, now, slug)
    .run();
  return true;
}

export async function deleteArtifactRow(env: Env, slug: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM artifact_grants WHERE slug = ?").bind(slug),
    env.DB.prepare("DELETE FROM artifact_versions WHERE slug = ?").bind(slug),
    env.DB.prepare("DELETE FROM artifact_views WHERE slug = ?").bind(slug),
    env.DB.prepare("DELETE FROM artifacts WHERE slug = ?").bind(slug),
  ]);
}

// --- Views log ---

export async function logView(env: Env, v: ViewRow): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO artifact_views (slug, version, email, path, country, referrer, viewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(v.slug, v.version, v.email, v.path, v.country, v.referrer, v.viewed_at)
      .run();
  } catch {
    // Logging must never break serving.
  }
}

export interface ViewStats {
  total: number;
  unique: number;
  recent: ViewRow[];
}

export async function getViews(env: Env, slug: string, limit = 50): Promise<ViewStats> {
  const counts = await env.DB.prepare(
    "SELECT COUNT(*) AS total, COUNT(DISTINCT email) AS uniq FROM artifact_views WHERE slug = ?"
  )
    .bind(slug)
    .first<{ total: number; uniq: number }>();
  const { results } = await env.DB.prepare(
    "SELECT slug, version, email, path, country, referrer, viewed_at FROM artifact_views WHERE slug = ? ORDER BY viewed_at DESC LIMIT ?"
  )
    .bind(slug, limit)
    .all<ViewRow>();
  return { total: counts?.total ?? 0, unique: counts?.uniq ?? 0, recent: results ?? [] };
}

/** Per-slug view counts (total + unique) for the dashboard, in one query. */
export async function viewCounts(env: Env): Promise<Map<string, { total: number; unique: number }>> {
  const { results } = await env.DB.prepare(
    "SELECT slug, COUNT(*) AS total, COUNT(DISTINCT email) AS uniq FROM artifact_views GROUP BY slug"
  ).all<{ slug: string; total: number; uniq: number }>();
  const map = new Map<string, { total: number; unique: number }>();
  for (const r of results ?? []) map.set(r.slug, { total: r.total, unique: r.uniq });
  return map;
}

/** Most-recent views across all artifacts (bounded), grouped by slug. */
export async function recentViews(env: Env, perSlug = 8, scan = 500): Promise<Map<string, ViewRow[]>> {
  const { results } = await env.DB.prepare(
    "SELECT slug, version, email, path, country, referrer, viewed_at FROM artifact_views ORDER BY viewed_at DESC LIMIT ?"
  )
    .bind(scan)
    .all<ViewRow>();
  const map = new Map<string, ViewRow[]>();
  for (const v of results ?? []) {
    const list = map.get(v.slug) ?? [];
    if (list.length < perSlug) list.push(v);
    map.set(v.slug, list);
  }
  return map;
}

// --- Owner-facing view analytics ---
//
// The event log (`artifact_views`) already carries everything below on every
// row. These are read-only aggregates for one artifact's owner — no new
// instrumentation, just different questions asked of data that already exists.

export interface ViewerSummary {
  email: string | null;
  views: number;
  lastVersion: number;
  lastViewedAt: string;
}

/**
 * Every distinct viewer of one artifact: how many times they opened it, and
 * which version they last saw. `email IS NULL` groups every anonymous view
 * into its own row rather than being dropped or folded into a named viewer —
 * SQLite's `GROUP BY` and `IS` both treat NULL as equal to NULL, so this falls
 * out of the grouping for free instead of needing special-casing.
 *
 * `last_version` is a correlated subquery rather than a window function: D1's
 * SQLite build support varies by compatibility date, and a subquery keyed on
 * the same (slug, email) pair — matched with `IS` so the anonymous group
 * matches itself — is the version-agnostic way to get "the version of this
 * group's most recent row".
 */
export async function viewersFor(env: Env, slug: string, limit = 200): Promise<ViewerSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT v1.email AS email,
            COUNT(*) AS views,
            MAX(v1.viewed_at) AS last_viewed_at,
            (SELECT v2.version FROM artifact_views v2
               WHERE v2.slug = v1.slug AND v2.email IS v1.email
               ORDER BY v2.viewed_at DESC, v2.id DESC LIMIT 1) AS last_version
       FROM artifact_views v1
      WHERE v1.slug = ?
      GROUP BY v1.email
      ORDER BY last_viewed_at DESC
      LIMIT ?`
  )
    .bind(slug, limit)
    .all<{ email: string | null; views: number; last_viewed_at: string; last_version: number }>();
  return (results ?? []).map((r) => ({
    email: r.email,
    views: r.views,
    lastVersion: r.last_version,
    lastViewedAt: r.last_viewed_at,
  }));
}

export interface VersionViewSummary {
  version: number;
  total: number;
  unique: number;
  lastViewedAt: string;
}

/** Views grouped by version — which ones are still being opened, so an owner can tell when a rollback is safe. */
export async function viewsByVersion(env: Env, slug: string): Promise<VersionViewSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT version, COUNT(*) AS total, COUNT(DISTINCT email) AS uniq, MAX(viewed_at) AS last_viewed_at
       FROM artifact_views
      WHERE slug = ?
      GROUP BY version
      ORDER BY version DESC`
  )
    .bind(slug)
    .all<{ version: number; total: number; uniq: number; last_viewed_at: string }>();
  return (results ?? []).map((r) => ({
    version: r.version,
    total: r.total,
    unique: r.uniq,
    lastViewedAt: r.last_viewed_at,
  }));
}

export interface ViewSources {
  referrers: { referrer: string | null; count: number }[];
  countries: { country: string | null; count: number }[];
}

/**
 * Where views came from: top referrers and countries, both already captured
 * on every row and never shown until now. A NULL referrer/country groups into
 * its own "unknown" bucket rather than being excluded from the ranking.
 */
export async function viewSources(env: Env, slug: string, limit = 8): Promise<ViewSources> {
  const [referrers, countries] = await Promise.all([
    env.DB.prepare(
      `SELECT referrer, COUNT(*) AS count FROM artifact_views WHERE slug = ?
       GROUP BY referrer ORDER BY count DESC, referrer LIMIT ?`
    )
      .bind(slug, limit)
      .all<{ referrer: string | null; count: number }>(),
    env.DB.prepare(
      `SELECT country, COUNT(*) AS count FROM artifact_views WHERE slug = ?
       GROUP BY country ORDER BY count DESC, country LIMIT ?`
    )
      .bind(slug, limit)
      .all<{ country: string | null; count: number }>(),
  ]);
  return {
    referrers: referrers.results ?? [],
    countries: countries.results ?? [],
  };
}

export async function listGrants(env: Env, slug: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT email FROM artifact_grants WHERE slug = ? ORDER BY email"
  )
    .bind(slug)
    .all<{ email: string }>();
  return (results ?? []).map((r) => r.email);
}

/** Remove an email from every artifact's grant list (when deleting a user). */
export async function removeEmailFromAllGrants(env: Env, email: string): Promise<void> {
  await env.DB.prepare("DELETE FROM artifact_grants WHERE email = ?").bind(email.toLowerCase()).run();
}

/** All grants grouped by slug (for the admin dashboard). */
export async function allGrants(env: Env): Promise<Map<string, string[]>> {
  const { results } = await env.DB.prepare(
    "SELECT slug, email FROM artifact_grants ORDER BY slug, email"
  ).all<{ slug: string; email: string }>();
  const map = new Map<string, string[]>();
  for (const r of results ?? []) {
    const list = map.get(r.slug) ?? [];
    list.push(r.email);
    map.set(r.slug, list);
  }
  return map;
}

/** All slugs a given email has been granted (for gallery filtering). */
export async function grantedSlugs(env: Env, email: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare(
    "SELECT slug FROM artifact_grants WHERE email = ?"
  )
    .bind(email.toLowerCase())
    .all<{ slug: string }>();
  return new Set((results ?? []).map((r) => r.slug));
}

export async function hasGrant(env: Env, slug: string, email: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM artifact_grants WHERE slug = ? AND email = ?"
  )
    .bind(slug, email.toLowerCase())
    .first<{ ok: number }>();
  return !!row;
}

// --- Waitlist ---

/**
 * Insert an email into the waitlist, or no-op if already present. The
 * uniqueness check and insert happen in one statement so concurrent
 * submissions of the same email can't race into duplicate rows.
 */
export async function addToWaitlist(env: Env, email: string, now: string): Promise<boolean> {
  const clean = email.trim().toLowerCase();
  const row = await env.DB.prepare(
    "INSERT INTO waitlist (email, created_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING RETURNING id"
  )
    .bind(clean, now)
    .first<{ id: number }>();
  return row !== null;
}

/** Replace an artifact's visibility and its full grant list atomically. */
export async function setAccess(
  env: Env,
  slug: string,
  visibility: "restricted" | "everyone",
  emails: string[],
  now: string
): Promise<void> {
  const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const stmts = [
    env.DB.prepare("UPDATE artifacts SET visibility = ?, updated_at = ? WHERE slug = ?").bind(
      visibility,
      now,
      slug
    ),
    env.DB.prepare("DELETE FROM artifact_grants WHERE slug = ?").bind(slug),
    ...clean.map((email) =>
      env.DB.prepare(
        "INSERT INTO artifact_grants (slug, email, created_at) VALUES (?, ?, ?)"
      ).bind(slug, email, now)
    ),
  ];
  await env.DB.batch(stmts);
}
