import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mintTurnCredential, turnIceServers, type TurnConfig } from '../../src/lib/turn.ts';

const CONFIG: TurnConfig = {
  urls: ['turn:203.0.113.10:16143?transport=udp'],
  staticAuthSecret: 'test-secret-not-a-real-one',
  credentialTtlSeconds: 300,
};

const NOW = new Date('2026-08-01T12:00:00.000Z');

describe('mintTurnCredential', () => {
  it('puts the expiry in the username, as the TURN REST scheme requires', () => {
    const { username, expiresAt } = mintTurnCredential(CONFIG, 'user-1', NOW);
    const [expiry, subject] = username.split(':');
    expect(Number(expiry)).toBe(Math.floor(NOW.getTime() / 1000) + 300);
    expect(subject).toBe('user-1');
    expect(expiresAt).toBe('2026-08-01T12:05:00.000Z');
  });

  it('is an HMAC-SHA1 of the username, base64 — what coturn recomputes', () => {
    const { username, credential } = mintTurnCredential(CONFIG, 'user-1', NOW);
    const expected = createHmac('sha1', CONFIG.staticAuthSecret).update(username).digest('base64');
    expect(credential).toBe(expected);
  });

  it('never returns the shared secret itself', () => {
    const minted = mintTurnCredential(CONFIG, 'user-1', NOW);
    expect(JSON.stringify(minted)).not.toContain(CONFIG.staticAuthSecret);
  });

  it('produces a different credential for a different subject', () => {
    const a = mintTurnCredential(CONFIG, 'user-1', NOW);
    const b = mintTurnCredential(CONFIG, 'user-2', NOW);
    expect(a.credential).not.toBe(b.credential);
  });

  it('produces a different credential as time moves on', () => {
    const a = mintTurnCredential(CONFIG, 'user-1', NOW);
    const b = mintTurnCredential(CONFIG, 'user-1', new Date(NOW.getTime() + 1000));
    expect(a.credential).not.toBe(b.credential);
  });

  it('strips a colon from the subject so it cannot forge an expiry', () => {
    // A subject of "9999999999:admin" would otherwise shift the expiry field.
    const { username } = mintTurnCredential(CONFIG, '9999999999:admin', NOW);
    const parts = username.split(':');
    expect(parts).toHaveLength(2);
    expect(Number(parts[0])).toBe(Math.floor(NOW.getTime() / 1000) + 300);
    expect(parts[1]).toBe('9999999999admin');
  });

  it('falls back to a placeholder rather than an empty subject', () => {
    const { username } = mintTurnCredential(CONFIG, '///', NOW);
    expect(username.endsWith(':user')).toBe(true);
  });
});

describe('turnIceServers', () => {
  it('offers the configured relay with a minted credential', () => {
    const [server, ...rest] = turnIceServers(CONFIG, 'user-1', NOW);
    expect(rest).toHaveLength(0);
    expect(server!.urls).toEqual(['turn:203.0.113.10:16143?transport=udp']);
    expect(server!.username).toMatch(/^\d+:user-1$/);
    expect(server!.credential).toBeTruthy();
  });

  it('degrades to no WebRTC rather than an unauthenticated relay', () => {
    expect(turnIceServers({ ...CONFIG, urls: [] }, 'user-1', NOW)).toEqual([]);
    expect(turnIceServers({ ...CONFIG, staticAuthSecret: '' }, 'user-1', NOW)).toEqual([]);
  });

  it('does not share a mutable array with the config', () => {
    const [server] = turnIceServers(CONFIG, 'user-1', NOW);
    server!.urls.push('turn:evil.invalid');
    expect(CONFIG.urls).toEqual(['turn:203.0.113.10:16143?transport=udp']);
  });
});
