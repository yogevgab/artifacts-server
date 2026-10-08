/**
 * Link previews for share links.
 *
 * When somebody pastes a share link into X, WhatsApp, iMessage, Slack, LinkedIn
 * and the like, the platform's crawler fetches it to build a card. A share link
 * answers a browser with a redirect plus a cookie, which a crawler neither keeps
 * nor follows into anything readable — so every shared artifact previewed as a
 * bare URL. A recognised preview crawler holding a VALID key now gets a tiny
 * page carrying the artifact's title and description instead.
 *
 * Deliberately narrow:
 *  - only with a valid, unexpired, unrevoked key — the same capability that
 *    opens the artifact, so nothing is revealed to anyone who could not already
 *    read it. A plain artifact or branded address never gets a card: a private
 *    artifact's title must not leak to whoever guesses its slug;
 *  - only for a request with no Sec-Fetch-Dest (no browser sends that on a
 *    navigation) and a known crawler User-Agent, so browsers, the CLI and the
 *    smoke test keep the redirect exactly as before;
 *  - `og:url` is omitted on purpose: the key is already in the message being
 *    previewed, and there is no reason to hand it to the platform a second time
 *    as a canonical URL it may store and show.
 */

import { esc } from "./pages";

/**
 * Crawlers that build link cards. iMessage identifies as
 * "facebookexternalhit/1.1 Facebot Twitterbot/1.0", so it is covered twice.
 */
const PREVIEW_BOT_RE =
  /facebookexternalhit|facebot|twitterbot|slackbot|discordbot|linkedinbot|whatsapp|telegrambot|skypeuripreview|pinterest|redditbot|embedly|iframely|vkshare|mastodon|signal|bluesky|cardyb|googlebot|google-pagerenderer|applebot|bingpreview|microsoftpreview|teams/i;

export function isLinkPreviewCrawler(headers: { get(name: string): string | null | undefined }): boolean {
  if (headers.get("Sec-Fetch-Dest")) return false;
  return PREVIEW_BOT_RE.test(headers.get("User-Agent") ?? "");
}

const FALLBACK_DESCRIPTION = "Shared with you on rtfx.pro.";
const MAX_DESCRIPTION = 300;

export function linkPreviewPage(input: {
  title: string;
  description: string | null;
  /** Absolute URL of a small square image (the rtfx mark). */
  image: string;
}): string {
  const title = input.title.trim() || "Shared on rtfx.pro";
  const raw = (input.description ?? "").replace(/\s+/g, " ").trim();
  const description =
    raw.length === 0
      ? FALLBACK_DESCRIPTION
      : raw.length > MAX_DESCRIPTION
        ? `${raw.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`
        : raw;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="rtfx.pro">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(input.image)}">
<meta property="og:image:alt" content="rtfx.pro">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(input.image)}">
</head><body>
<h1>${esc(title)}</h1>
<p>${esc(description)}</p>
</body></html>`;
}
