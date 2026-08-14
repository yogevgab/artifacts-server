#!/usr/bin/env node
// Read-only deploy-readiness check for wrangler.jsonc. Never touches Cloudflare
// or mutates any file — safe to run any time, including before resources exist.
//
// Usage:
//   node scripts/validate-deploy-config.mjs            # report only, exits 1 on structural errors
//   node scripts/validate-deploy-config.mjs --strict    # also fail if provisioning is incomplete
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkWranglerConfig, stripJsonComments } from "./validate-deploy-config.lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_PATH = join(ROOT, "wrangler.jsonc");

function main() {
  const strict = process.argv.includes("--strict");

  const raw = readFileSync(WRANGLER_PATH, "utf8");
  let config;
  try {
    config = JSON.parse(stripJsonComments(raw));
  } catch (e) {
    console.error(`✗ could not parse wrangler.jsonc: ${e.message}`);
    process.exit(1);
  }

  const { errors, pending, ok } = checkWranglerConfig(config);

  if (ok.length) {
    console.log("Configured:");
    for (const m of ok) console.log(`  ✓ ${m}`);
  }
  if (pending.length) {
    console.log("\nPending (fill in before production launch — see docs/DEPLOY_RTFX.md):");
    for (const m of pending) console.log(`  … ${m}`);
  }
  if (errors.length) {
    console.log("\nErrors:");
    for (const m of errors) console.log(`  ✗ ${m}`);
  }
  console.log("");

  if (errors.length) {
    console.error(`✗ ${errors.length} config error(s) — fix wrangler.jsonc before deploying.`);
    process.exit(1);
  }
  if (strict && pending.length) {
    console.error(`✗ --strict: ${pending.length} item(s) still pending — not ready to deploy.`);
    process.exit(1);
  }
  console.log(
    pending.length ? "No structural errors. Some values are still pending manual provisioning." : "Config looks deploy-ready."
  );
}

main();
