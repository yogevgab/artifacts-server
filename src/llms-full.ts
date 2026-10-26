import type { Env } from "./env";
import { SITE, MCP_URL, PUBLIC_PAGES, canonicalUrl, siteOrigin } from "./seo";
import { htmlToMarkdown } from "./html-text";
import {
  CLAUDE_CODE_CMD,
  CONNECT_NOTE,
  CONNECT_STEPS,
  ENTERPRISE_LINES,
  FAQS,
  MCP_JSON,
  OTHER_CLIENTS_NOTE,
  VIDEO,
  WALKTHROUGH,
} from "./home-content";
import { GUIDE_PARTS, guideSteps } from "./guide";
import { tierLimitLines } from "./landing";
import { PUBLIC_TIERS, TIER_LABEL, tierPath, tierPrice, isPlanName } from "./plan-copy";
import { mediaUrl } from "./media";
import { answerPagesMarkdown } from "./answer-pages";

/**
 * `/llms-full.txt`: the whole public story (home page, step-by-step guide, FAQ,
 * pricing facts) as one markdown document for answer engines.
 *
 * It owns no copy. Every sentence comes from the data the pages render from —
 * `src/home-content.ts`, the guide's shot list, `PLANS`/`plan-copy` — so it
 * cannot drift from what a visitor reads. `llms.txt` (src/seo.ts) stays the short
 * summary and the "Not shipped yet" list; this is the long form it links to.
 */
export function llmsFullTxt(env: Pick<Env, "PUBLIC_BASE_URL">): string {
  const origin = siteOrigin(env);
  const md = (html: string) => htmlToMarkdown(html, origin);
  const abs = (path: string) => canonicalUrl(env, path);

  const out: string[] = [];
  out.push(`# ${SITE.homeTitle}`, "", `> ${SITE.description}`, "");
  out.push(
    `Short summary and the list of what is not built: ${abs("/llms.txt")}. ` +
      `The brand "rtfx" is also used by unrelated projects; this is the rtfx.pro MCP server for Claude.`,
    ""
  );

  // --- home ---
  out.push(`## Home page (${abs("/")})`, "");
  out.push(
    "rtfx.pro is an MCP server. Connect it to Claude once, then ask Claude to publish, share or " +
      "delete what it made — each artifact gets a private link only the people you choose can open.",
    "",
    `MCP endpoint: \`${MCP_URL}\``,
    "",
    `Walkthrough video (${VIDEO.duration.replace("PT", "").toLowerCase()}, ${VIDEO.width}×${VIDEO.height}): ` +
      `${abs(mediaUrl(VIDEO.file))} — ${VIDEO.description}`,
    ""
  );

  out.push("### 1. Add rtfx to Claude", "", "Claude on web, desktop and mobile:", "");
  CONNECT_STEPS.forEach((s, i) => out.push(`${i + 1}. ${md(s)}`));
  out.push("", CONNECT_NOTE, "", "Other MCP clients:", "", md(OTHER_CLIENTS_NOTE), "");
  out.push("```", CLAUDE_CODE_CMD, "```", "", "```json", MCP_JSON, "```", "");

  for (const w of WALKTHROUGH) {
    out.push(`### ${w.heading}`, "");
    for (const a of w.asks) out.push(`- ${md(a)}`);
    out.push("", md(w.note), "");
  }

  // --- FAQ ---
  out.push(`## FAQ (${abs("/#faq")})`, "");
  for (const f of FAQS) {
    out.push(`### ${f.q}`, "", f.a, "");
    if (f.more) out.push(`Read more: ${abs(f.more.href)}`, "");
  }

  // --- pricing ---
  out.push(`## Pricing (${abs("/#pricing")})`, "");
  for (const tier of PUBLIC_TIERS) {
    const page = tierPath(tier);
    out.push(`### ${TIER_LABEL[tier]} — ${tierPrice(tier)}${page ? ` (${abs(page)})` : ""}`, "");
    const lines = isPlanName(tier) ? tierLimitLines(tier) : ENTERPRISE_LINES;
    for (const l of lines) out.push(`- ${l}`);
    out.push("");
  }
  out.push(
    "Limits are per workspace, not per person. Storage counts every version you've kept, which is why Free keeps your last 5 and the paid plans keep every one.",
    ""
  );

  // --- guide ---
  const guide = PUBLIC_PAGES.find((p) => p.path === "/guide");
  out.push(`## Step-by-step guide (${abs("/guide")})`, "");
  if (guide) out.push(guide.summary, "");
  const steps = guideSteps();
  for (const part of GUIDE_PARTS) {
    out.push(`### ${part.letter}. ${part.title} (${abs(`/guide#${part.id}`)})`, "");
    for (const s of steps.filter((x) => x.part === part.id)) {
      out.push(`${s.n}. **${s.name}.** ${md(s.html)} ![${s.alt}](${abs(s.image)})`);
    }
    out.push("");
  }

  out.push(...answerPagesMarkdown(env));

  out.push(
    "## Links",
    "",
    ...PUBLIC_PAGES.map((p) => `- [${p.title}](${abs(p.path)})`),
    `- [llms.txt](${abs("/llms.txt")}): short summary, what is and is not shipped.`,
    ""
  );
  return out.join("\n");
}
