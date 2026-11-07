/**
 * Sign-in challenges.
 *
 * One challenge serves both routes into the product: a 6-digit code the person
 * types, and a magic-link token they click. They are two representations of the
 * same grant, so redeeming either closes both — a link that still worked after
 * its code had been used would be a second, invisible credential.
 *
 * Neither the code nor the token is stored in plaintext; only SHA-256 hashes,
 * matching how `api_tokens` already treats its secrets.
 */

import type { Env } from "./env";
import { hashToken } from "./tokens";
import { timingSafeEqual } from "./reviewer";

/** How long a challenge lives. Long enough to fetch a phone, short enough to matter. */
export const CHALLENGE_TTL_MINUTES = 15;

/**
 * Wrong codes tolerated before the challenge is burned. Six digits is a million
 * possibilities; five attempts makes online guessing hopeless without making a
 * fat-fingered person start over immediately.
 */
export const MAX_ATTEMPTS = 5;

export type ChallengePurpose = "signin" | "guest";

export interface Challenge {
  email: string;
  purpose: ChallengePurpose;
  slug?: string;
}

export interface IssuedChallenge extends Challenge {
  /** Shown to the person. Never stored. */
  code: string;
  /** Embedded in the magic link. Never stored. */
  token: string;
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A uniformly-distributed 6-digit code. Rejection sampling rather than `% 1e6`,
 * which would bias the low end of the range.
 */
function sixDigitCode(): string {
  const limit = 1_000_000;
  const max = Math.floor(0xffffffff / limit) * limit;
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= max);
  return String(n % limit).padStart(6, "0");
}

export async function createChallenge(
  env: Env,
  o: {
    email: string;
    purpose: ChallengePurpose;
    slug?: string;
    now: string;
    noLink?: boolean;
    /**
     * The customer-host origin this challenge was issued on (a custom domain),
     * or omitted for the app hosts. A challenge can only be redeemed on the
     * origin that issued it: the owner of a custom domain controls the server
     * behind it, so whatever it can read (a code, a magic token) must be worth
     * nothing on rtfx.pro.
     */
    origin?: string | null;
  }
): Promise<IssuedChallenge> {
  const email = normalize(o.email);
  const code = sixDigitCode();
  const token = hex(crypto.getRandomValues(new Uint8Array(24)));
  const id = hex(crypto.getRandomValues(new Uint8Array(12)));

  const expiresAt = new Date(
    Date.parse(o.now) + CHALLENGE_TTL_MINUTES * 60_000
  ).toISOString();

  // The code hash is salted with the email so an attacker holding the table
  // cannot precompute one rainbow table across all million codes and match it
  // against every row at once.
  const [codeHash, tokenHash] = await Promise.all([
    hashToken(`${email}:${code}`),
    // noLink (reviewer): the stored hash is of a value never returned or sent,
    // so no magic link can ever redeem this challenge.
    hashToken(o.noLink ? `nolink:${token}` : token),
  ]);

  if (o.origin) {
    // Migration 0026 adds the column; only customer-host sign-ins need it, so a
    // Worker ahead of the migration still signs in on the app hosts.
    await env.DB.prepare(
      `INSERT INTO auth_challenges
         (id, email, code_hash, token_hash, purpose, slug, attempts, expires_at, consumed_at, created_at, origin)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`
    )
      .bind(id, email, codeHash, tokenHash, o.purpose, o.slug ?? null, expiresAt, o.now, o.origin)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO auth_challenges
         (id, email, code_hash, token_hash, purpose, slug, attempts, expires_at, consumed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)`
    )
      .bind(id, email, codeHash, tokenHash, o.purpose, o.slug ?? null, expiresAt, o.now)
      .run();
  }

  return { email, purpose: o.purpose, slug: o.slug, code, token };
}

interface Row {
  id: string;
  email: string;
  purpose: string;
  slug: string | null;
  attempts: number;
  /** Customer-host origin that issued it; null/absent = the app hosts. */
  origin?: string | null;
}

/**
 * Does this challenge belong to the origin redeeming it? `requestOrigin` is the
 * customer origin of the redeeming request, or null on an app host; `undefined`
 * skips the check (unit tests). A challenge issued on a custom domain is only
 * good there, and one issued on the app hosts is never good on a custom domain.
 */
function originMatches(row: Row, requestOrigin: string | null | undefined): boolean {
  if (requestOrigin === undefined) return true;
  return (row.origin ?? null) === (requestOrigin ?? null);
}

function toChallenge(row: Row): Challenge {
  return {
    email: row.email,
    purpose: row.purpose === "guest" ? "guest" : "signin",
    ...(row.slug ? { slug: row.slug } : {}),
  };
}

/** Mark a challenge used. Conditional, so two concurrent redeems cannot both win. */
async function consume(env: Env, id: string, now: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`
  )
    .bind(now, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Redeem by typed code. Only a MEMBER sign-in challenge (`purpose = 'signin'`)
 * can be redeemed this way: `/auth/verify` mints a member session from the
 * result, so a guest-share challenge (which is bound to one artifact and must
 * only ever yield a guest credential) must be invisible here. Without the filter
 * its code would have minted a member session.
 *
 * Returns null for every failure — wrong code, expired,
 * already used, wrong address, too many attempts — because the caller must not
 * be able to tell those apart, and neither must the person typing.
 */
export async function redeemCode(
  env: Env,
  email: string,
  code: string,
  now: string,
  requestOrigin?: string | null
): Promise<Challenge | null> {
  const addr = normalize(email);
  const codeHash = await hashToken(`${addr}:${code}`);

  const rows = await env.DB.prepare(
    `SELECT * FROM auth_challenges
      WHERE email = ? AND consumed_at IS NULL AND expires_at > ? AND purpose = 'signin'
      ORDER BY created_at DESC LIMIT 10`
  )
    .bind(addr, now)
    .all<Row>();
  // The newest challenge issued on THIS origin (a code mailed for docs.acme.com
  // is invisible to rtfx.pro, and the other way round).
  const row = (rows.results ?? []).find((r) => originMatches(r, requestOrigin)) ?? null;

  if (!row) return await spendDummyGuess(env, codeHash);
  // Every guess spends an attempt BEFORE it is checked (see reserveAttempt),
  // so parallel requests cannot all slip under the cap.
  if (!(await reserveAttempt(env, row.id))) return null;

  const match = await env.DB.prepare(
    `SELECT id FROM auth_challenges WHERE id = ? AND code_hash = ?`
  )
    .bind(row.id, codeHash)
    .first<{ id: string }>();

  if (!match) return null;
  return (await consume(env, row.id, now)) ? toChallenge(row) : null;
}

/**
 * The same two statements a real guess runs (a conditional UPDATE, then a hash
 * lookup), aimed at a row that does not exist. Without it, "no challenge for
 * this address" returns measurably faster than "wrong code", and since the
 * artifact gate now issues member challenges only to people who belong to the
 * artifact, that latency would say who does. Always resolves to null.
 */
async function spendDummyGuess(env: Env, codeHash: string): Promise<null> {
  await reserveAttempt(env, "-");
  await env.DB.prepare(`SELECT id FROM auth_challenges WHERE id = ? AND code_hash = ?`)
    .bind("-", codeHash)
    .first<{ id: string }>();
  return null;
}

/**
 * Spend one attempt on a challenge, atomically, before the guess is compared.
 * A single conditional UPDATE: it succeeds only while the challenge is unused
 * and under MAX_ATTEMPTS, so N concurrent guesses get at most MAX_ATTEMPTS
 * evaluations between them. (Reading `attempts`, comparing, then incrementing
 * let parallel requests all read 0 and all guess — which mattered most for the
 * reviewer's fixed code, where ruled-out guesses carry over between challenges.)
 */
async function reserveAttempt(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE auth_challenges SET attempts = attempts + 1
      WHERE id = ? AND consumed_at IS NULL AND attempts < ?`
  )
    .bind(id, MAX_ATTEMPTS)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Redeem the reviewer's fixed code. Mirrors {@link redeemCode}: needs an
 * unconsumed, unexpired challenge (so a start is required first), counts
 * attempts on it, burns at MAX_ATTEMPTS, consumes on success.
 */
export async function redeemReviewerCode(
  env: Env,
  email: string,
  code: string,
  expected: string,
  now: string,
  requestOrigin?: string | null
): Promise<Challenge | null> {
  const addr = normalize(email);
  const rows = await env.DB.prepare(
    `SELECT * FROM auth_challenges
      WHERE email = ? AND consumed_at IS NULL AND expires_at > ? AND purpose = 'signin'
      ORDER BY created_at DESC LIMIT 10`
  )
    .bind(addr, now)
    .all<Row>();
  const row = (rows.results ?? []).find((r) => originMatches(r, requestOrigin)) ?? null;
  if (!row) return await spendDummyGuess(env, "-");
  if (!(await reserveAttempt(env, row.id))) return null;
  if (!timingSafeEqual(code, expected)) return null;
  return (await consume(env, row.id, now)) ? toChallenge(row) : null;
}

/** Redeem by magic-link token. Same single-use semantics as the code. */
export async function redeemToken(
  env: Env,
  token: string,
  now: string,
  requestOrigin?: string | null
): Promise<Challenge | null> {
  if (!token) return null;
  const tokenHash = await hashToken(token);

  const row = await env.DB.prepare(
    `SELECT * FROM auth_challenges
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`
  )
    .bind(tokenHash, now)
    .first<Row>();

  if (!row) return null;
  // Wrong origin: refuse WITHOUT consuming, so the legitimate host can still redeem.
  if (!originMatches(row, requestOrigin)) return null;
  return (await consume(env, row.id, now)) ? toChallenge(row) : null;
}
