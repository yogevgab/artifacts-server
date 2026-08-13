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
  checkCommand,
  checkSkill,
  checkSkillNameMatchesDir,
  checkPluginRootRefs,
  findSecrets,
  mergeResults,
} from "./validate-plugin.lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARKETPLACE = join(ROOT, ".claude-plugin", "marketplace.json");
const PLUGINS_DIR = join(ROOT, "plugins");

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
}

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

  if (!existsSync(join(pluginRoot, "README.md"))) errors.push(`plugins/${name}: no README.md`);

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
