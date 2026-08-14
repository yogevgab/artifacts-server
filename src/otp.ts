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
  o: { email: string; purpose: ChallengePurpose; slug?: string; now: string }
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
    hashToken(token),
  ]);

  await env.DB.prepare(
    `INSERT INTO auth_challenges
       (id, email, code_hash, token_hash, purpose, slug, attempts, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)`
  )
    .bind(id, email, codeHash, tokenHash, o.purpose, o.slug ?? null, expiresAt, o.now)
    .run();

  return { email, purpose: o.purpose, slug: o.slug, code, token };
}

interface Row {
  id: string;
  email: string;
  purpose: string;
  slug: string | null;
  attempts: number;
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
 * Redeem by typed code. Returns null for every failure — wrong code, expired,
 * already used, wrong address, too many attempts — because the caller must not
 * be able to tell those apart, and neither must the person typing.
 */
export async function redeemCode(
  env: Env,
  email: string,
  code: string,
  now: string
): Promise<Challenge | null> {
  const addr = normalize(email);
  const codeHash = await hashToken(`${addr}:${code}`);

  const row = await env.DB.prepare(
    `SELECT id, email, purpose, slug, attempts FROM auth_challenges
      WHERE email = ? AND consumed_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(addr, now)
    .first<Row & { code_hash?: string }>();

  if (!row) return null;
  if (row.attempts >= MAX_ATTEMPTS) return null;

  const match = await env.DB.prepare(
    `SELECT id FROM auth_challenges WHERE id = ? AND code_hash = ?`
  )
    .bind(row.id, codeHash)
    .first<{ id: string }>();

  if (!match) {
    // A wrong guess costs an attempt. At MAX_ATTEMPTS the challenge is dead
    // even for the correct code, which is what bounds brute force.
    await env.DB.prepare(
      `UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?`
    )
      .bind(row.id)
      .run();
    return null;
  }

  return (await consume(env, row.id, now)) ? toChallenge(row) : null;
}

/** Redeem by magic-link token. Same single-use semantics as the code. */
export async function redeemToken(
  env: Env,
  token: string,
  now: string
): Promise<Challenge | null> {
  if (!token) return null;
  const tokenHash = await hashToken(token);

  const row = await env.DB.prepare(
    `SELECT id, email, purpose, slug, attempts FROM auth_challenges
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`
  )
    .bind(tokenHash, now)
    .first<Row>();

  if (!row) return null;
  return (await consume(env, row.id, now)) ? toChallenge(row) : null;
}
