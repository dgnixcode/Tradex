// Password hashing — plan/phase-00 T00.9.
//
// scrypt, from node:crypto. Chosen over Argon2id for one reason: Argon2 needs a
// native dependency, and a native build step on a Windows dev box is a real
// source of friction for a two-person team. scrypt is memory-hard, in the
// standard library, and strong at these parameters.
//
// The stored form is self-describing, so parameters can be raised later and old
// hashes still verify — `needsRehash()` reports when a hash predates the current
// cost settings.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Current cost. N=2^15 is ~32 MB per hash, which is a sane 2026 default. */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keylen: 32 } as const;

const SALT_BYTES = 16;
const maxmemFor = (N: number, r: number): number => 256 * N * r * 2;

export class PasswordError extends Error {
  override readonly name = 'PasswordError';
}

/** Minimum viable policy. Length beats composition rules. */
export function assertPasswordAcceptable(password: string): void {
  if (typeof password !== 'string') throw new PasswordError('password must be a string');
  if (password.length < 12) throw new PasswordError('password must be at least 12 characters');
  if (password.length > 1024) throw new PasswordError('password must be at most 1024 characters');
}

/** Returns `scrypt$N$r$p$saltB64$hashB64`. Safe to store; reveals no secret. */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordAcceptable(password);
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password, salt, keylen, { N, r, p, maxmem: maxmemFor(N, r) });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(stored: string): ParsedHash {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    throw new PasswordError('stored password hash is not in the expected scrypt format');
  }
  const N = Number.parseInt(parts[1] ?? '', 10);
  const r = Number.parseInt(parts[2] ?? '', 10);
  const p = Number.parseInt(parts[3] ?? '', 10);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    throw new PasswordError('stored password hash has malformed parameters');
  }
  return {
    N,
    r,
    p,
    salt: Buffer.from(parts[4] ?? '', 'base64'),
    hash: Buffer.from(parts[5] ?? '', 'base64'),
  };
}

/**
 * Constant-time verification. Never short-circuits on a mismatch, and never
 * reveals through its error whether the user exists — the caller decides that.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const { N, r, p, salt, hash } = parse(stored);
  const candidate = await scrypt(password, salt, hash.byteLength, { N, r, p, maxmem: maxmemFor(N, r) });
  return candidate.byteLength === hash.byteLength && timingSafeEqual(candidate, hash);
}

/** True when the hash was made with weaker parameters than we now use. */
export function needsRehash(stored: string): boolean {
  const { N, r, p } = parse(stored);
  return N < SCRYPT_PARAMS.N || r < SCRYPT_PARAMS.r || p < SCRYPT_PARAMS.p;
}
