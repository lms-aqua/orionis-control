import { describe, expect, it, vi } from 'vitest';
import {
  buildDigestHeader,
  parseDigestChallenge,
  fetchWithDigest,
} from '../../src/lib/http-digest.ts';

describe('parseDigestChallenge', () => {
  it('parses a Digest challenge with quoted and bare fields', () => {
    const challenge = parseDigestChallenge(
      'Digest realm="testrealm@host.com", qop="auth", nonce="abc123", opaque="xyz"',
    );
    expect(challenge).toEqual({
      realm: 'testrealm@host.com',
      nonce: 'abc123',
      qop: 'auth',
      opaque: 'xyz',
      algorithm: null,
    });
  });

  it('returns null for a Basic challenge', () => {
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull();
  });

  it('returns null when there is no challenge at all', () => {
    expect(parseDigestChallenge(null)).toBeNull();
  });
});

describe('buildDigestHeader', () => {
  // The worked example from RFC 2617 §3.5 — a fixed vector that pins the whole
  // computation without a live camera.
  it('reproduces the RFC 2617 response hash', () => {
    const header = buildDigestHeader({
      username: 'Mufasa',
      password: 'Circle Of Life',
      method: 'GET',
      uri: '/dir/index.html',
      cnonce: '0a4f113b',
      nc: '00000001',
      challenge: {
        realm: 'testrealm@host.com',
        nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
        qop: 'auth',
        opaque: '5ccc069c403ebaf9f0171e9517f40e41',
        algorithm: null,
      },
    });
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain('qop=auth');
    expect(header).toContain('nc=00000001');
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it('omits qop and cnonce when the challenge offers no qop', () => {
    const header = buildDigestHeader({
      username: 'u',
      password: 'p',
      method: 'GET',
      uri: '/x',
      cnonce: 'fixed',
      challenge: { realm: 'r', nonce: 'n', qop: null, opaque: null, algorithm: null },
    });
    expect(header).not.toContain('qop=');
    expect(header).not.toContain('cnonce=');
    expect(header).not.toContain('opaque=');
  });
});

describe('fetchWithDigest', () => {
  it('answers a Digest challenge on the retry', async () => {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      calls.push({ url, auth });
      if (!auth) {
        return new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Digest realm="cam", nonce="n1", qop="auth"' },
        });
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchWithDigest(fetchImpl, 'http://cam.invalid/api?x=1', {
      username: 'u',
      password: 'p',
      timeoutMs: 1000,
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.auth).toBeUndefined();
    expect(calls[1]!.auth).toMatch(/^Digest /);
    // The Request-URI in the header is path + query, not the whole URL.
    expect(calls[1]!.auth).toContain('uri="/api?x=1"');
  });

  it('falls back to Basic when the camera asks for it', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (!auth) {
        return new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Basic realm="cam"' },
        });
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchWithDigest(fetchImpl, 'http://cam.invalid/pic', {
      username: 'u',
      password: 'p',
      timeoutMs: 1000,
    });
    expect(res.status).toBe(200);
  });

  it('passes a 200 straight through without a second request', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('ok', { status: 200 }),
    ) as unknown as typeof fetch;
    const res = await fetchWithDigest(fetchImpl, 'http://cam.invalid/pic', {
      username: 'u',
      password: 'p',
      timeoutMs: 1000,
    });
    expect(res.status).toBe(200);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });
});
