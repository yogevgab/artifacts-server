#!/usr/bin/env node
/**
 * One-shot setup for artifacts-server.
 *
 * Creates the R2 bucket + D1 database, applies the schema, wires Cloudflare
 * Access (two apps, policies, a CLI service token), fills in wrangler.jsonc,
 * and deploys.
 *
 * Prerequisites:
 *   - `npx wrangler login` (Workers/R2/D1/deploy use this OAuth session)
 *   - Your domain is a zone on the same Cloudflare account
 *   - Cloudflare Zero Trust enabled (pick a team name once in the dashboard)
 *
 * Inputs (env vars or interactive prompt):
 *   DOMAIN               hostname to serve from, e.g. artifacts.example.com
 *   ADMIN_EMAIL          your admin email (comma-separated for several)
 *   ACCESS_TEAM_DOMAIN   e.g. myteam.cloudflareaccess.com
 *   CF_API_TOKEN         token with "Access: Apps and Policies — Edit"
 *                        (omit / set SKIP_ACCESS=1 to configure Access later)
 *
 * Usage:  npx wrangler login && npm run setup
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(ROOT, "wrangler.jsonc");
const CF_API = "https://api.cloudflare.com/client/v4";

const log = (m) => console.log(`\x1b[36m▸\x1b[0m ${m}`);
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], ...opts });
}
function wrangler(args, opts = {}) {
  return sh("npx", ["--yes", "wrangler@4", ...args], opts);
}

async function prompt(rl, label, envVal) {
  if (envVal) return envVal;
  const v = (await rl.question(`  ${label}: `)).trim();
  return v;
}

/** Replace the value of a JSON string key in wrangler.jsonc, preserving comments. */
function patch(key, value) {
  let content = readFileSync(WRANGLER, "utf8");
  const re = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
  if (!re.test(content)) die(`could not find "${key}" in wrangler.jsonc`);
  content = content.replace(re, `$1${JSON.stringify(value)}`);
  writeFileSync(WRANGLER, content);
}

async function cf(token, method, path, body) {
  const res = await fetch(`${CF_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!data?.success) die(`Cloudflare API ${method} ${path} failed: ${JSON.stringify(data?.errors ?? res.status)}`);
  return data.result;
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    log("Checking wrangler login…");
    let whoami;
    try {
      whoami = wrangler(["whoami"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      die("run `npx wrangler login` first");
    }
    const accountId = (whoami.match(/([0-9a-f]{32})/) || [])[1];
    if (!accountId) die("could not determine account id from `wrangler whoami`");
    ok(`account ${accountId}`);

    console.log("\nConfiguration (leave blank to accept env / skip):");
    const domain = await prompt(rl, "Domain (e.g. artifacts.example.com)", process.env.DOMAIN);
    if (!domain) die("DOMAIN is required");
    const adminEmail = await prompt(rl, "Admin email(s)", process.env.ADMIN_EMAIL);
    if (!adminEmail) die("ADMIN_EMAIL is required");
    const teamDomain = await prompt(rl, "Access team domain (…cloudflareaccess.com)", process.env.ACCESS_TEAM_DOMAIN);
    const skipAccess = process.env.SKIP_ACCESS === "1" || !teamDomain;
    const apiToken = skipAccess ? "" : await prompt(rl, "CF API token (Access: Apps and Policies — Edit)", process.env.CF_API_TOKEN);

    // --- Storage ---
    log("Creating R2 bucket 'artifacts-files'…");
    try { wrangler(["r2", "bucket", "create", "artifacts-files"], { stdio: ["pipe", "pipe", "pipe"] }); ok("bucket ready"); }
    catch { ok("bucket already exists"); }

    log("Creating D1 database 'artifacts-meta'…");
    try { wrangler(["d1", "create", "artifacts-meta"], { stdio: ["pipe", "pipe", "pipe"] }); } catch { /* may already exist */ }
    const list = JSON.parse(wrangler(["d1", "list", "--json"], { stdio: ["pipe", "pipe", "pipe"] }));
    const db = list.find((d) => d.name === "artifacts-meta");
    if (!db?.uuid) die("could not find D1 database id");
    ok(`D1 ${db.uuid}`);

    // --- Base config ---
    log("Writing wrangler.jsonc…");
    patch("pattern", domain);
    patch("database_id", db.uuid);
    patch("ADMIN_EMAILS", adminEmail);
    patch("CF_ACCOUNT_ID", accountId);
    if (teamDomain) patch("ACCESS_TEAM_DOMAIN", teamDomain);

    log("Applying database schema…");
    wrangler(["d1", "execute", "artifacts-meta", "--remote", "--file", "schema.sql", "-y"]);
    ok("schema applied");

    log("Deploying Worker (creates the custom domain)…");
    wrangler(["deploy"]);
    ok(`deployed to https://${domain}`);

    if (skipAccess) {
      console.log("\nSkipped Cloudflare Access setup. See README → Deployment to finish it.");
      ok("Base deploy complete.");
      return;
    }

    // --- Cloudflare Access ---
    log("Creating Access service token 'artifacts-cli'…");
    const tokens = await cf(apiToken, "GET", `/accounts/${accountId}/access/service_tokens`);
    let svc = tokens.find((t) => t.name === "artifacts-cli");
    let clientId, clientSecret;
    if (svc) { clientId = svc.client_id; ok("service token exists (secret not re-shown)"); }
    else {
      svc = await cf(apiToken, "POST", `/accounts/${accountId}/access/service_tokens`, { name: "artifacts-cli", duration: "8760h" });
      clientId = svc.client_id; clientSecret = svc.client_secret;
      ok("service token created");
    }
    const tokenId = svc.id;

    const emailPolicy = { name: "artifacts — humans", decision: "allow", include: [{ email: { email: adminEmail.split(",")[0].trim() } }], precedence: 1 };
    const cliPolicy = { name: "artifacts — cli", decision: "non_identity", include: [{ service_token: { token_id: tokenId } }], precedence: 2 };

    async function ensureApp(name, destinations) {
      const apps = await cf(apiToken, "GET", `/accounts/${accountId}/access/apps`);
      let app = apps.find((a) => a.name === name);
      const payload = { name, type: "self_hosted", destinations, session_duration: "24h", app_launcher_visible: false, policies: [emailPolicy, cliPolicy] };
      if (app) app = await cf(apiToken, "PUT", `/accounts/${accountId}/access/apps/${app.id}`, payload);
      else app = await cf(apiToken, "POST", `/accounts/${accountId}/access/apps`, payload);
      return app;
    }

    log("Creating Access applications + policies…");
    const viewer = await ensureApp("Artifacts (viewers)", [{ type: "public", uri: domain }]);
    const admin = await ensureApp("Artifacts (admin)", [
      { type: "public", uri: `${domain}/admin` },
      { type: "public", uri: `${domain}/api` },
    ]);
    const policies = await cf(apiToken, "GET", `/accounts/${accountId}/access/apps/${viewer.id}/policies`);
    const humans = policies.find((p) => p.decision === "allow");
    ok("Access apps configured");

    log("Writing Access config + deploying…");
    patch("ACCESS_AUD", `${viewer.aud},${admin.aud}`);
    patch("ACCESS_VIEWER_APP_ID", viewer.id);
    patch("ACCESS_VIEWER_POLICY_ID", humans.id);
    patch("ADMIN_SERVICE_TOKENS", clientId);
    wrangler(["deploy"]);

    log("Storing CF_API_TOKEN secret…");
    wrangler(["secret", "put", "CF_API_TOKEN"], { input: apiToken, stdio: ["pipe", "pipe", "pipe"] });
    ok("secret stored");

    console.log("\n\x1b[32m✓ Done!\x1b[0m Your artifacts server is live at " + `https://${domain}`);
    console.log("\nAdd yourself + others under Users in the /admin dashboard.");
    console.log("\nCLI credentials (save these — the secret is shown only once):");
    console.log(`  export ARTIFACTS_URL=https://${domain}`);
    console.log(`  export CF_ACCESS_CLIENT_ID=${clientId}`);
    console.log(`  export CF_ACCESS_CLIENT_SECRET=${clientSecret ?? "<existing token — recreate in Zero Trust if lost>"}`);
  } finally {
    rl.close();
  }
}

main().catch((e) => die(e.message));
