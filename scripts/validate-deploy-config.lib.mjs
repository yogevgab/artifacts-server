// Pure validation logic for wrangler.jsonc's deploy-readiness, kept free of
// Node built-ins so it can also be imported from the Workers-pool test suite.

export const EXPECTED_APP_HOSTNAME = "rtfx.pro";
export const EXPECTED_CONTENT_HOSTNAME = "a.rtfx.pro";
/**
 * The dedicated remote-MCP hostname. An *app* host, like `rtfx.pro` — it serves
 * `/mcp`, `/oauth` and `/.well-known`, so listing it as a content host would 404
 * the endpoints it exists for. The route is optional (an instance can serve MCP
 * on its app host and nothing breaks); the content-host mistake is not.
 */
export const EXPECTED_MCP_HOSTNAME = "mcp.rtfx.pro";
export const DEFAULT_ADMIN_EMAIL_PLACEHOLDER = "you@example.com";
export const DEFAULT_DATABASE_ID_PLACEHOLDER = "REPLACE_WITH_D1_DATABASE_ID";

/** Strip line and block comments from JSONC, leaving string contents untouched. */
export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next;
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
    } else if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

function routePatterns(config) {
  return (config.routes ?? []).map((r) => (typeof r === "string" ? r : r.pattern)).filter(Boolean);
}

function parseHostnames(raw) {
  return (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Check a parsed wrangler.jsonc for deploy readiness.
 *
 * `errors` are structural mistakes that break the app regardless of provisioning
 * state (e.g. a content hostname with no matching route). `pending` are fields
 * that are legitimately blank until Cloudflare resources are manually provisioned
 * state (D1 database id, admin email, billing ids).
 */
export function checkWranglerConfig(config) {
  const errors = [];
  const pending = [];
  const ok = [];

  const routes = routePatterns(config);
  if (routes.includes(EXPECTED_APP_HOSTNAME)) ok.push(`routes include ${EXPECTED_APP_HOSTNAME}`);
  else errors.push(`routes must include a "${EXPECTED_APP_HOSTNAME}" entry`);

  if (routes.includes(EXPECTED_CONTENT_HOSTNAME)) ok.push(`routes include ${EXPECTED_CONTENT_HOSTNAME}`);
  else errors.push(`routes must include an "${EXPECTED_CONTENT_HOSTNAME}" entry`);

  const vars = config.vars ?? {};
  const contentHosts = parseHostnames(vars.CONTENT_HOSTNAMES);
  if (contentHosts.length === 0) {
    errors.push("vars.CONTENT_HOSTNAMES is empty — artifact content would be served from the app origin");
  } else {
    let contentHostsOk = true;
    for (const host of contentHosts) {
      if (!routes.includes(host)) {
        errors.push(`CONTENT_HOSTNAMES lists "${host}" but no matching routes[] entry exists`);
        contentHostsOk = false;
      }
    }
    if (contentHosts.includes(EXPECTED_APP_HOSTNAME)) {
      errors.push(`CONTENT_HOSTNAMES must not include the app hostname "${EXPECTED_APP_HOSTNAME}"`);
      contentHostsOk = false;
    }
    // The MCP host terminates bearer credentials and serves the OAuth
    // authorization server. Listing it as content would both break it and undo
    // the isolation the split exists for, so it is an error, not a warning.
    if (contentHosts.includes(EXPECTED_MCP_HOSTNAME)) {
      errors.push(
        `CONTENT_HOSTNAMES must not include the remote-MCP hostname "${EXPECTED_MCP_HOSTNAME}" — ` +
          "it is an app host (serves /mcp, /oauth, /.well-known)"
      );
      contentHostsOk = false;
    }
    if (contentHostsOk) ok.push(`CONTENT_HOSTNAMES: ${contentHosts.join(", ")}`);
  }

  // Optional, and reported either way: without the route, `claude mcp add
  // --transport http rtfx https://mcp.rtfx.pro/mcp` resolves nowhere, and the
  // documented onboarding command is the one thing a reader cannot check.
  if (routes.includes(EXPECTED_MCP_HOSTNAME)) {
    ok.push(`routes include ${EXPECTED_MCP_HOSTNAME} (remote MCP / OAuth host)`);
  } else {
    pending.push(
      `routes have no "${EXPECTED_MCP_HOSTNAME}" entry — remote MCP answers on ` +
        `${EXPECTED_APP_HOSTNAME} only, so docs must not advertise the dedicated host`
    );
  }

  const r2 = (config.r2_buckets ?? []).find((b) => b.binding === "FILES");
  if (r2?.bucket_name) ok.push(`R2 binding FILES -> ${r2.bucket_name}`);
  else errors.push('r2_buckets must define a "FILES" binding with a bucket_name');

  const d1 = (config.d1_databases ?? []).find((d) => d.binding === "DB");
  if (!d1?.database_name) {
    errors.push('d1_databases must define a "DB" binding with a database_name');
  } else if (!d1.database_id || d1.database_id === DEFAULT_DATABASE_ID_PLACEHOLDER) {
    pending.push("d1_databases[DB].database_id is a placeholder — run `wrangler d1 create` and fill it in");
  } else {
    ok.push(`D1 binding DB -> ${d1.database_name} (${d1.database_id})`);
  }

  // Transactional email. The binding is restricted to a single sender on
  // purpose — this Worker also serves user-uploaded HTML, so capping the
  // addresses it can send From limits the blast radius of any future bug.
  // `remote: true` is a local-dev convenience that sends REAL mail; it must
  // never be committed.
  const emailBinding = (config.send_email ?? []).find((b) => b && b.name === "EMAIL");
  if (!emailBinding) {
    errors.push('send_email must declare a binding named "EMAIL"');
  } else if (emailBinding.remote) {
    errors.push('send_email binding "EMAIL" must not set "remote" in committed config');
  } else {
    const allowed = emailBinding.allowed_sender_addresses ?? [];
    if (allowed.length === 0) {
      errors.push('send_email binding "EMAIL" must restrict allowed_sender_addresses');
    } else if (vars.MAIL_FROM && !allowed.includes(vars.MAIL_FROM)) {
      errors.push(
        `vars.MAIL_FROM "${vars.MAIL_FROM}" is not in the EMAIL binding's allowed_sender_addresses`
      );
    } else {
      ok.push(`EMAIL binding restricted to ${allowed.join(", ")}`);
    }
  }

  if (!vars.ADMIN_EMAILS || vars.ADMIN_EMAILS === DEFAULT_ADMIN_EMAIL_PLACEHOLDER) {
    pending.push("vars.ADMIN_EMAILS is unset/default — set real admin email(s) before deploying");
  } else {
    ok.push(`ADMIN_EMAILS: ${vars.ADMIN_EMAILS}`);
  }

  for (const key of [
    "LEMONSQUEEZY_STORE_ID",
    "LEMONSQUEEZY_VARIANT_FREE",
    "LEMONSQUEEZY_VARIANT_PRO",
    "LEMONSQUEEZY_VARIANT_TEAM",
  ]) {
    if (!vars[key]) pending.push(`vars.${key} is empty — set Lemon Squeezy billing config before paid launch`);
    else ok.push(`${key} is set`);
  }

  ok.push("SESSION_SECRET and LEMONSQUEEZY_WEBHOOK_SECRET are secrets — verify with `wrangler secret list`");

  return { errors, pending, ok };
}
