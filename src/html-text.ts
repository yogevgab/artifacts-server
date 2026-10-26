/**
 * Turn the small HTML subset the public copy uses (`<b>`, `<em>`, `<code>`,
 * `<q>`, `<a>`, a few entities) into plain text or markdown. Used so structured
 * data and `/llms-full.txt` are derived from the strings the pages render rather
 * than being a second hand-typed copy of them.
 */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&rarr;": "→",
  "&hellip;": "…",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&middot;": "·",
  "&nbsp;": " ",
};

function decode(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|rarr|hellip|ldquo|rdquo|middot|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Plain text: tags dropped, `<q>` becomes curly quotes, entities decoded. */
export function htmlToText(html: string): string {
  return squash(
    decode(
      html
        .replace(/<q>/g, "“")
        .replace(/<\/q>/g, "”")
        .replace(/<[^>]+>/g, "")
    )
  );
}

/** Markdown: `<b>`/`<em>`/`<code>`/`<a>` kept as markdown, relative links made absolute. */
export function htmlToMarkdown(html: string, origin: string): string {
  return squash(
    decode(
      html
        .replace(/<(?:b|strong)>/g, "**")
        .replace(/<\/(?:b|strong)>/g, "**")
        .replace(/<\/?em>/g, "_")
        .replace(/<\/?code>/g, "`")
        .replace(/<q>/g, "“")
        .replace(/<\/q>/g, "”")
        .replace(/<a href="([^"]+)">(.*?)<\/a>/g, (_m, href: string, text: string) => {
          const abs = href.startsWith("/") ? `${origin}${href}` : href;
          return `[${text}](${abs})`;
        })
        .replace(/<[^>]+>/g, "")
    )
  );
}
