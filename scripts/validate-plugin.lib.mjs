// Pure checks for the Claude Code plugin under plugins/rtfx.
//
// Same split as validate-deploy-config: everything here is a function over plain
// data so the test suite can exercise it inside the Workers pool, while
// validate-plugin.mjs does the filesystem walk.
//
// The rules encode what Claude Code actually requires to load a plugin —
// manifest in `.claude-plugin/`, components at plugin root, one SKILL.md per
// skill directory — plus the two things a repo can get wrong silently: a
// component referencing a path that no longer exists, and a real credential
// pasted in where a placeholder belongs.

/** Component directory names Claude Code auto-discovers, at plugin root. */
export const COMPONENT_DIRS = ["commands", "agents", "skills", "hooks"];

/** kebab-case: what plugin, command and skill names must be. */
export const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * Split YAML frontmatter off a markdown file. Only the flat `key: value` shape
 * Claude Code uses is parsed — enough to validate, and it never silently
 * "succeeds" on something more complex, because unknown lines are ignored
 * rather than guessed at.
 */
export function parseFrontmatter(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const raw = text.slice(text.indexOf("\n") + 1, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const frontmatter = {};
  let lastKey = null;
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (match) {
      lastKey = match[1];
      frontmatter[lastKey] = match[2].trim().replace(/^["']|["']$/g, "");
    } else if (lastKey && /^\s+\S/.test(line)) {
      // A folded continuation line — keep it, so a wrapped description still
      // reads as one value rather than looking empty.
      frontmatter[lastKey] = `${frontmatter[lastKey]} ${line.trim()}`.trim();
    }
  }
  return { frontmatter, body };
}

/**
 * Things that look like live credentials. The plugin's docs are full of the
 * *shape* of a token on purpose, so the patterns match a plausible secret
 * (long, high-entropy tail) and not the `rtfx_…` placeholder used everywhere.
 */
const SECRET_PATTERNS = [
  { name: "rtfx API token", re: /\brtfx_[A-Za-z0-9]{6,}_[A-Za-z0-9_-]{12,}/ },
  { name: "Cloudflare Access service token", re: /\b[0-9a-f]{32}\.access\b/ },
  { name: "Cloudflare API token", re: /\bCF_API_TOKEN\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private key block", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

/** Scan any text for a credential that should never have been committed. */
export function findSecrets(text) {
  return SECRET_PATTERNS.filter(({ re }) => re.test(text)).map(({ name }) => name);
}

export function checkPluginManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { errors: ["plugin.json must be a JSON object"], ok: [] };
  }
  const ok = [];
  const { name, version, description } = manifest;

  if (typeof name !== "string" || !name) errors.push("plugin.json is missing a `name`");
  else if (!KEBAB_CASE.test(name)) errors.push(`plugin name "${name}" must be kebab-case`);
  else ok.push(`plugin name "${name}"`);

  if (version !== undefined) {
    if (typeof version !== "string" || !SEMVER.test(version)) {
      errors.push(`plugin version "${version}" must be semver (MAJOR.MINOR.PATCH)`);
    } else ok.push(`version ${version}`);
  }

  if (typeof description !== "string" || description.trim().length < 20) {
    errors.push("plugin.json needs a `description` of at least 20 characters — it is what a user reads before installing");
  } else ok.push("description present");

  return { errors, ok };
}

/**
 * `knownPluginDirs` is the set of directories that actually exist, so a
 * marketplace entry pointing at a moved or renamed plugin fails here rather
 * than at install time on somebody else's machine.
 */
export function checkMarketplace(manifest, knownPluginDirs = []) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { errors: ["marketplace.json must be a JSON object"], ok: [] };
  }
  const ok = [];

  if (typeof manifest.name !== "string" || !KEBAB_CASE.test(manifest.name ?? "")) {
    errors.push(`marketplace name "${manifest.name}" must be kebab-case`);
  } else ok.push(`marketplace "${manifest.name}"`);

  if (!manifest.owner || typeof manifest.owner.name !== "string" || !manifest.owner.name) {
    errors.push("marketplace.json needs an `owner.name`");
  }

  const plugins = manifest.plugins;
  if (!Array.isArray(plugins) || !plugins.length) {
    errors.push("marketplace.json needs a non-empty `plugins` array");
    return { errors, ok };
  }

  const seen = new Set();
  for (const entry of plugins) {
    const label = entry?.name ?? "(unnamed)";
    if (typeof entry?.name !== "string" || !KEBAB_CASE.test(entry.name)) {
      errors.push(`marketplace entry "${label}" needs a kebab-case \`name\``);
    } else if (seen.has(entry.name)) {
      errors.push(`marketplace lists "${entry.name}" more than once`);
    } else seen.add(entry.name);

    if (typeof entry?.source !== "string" || !entry.source.startsWith("./")) {
      errors.push(`marketplace entry "${label}" needs a \`source\` path starting with "./"`);
    } else if (knownPluginDirs.length && !knownPluginDirs.includes(entry.source)) {
      errors.push(`marketplace entry "${label}" points at ${entry.source}, which has no .claude-plugin/plugin.json`);
    } else ok.push(`entry "${label}" → ${entry.source}`);

    if (typeof entry?.description !== "string" || !entry.description.trim()) {
      errors.push(`marketplace entry "${label}" needs a \`description\``);
    }
  }

  return { errors, ok };
}

export function checkCommand(path, text) {
  const errors = [];
  const parsed = parseFrontmatter(text);
  if (!parsed) return { errors: [`${path}: missing YAML frontmatter`], ok: [] };

  const { frontmatter, body } = parsed;
  if (!frontmatter.description) errors.push(`${path}: frontmatter needs a \`description\``);
  else if (frontmatter.description.length > 120) {
    errors.push(`${path}: description is ${frontmatter.description.length} chars — keep it under 120 so /help stays readable`);
  }
  if (!body.trim()) errors.push(`${path}: has no body — the prompt is what the command does`);

  return { errors, ok: errors.length ? [] : [`${path}`] };
}

export function checkSkill(path, text) {
  const errors = [];
  const parsed = parseFrontmatter(text);
  if (!parsed) return { errors: [`${path}: missing YAML frontmatter`], ok: [] };

  const { frontmatter, body } = parsed;
  if (!frontmatter.name) errors.push(`${path}: frontmatter needs a \`name\``);
  else if (!KEBAB_CASE.test(frontmatter.name)) errors.push(`${path}: skill name "${frontmatter.name}" must be kebab-case`);

  if (!frontmatter.description) errors.push(`${path}: frontmatter needs a \`description\``);
  else if (!/\buse when\b/i.test(frontmatter.description)) {
    // A skill is selected by its description alone. One that describes what it
    // *is* rather than when to reach for it never gets picked up.
    errors.push(`${path}: description should say when to use the skill ("Use when …") — that string is the only thing model-side selection sees`);
  }
  if (!body.trim()) errors.push(`${path}: has no body`);

  return { errors, ok: errors.length ? [] : [`${path}`] };
}

/**
 * A skill directory's name and its frontmatter `name` must agree, otherwise the
 * two disagree about what the skill is called and referencing it breaks.
 */
export function checkSkillNameMatchesDir(dirName, text) {
  const parsed = parseFrontmatter(text);
  const declared = parsed?.frontmatter?.name;
  if (!declared || declared === dirName) return { errors: [], ok: [] };
  return { errors: [`skills/${dirName}/SKILL.md declares name "${declared}" — it must match the directory name`], ok: [] };
}

/**
 * Intra-plugin references must go through `${CLAUDE_PLUGIN_ROOT}` and point at a
 * file that exists. `exists` is injected so this stays filesystem-free.
 */
export function checkPluginRootRefs(path, text, exists) {
  const errors = [];
  const referenced = new Set();
  for (const m of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._\/-]+)/g)) referenced.add(m[1]);
  for (const ref of referenced) {
    if (!exists(ref)) errors.push(`${path}: references \${CLAUDE_PLUGIN_ROOT}/${ref}, which does not exist`);
  }
  // A bare `scripts/rtfx.mjs` in a command body resolves against the user's cwd,
  // not the plugin — it works on the author's machine and nowhere else.
  if (/(?<!\$\{CLAUDE_PLUGIN_ROOT\}\/)(?<![\w./-])scripts\/rtfx\.mjs/.test(text) && !path.endsWith("README.md")) {
    errors.push(`${path}: refers to scripts/rtfx.mjs without \${CLAUDE_PLUGIN_ROOT}/ — that path only resolves in the plugin's own directory`);
  }
  return { errors, ok: referenced.size ? [`${path}: ${referenced.size} plugin-root reference(s) resolve`] : [] };
}

/** Merge several check results into one. */
export function mergeResults(results) {
  return {
    errors: results.flatMap((r) => r.errors ?? []),
    ok: results.flatMap((r) => r.ok ?? []),
  };
}
