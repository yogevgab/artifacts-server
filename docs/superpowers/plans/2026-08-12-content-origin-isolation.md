# Content Origin Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make the artifact-serving path host-aware so a configurable "content hostname" (e.g. `a.rtfx.pro`) can serve only artifact files, never `/admin`, `/api/*`, `/whoami`, `/health`, `/v/*`, or the gallery `/`.

**Architecture:** Add a pure, unit-testable `src/host.ts` module that (a) parses a comma-separated `CONTENT_HOSTNAMES` env var, (b) extracts the request hostname from the Hono `Context`'s request URL (authoritative in Workers — reflects the actual routed hostname, not a spoofable read of a raw header in a way that differs from what Cloudflare's edge matched), and (c) classifies a path as a "management path" (any named app route) vs. an artifact path. Wire one `app.use("*", ...)` middleware into `src/index.ts`, registered before all other routes, that 404s management paths when the request's hostname is a configured content host. Everything else (including the existing catch-all artifact route) is untouched, so app-host behavior is unchanged and content-host requests for real artifact paths fall through normally.

**Tech Stack:** Cloudflare Workers, Hono, TypeScript, Vitest (`@cloudflare/vitest-pool-workers`).

**Spec:** GitHub issue #1 (P0 launch security: split artifact content onto a content-only origin) — task description in the conversation that produced this plan; no separate design doc.

## Global Constraints

- Do not deploy. Do not add secrets. Do not edit landing/marketing copy.
- Preserve existing behavior and tests: with `CONTENT_HOSTNAMES` unset (the default), every existing route on every host must behave exactly as today.
- New env var must be configurable (wrangler var), not a hardcoded hostname.
- `npm run check` (`tsc --noEmit && vitest run`) must pass at the end.

---

### Task 1: Env var plumbing

**Files:**
- Modify: `src/env.ts` (add `CONTENT_HOSTNAMES?: string` to the `Env` interface)
- Modify: `wrangler.jsonc` (add `CONTENT_HOSTNAMES: ""` to `vars`, with a comment; add a comment near `routes` explaining how to add a second route for the content host)

**Interfaces:**
- Produces: `Env.CONTENT_HOSTNAMES?: string` — comma-separated list of hostnames (case-insensitive) that should be treated as content-only origins. Consumed by Task 2's `src/host.ts`.

- [x] **Step 1: Add the field to `Env`**

In `src/env.ts`, inside the `Env` interface, add (near the other top-level config fields, after `DEV_LOGIN`):

```ts
  /**
   * Comma-separated hostnames (e.g. "a.rtfx.pro" or "a.rtfx.pro,a-staging.rtfx.pro")
   * that serve artifact content ONLY — no /admin, /api, /whoami, /health, /v, or "/".
   * Leave unset to keep everything on a single origin (current behavior).
   */
  CONTENT_HOSTNAMES?: string;
```

- [x] **Step 2: Document the var in `wrangler.jsonc`**

In `wrangler.jsonc`, inside `"vars"`, add after `ACCESS_VIEWER_POLICY_ID`:

```jsonc
    "ACCESS_VIEWER_POLICY_ID": "",
    // Comma-separated hostnames that serve artifact content ONLY (no admin/API/
    // dashboard). Leave empty to keep a single origin. To actually route a second
    // hostname to this Worker, add another entry to `routes` below, e.g.
    // { "pattern": "a.rtfx.pro", "custom_domain": true }, and list it here.
    "CONTENT_HOSTNAMES": ""
```

(Adjust trailing commas as needed to keep valid JSONC.)

- [x] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: passes with no errors (the field is optional, so no existing call sites break).

- [x] **Step 4: Commit**

```bash
git add src/env.ts wrangler.jsonc
git commit -m "Add configurable CONTENT_HOSTNAMES env var"
```

---

### Task 2: `src/host.ts` — pure host/path classification helpers

**Files:**
- Create: `src/host.ts`
- Test: `test/host.test.ts`

**Interfaces:**
- Consumes: `Env` from `src/env.ts` (`Task 1`).
- Produces (consumed by Task 3):
  - `parseHostnames(raw: string | undefined): Set<string>`
  - `requestHostname(url: string): string`
  - `isContentHost(env: Env, url: string): boolean`
  - `isManagementPath(path: string): boolean`

- [x] **Step 1: Write the failing tests**

Create `test/host.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseHostnames, requestHostname, isContentHost, isManagementPath } from "../src/host";
import type { Env } from "../src/env";

describe("parseHostnames", () => {
  it("splits, trims, lowercases, and drops empties", () => {
    expect(parseHostnames("A.com, b.com ,,c.COM")).toEqual(new Set(["a.com", "b.com", "c.com"]));
  });
  it("handles undefined", () => {
    expect(parseHostnames(undefined)).toEqual(new Set());
  });
});

describe("requestHostname", () => {
  it("extracts a lowercase hostname from a URL", () => {
    expect(requestHostname("https://A.Rtfx.pro/solo/")).toBe("a.rtfx.pro");
  });
  it("returns empty string for an invalid URL", () => {
    expect(requestHostname("not-a-url")).toBe("");
  });
});

describe("isContentHost", () => {
  it("is false when CONTENT_HOSTNAMES is unset", () => {
    expect(isContentHost({} as Env, "https://a.rtfx.pro/x")).toBe(false);
  });
  it("is true only for a hostname in the configured list", () => {
    const env = { CONTENT_HOSTNAMES: "a.rtfx.pro,b.rtfx.pro" } as Env;
    expect(isContentHost(env, "https://a.rtfx.pro/x")).toBe(true);
    expect(isContentHost(env, "https://b.rtfx.pro/x")).toBe(true);
    expect(isContentHost(env, "https://rtfx.pro/x")).toBe(false);
  });
});

describe("isManagementPath", () => {
  it("blocks exact management paths", () => {
    for (const p of ["/", "/health", "/whoami", "/admin", "/api", "/v"]) {
      expect(isManagementPath(p)).toBe(true);
    }
  });
  it("blocks nested management paths", () => {
    for (const p of ["/admin/", "/api/artifacts", "/v/slug/1/index.html"]) {
      expect(isManagementPath(p)).toBe(true);
    }
  });
  it("does not block artifact paths that merely start with a reserved word", () => {
    for (const p of ["/adminfoo", "/apidocs", "/vault/"]) {
      expect(isManagementPath(p)).toBe(false);
    }
  });
  it("does not block ordinary artifact paths", () => {
    for (const p of ["/solo/", "/bundle/app.js"]) {
      expect(isManagementPath(p)).toBe(false);
    }
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/host.test.ts`
Expected: FAIL — `src/host.ts` does not exist yet (module not found).

- [x] **Step 3: Implement `src/host.ts`**

```ts
import type { Env } from "./env";

const MANAGEMENT_PATHS = new Set(["/", "/health", "/whoami"]);
const MANAGEMENT_PREFIXES = ["/admin", "/api", "/v"];

/** Parse a comma-separated hostname list (env var) into a lowercase set. */
export function parseHostnames(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** Lowercase hostname from a full request URL (authoritative in Workers). */
export function requestHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** True if this request's hostname is a configured content-only origin. */
export function isContentHost(env: Env, url: string): boolean {
  const hosts = parseHostnames(env.CONTENT_HOSTNAMES);
  if (hosts.size === 0) return false;
  return hosts.has(requestHostname(url));
}

/**
 * True for app-only management/dashboard routes (gallery, admin, API, whoami,
 * health, version preview) that must never be reachable from a content host.
 */
export function isManagementPath(path: string): boolean {
  if (MANAGEMENT_PATHS.has(path)) return true;
  return MANAGEMENT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/host.test.ts`
Expected: PASS (all cases above).

- [x] **Step 5: Commit**

```bash
git add src/host.ts test/host.test.ts
git commit -m "Add host/path classification helpers for content-origin isolation"
```

---

### Task 3: Wire host-aware middleware into `src/index.ts`

**Files:**
- Modify: `src/index.ts`
- Test: `test/integration.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `isContentHost`, `isManagementPath` from `src/host.ts` (Task 2); `notFoundPage` already imported from `src/pages.ts`.

- [x] **Step 1: Write the failing integration tests**

Append to `test/integration.test.ts` (after the last `describe` block, using the existing `req`, `htmlForm`, `env`, `app` already in scope in that file):

```ts
describe("content host isolation", () => {
  const CONTENT_HOST = "content.test.local";
  const contentEnv = { ...env, CONTENT_HOSTNAMES: CONTENT_HOST } as any;
  const contentReq = (path: string, init?: RequestInit) =>
    app.request(`https://${CONTENT_HOST}${path}`, init, contentEnv);
  const appReq = (path: string, init?: RequestInit) =>
    app.request(`https://app.test.local${path}`, init, contentEnv);

  it("serves artifact files on the content host", async () => {
    await req("/api/artifacts", {
      method: "POST",
      body: htmlForm({ title: "Solo", slug: "solo" }, "x.html", strToU8("<h1>solo</h1>")),
    });
    const res = await contentReq("/solo/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("solo");
  });

  it("blocks management routes on the content host", async () => {
    await req("/api/artifacts", {
      method: "POST",
      body: htmlForm({ title: "Solo2", slug: "solo2" }, "x.html", strToU8("<h1>solo2</h1>")),
    });
    for (const path of ["/", "/health", "/whoami", "/admin", "/api/artifacts", "/v/solo2/1/"]) {
      const res = await contentReq(path);
      expect(res.status).toBe(404);
    }
  });

  it("leaves the app host fully functional when CONTENT_HOSTNAMES is configured", async () => {
    expect((await appReq("/health")).status).toBe(200);
    expect((await appReq("/admin")).status).toBe(200);
  });

  it("with CONTENT_HOSTNAMES unset, every existing host behaves as before (no restriction)", async () => {
    expect((await req("/admin")).status).toBe(200);
    expect((await req("/health")).status).toBe(200);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/integration.test.ts -t "content host isolation"`
Expected: FAIL — the "blocks management routes" case fails because `/admin`, `/api/artifacts`, etc. currently return 200/other on any host.

- [x] **Step 3: Implement the middleware in `src/index.ts`**

Add the import (with the other local imports near the top):

```ts
import { isContentHost, isManagementPath } from "./host";
```

Add the middleware as the very first thing registered on `app`, immediately after `const app = new Hono<...>();` and before `app.get("/health", ...)`:

```ts
// Content-origin isolation: a configured content host (CONTENT_HOSTNAMES) may
// only serve artifact files — never the dashboard/API/admin/gallery routes.
app.use("*", async (c, next) => {
  if (isContentHost(c.env, c.req.url) && isManagementPath(c.req.path)) {
    return c.html(notFoundPage(), 404);
  }
  await next();
});
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/integration.test.ts -t "content host isolation"`
Expected: PASS (all 4 new cases).

- [x] **Step 5: Run the full suite**

Run: `npm run check`
Expected: `tsc --noEmit` passes and all Vitest suites (including the pre-existing ones) pass unchanged.

- [x] **Step 6: Commit**

```bash
git add src/index.ts test/integration.test.ts
git commit -m "Enforce content-origin isolation via host-aware middleware"
```

---

## Self-Review Notes

- Spec coverage: content host can serve artifacts (Task 3 test 1); content host blocks `/admin`, `/api/*`, `/whoami`, `/health`, and (as a judgment call, since the task text left it open) the gallery `/` and admin-only `/v/*` version-preview route, all as management paths (Task 3 test 2); app host unaffected, including when `CONTENT_HOSTNAMES` is set (Task 3 tests 3–4); hostname configurable via env var, not hardcoded (Task 1); `npm run check` passes (Task 3 step 5).
- No placeholders: every step has literal code.
- Type consistency: `isContentHost(env, url)` and `isManagementPath(path)` signatures match between Task 2's definition and Task 3's call site.
