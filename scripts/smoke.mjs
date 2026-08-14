#!/usr/bin/env node
// End-to-end smoke check against a *running* rtfx deployment.
//
// Why this exists: three bugs shipped in one day while all 909 unit tests
// stayed green (2026-08-14) —
//   1. X-Frame-Options: DENY was stamped on artifact content by app-wide
//      middleware, so a browser refused to render the viewer shell's iframe.
//      The shell rendered perfectly around an empty box.
//   2. A share link (?k=<key>) authorized the entry document but not its
//      subresources — the iframe URL and relative assets arrived with no key
//      and 404'd.
//   3. The permissive CSP written for HTML artifacts (script-src *
//      'unsafe-inline'…) was also applied to PDFs and broke Chrome's built-in
//      PDF viewer.
//
// The common thread: every one is about what a BROWSER does with a response,
// and unit tests only ever asserted markup/headers in isolation — nothing
// exercised the actual request a browser makes for the iframe's src. This
// script closes that gap at the HTTP level: publish real artifacts, fetch the
// shell exactly as a navigation would (Sec-Fetch-Dest: document), extract the
// iframe's src, and fetch THAT — the request that never got made in any unit
// test — asserting on status, bytes and headers.
//
// ============================================================================
// WHAT THIS DOES NOT PROVE
// ============================================================================
// This is not a rendering test. It never launches a browser, never executes
// JavaScript, never lays out a page. Concretely, it CANNOT catch:
//   - Chrome's PDF viewer refusing to instantiate inside a sandboxed iframe
//     (the actual root cause behind bug 3's *symptom* — see the long comment
//     on `sandboxFor()` in src/shell.ts). That failure mode renders a broken-
//     document icon with no failed request and no console error: every HTTP
//     signal looks fine. Only a real browser (Playwright/Puppeteer/
//     chrome-devtools-mcp driving real Chrome) can catch it.
//   - Any visual regression, layout shift, or the scroll-reporter postMessage
//     bridge actually working.
//   - JavaScript inside an artifact actually running correctly.
// If those matter, the next step is a slower, separate browser-driven check
// (e.g. chrome-devtools-mcp) that loads the shell URL in real Chrome and
// inspects the iframe's rendered state — not a replacement for this script,
// a complement to it.
// ============================================================================
//
// Usage:
//   RTFX_API_TOKEN=rtfx_... [ARTIFACTS_URL=https://rtfx.pro] node scripts/smoke.mjs [timestamp]
//
// Env:
//   RTFX_API_TOKEN            required. Minted at /admin/integrations with
//                             scopes: read, publish, manage (manage is needed
//                             to delete what this script creates).
//   ARTIFACTS_URL / RTFX_URL  base URL of the app/API host. Defaults to
//                             https://rtfx.pro (production), matching the
//                             convention in cli/artifacts.mjs and the rtfx
//                             Claude Code plugin.
//   CF_ACCESS_CLIENT_ID       optional. Only for a self-hosted instance that
//   CF_ACCESS_CLIENT_SECRET   still gates every path with Cloudflare Access at
//                             the edge (see docs/DEPLOY_RTFX.md §5e). Sent
//                             alongside the bearer token on API calls, exactly
//                             like cli/artifacts.mjs. Deliberately NOT sent on
//                             the share-link-only fetches in step 8/9 below —
//                             those must prove the link alone is sufficient,
//                             the same as a real recipient's browser.
//
// A timestamp may be passed as the first argument (or via SMOKE_TS) to name
// the run's artifacts deterministically, e.g. for re-running a failed check
// against the same slugs. Defaults to Date.now() — never Math.random(): the
// script is meant to run repeatedly against production, and a slug collision
// from two runs racing is worse than a slug nobody remembers.
//
// Safety: every artifact and share link this script creates is deleted in a
// `finally` block, best-effort, even when an assertion fails partway through.

import {
  resolveConfig,
  authHeaders,
  apiUrl,
  machineApiPath,
  describeNonJsonResponse,
} from "../plugins/rtfx/scripts/rtfx.lib.mjs";

// --- setup -------------------------------------------------------------------

const config = resolveConfig(process.env);

if (!config.hasToken) {
  console.error("✗ RTFX_API_TOKEN is not set — nothing to smoke-test against.");
  console.error("");
  console.error(`  Set RTFX_API_TOKEN to a token minted at ${config.endpoint}/admin/integrations`);
  console.error(`  with scopes: read, publish, manage (manage is required to clean up after`);
  console.error(`  this script). Optionally set ARTIFACTS_URL if not testing ${config.endpoint}.`);
  process.exit(1);
}

// This publishes and deletes REAL artifacts wherever it points, and it points
// at production by default. That default is right for CI — smoke-testing the
// deployment is the whole point — but it made an accidental local run publish
// two artifacts to rtfx.pro that then could not be cleaned up. So an
// interactive run against production has to say so out loud.
const isCI = !!process.env.CI;
const targetsProduction = /(^|\/\/)(www\.)?rtfx\.pro$/.test(new URL(config.endpoint).host);
if (targetsProduction && !isCI && process.env.SMOKE_CONFIRM !== "1") {
  console.error(`refusing to run against production (${config.endpoint}) outside CI.`);
  console.error("  This publishes and then deletes real artifacts.");
  console.error("  Set SMOKE_CONFIRM=1 to do it anyway, or point ARTIFACTS_URL somewhere else.");
  process.exit(2);
}

const ts = process.argv[2] || process.env.SMOKE_TS || String(Date.now());
const SLUG_HTML = `smoke-${ts}-html`;
const SLUG_PDF = `smoke-${ts}-pdf`;

console.log(`== rtfx smoke check ==`);
console.log(`target: ${config.endpoint}`);
console.log(`run id: ${ts}`);

// --- tiny test harness ---------------------------------------------------

class SmokeFailure extends Error {
  constructor(check, meaning, detail) {
    super(`${check} — ${meaning}${detail ? `\n      ${detail}` : ""}`);
    this.check = check;
    this.meaning = meaning;
    this.detail = detail;
  }
}

let stepNum = 0;
function step(label) {
  stepNum++;
  console.log(`\n[${stepNum}] ${label}`);
}

/** Print a passing line, or throw a SmokeFailure naming what broke and why it matters. */
function must(condition, check, meaning, detail) {
  if (!condition) throw new SmokeFailure(check, meaning, detail);
  console.log(`  ✓ ${check}`);
}

// --- HTTP helpers ----------------------------------------------------------

/** A JSON API call against `/api/...`. `machine: true` (default) rewrites to
 *  `/api/machine/...`, the bearer-token-only surface used for publish/delete.
 *  Share-link management is NOT mirrored there (see src/share-routes.ts), so
 *  it must pass `machine: false`. */
async function apiCall(path, init = {}, { machine = true } = {}) {
  const target = machine ? machineApiPath(path) : path;
  const url = apiUrl(config.endpoint, target);
  let res;
  try {
    res = await fetch(url, { ...init, headers: { ...authHeaders(config), ...(init.headers ?? {}) } });
  } catch (e) {
    throw new SmokeFailure(
      `reach ${url}`,
      "the base URL is unreachable — check ARTIFACTS_URL, DNS and TLS",
      e.message
    );
  }
  let body = null;
  let isJson = false;
  try {
    body = await res.json();
    isJson = true;
  } catch {
    /* not JSON */
  }
  if (!isJson) {
    const { message, hint } = describeNonJsonResponse(url, res.url);
    throw new SmokeFailure(`call ${target}`, hint, `${message} (HTTP ${res.status})`);
  }
  return { res, body, url };
}

/** A raw content fetch — no JSON parsing, headers/body inspected directly.
 *  This is deliberately separate from `apiCall`: the whole point of this
 *  script is to make the exact request a browser makes for artifact content,
 *  and a browser does not send `Accept: application/json`. */
async function rawFetch(url, init = {}) {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new SmokeFailure(
      `reach ${url}`,
      "the content host is unreachable — check DNS, TLS, and CONTENT_HOSTNAMES routing",
      e.message
    );
  }
}

/** Extract the first `<iframe src="...">` from shell HTML, or null. */
function extractIframeSrc(html) {
  const m = /<iframe\b[^>]*\ssrc="([^"]*)"/i.exec(html);
  if (!m) return null;
  return m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"');
}

/** Pull the `name=value` pair off a Set-Cookie line (drop attributes). */
function cookiePair(setCookieLine) {
  return setCookieLine.split(";")[0].trim();
}

// --- fixtures ----------------------------------------------------------------
// Deliberately tiny: this script proves the HTTP contract, not that the
// content is realistic. Both fixtures embed `ts` so a run is identifiable if
// ever inspected manually before cleanup runs.

const HTML_BYTES = new TextEncoder().encode(
  `<!doctype html><html><head><meta charset="utf-8"><title>rtfx smoke ${ts}</title></head>` +
    `<body><h1>rtfx smoke test ${ts}</h1></body></html>`
);

// The smallest widely-recognized valid PDF shape: a catalog, a one-page pages
// tree, and a trailer. No xref table (most readers tolerate that; this script
// never renders it, it only needs `%PDF` magic bytes plus enough structure to
// be an honest fixture rather than four bytes wearing a .pdf extension).
const PDF_BYTES = new TextEncoder().encode(
  `%PDF-1.4\n` +
    `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n` +
    `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n` +
    `% rtfx smoke ${ts}\n` +
    `trailer<</Root 1 0 R/Size 4>>\n` +
    `%%EOF\n`
);

// --- main ----------------------------------------------------------------

const created = { htmlSlug: null, pdfSlug: null, linkId: null, linkSlug: null };

async function publish(slug, title, filename, bytes, mimeType) {
  const form = new FormData();
  form.set("slug", slug);
  form.set("title", title);
  form.set("file", new File([bytes], filename, { type: mimeType }));
  const { res, body, url } = await apiCall("/api/artifacts", { method: "POST", body: form });
  must(
    res.ok,
    `publish ${slug}`,
    "publishing must succeed for the rest of this check to mean anything",
    res.ok ? "" : `HTTP ${res.status}: ${body?.detail || body?.error || url}`
  );
  return body; // { slug, url, type, file_count, version }
}

/** Fetch the viewer shell as a real navigation would (bug 1/3 setup) and
 *  return { html, iframeUrl }. */
async function fetchShell(artifactUrl, extraHeaders) {
  const res = await rawFetch(artifactUrl, {
    headers: { "Sec-Fetch-Dest": "document", ...extraHeaders },
  });
  const html = res.ok ? await res.text() : "";
  return { res, html, iframeSrc: html ? extractIframeSrc(html) : null };
}

async function main() {
  // --- 1/2: publish -----------------------------------------------------
  step("publish an HTML artifact and a PDF artifact via the machine API");
  const htmlArtifact = await publish(SLUG_HTML, `rtfx smoke (html) ${ts}`, "index.html", HTML_BYTES, "text/html");
  created.htmlSlug = SLUG_HTML;
  must(htmlArtifact.type === "single", "html artifact type", "expected a single-file HTML artifact", `got "${htmlArtifact.type}"`);

  const pdfArtifact = await publish(SLUG_PDF, `rtfx smoke (pdf) ${ts}`, "smoke.pdf", PDF_BYTES, "application/pdf");
  created.pdfSlug = SLUG_PDF;
  must(pdfArtifact.type === "pdf", "pdf artifact type", "expected the upload to be sniffed as a PDF by its magic bytes", `got "${pdfArtifact.type}"`);

  // --- HTML: shell + iframe (bug 1 & regression-in-general) --------------
  step("fetch the HTML artifact's viewer shell as a browser navigation would");
  const htmlShell = await fetchShell(htmlArtifact.url, authHeaders(config));
  must(htmlShell.res.status === 200, "shell responds 200", "a navigation to a published artifact must render, not error", `HTTP ${htmlShell.res.status}`);
  must(
    (htmlShell.res.headers.get("content-type") || "").startsWith("text/html"),
    "shell content-type is text/html",
    "the shell itself is our own markup — the browser expects HTML here"
  );
  must(htmlShell.iframeSrc !== null, "shell contains an <iframe src=…>", "the shell's whole job is to frame the artifact — no iframe means nothing would ever render, exactly what bug 1 looked like from the outside");
  const htmlIframeUrl = new URL(htmlShell.iframeSrc, htmlArtifact.url).toString();
  console.log(`      iframe src: ${htmlShell.iframeSrc}`);

  step("fetch the iframe's src — the request a unit test never makes (catches bug 1 & 3)");
  const htmlFrame = await rawFetch(htmlIframeUrl, { headers: authHeaders(config) });
  const htmlFrameBytes = new Uint8Array(await htmlFrame.arrayBuffer());
  must(htmlFrame.status === 200, "iframe content responds 200", "the shell renders around this response — anything but 200 is the empty-box bug", `HTTP ${htmlFrame.status}`);
  must(htmlFrameBytes.byteLength > 0, "iframe content is non-empty", "a 200 with zero bytes is as broken as a 404 for what the browser puts inside the frame");
  must(
    (htmlFrame.headers.get("content-type") || "").startsWith("text/html"),
    "iframe content-type is text/html",
    "the browser decides how to render the frame from this header"
  );
  const htmlFrameXfo = htmlFrame.headers.get("x-frame-options");
  must(
    !htmlFrameXfo || htmlFrameXfo.toUpperCase() !== "DENY",
    "artifact content does not send X-Frame-Options: DENY",
    "this is bug 1 exactly: app-wide middleware stamps DENY on any response that doesn't set its own XFO, and a framed DENY response never renders — the shell looks fine around an empty box",
    htmlFrameXfo ? `got "${htmlFrameXfo}"` : "no X-Frame-Options header at all"
  );

  // --- PDF: shell + iframe + CSP (bug 3) ----------------------------------
  step("fetch the PDF artifact's viewer shell");
  const pdfShell = await fetchShell(pdfArtifact.url, authHeaders(config));
  must(pdfShell.res.status === 200, "shell responds 200", "same as the HTML case — a navigation must render", `HTTP ${pdfShell.res.status}`);
  must(pdfShell.iframeSrc !== null, "shell contains an <iframe src=…>", "the PDF viewer is also framed — see src/shell.ts sandboxFor()");
  const pdfIframeUrl = new URL(pdfShell.iframeSrc, pdfArtifact.url).toString();
  console.log(`      iframe src: ${pdfShell.iframeSrc}`);

  step("fetch the PDF iframe's src and check its CSP (catches bug 3)");
  const pdfFrame = await rawFetch(pdfIframeUrl, { headers: authHeaders(config) });
  const pdfFrameBytes = new Uint8Array(await pdfFrame.arrayBuffer());
  must(pdfFrame.status === 200, "PDF content responds 200", "same empty-box failure mode as the HTML case", `HTTP ${pdfFrame.status}`);
  must(pdfFrameBytes.byteLength > 0, "PDF content is non-empty", "a 200 with zero bytes cannot be a PDF");
  must(
    (pdfFrame.headers.get("content-type") || "").startsWith("application/pdf"),
    "PDF content-type is application/pdf",
    "Chrome's built-in PDF viewer decides whether to even try based on this header"
  );
  const pdfFrameXfo = pdfFrame.headers.get("x-frame-options");
  must(
    !pdfFrameXfo || pdfFrameXfo.toUpperCase() !== "DENY",
    "PDF content does not send X-Frame-Options: DENY",
    "the DENY-by-default middleware bug applies to every content type, not just HTML"
  );
  const pdfCsp = pdfFrame.headers.get("content-security-policy") || "";
  must(
    !pdfCsp.toLowerCase().includes("script-src"),
    "PDF response does not carry the permissive script-src CSP",
    "bug 3 exactly: the CSP written for HTML artifacts (script-src * 'unsafe-inline'…) was also applied to PDFs, and that policy is what broke Chrome's built-in PDF viewer — this cannot prove the viewer works (only a real browser can, see the file header), but it proves the policy that broke it is gone",
    pdfCsp ? `got "${pdfCsp}"` : "no CSP header at all"
  );

  // --- share link (bug 2) -------------------------------------------------
  step("create a share link for the HTML artifact");
  const { res: linkRes, body: link } = await apiCall(`/api/artifacts/${encodeURIComponent(SLUG_HTML)}/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }, { machine: false });
  must(linkRes.ok, "create share link", "share-link creation must succeed to test what it authorizes", linkRes.ok ? "" : `HTTP ${linkRes.status}: ${link?.detail || link?.error}`);
  created.linkId = link.id;
  created.linkSlug = SLUG_HTML;
  must(typeof link.url === "string" && link.url.includes("?k="), "share link URL carries a key", "the URL *is* the credential — no key, no capability");

  step("redeem the share link using ONLY the link — no bearer token, no prior session (catches bug 2)");
  // Step A: present the key. The server must exchange it for a path-scoped
  // cookie and redirect to the clean URL — no Authorization header is sent
  // here, deliberately: a real recipient's browser has none either.
  const redeemRes = await rawFetch(link.url, {
    redirect: "manual",
    headers: { "Sec-Fetch-Dest": "document" },
  });
  must(
    redeemRes.status === 302,
    "share link exchanges the key for a cookie",
    "the app strips ?k= from the URL and sets a path-scoped cookie so the key never lingers in history/referrers",
    `HTTP ${redeemRes.status}`
  );
  const setCookie = typeof redeemRes.headers.getSetCookie === "function"
    ? redeemRes.headers.getSetCookie()[0]
    : redeemRes.headers.get("set-cookie");
  must(!!setCookie, "server sets the link cookie", "without this cookie, every subsequent request the browser makes — including the iframe's — has no credential at all, which is bug 2 verbatim");
  const linkCookie = cookiePair(setCookie);
  const location = redeemRes.headers.get("location");
  must(!!location, "redirect has a Location", "the browser needs somewhere to land after the key is exchanged");
  const cleanShellUrl = new URL(location, link.url).toString();

  // Step B: the entry document, fetched with only the cookie — this is the
  // part that worked even with bug 2 (the bug was specifically about
  // subresources), but confirms the baseline before checking the part that
  // didn't.
  const linkShell = await rawFetch(cleanShellUrl, { headers: { "Sec-Fetch-Dest": "document", Cookie: linkCookie } });
  const linkShellHtml = linkShell.ok ? await linkShell.text() : "";
  must(linkShell.status === 200, "entry document opens via the link cookie alone", "this is the part bug 2 did NOT break — confirms the baseline before checking the subresource below", `HTTP ${linkShell.status}`);
  const linkIframeSrc = linkShellHtml ? extractIframeSrc(linkShellHtml) : null;
  must(linkIframeSrc !== null, "shell (via link) still contains an <iframe src=…>", "same shell markup regardless of how the visitor arrived");

  step("fetch the iframe's src using ONLY the link cookie (this is exactly what bug 2 broke)");
  const linkIframeUrl = new URL(linkIframeSrc, cleanShellUrl).toString();
  console.log(`      iframe src: ${linkIframeSrc}`);
  const linkFrame = await rawFetch(linkIframeUrl, { headers: { Cookie: linkCookie } });
  const linkFrameBytes = new Uint8Array(await linkFrame.arrayBuffer());
  must(
    linkFrame.status === 200,
    "iframe subresource opens via the link cookie alone",
    "bug 2 exactly: the share link authorized the entry document but not its subresources, so the iframe URL arrived with no credential and 404'd — the shell rendered around an empty box for anyone who opened the artifact by link",
    `HTTP ${linkFrame.status}`
  );
  must(linkFrameBytes.byteLength > 0, "iframe subresource is non-empty (via link)", "a 200 with zero bytes via the link is the same empty-box failure by another door");

  console.log("\nALL CHECKS PASSED");
}

// --- cleanup -----------------------------------------------------------------
// Best-effort, runs regardless of outcome above. Every artifact and link this
// script creates is deleted here so the script is safe to run repeatedly
// against production: nothing it creates outlives the run that created it.

async function cleanup() {
  const problems = [];

  if (created.linkId && created.linkSlug) {
    try {
      const { res, body } = await apiCall(
        `/api/artifacts/${encodeURIComponent(created.linkSlug)}/links/${encodeURIComponent(created.linkId)}`,
        { method: "DELETE" },
        { machine: false }
      );
      if (!res.ok) problems.push(`revoke share link ${created.linkId}: HTTP ${res.status} ${body?.detail || body?.error || ""}`);
    } catch (e) {
      problems.push(`revoke share link ${created.linkId}: ${e.message}`);
    }
  }

  for (const slug of [created.htmlSlug, created.pdfSlug]) {
    if (!slug) continue;
    try {
      const { res, body } = await apiCall(`/api/artifacts/${encodeURIComponent(slug)}`, { method: "DELETE" });
      if (!res.ok) problems.push(`delete artifact ${slug}: HTTP ${res.status} ${body?.detail || body?.error || ""}`);
    } catch (e) {
      problems.push(`delete artifact ${slug}: ${e.message}`);
    }
  }

  if (problems.length) {
    console.error("\n⚠ cleanup did not fully succeed — manual follow-up needed:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `  (DELETE needs the token's "manage" scope; if it's missing, re-mint with ` +
        `--scopes read,publish,manage and delete these by hand)`
    );
  }
  return problems;
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  exitCode = 1;
  if (e instanceof SmokeFailure) {
    console.error(`\n✗ FAILED: ${e.check}`);
    console.error(`  meaning: ${e.meaning}`);
    if (e.detail) console.error(`  detail: ${e.detail}`);
  } else {
    console.error(`\n✗ FAILED: unexpected error`);
    console.error(`  ${e.stack || e.message || e}`);
  }
} finally {
  const problems = await cleanup();
  if (problems.length) exitCode = 1;
}

process.exit(exitCode);
