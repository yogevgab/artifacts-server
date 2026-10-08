/**
 * What we record about WHERE and WHAT a view came from: IP address, the
 * approximate place Cloudflare reports, and a coarse device/OS/browser read
 * from the User-Agent.
 *
 * The User-Agent parser is deliberately tiny and dependency-free. It answers
 * "iPhone · Safari" for an owner glancing at a list, not fingerprinting: it
 * returns a handful of labels, never a version number, and the raw string is
 * truncated before it is stored. Order of the checks matters (Edge and Opera
 * both say "Chrome"; Chrome says "Safari"; iPads say "Mac" in desktop mode),
 * so each rule is commented with what it must beat.
 */

/** IP addresses are erased after this many days (see `eraseOldIps` in src/db.ts). */
export const IP_RETENTION_DAYS = 90;

const MAX_UA = 300;

export type DeviceKind = "mobile" | "tablet" | "desktop" | "bot";

export interface ViewContext {
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  device: DeviceKind | null;
  os: string | null;
  browser: string | null;
  user_agent: string | null;
}

/** Link-card crawlers, search bots and scripted clients. */
const BOT_RE =
  /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|facebot|whatsapp|slackbot|discordbot|linkedinbot|telegrambot|skypeuripreview|pinterest|embedly|iframely|vkshare|bingpreview|microsoftpreview|cardyb|mastodon|bluesky|headless|lighthouse|curl\/|wget\/|python-requests|go-http-client|node-fetch|axios\/|okhttp/i;

const BOT_NAMES: [RegExp, string][] = [
  [/whatsapp/i, "WhatsApp"],
  [/twitterbot/i, "Twitterbot"],
  [/facebookexternalhit|facebot/i, "Facebook"],
  [/slackbot/i, "Slack"],
  [/discordbot/i, "Discord"],
  [/linkedinbot/i, "LinkedIn"],
  [/telegrambot/i, "Telegram"],
  [/googlebot|google-pagerenderer/i, "Googlebot"],
  [/applebot/i, "Applebot"],
  [/bingpreview|bingbot|microsoftpreview/i, "Bing"],
  [/skypeuripreview/i, "Skype"],
  [/pinterest/i, "Pinterest"],
];

export function parseUserAgent(ua: string | null | undefined): Pick<ViewContext, "device" | "os" | "browser"> {
  const s = (ua ?? "").trim();
  if (!s) return { device: null, os: null, browser: null };

  if (BOT_RE.test(s)) {
    const named = BOT_NAMES.find(([re]) => re.test(s));
    return { device: "bot", os: null, browser: named ? named[1] : "Bot" };
  }

  // OS. iPad/iPhone before Mac (iOS UAs also say "like Mac OS X"); Android
  // before Linux (Android UAs say "Linux").
  let os: string | null = null;
  if (/iPhone|iPad|iPod/.test(s)) os = "iOS";
  else if (/Android/.test(s)) os = "Android";
  else if (/Windows/.test(s)) os = "Windows";
  else if (/CrOS/.test(s)) os = "ChromeOS";
  else if (/Macintosh|Mac OS X/.test(s)) os = "macOS";
  else if (/Linux|X11/.test(s)) os = "Linux";

  let device: DeviceKind = "desktop";
  if (/iPad|Tablet/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) device = "tablet";
  else if (/iPhone|iPod|Mobile|Android/.test(s)) device = "mobile";

  // Browser. Edge/Opera/Samsung/Firefox-iOS/Chrome-iOS before Chrome; Chrome
  // before Safari (Chrome's UA contains "Safari"); in-app webviews first.
  let browser: string | null = null;
  if (/FBAN|FBAV/.test(s)) browser = "Facebook";
  else if (/Instagram/.test(s)) browser = "Instagram";
  else if (/\bLine\//.test(s)) browser = "LINE";
  else if (/EdgiOS|EdgA|Edg\//.test(s)) browser = "Edge";
  else if (/OPR\/|OPiOS|Opera/.test(s)) browser = "Opera";
  else if (/SamsungBrowser/.test(s)) browser = "Samsung Internet";
  else if (/FxiOS|Firefox\//.test(s)) browser = "Firefox";
  else if (/CriOS|Chrome\//.test(s)) browser = "Chrome";
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = "Safari";
  else if (/Safari\//.test(s)) browser = "Safari";
  else if (/(iPhone|iPad).*AppleWebKit/.test(s)) browser = "Safari";

  return { device, os, browser };
}

/** First hop of an X-Forwarded-For style header. */
function firstHop(v: string | null | undefined): string | null {
  const first = (v ?? "").split(",")[0]?.trim();
  return first || null;
}

const clean = (v: unknown, max = 100): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

/** Everything we keep about the request, tolerant of a missing `request.cf` (tests, local dev). */
export function captureViewContext(request: Request): ViewContext {
  const cf = (request as { cf?: { country?: unknown; region?: unknown; city?: unknown } }).cf ?? null;
  const h = request.headers;
  const ip = clean(h.get("CF-Connecting-IP") ?? firstHop(h.get("X-Forwarded-For")), 64);
  const ua = clean(h.get("User-Agent"), MAX_UA);
  return {
    ip,
    country: clean(cf?.country, 8),
    region: clean(cf?.region),
    city: clean(cf?.city),
    ...parseUserAgent(ua),
    user_agent: ua,
  };
}
