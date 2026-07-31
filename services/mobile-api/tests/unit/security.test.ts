import { describe, expect, it } from 'vitest';
import {
  createPkcePair,
  hashToken,
  pkceChallengeFor,
  randomToken,
  safeEqual,
  verifyPkce,
} from '../../src/lib/crypto.ts';
import { redact, redactString, redactUrl, REDACTED } from '../../src/lib/redact.ts';
import { AppError, isRecoverable, statusForCode } from '../../src/lib/errors.ts';
import { fail, ok } from '../../src/lib/envelope.ts';

describe('PKCE', () => {
  it('generates an RFC 7636-compliant verifier and S256 challenge', () => {
    const pair = createPkcePair();
    expect(pair.method).toBe('S256');
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.verifier.length).toBeLessThanOrEqual(128);
    expect(pair.verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(pair.challenge).not.toBe(pair.verifier);
    expect(verifyPkce(pair.verifier, pair.challenge)).toBe(true);
  });

  it('is deterministic for a given verifier', () => {
    const pair = createPkcePair();
    expect(pkceChallengeFor(pair.verifier)).toBe(pair.challenge);
  });

  it('rejects a mismatched verifier', () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(verifyPkce(b.verifier, a.challenge)).toBe(false);
  });

  it('rejects verifiers that are too short, too long, or malformed', () => {
    const { challenge } = createPkcePair();
    expect(verifyPkce('too-short', challenge)).toBe(false);
    expect(verifyPkce('a'.repeat(129), challenge)).toBe(false);
    expect(verifyPkce(`${'a'.repeat(42)}!`, challenge)).toBe(false);
  });

  it('produces unique pairs', () => {
    const seen = new Set(Array.from({ length: 50 }, () => createPkcePair().verifier));
    expect(seen.size).toBe(50);
  });
});

describe('token hashing', () => {
  it('never stores the plaintext', () => {
    const token = randomToken(32);
    const hash = hashToken(token);
    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
    expect(hashToken(token)).toBe(hash);
  });

  it('compares in constant time without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('redaction', () => {
  it('removes values under sensitive keys, recursively', () => {
    const input = {
      username: 'pat',
      password: 'hunter2',
      nested: { refresh_token: 'abc123', clientSecret: 'shh', keep: 'visible' },
      list: [{ apiKey: 'k' }],
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.username).toBe('pat');
    expect(out.password).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).refresh_token).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).clientSecret).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).keep).toBe('visible');
    expect(((out.list as unknown[])[0] as Record<string, unknown>).apiKey).toBe(REDACTED);
  });

  it('removes secret-shaped values even under innocent keys', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(redactString(`token is ${jwt}`)).not.toContain('eyJhbGciOi');
    expect(redactString('Authorization: Bearer abc123def456')).toContain(REDACTED);
    expect(redactString('-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----')).toBe(
      REDACTED,
    );
  });

  it('handles cycles and bounds depth', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    expect((redact(a) as Record<string, unknown>).self).toBe('[circular]');
  });

  it('strips credentials and query strings from URLs', () => {
    expect(redactUrl('https://user:pw@host.invalid/path?token=abc')).toBe(
      'https://host.invalid/path?[redacted]',
    );
    expect(redactUrl('not a url')).toBe('not a url');
  });
});

describe('error mapping', () => {
  it('maps codes to the right HTTP status', () => {
    expect(statusForCode('UNAUTHENTICATED')).toBe(401);
    expect(statusForCode('INSUFFICIENT_ROLE')).toBe(403);
    expect(statusForCode('NOT_FOUND')).toBe(404);
    expect(statusForCode('RULE_DUPLICATE')).toBe(409);
    expect(statusForCode('RULE_INVALID')).toBe(422);
    expect(statusForCode('RATE_LIMITED')).toBe(429);
    expect(statusForCode('CAPABILITY_UNSUPPORTED')).toBe(501);
    expect(statusForCode('SERVICE_NOT_CONFIGURED')).toBe(503);
    expect(statusForCode('UPSTREAM_TIMEOUT')).toBe(504);
  });

  it('marks only genuinely retryable codes as recoverable', () => {
    expect(isRecoverable('UPSTREAM_TIMEOUT')).toBe(true);
    expect(isRecoverable('CAMERA_OFFLINE')).toBe(true);
    expect(isRecoverable('INSUFFICIENT_ROLE')).toBe(false);
    expect(isRecoverable('VALIDATION_FAILED')).toBe(false);
    expect(isRecoverable('RULE_DUPLICATE')).toBe(false);
  });

  it('builds envelopes with a request id and ISO timestamp', () => {
    const success = ok({ hello: 'world' }, 'req_1');
    expect(success.success).toBe(true);
    expect(success.requestId).toBe('req_1');
    expect(() => new Date(success.serverTime).toISOString()).not.toThrow();

    const failure = fail(new AppError('CAMERA_OFFLINE', 'The camera is unavailable.'), 'req_2');
    expect(failure.success).toBe(false);
    expect(failure.error.code).toBe('CAMERA_OFFLINE');
    expect(failure.error.recoverable).toBe(true);
    expect(failure.error.details).toBeNull();
  });
});
