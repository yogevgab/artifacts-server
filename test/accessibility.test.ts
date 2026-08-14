import { describe, it, expect, beforeEach } from "vitest";
import { initDb, clearR2, req, as } from "./fixtures";

/**
 * Accessibility regressions (issue #36).
 *
 * These are not a substitute for using the product with a keyboard and a screen
 * reader — they are the floor underneath that. Each test pins one structural
 * property that is cheap to break in a template string and expensive to notice:
 * the landmark that lets somebody skip the nav, the single `h1` that says what
 * the page is, the label on the one input in the funnel, the focus ring, the
 * reduced-motion block, the 44px touch target.
 *
 * They run against every public page *and* every dashboard section, because the
 * two halves of this product share a stylesheet but not their markup, and only
 * one of them had a skip link before this issue.
 */

const SUPER = "admin@test.com"; // SUPER_ADMIN_EMAILS in vitest.config.ts
const ANON = { headers: { "X-Dev-Anonymous": "true" } };

const PUBLIC_PAGES = ["/", "/docs", "/login", "/privacy", "/terms"];
const APP_PAGES = [
  "/admin",
  "/admin/artifacts",
  "/admin/gallery",
  "/admin/billing",
  "/admin/people",
  "/admin/integrations",
  "/admin/settings",
  "/admin/platform",
];

beforeEach(async () => {
  await initDb();
  await clearR2();
});

const html = async (path: string, init?: RequestInit) => await (await req(path, init)).text();
const publicHtml = (path: string) => html(path, ANON);
const appHtml = (path: string) => html(path, as(SUPER));

/** Every page in the product, public and signed-in, as [path, html] pairs. */
async function everyPage(): Promise<[string, string][]> {
  const pub = await Promise.all(PUBLIC_PAGES.map(async (p): Promise<[string, string]> => [p, await publicHtml(p)]));
  const app = await Promise.all(APP_PAGES.map(async (p): Promise<[string, string]> => [p, await appHtml(p)]));
  return [...pub, ...app];
}

// --- landmarks and structure ------------------------------------------------

describe("every page can be navigated by keyboard from the top", () => {
  it("opens with a skip link that points at a main landmark it actually has", async () => {
    for (const [path, body] of await everyPage()) {
      expect(body, path).toContain('<a class="skip" href="#main">Skip to content</a>');
      expect(body, path).toMatch(/<main[^>]*\bid="main"/);
    }
  });

  it("puts the skip link before anything else focusable", async () => {
    for (const [path, body] of await everyPage()) {
      const firstLink = body.indexOf("<a ");
      expect(body.slice(firstLink, firstLink + 60), path).toContain('class="skip"');
    }
  });

  it("declares its language, so a screen reader reads it in the right voice", async () => {
    for (const [path, body] of await everyPage()) {
      expect(body, path).toContain('<html lang="en">');
    }
  });

  it("names every navigation region, since a page has more than one", async () => {
    for (const [path, body] of await everyPage()) {
      const navs = body.match(/<nav\b[^>]*>/g) ?? [];
      expect(navs.length, path).toBeGreaterThan(0);
      for (const nav of navs) {
        expect(nav, `${path} — ${nav}`).toMatch(/aria-label(ledby)?="/);
      }
    }
  });

  it("says what the page is exactly once, in one h1", async () => {
    for (const [path, body] of await everyPage()) {
      expect(body.match(/<h1[ >]/g) ?? [], path).toHaveLength(1);
    }
  });

  it("gives the artifact 404 an h1 too, not a bare h3", async () => {
    const body = await html("/no-such-artifact/");
    expect(body.match(/<h1[ >]/g) ?? []).toHaveLength(1);
    expect(body).toMatch(/<main[^>]*\bid="main"/);
  });
});

// --- controls ---------------------------------------------------------------

/**
 * `id="…"` but not `data-workspace-id="…"` — the attribute, not any attribute
 * whose name happens to end in "id".
 */
const ID_ATTR = /(?<![-\w])id="([^"]+)"/;

/**
 * `<input>`/`<select>`/`<textarea>` that nothing names: no `<label for>`, no
 * wrapping `<label>`, no `aria-label`/`aria-labelledby`.
 */
function unlabelledFields(body: string): string[] {
  const forIds = new Set([...body.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map(([, id]) => id));
  // Implicit labelling — `<label>Read <input type="checkbox"></label>` — is just
  // as valid, so the ranges of every label element count as labelled ground.
  const wraps = [...body.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)].map(
    (m) => [m.index!, m.index! + m[0].length] as const
  );
  return [...body.matchAll(/<(input|select|textarea)\b[^>]*>/g)]
    .filter(([tag]) => !/type="(hidden|submit|button)"/.test(tag))
    .filter(([tag]) => !/aria-label(ledby)?="/.test(tag))
    .filter((m) => !wraps.some(([from, to]) => m.index! >= from && m.index! < to))
    .filter(([tag]) => {
      const id = ID_ATTR.exec(tag)?.[1];
      return !id || !forIds.has(id);
    })
    .map(([tag]) => tag);
}

describe("every control says what it is", () => {
  it("labels every field on every page — a placeholder is not a label", async () => {
    for (const [path, body] of await everyPage()) {
      expect(unlabelledFields(body), path).toEqual([]);
    }
  });

  it("keeps the final conversion CTA explicit and keyboard reachable", async () => {
    const body = await publicHtml("/");
    expect(body).toContain('data-cta="signup-final"');
    expect(body).toContain('href="/signup"');
  });

  it("does not leave a dead waitlist form or live-region script on the landing page", async () => {
    const body = await publicHtml("/");
    expect(body).not.toContain('id="wl"');
    expect(body).not.toContain("msg.style.color");
  });

  /**
   * 'Sending…' used to be passed through the success path, so a request that had
   * not been answered yet was painted in the green success box — state as
   * decoration, which docs/DESIGN.md forbids. Pending is now its own neutral
   * state, and only a real answer colours the box.
   */
  it("does not keep obsolete waitlist pending-state script on the signup funnel", async () => {
    const body = await publicHtml("/");
    expect(body).not.toContain("show('Sending…', 'pending')");
    expect(body).not.toContain("show('Sending…', true)");
  });

  /**
   * Every non-2xx used to render "Enter a valid email address", so somebody who
   * submitted twice was told their own address was malformed. A rate limit and a
   * validation failure are different problems with different remedies, and the
   * live region is the only place either is ever explained.
   */
  it("does not ship the obsolete waitlist fetch handler on the signup funnel", async () => {
    const body = await publicHtml("/");
    expect(body).not.toContain("res.status === 429");
    expect(body).not.toContain("res.status === 400");
  });

  it("never nests a control inside a control", async () => {
    for (const [path, body] of await everyPage()) {
      expect(body, path).not.toMatch(/<a\b[^>]*>\s*<(button|a)\b/i);
      expect(body, path).not.toMatch(/<button\b[^>]*>\s*<(button|a)\b/i);
    }
  });

  it("never gives a bare div an aria-label, which nothing announces", async () => {
    for (const [path, body] of await everyPage()) {
      for (const [tag] of body.matchAll(/<div\b[^>]*aria-label="[^"]*"[^>]*>/g)) {
        expect(tag, `${path} — ${tag}`).toMatch(/\brole="/);
      }
    }
  });

  it("uses ids uniquely, since a duplicate id silently breaks label association", async () => {
    for (const [path, body] of await everyPage()) {
      const ids = [...body.matchAll(new RegExp(ID_ATTR, "g"))].map(([, id]) => id);
      expect([...new Set(ids)].sort(), path).toEqual([...ids].sort());
    }
  });
});

// --- the stylesheet's accessibility guarantees ------------------------------

describe("the shared stylesheet keeps its accessibility guarantees", () => {
  it("shows a real focus ring, including on fields that suppress the default outline", async () => {
    const body = await publicHtml("/");
    expect(body).toContain(":focus-visible{outline:3px solid var(--accent);outline-offset:3px}");
    // input:focus sets outline:none for the pointer case, so :focus-visible has
    // to put it back or a keyboard user is left with a 16%-alpha tint.
    expect(body).toContain(
      "input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:2px}"
    );
  });

  it("stops moving for anyone who asks it to", async () => {
    for (const [path, body] of await everyPage()) {
      expect(body, path).toContain("@media(prefers-reduced-motion:reduce)");
      expect(body, path).toContain("html{scroll-behavior:auto}");
      expect(body, path).toMatch(/animation-iteration-count:1 !important/);
    }
  });

  it("grows nav and row controls to 44px on a touch screen", async () => {
    const landing = await publicHtml("/");
    expect(landing).toContain(".nav a,footer.site nav a,.toc a{min-height:44px");
    const dashboard = await appHtml("/admin");
    expect(dashboard).toMatch(/@media\(pointer:coarse\)\{[^}]*min-height:44px/);
  });

  it("keeps wide tables inside their own scroll box rather than widening the page", async () => {
    for (const path of ["/docs", "/privacy"]) {
      const body = await publicHtml(path);
      expect(body, path).toContain(".table-wrap{overflow-x:auto");
      // Every table on these pages is inside one.
      const tables = (body.match(/<table\b/g) ?? []).length;
      const wrapped = (body.match(/<div class="table-wrap"><table\b/g) ?? []).length;
      expect(wrapped, path).toBe(tables);
    }
  });
});

// --- colour contrast --------------------------------------------------------

/** WCAG relative luminance for an `#rrggbb` colour. */
function luminance(hex: string): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every `--name:#hex` in the stylesheet, in source order: dark scheme, then light. */
function tokens(body: string, name: string): string[] {
  return [...body.matchAll(new RegExp(`--${name}:(#[0-9a-f]{6})`, "g"))].map(([, hex]) => hex);
}

describe("text colours clear 4.5:1 in both colour schemes", () => {
  it("holds for the muted and faint inks the whole product writes in", async () => {
    const body = await publicHtml("/");
    const inks = { muted: tokens(body, "muted"), faint: tokens(body, "faint") };
    // Two declarations each: :root (dark) then the prefers-color-scheme:light block.
    expect(inks.muted).toHaveLength(2);
    expect(inks.faint).toHaveLength(2);

    // Checked against the *lighter* of the two dark backgrounds and the *darker*
    // of the two light ones — the worst case of the page gradient in each scheme.
    const bg = { dark: tokens(body, "bg2")[0], light: tokens(body, "bg2")[1] };
    for (const [name, [dark, light]] of Object.entries(inks)) {
      expect(contrast(dark, bg.dark), `${name} (dark)`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(light, bg.light), `${name} (light)`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("holds for the status colours a result message is painted in", async () => {
    const body = await publicHtml("/");
    const bg = { dark: tokens(body, "bg2")[0], light: tokens(body, "bg2")[1] };
    for (const name of ["ok", "danger", "accent", "link-hover"]) {
      const [dark, light] = tokens(body, name);
      expect(contrast(dark, bg.dark), `${name} (dark)`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(light, bg.light), `${name} (light)`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
