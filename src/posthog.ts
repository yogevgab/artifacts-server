import type { Env } from "./env";

/**
 * PostHog wiring for the dashboard (`/admin`) only.
 *
 * Nothing in this file runs anywhere else. The public site, the viewer shell
 * and the artifact content host never import it — see `src/portal.ts`, the
 * only caller. Everything here is inert until:
 *
 *  1. `POSTHOG_KEY` is set (an operator opted the deployment in at all), and
 *  2. the person looking at the dashboard accepts the consent choice in
 *     `src/consent.ts` (`analyticsConsentNotice`/`analyticsConsentScript`).
 *
 * `posthogConfig` is the single gate for (1): every other function in this
 * file, and every caller, treats `null` as "say and do nothing about this."
 */
export interface PostHogConfig {
  key: string;
  host: string;
}

/** PostHog Cloud's US region — the default `api_host` used when a key is set but a host is not. */
const DEFAULT_HOST = "https://us.i.posthog.com";

/**
 * Reads `POSTHOG_KEY`/`POSTHOG_HOST` from the environment. Returns `null` when
 * no key is set — the only state a self-hosted operator who never opted in
 * should ever produce, and the only state this whole feature is required to
 * be silent and inert in (see docs/PUBLIC_SITE.md and the PostHog rollout
 * report).
 */
export function posthogConfig(env: Env): PostHogConfig | null {
  const key = env.POSTHOG_KEY?.trim();
  if (!key) return null;
  const host = env.POSTHOG_HOST?.trim() || DEFAULT_HOST;
  return { key, host };
}

/** The origin a `posthog.init` ingestion/config host resolves to, for CSP. */
function originOf(host: string): string {
  try {
    return new URL(host).origin;
  } catch {
    return host;
  }
}

/**
 * PostHog's web snippet loads its actual bundle from a sibling `-assets.`
 * subdomain of the ingestion host on PostHog Cloud (see the official snippet
 * in `src/consent.ts`: `s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")`).
 * A self-hosted `POSTHOG_HOST` that doesn't match that pattern serves both
 * from the same origin, so this simply falls back to the ingestion origin —
 * harmless to list twice in a CSP allow-list.
 */
function assetOrigin(host: string): string {
  try {
    const u = new URL(host);
    return `${u.protocol}//${u.hostname.replace(".i.posthog.com", "-assets.i.posthog.com")}`;
  } catch {
    return host;
  }
}

/**
 * Additive CSP for `/admin`, delivered as a `<meta http-equiv>` tag (see
 * `layout()` in `src/pages.ts`) rather than a response header — this app has
 * no per-route header middleware for `/admin` to hook today. A meta tag
 * cannot carry `frame-ancestors`, `report-uri` or `sandbox`, which is fine
 * here: this policy only ever widens `script-src`/`connect-src`/`worker-src`
 * to the two PostHog hosts, and only on pages that pass a `PostHogConfig`.
 * The artifact content host's CSP (`src/serve.ts`) is untouched by this file.
 */
export function posthogCsp(cfg: PostHogConfig): string {
  const ingest = originOf(cfg.host);
  const assets = assetOrigin(cfg.host);
  const hosts = Array.from(new Set([ingest, assets])).join(" ");
  // worker-src blob: is what session replay's compression worker needs — see
  // PostHog's own CSP troubleshooting guidance for "recordings not captured."
  return `script-src 'self' 'unsafe-inline' ${hosts}; connect-src 'self' ${hosts}; worker-src 'self' blob:;`;
}
