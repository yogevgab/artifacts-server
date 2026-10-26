#!/usr/bin/env node
/**
 * Tell IndexNow search engines (Bing, Yandex, Seznam, Naver, ...) that the public
 * pages changed. Run it after a deploy:
 *
 *     INDEXNOW_KEY=<key> node scripts/indexnow-ping.mjs
 *
 * The key must be the same value the Worker has as `INDEXNOW_KEY`, because the
 * Worker serves `https://<host>/<key>.txt` with it and the engines fetch that file
 * to verify you own the host. The key is not in the repo: generate one
 * (8-128 chars, letters, digits, dashes), set it as a Worker var/secret, deploy,
 * then ping.
 *
 * Options (environment):
 *   INDEXNOW_KEY   required
 *   SITE_URL       origin to ping, default https://rtfx.pro
 *
 * Flags:
 *   --dry-run      print the request body instead of sending it
 *
 * The URL list is the live sitemap (`/sitemap.xml`), so it is always exactly the
 * set of indexable pages and nothing gated.
 */

const ENDPOINT = "https://api.indexnow.org/indexnow";
const KEY_RE = /^[A-Za-z0-9-]{8,128}$/;

/** `<loc>` values of a sitemap document. */
export function sitemapUrls(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

/** The IndexNow request body for a host, key and URL list. */
export function indexNowBody(origin, key, urlList) {
  const host = new URL(origin).host;
  return { host, key, keyLocation: `${origin}/${key}.txt`, urlList };
}

async function main() {
  const key = (process.env.INDEXNOW_KEY ?? "").trim();
  if (!KEY_RE.test(key)) {
    console.error("Set INDEXNOW_KEY (8-128 chars: letters, digits, dashes).");
    process.exit(1);
  }
  const origin = (process.env.SITE_URL ?? "https://rtfx.pro").replace(/\/+$/, "");
  const dry = process.argv.includes("--dry-run");

  const sm = await fetch(`${origin}/sitemap.xml`);
  if (!sm.ok) {
    console.error(`Could not read ${origin}/sitemap.xml: HTTP ${sm.status}`);
    process.exit(1);
  }
  const urlList = sitemapUrls(await sm.text());
  if (urlList.length === 0) {
    console.error("The sitemap lists no URLs; nothing to ping.");
    process.exit(1);
  }

  // The engines fetch keyLocation to verify ownership; fail early if it is not live.
  const keyRes = await fetch(`${origin}/${key}.txt`);
  const served = keyRes.ok ? (await keyRes.text()).trim() : "";
  if (served !== key) {
    console.error(
      `${origin}/${key}.txt does not return the key (HTTP ${keyRes.status}). ` +
        "Set INDEXNOW_KEY on the Worker and deploy first."
    );
    process.exit(1);
  }

  const body = indexNowBody(origin, key, urlList);
  if (dry) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  console.log(`IndexNow: HTTP ${res.status} for ${urlList.length} URLs (200/202 = accepted).`);
  if (res.status !== 200 && res.status !== 202) process.exit(1);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
