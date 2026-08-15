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

/** Fields a marketplace entry and a plugin manifest both carry, and must agree on. */
const SHARED_ENTRY_FIELDS = ["version", "description", "homepage", "repository", "license"];

/**
 * A marketplace entry may restate any field from the plugin manifest, and
 * Claude Code shows the *entry* before install while the *manifest* is what
 * gets installed. Two copies of a version string is the drift that matters:
 * `version` in the entry pins the plugin, so an entry left at 1.1.0 after
 * plugin.json moved to 1.2.0 silently stops shipping updates to everyone who
 * already installed it. Nothing about that failure is visible on this machine,
 * which is exactly why it is checked here.
 */
export function checkMarketplaceEntryMatchesManifest(entry, manifest) {
  const errors = [];
  const ok = [];
  if (!entry || !manifest) return { errors, ok };
  const label = entry.name ?? "(unnamed)";

  if (entry.name && manifest.name && entry.name !== manifest.name) {
    errors.push(`marketplace entry "${label}" disagrees with its plugin.json name "${manifest.name}"`);
  }

  for (const field of SHARED_ENTRY_FIELDS) {
    if (entry[field] === undefined || manifest[field] === undefined) continue;
    if (entry[field] !== manifest[field]) {
      errors.push(
        `marketplace entry "${label}" sets ${field} "${entry[field]}" but plugins/${manifest.name}/.claude-plugin/plugin.json says "${manifest[field]}" — bump both or drop it from the entry`
      );
    } else if (field === "version") ok.push(`entry "${label}" pins version ${entry.version}, matching plugin.json`);
  }

  return { errors, ok };
}

/**
 * Every https URL a marketplace entry advertises. A typo'd homepage is a dead
 * link on the install screen, which is the first thing a stranger to the
 * project sees.
 */
export function checkMarketplaceUrls(manifest) {
  const errors = [];
  const ok = [];
  if (!manifest || typeof manifest !== "object") return { errors, ok };

  const candidates = [
    ["owner.url", manifest.owner?.url],
    ...(Array.isArray(manifest.plugins) ? manifest.plugins : []).flatMap((entry) => {
      const label = entry?.name ?? "(unnamed)";
      return [
        [`${label}.homepage`, entry?.homepage],
        [`${label}.repository`, entry?.repository],
        [`${label}.author.url`, entry?.author?.url],
      ];
    }),
  ];

  let checked = 0;
  for (const [where, value] of candidates) {
    if (value === undefined) continue;
    if (typeof value !== "string" || !/^https:\/\/[^\s"']+$/.test(value)) {
      errors.push(`marketplace ${where} must be an https URL, got "${value}"`);
    } else checked++;
  }
  if (checked) ok.push(`${checked} marketplace URL(s) well-formed`);

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
  // not the plugin — it works on the author's machine and nowhere else. Applies
  // to every script the plugin ships, not just the publisher.
  const bare = /(?<!\$\{CLAUDE_PLUGIN_ROOT\}\/)(?<![\w./-])scripts\/[A-Za-z0-9._-]+\.mjs/.exec(text);
  if (bare && !path.endsWith("README.md")) {
    errors.push(`${path}: refers to ${bare[0]} without \${CLAUDE_PLUGIN_ROOT}/ — that path only resolves in the plugin's own directory`);
  }
  return { errors, ok: referenced.size ? [`${path}: ${referenced.size} plugin-root reference(s) resolve`] : [] };
}

/**
 * A plugin's `.mcp.json` — the MCP servers installing it registers (issue #39).
 *
 * Two things this catches that nothing else can. First, an `args` entry pointing
 * at a script that has been renamed: the server then fails to start on the user's
 * machine with a bare ENOENT, long after install. Second, and the reason the rule
 * is strict about it: a credential typed into the `env` block. That block is
 * committed to the repository, so a token there is a published token — the server
 * inherits the shell environment instead, which is why the shipped config has no
 * `env` at all.
 */
export function checkMcpConfig(path, config, exists) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { errors: [`${path}: must be a JSON object`], ok: [] };
  }
  const errors = [];
  const ok = [];
  const servers = config.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return { errors: [`${path}: needs an \`mcpServers\` object`], ok: [] };
  }
  const names = Object.keys(servers);
  if (!names.length) errors.push(`${path}: \`mcpServers\` is empty`);

  for (const name of names) {
    const before = errors.length;
    const server = servers[name];
    if (!KEBAB_CASE.test(name)) errors.push(`${path}: server name "${name}" must be kebab-case`);
    if (!server || typeof server !== "object" || Array.isArray(server)) {
      errors.push(`${path}: server "${name}" must be an object`);
      continue;
    }
    if (typeof server.command !== "string" || !server.command.trim()) {
      errors.push(`${path}: server "${name}" needs a \`command\``);
    }
    const args = server.args ?? [];
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      errors.push(`${path}: server "${name}" \`args\` must be an array of strings`);
    } else {
      for (const arg of args) {
        const m = /^\$\{CLAUDE_PLUGIN_ROOT\}\/(.+)$/.exec(arg);
        if (m && !exists(m[1])) {
          errors.push(`${path}: server "${name}" runs \${CLAUDE_PLUGIN_ROOT}/${m[1]}, which does not exist`);
        } else if (/\.mjs$/.test(arg) && !m) {
          errors.push(`${path}: server "${name}" runs "${arg}" — a script path must start with \${CLAUDE_PLUGIN_ROOT}/ or it resolves against the user's cwd`);
        }
      }
    }
    const env = server.env ?? {};
    if (typeof env !== "object" || Array.isArray(env)) {
      errors.push(`${path}: server "${name}" \`env\` must be an object`);
    } else {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string") {
          errors.push(`${path}: server "${name}" env ${key} must be a string`);
          continue;
        }
        // A committed config is a published config. Only an indirection
        // (`${SOMETHING}`) or an obvious placeholder belongs here.
        const placeholder = /^\s*$/.test(value) || /^\$\{[^}]+\}$/.test(value) || /[…<]/.test(value);
        if (/TOKEN|SECRET|KEY|PASSWORD/i.test(key) && !placeholder) {
          errors.push(`${path}: server "${name}" hard-codes ${key} — leave it out and let the server inherit it from the environment`);
        }
      }
    }
    if (errors.length === before) ok.push(`${path}: server "${name}" → ${server.command}`);
  }
  return { errors, ok };
}

/** Key-order-independent serialization, so "same config" means same config. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A plugin may declare its MCP servers in two places — `mcpServers` inside
 * `plugin.json` and a `.mcp.json` at plugin root — and shipping both is the
 * convention. Two declarations that disagree is precisely the drift worth
 * failing on: whichever one the loader reads, the other is a lie, and which one
 * that is depends on a Claude Code version nobody in this repo controls.
 */
export function checkMcpAgreement(manifestServers, fileServers) {
  if (!manifestServers || !fileServers) return { errors: [], ok: [] };
  if (canonicalJson(manifestServers) === canonicalJson(fileServers)) {
    return { errors: [], ok: ["plugin.json and .mcp.json declare the same MCP servers"] };
  }
  return {
    errors: [
      "plugin.json `mcpServers` and .mcp.json disagree — keep them identical, or ship only one of the two",
    ],
    ok: [],
  };
}

/** Merge several check results into one. */
export function mergeResults(results) {
  return {
    errors: results.flatMap((r) => r.errors ?? []),
    ok: results.flatMap((r) => r.ok ?? []),
  };
}
