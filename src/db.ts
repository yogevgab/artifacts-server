import type { Env, ArtifactRow, VersionRow, ViewRow } from "./env";

export async function listArtifacts(env: Env): Promise<ArtifactRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM artifacts ORDER BY created_at DESC"
  ).all<ArtifactRow>();
  return results ?? [];
}

export async function getArtifact(env: Env, slug: string): Promise<ArtifactRow | null> {
  return env.DB.prepare("SELECT * FROM artifacts WHERE slug = ?").bind(slug).first<ArtifactRow>();
}

export async function upsertArtifact(env: Env, row: ArtifactRow): Promise<void> {
  // visibility is set on INSERT but intentionally NOT in DO UPDATE SET, so
  // publishing a new version preserves the artifact's existing access setting.
  await env.DB.prepare(
    `INSERT INTO artifacts
       (slug, title, description, type, entry, file_count, size_bytes, created_by, created_at, updated_at, visibility, current_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      row.current_version
    )
    .run();
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
