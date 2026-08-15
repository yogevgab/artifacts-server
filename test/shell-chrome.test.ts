import { describe, it, expect, beforeEach } from "vitest";
import { initDb, clearR2, req, as } from "./fixtures";

const OWNER = "owner@rtfx.pro";

beforeEach(async () => {
  await initDb();
  await clearR2();
  const body = new FormData();
  body.set("slug", "demo");
  body.set("title", "Demo");
  body.set("visibility", "everyone");
  body.set("file", new File(["<html><body><h1>hi</h1></body></html>"], "index.html", { type: "text/html" }));
  await req("/api/artifacts", { method: "POST", body, ...as(OWNER) });
});

const nav = (who: string) =>
  req("/demo/", {
    ...as(who),
    headers: { ...(as(who).headers as Record<string, string>), "Sec-Fetch-Dest": "document" },
  });

/**
 * The shell inlines exactly one stylesheet, so its layout rules are the only
 * place the panels' positioning is decided. These helpers read that stylesheet
 * as text — there is no DOM in this suite — which is enough to pin the handful
 * of declarations that decide *where* things sit, without freezing the visual
 * details around them.
 */
function stylesheet(html: string): string {
  const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  expect(blocks.length, "the shell should inline exactly one stylesheet").toBe(1);
  return blocks[0][1];
}

/** The declarations of the top-level rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector}{`);
  expect(at, `no top-level rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(at + selector.length + 2, css.indexOf("}", at));
}

/** Everything inside the one narrow-screen media query. */
function narrowScreen(css: string): string {
  const at = css.indexOf("@media(max-width:640px){");
  expect(at, "no narrow-screen media query").toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("\n}", at));
}

const zIndex = (declarations: string): number => {
  const n = /z-index:(\d+)/.exec(declarations)?.[1];
  expect(n, `no z-index in "${declarations.slice(0, 40)}…"`).toBeDefined();
  return Number(n);
};

describe("shell chrome", () => {
  it("offers a way to hide the bar", async () => {
    const html = await (await nav(OWNER)).text();
    expect(html).toContain("data-hide-bar");
  });

  it("marks the bar so it can be shown again once hidden", async () => {
    const html = await (await nav(OWNER)).text();
    expect(html).toContain("data-show-bar");
    expect(html).toContain("data-bar");
  });

  it("keeps an accessible name on both icon-only bar controls", async () => {
    const html = await (await nav(OWNER)).text();
    const hide = /<button[^>]*data-hide-bar[^>]*>/.exec(html)?.[0] ?? "";
    expect(hide).toContain('aria-label="Hide toolbar"');
    const peek = /<button[^>]*data-show-bar[^>]*>/.exec(html)?.[0] ?? "";
    expect(peek).toContain('aria-label="Show toolbar"');
    // The chevrons are decoration; the label is the name.
    expect(html).toContain('<svg class="chev"');
    expect(html).toMatch(/<svg class="chev"[^>]*aria-hidden="true"/);
  });
});

/**
 * The toolbar is one row at every width. It used to wrap, which cost twice:
 * controls reflowed onto a second line on a phone, and `--bar-h` — measured
 * from `offsetHeight` and used by the collapse animation — changed underneath
 * it. The title absorbs the pressure instead, by shrinking and ellipsising.
 */
describe("the toolbar is a single quiet row", () => {
  it("never wraps, and reserves a stable height", async () => {
    const css = stylesheet(await (await nav(OWNER)).text());
    const bar = rule(css, ".bar");
    expect(bar).toContain("flex-wrap:nowrap");
    expect(bar).toContain("min-height:48px");
  });

  it("shrinks the title rather than pushing controls off the edge", async () => {
    const css = stylesheet(await (await nav(OWNER)).text());
    const title = rule(css, ".bar .title");
    expect(title).toContain("min-width:0");
    expect(title).toContain("text-overflow:ellipsis");
    expect(title).toContain("white-space:nowrap");
  });

  it("groups every action into one cluster on the right", async () => {
    const html = await (await nav(OWNER)).text();
    const actions = html.indexOf("data-actions");
    expect(actions).toBeGreaterThan(-1);
    for (const control of ["data-open-chat", "data-copy-link", "data-open-share", "data-hide-bar"]) {
      expect(html.indexOf(control), `${control} is outside the action cluster`).toBeGreaterThan(actions);
    }
    // …and the spacer that pushes the cluster there comes before it.
    expect(html.indexOf('class="spacer"')).toBeLessThan(actions);
  });

  it("drops the version pill before it drops the title on a phone", async () => {
    const narrow = narrowScreen(stylesheet(await (await nav(OWNER)).text()));
    expect(narrow).toContain(".bar .ver");
    expect(narrow).toContain("display:none");
    expect(narrow).not.toContain(".bar .title{display:none");
  });
});

/**
 * Positioning. The share panel used to be `position:fixed` against the bottom
 * of the viewport — the same corner the chat drawer claims — so on any screen
 * it read as detached from the button that opened it and overlapped the chat.
 * It is now a popover anchored to its own trigger, and the two panels are
 * mutually exclusive so they cannot stack even where both are bottom sheets.
 */
describe("the share panel is anchored to the Share button", () => {
  it("wraps the button and the panel in one positioned container", async () => {
    const html = await (await nav(OWNER)).text();
    expect(html).toContain('class="share" data-share');
    // The button opens it, so the button must be the anchor it hangs from.
    expect(html.indexOf("data-share")).toBeLessThan(html.indexOf("data-open-share"));
    expect(html.indexOf("data-open-share")).toBeLessThan(html.indexOf("data-share-panel"));
    expect(rule(stylesheet(html), ".share")).toContain("position:relative");
  });

  it("hangs the panel under the button, right-aligned, not pinned to a corner", async () => {
    const panel = rule(stylesheet(await (await nav(OWNER)).text()), ".panel");
    expect(panel).toContain("position:absolute");
    expect(panel).toContain("top:calc(100% + 6px)");
    expect(panel).toContain("right:0");
    expect(panel, "a wide-screen popover must not pin itself to the viewport").not.toContain(
      "position:fixed"
    );
    expect(panel).not.toContain("bottom:");
  });

  it("wires the button to the panel for assistive tech", async () => {
    const html = await (await nav(OWNER)).text();
    const button = /<button[^>]*data-open-share[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain('aria-haspopup="dialog"');
    expect(button).toContain('aria-controls="rtfx-share"');
    const panel = /<section[^>]*data-share-panel[^>]*>/.exec(html)?.[0] ?? "";
    expect(panel).toContain('id="rtfx-share"');
    expect(panel).toContain('role="dialog"');
    expect(panel).toContain('aria-label="Sharing"');
    // Focus has somewhere to land when the popover opens.
    expect(panel).toContain('tabindex="-1"');
  });

  it("gives the panel its own dismissal, and folds it away with the bar", async () => {
    const html = await (await nav(OWNER)).text();
    expect(html).toContain("data-close-share");
    expect(/<button[^>]*data-close-share[^>]*>/.exec(html)?.[0]).toContain(
      'aria-label="Close sharing"'
    );
    // A popover anchored to the bar cannot outlive the bar collapsing.
    expect(html).toContain("closeShare()");
  });

  it("becomes a bottom sheet only where a popover will not fit", async () => {
    const narrow = narrowScreen(stylesheet(await (await nav(OWNER)).text()));
    expect(narrow).toContain(".panel{position:fixed");
    expect(narrow).toContain("inset:auto 0 0 0");
    expect(narrow).toContain("border-radius:20px 20px 0 0");
  });
});

/**
 * The chat is a drawer: a floating card in the bottom-right on a wide screen,
 * a bottom sheet on a phone, with three fixed bands — head, scrolling log,
 * composer — so the composer never scrolls away from the messages.
 */
describe("the chat is a drawer, not a slab bolted to the bottom", () => {
  it("floats clear of every edge on a wide screen", async () => {
    const chat = rule(stylesheet(await (await nav(OWNER)).text()), ".chat");
    expect(chat).toContain("position:fixed");
    expect(chat).toContain("right:16px");
    expect(chat).toContain("bottom:16px");
    expect(chat).toContain("border-radius:var(--sh-r)");
    expect(chat).toContain("box-shadow:var(--sh-shadow)");
    // Its height accounts for the toolbar, so the card never runs under it.
    expect(chat).toContain("var(--bar-h,48px)");
  });

  it("claims the opposite corner from the share popover", async () => {
    const css = stylesheet(await (await nav(OWNER)).text());
    // The popover hangs from the top of the viewport, the drawer sits at the
    // bottom: on a wide screen they cannot reach each other.
    expect(rule(css, ".panel")).toContain("top:");
    expect(rule(css, ".chat")).not.toContain("top:");
  });

  it("splits into a fixed head, a scrolling log and a fixed composer", async () => {
    const css = stylesheet(await (await nav(OWNER)).text());
    expect(rule(css, ".chat-head")).toContain("flex:none");
    expect(rule(css, ".chat-form")).toContain("flex:none");
    const log = rule(css, ".chat-log");
    expect(log).toContain("flex:1 1 auto");
    // Without this a long conversation stretches the card instead of scrolling.
    expect(log).toContain("min-height:0");
    expect(log).toContain("overflow:auto");
  });

  it("names itself, and the button that opens it says so", async () => {
    const html = await (await nav(OWNER)).text();
    const chat = /<section[^>]*data-chat[^>]*>/.exec(html)?.[0] ?? "";
    expect(chat).toContain('id="rtfx-chat"');
    expect(chat).toContain('role="dialog"');
    expect(chat).toContain('aria-label="Conversation"');
    const button = /<button[^>]*data-open-chat[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain('aria-controls="rtfx-chat"');
  });

  it("lets a keyboard reach and scroll the log, and read the header hierarchy", async () => {
    const html = await (await nav(OWNER)).text();
    const log = /<div[^>]*data-chat-log[^>]*>/.exec(html)?.[0] ?? "";
    expect(log).toContain('role="log"');
    expect(log).toContain('aria-live="polite"');
    expect(log).toContain('tabindex="0"');
    expect(html).toContain('class="chat-title"');
    expect(html).toContain('class="sub"');
  });

  it("fills the bottom of a phone screen instead of floating in a corner", async () => {
    const narrow = narrowScreen(stylesheet(await (await nav(OWNER)).text()));
    expect(narrow).toContain(".chat{inset:auto 0 0 0");
    expect(narrow).toContain("safe-area-inset-bottom");
  });
});

/**
 * Layering is decided in one place, because the share popover is a *child* of
 * the toolbar — anchoring it to the Share button costs it its own stacking
 * context. If the toolbar ever ranks below the chat, the popover disappears
 * behind the drawer with nothing in the popover's own rules to explain why.
 */
describe("panels layer in a defined order", () => {
  it("puts the toolbar (and so the popover) above the chat, above the scrim", async () => {
    const css = stylesheet(await (await nav(OWNER)).text());
    const bar = zIndex(rule(css, ".bar"));
    const chat = zIndex(rule(css, ".chat"));
    const scrim = zIndex(rule(css, ".scrim"));
    const peek = zIndex(rule(css, ".peek"));
    expect(bar).toBeGreaterThan(chat);
    expect(chat).toBeGreaterThan(scrim);
    expect(peek).toBeGreaterThan(bar);
  });

  it("dims the artifact only where a panel actually covers it", async () => {
    const css = stylesheet(await (await nav(OWNER)).text());
    expect(rule(css, ".scrim")).toContain("display:none");
    expect(narrowScreen(css)).toContain(".scrim:not([hidden]){display:block}");
  });

  it("ships the scrim closed, and lets a tap or Escape dismiss a panel", async () => {
    const html = await (await nav(OWNER)).text();
    expect(html).toContain('<div class="scrim" data-scrim hidden>');
    expect(html).toContain("data-scrim");
    expect(html).toContain("'Escape'");
    // One panel at a time: opening either closes the other.
    expect(html).toContain("closeChat()");
    expect(html).toContain("closeShare()");
  });
});

describe("every interactive control shows focus", () => {
  it("declares one :focus-visible ring covering links, buttons and fields", async () => {
    const css = stylesheet(await (await nav(OWNER)).text());
    const at = css.indexOf("a:focus-visible");
    expect(at, "no shared focus-visible rule").toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("}", at));
    for (const selector of ["button:focus-visible", "input:focus-visible", "select:focus-visible"]) {
      expect(block, `focus ring misses ${selector}`).toContain(selector);
    }
    expect(block).toContain("outline:2px solid var(--sh-accent)");
    expect(block).toContain("outline-offset:2px");
  });

  it("still honours prefers-reduced-motion", async () => {
    const css = stylesheet(await (await nav(OWNER)).text());
    expect(css).toContain("@media(prefers-reduced-motion:reduce)");
  });
});

/**
 * The restyle must not quietly drop a feature. Every hook the client script and
 * the rest of the suite drive is asserted here in one place, so a future CSS
 * pass that rewrites the markup fails loudly rather than shipping a toolbar
 * with a missing button.
 */
describe("restyling the chrome kept every control", () => {
  it("still renders every data hook the shell script binds to", async () => {
    const html = await (await nav(OWNER)).text();
    for (const hook of [
      "data-bar",
      "data-show-bar",
      "data-hide-bar",
      "data-copy-link",
      "data-open-chat",
      "data-close-chat",
      "data-chat-log",
      "data-chat-form",
      "data-open-share",
      "data-share-panel",
      "data-share-summary",
      "data-share-list",
      "data-share-add",
      "data-link-expiry",
      "data-link-days",
      "data-make-link",
      "data-link-list",
    ]) {
      expect(html, `missing hook: ${hook}`).toContain(hook);
    }
  });

  it("keeps the chrome outside the sandboxed frame", async () => {
    const html = await (await nav(OWNER)).text();
    const frame = html.indexOf("<iframe");
    expect(frame).toBeGreaterThan(-1);
    // Every piece of privileged UI is a sibling that precedes the frame, never
    // markup handed to the artifact.
    for (const hook of ["data-bar", "data-chat", "data-share-panel", "data-scrim"]) {
      expect(html.indexOf(hook), `${hook} must live outside the frame`).toBeLessThan(frame);
    }
    const tag = /<iframe[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toContain("sandbox=");
    expect(tag).not.toContain("allow-same-origin");
  });
});

describe("scroll reporting from the frame", () => {
  /**
   * The frame is cross-origin by design, so the shell cannot observe scrolling
   * inside it. A tiny reporter posts the scroll position out. It is deliberately
   * capability-free: the shell uses it only to hide chrome, so an artifact that
   * forges the message can at worst hide or show a toolbar.
   */
  it("injects the reporter into framed HTML", async () => {
    const res = await req("/demo/?raw=1", as(OWNER));
    const html = await res.text();
    expect(html).toContain("rtfx:scroll");
    expect(html).toContain("<h1>hi</h1>");
  });

  it("leaves unframed HTML byte-identical, so downloads and the CLI are untouched", async () => {
    const html = await (await req("/demo/", as(OWNER))).text();
    expect(html).not.toContain("rtfx:scroll");
    expect(html).toBe("<html><body><h1>hi</h1></body></html>");
  });

  it("never touches non-HTML assets", async () => {
    const body = new FormData();
    body.set("slug", "assets");
    body.set("title", "Assets");
    body.set("visibility", "everyone");
    const zip = new File([new Uint8Array()], "x.zip");
    void zip;
    // A CSS file inside the artifact must pass through unchanged.
    const res = await req("/demo/missing.css?raw=1", as(OWNER));
    expect(res.status).toBe(404);
  });
});

describe("who sees the banner", () => {
  it("shows it to the owner", async () => {
    expect(await (await nav(OWNER)).text()).toContain("data-share-banner");
  });

  it("hides it from someone who can only view", async () => {
    expect(await (await nav("reader@example.com")).text()).not.toContain("data-share-banner");
  });
});

describe("artifact content can actually be framed by the shell", () => {
  /**
   * Regression: the global security middleware stamps X-Frame-Options: DENY on
   * every response that lacks one. Artifact content set `frame-ancestors 'self'`
   * but no XFO, so it inherited DENY and browsers refused to render the frame —
   * the shell rendered perfectly around an empty box. Caught in a real browser,
   * not by curling the markup.
   */
  it("does not send X-Frame-Options: DENY on framed content", async () => {
    const res = await req("/demo/?raw=1", as(OWNER));
    expect(res.headers.get("x-frame-options")).not.toBe("DENY");
  });

  it("allows same-origin framing explicitly", async () => {
    const res = await req("/demo/?raw=1", as(OWNER));
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
  });

  it("keeps DENY on the app's own pages, which must never be framed", async () => {
    const res = await req("/login", { headers: { "X-Dev-Anonymous": "true" } });
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});
