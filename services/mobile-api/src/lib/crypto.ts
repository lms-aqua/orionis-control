/** PKCE, opaque tokens, hashing and constant-time comparison. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

export function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

/** Storage form for any bearer-like secret. The plaintext is never persisted. */
export function hashToken(token: string): string {
  return sha256(token).toString('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// --- PKCE (RFC 7636) --------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** Verifier length is 43–128 chars per RFC 7636; 32 random bytes gives 43. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallengeFor(verifier), method: 'S256' };
}

export function pkceChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Verifies a presented verifier against a stored S256 challenge. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;
  return safeEqual(pkceChallengeFor(verifier), challenge);
}
