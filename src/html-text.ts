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

function inlineMarkdown(html: string, origin: string): string {
  return decode(
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
  );
}

/**
 * Markdown: `<b>`/`<em>`/`<code>`/`<a>` kept as markdown, relative links made absolute.
 * Copy that contains a `<pre>` block (a config snippet) keeps it as a fenced code block,
 * with its line breaks, and its `<li>` items as "- " lines, so the snippet stays valid.
 * Copy without one is flattened to a single line, as before.
 */
export function htmlToMarkdown(html: string, origin: string): string {
  if (!/<pre\b/.test(html)) return squash(inlineMarkdown(html, origin));
  const parts = html.split(/(<pre\b[^>]*>[\s\S]*?<\/pre>)/);
  const out: string[] = [];
  for (const part of parts) {
    if (/^<pre\b/.test(part)) {
      const code = decode(part.replace(/<[^>]+>/g, "")).replace(/^\n+|\s+$/g, "");
      out.push("```\n" + code + "\n```");
    } else {
      const lines = inlineMarkdown(part.replace(/<li\b[^>]*>/g, "\n- "), origin)
        .split("\n")
        .map(squash)
        .filter(Boolean);
      if (lines.length) out.push(lines.join("\n"));
    }
  }
  return out.join("\n\n");
}
