#!/usr/bin/env node
// Read-only structural check of the Claude Code marketplace + plugin in this
// repo. Touches nothing, talks to nothing — safe to run any time.
//
// Usage:
//   node scripts/validate-plugin.mjs      # exits 1 on any error
//
// What it catches that a test cannot: the real files. The pure rules live in
// validate-plugin.lib.mjs and are unit-tested; this walks the tree and applies
// them, so a renamed script, a skill whose directory and frontmatter disagree,
// or a token pasted into a doc all fail here before they reach a user.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import {
  checkPluginManifest,
  checkMarketplace,
  checkMarketplaceEntryMatchesManifest,
  checkMarketplaceUrls,
  checkCommand,
  checkSkill,
  checkSkillNameMatchesDir,
  checkPluginRootRefs,
  checkMcpConfig,
  checkMcpAgreement,
  checkChangelog,
  checkCommunityMarketplaceClaims,
  checkSubmissionPacket,
  findSecrets,
  mergeResults,
} from "./validate-plugin.lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARKETPLACE = join(ROOT, ".claude-plugin", "marketplace.json");
const PLUGINS_DIR = join(ROOT, "plugins");
const DOCS_DIR = join(ROOT, "docs");
const SUBMISSION_DOC = join(DOCS_DIR, "ANTHROPIC_PLUGIN_SUBMISSION.md");

const errors = [];
const ok = [];

function collect(result) {
  errors.push(...result.errors);
  ok.push(...result.ok);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    errors.push(`${relative(ROOT, path)}: ${e.message}`);
    return null;
  }
}

/** Every file under `dir`, recursively, as paths relative to it. */
function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
}

// --- Marketplace -------------------------------------------------------------

if (!existsSync(MARKETPLACE)) {
  errors.push(".claude-plugin/marketplace.json is missing — without it the repo is not installable with `/plugin marketplace add`");
}

const pluginDirs = existsSync(PLUGINS_DIR)
  ? readdirSync(PLUGINS_DIR).filter((n) => existsSync(join(PLUGINS_DIR, n, ".claude-plugin", "plugin.json")))
  : [];

const marketplace = existsSync(MARKETPLACE) ? readJson(MARKETPLACE) : null;
if (marketplace) {
  collect(checkMarketplace(marketplace, pluginDirs.map((n) => `./plugins/${n}`)));
  collect(checkMarketplaceUrls(marketplace));
}

/** Marketplace entry by the plugin directory it points at, for the agreement check below. */
const entryBySource = new Map(
  (Array.isArray(marketplace?.plugins) ? marketplace.plugins : [])
    .filter((entry) => typeof entry?.source === "string")
    .map((entry) => [entry.source, entry])
);

if (!pluginDirs.length) errors.push("plugins/ contains no plugin with a .claude-plugin/plugin.json");

// --- Each plugin -------------------------------------------------------------

for (const name of pluginDirs) {
  const pluginRoot = join(PLUGINS_DIR, name);
  const rel = (p) => relative(ROOT, p).split("\\").join("/");

  const manifest = readJson(join(pluginRoot, ".claude-plugin", "plugin.json"));
  if (manifest) {
    collect(checkPluginManifest(manifest));
    if (manifest.name && manifest.name !== name) {
      errors.push(`plugins/${name}: manifest name is "${manifest.name}" — it must match the directory name`);
    }
    collect(checkMarketplaceEntryMatchesManifest(entryBySource.get(`./plugins/${name}`), manifest));
  }

  // Components must sit at plugin root, never inside .claude-plugin/.
  for (const component of ["commands", "agents", "skills", "hooks"]) {
    if (existsSync(join(pluginRoot, ".claude-plugin", component))) {
      errors.push(`plugins/${name}/.claude-plugin/${component}/ must move to plugins/${name}/${component}/ — Claude Code only discovers components at plugin root`);
    }
  }

  const exists = (ref) => existsSync(join(pluginRoot, ref));

  const commandsDir = join(pluginRoot, "commands");
  const commands = existsSync(commandsDir) ? readdirSync(commandsDir).filter((f) => f.endsWith(".md")) : [];
  if (!commands.length) errors.push(`plugins/${name}: no commands found`);
  for (const file of commands) {
    const path = join(commandsDir, file);
    const text = readFileSync(path, "utf8");
    collect(mergeResults([checkCommand(rel(path), text), checkPluginRootRefs(rel(path), text, exists)]));
  }

  const skillsDir = join(pluginRoot, "skills");
  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir).filter((d) => existsSync(join(skillsDir, d, "SKILL.md")))
    : [];
  if (!skills.length) errors.push(`plugins/${name}: no skills found (skills/<name>/SKILL.md)`);
  for (const skill of skills) {
    const path = join(skillsDir, skill, "SKILL.md");
    const text = readFileSync(path, "utf8");
    collect(
      mergeResults([
        checkSkill(rel(path), text),
        checkSkillNameMatchesDir(skill, text),
        checkPluginRootRefs(rel(path), text, exists),
      ])
    );
    // A skill that points at references/foo.md it does not ship is a dead end
    // the model only discovers mid-task.
    for (const m of text.matchAll(/`(references|examples|scripts)\/([A-Za-z0-9._-]+)`/g)) {
      const ref = `skills/${skill}/${m[1]}/${m[2]}`;
      if (!exists(ref)) errors.push(`${rel(path)}: references ${m[1]}/${m[2]}, which does not exist`);
    }
  }

  // MCP servers the plugin registers on install (issue #39). Optional — but a
  // broken one fails on the user's machine at connect time, not here, so it is
  // checked as strictly as a command. Declared in both places by convention, so
  // both are checked and then compared.
  const mcpPath = join(pluginRoot, ".mcp.json");
  const mcpFile = existsSync(mcpPath) ? readJson(mcpPath) : null;
  if (mcpFile) collect(checkMcpConfig(`plugins/${name}/.mcp.json`, mcpFile, exists));
  if (manifest?.mcpServers) {
    collect(checkMcpConfig(`plugins/${name}/.claude-plugin/plugin.json`, { mcpServers: manifest.mcpServers }, exists));
    collect(checkMcpAgreement(manifest.mcpServers, mcpFile?.mcpServers));
  }

  if (!existsSync(join(pluginRoot, "README.md"))) errors.push(`plugins/${name}: no README.md`);

  // A published plugin is pinned to a commit, so its changelog is the only place
  // a reviewer or user can read what the declared version actually contains.
  const changelogPath = join(pluginRoot, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    errors.push(`plugins/${name}: no CHANGELOG.md — a version a user can install needs release notes they can read`);
  } else if (manifest?.version) {
    collect(checkChangelog(`plugins/${name}/CHANGELOG.md`, readFileSync(changelogPath, "utf8"), manifest.version));
  }

  // --- Secrets ---------------------------------------------------------------
  for (const file of walk(pluginRoot)) {
    const found = findSecrets(readFileSync(join(pluginRoot, file), "utf8"));
    for (const kind of found) errors.push(`plugins/${name}/${file}: looks like a committed ${kind} — use a placeholder`);
  }

  ok.push(`plugins/${name}: ${commands.length} command(s), ${skills.length} skill(s)`);
}

if (marketplace) {
  const found = findSecrets(readFileSync(MARKETPLACE, "utf8"));
  for (const kind of found) errors.push(`.claude-plugin/marketplace.json: looks like a committed ${kind}`);
}

// --- What the docs claim ------------------------------------------------------

// Every markdown page a stranger might read, checked for the one claim this repo
// cannot make: that the plugin is listed in Anthropic's community marketplace.
const markdownPages = [
  ...readdirSync(ROOT).filter((f) => f.endsWith(".md")),
  ...walk(DOCS_DIR).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
  ...walk(PLUGINS_DIR).filter((f) => f.endsWith(".md")).map((f) => `plugins/${f}`),
];
for (const page of markdownPages) {
  collect(checkCommunityMarketplaceClaims(page, readFileSync(join(ROOT, page), "utf8")));
}

// The submission packet restates manifest fields for a human to type into a
// form. It is checked against the manifest for the same reason the marketplace
// entry is: nothing about the drift is visible where it does damage.
if (!existsSync(SUBMISSION_DOC)) {
  errors.push("docs/ANTHROPIC_PLUGIN_SUBMISSION.md is missing — the submission packet is what a human transcribes into the form");
} else {
  const submissionPlugin = "rtfx";
  const manifestPath = join(PLUGINS_DIR, submissionPlugin, ".claude-plugin", "plugin.json");
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : null;
  if (manifest) {
    collect(
      checkSubmissionPacket("docs/ANTHROPIC_PLUGIN_SUBMISSION.md", readFileSync(SUBMISSION_DOC, "utf8"), {
        version: manifest.version,
        repository: manifest.repository,
        pluginPath: `./plugins/${submissionPlugin}`,
      })
    );
  }
}

// --- Report ------------------------------------------------------------------

if (ok.length) {
  console.log("Valid:");
  for (const m of ok) console.log(`  ✓ ${m}`);
}
if (errors.length) {
  console.log("\nErrors:");
  for (const m of errors) console.log(`  ✗ ${m}`);
  console.log(`\n${errors.length} problem(s).`);
  process.exit(1);
}
console.log("\nPlugin structure is valid.");
