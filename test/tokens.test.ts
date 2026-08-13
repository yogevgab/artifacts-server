import { describe, it, expect } from "vitest";
import {
  generateToken,
  tokenId,
  hashToken,
  parseScopes,
  rowScopes,
  isTokenUsable,
  needsTouch,
  toPublicToken,
  DEFAULT_SCOPES,
  type ApiTokenRow,
} from "../src/tokens";

const row = (over: Partial<ApiTokenRow> = {}): ApiTokenRow => ({
  id: "abc123abc123",
  name: "test",
  owner_email: "bob@beta.com",
  is_admin: 0,
  scopes: "read,publish",
  created_by: "admin@test.com",
  created_at: "2026-01-01T00:00:00.000Z",
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  ...over,
});

describe("token generation", () => {
  it("mints rtfx_<id>_<secret> with the id recoverable from the string", () => {
    const { id, token } = generateToken();
    expect(token.startsWith(`rtfx_${id}_`)).toBe(true);
    expect(tokenId(token)).toBe(id);
  });

  it("is unguessable: every token differs and carries ≥256 bits of secret", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken().token));
    expect(tokens.size).toBe(200);
    // base64url can itself contain "_", so take everything past the id prefix.
    const { id, token } = generateToken();
    expect(token.slice(`rtfx_${id}_`.length).length).toBe(43); // 32 bytes, base64url
  });

  it("rejects strings that are not our tokens", () => {
    expect(tokenId("nope")).toBeNull();
    expect(tokenId("rtfx_zzzz_secret")).toBeNull();
    expect(tokenId("rtfx_abc123abc123_short")).toBeNull();
  });
});

describe("token hashing", () => {
  it("is deterministic and 64 hex chars (SHA-256)", async () => {
    const h = await hashToken("rtfx_abc_def");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken("rtfx_abc_def")).toBe(h);
  });

  it("differs for tokens that differ by one character", async () => {
    expect(await hashToken("rtfx_abc_def")).not.toBe(await hashToken("rtfx_abc_deg"));
  });

  it("never contains the plaintext", async () => {
    const { id, token } = generateToken();
    const hash = await hashToken(token);
    expect(hash).not.toContain(token.slice(`rtfx_${id}_`.length));
    expect(hash).not.toContain(token);
  });
});

describe("scopes", () => {
  it("accepts a known, de-duplicated, case-insensitive list", () => {
    expect(parseScopes(["read", "PUBLISH", "read"])).toEqual(["read", "publish"]);
  });

  it("rejects unknown scopes, empty lists, and non-arrays", () => {
    expect(parseScopes(["read", "root"])).toBeNull();
    expect(parseScopes([])).toBeNull();
    expect(parseScopes("read")).toBeNull();
    expect(parseScopes([1])).toBeNull();
    expect(parseScopes(undefined)).toBeNull();
  });

  it("defaults to read + publish — never manage", () => {
    expect(DEFAULT_SCOPES).toEqual(["read", "publish"]);
  });

  it("ignores unrecognized scopes stored on a row", () => {
    expect(rowScopes({ scopes: "read, publish ,bogus" })).toEqual(["read", "publish"]);
  });
});

describe("token usability", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");

  it("a fresh, non-expiring token is usable", () => {
    expect(isTokenUsable(row(), now)).toBe(true);
  });

  it("a revoked token is not", () => {
    expect(isTokenUsable(row({ revoked_at: "2026-05-01T00:00:00.000Z" }), now)).toBe(false);
  });

  it("an expired token is not — and expiry at the exact instant counts as expired", () => {
    expect(isTokenUsable(row({ expires_at: "2026-05-31T23:59:59.000Z" }), now)).toBe(false);
    expect(isTokenUsable(row({ expires_at: now.toISOString() }), now)).toBe(false);
    expect(isTokenUsable(row({ expires_at: "2026-06-01T00:00:01.000Z" }), now)).toBe(true);
  });
});

describe("last-used tracking", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");

  it("touches a never-used token, then throttles", () => {
    expect(needsTouch(row(), now)).toBe(true);
    expect(needsTouch(row({ last_used_at: "2026-05-31T23:59:00.000Z" }), now)).toBe(false);
    expect(needsTouch(row({ last_used_at: "2026-05-31T23:50:00.000Z" }), now)).toBe(true);
    expect(needsTouch(row({ last_used_at: "not-a-date" }), now)).toBe(true);
  });
});

describe("public representation", () => {
  it("exposes no secret material and decodes flags", () => {
    const pub = toPublicToken(row({ is_admin: 1, scopes: "read,manage" }));
    expect(pub).toMatchObject({ id: "abc123abc123", is_admin: true, scopes: ["read", "manage"] });
    expect(JSON.stringify(pub)).not.toContain("hash");
  });
});
