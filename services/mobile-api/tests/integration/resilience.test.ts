/**
 * Behaviour when upstreams are absent, failing or being abused.
 *
 * The product rule under test: the gateway degrades to an honest typed error
 * and never invents data.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { API_PREFIX, createHarness, type Harness } from '../helpers/harness.ts';
import { StubAdGuardAdapter, StubOrionisAdapter } from '../helpers/stub-adapters.ts';
import { AppError } from '../../src/lib/errors.ts';

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('no upstreams configured', () => {
  it('serves camera routes with SERVICE_NOT_CONFIGURED rather than placeholder data', async () => {
    // No orionis/adguard override → services.ts builds the "unconfigured" adapters.
    harness = await createHarness();
    const tokens = await harness.signIn();

    for (const path of ['/cameras', '/events', '/recordings']) {
      const res = await harness.app.inject({
        method: 'GET',
        url: `${API_PREFIX}${path}`,
        headers: harness.auth(tokens.accessToken),
      });
      expect(res.statusCode, path).toBe(503);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('SERVICE_NOT_CONFIGURED');
      expect(body.error.message).toContain('ORIONIS_INTERNAL_URL');
      expect(body.data).toBeUndefined();
    }
  });

  it('serves AdGuard routes with SERVICE_NOT_CONFIGURED', async () => {
    harness = await createHarness();
    const tokens = await harness.signIn();
    const res = await harness.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/adguard/status`,
      headers: harness.auth(tokens.accessToken),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toContain('ADGUARD_INTERNAL_URL');
  });

  it('still reports honest capability flags from /meta', async () => {
    harness = await createHarness();
    const res = await harness.app.inject({ method: 'GET', url: `${API_PREFIX}/meta` });
    const data = res.json().data;
    expect(data.capabilities.cameras).toBe(false);
    expect(data.capabilities.adguard).toBe(false);
    expect(data.capabilities.push).toBe(false);
    expect(data.unconfigured).toEqual(expect.arrayContaining(['orionis', 'adguard', 'push']));
  });

  it('still returns a System screen with an unknown row per missing service', async () => {
    harness = await createHarness();
    const tokens = await harness.signIn();
    const res = await harness.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/system/services`,
      headers: harness.auth(tokens.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.services.map((s: { id: string }) => s.id);
    expect(ids).toContain('orionis-api');
    expect(ids).toContain('adguard');
    expect(ids).toContain('mobile-api');
  });
});

describe('partial upstream failure', () => {
  it('degrades the dashboard section by section instead of failing wholesale', async () => {
    const orionis = new StubOrionisAdapter();
    const adguard = new StubAdGuardAdapter();
    adguard.failWith = new AppError('UPSTREAM_TIMEOUT', 'AdGuard did not respond in time.');
    harness = await createHarness({ orionis, adguard });
    const tokens = await harness.signIn();

    const res = await harness.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/dashboard`,
      headers: harness.auth(tokens.accessToken),
    });

    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.cameras.available).toBe(true);
    expect(data.cameras.data.total).toBe(2);
    expect(data.cameras.data.offline).toBe(1);
    expect(data.adguard.status.available).toBe(false);
    expect(data.adguard.status.error.code).toBe('UPSTREAM_TIMEOUT');
    expect(data.adguard.status.error.recoverable).toBe(true);
  });

  it('reports a camera as offline rather than opening a dead stream', async () => {
    const orionis = new StubOrionisAdapter();
    harness = await createHarness({ orionis, adguard: new StubAdGuardAdapter() });
    const tokens = await harness.signIn();

    const res = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/cameras/cam-yard/stream-sessions`,
      headers: harness.auth(tokens.accessToken),
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('CAMERA_OFFLINE');
  });

  it('refuses a stream protocol the camera does not support', async () => {
    const orionis = new StubOrionisAdapter();
    harness = await createHarness({ orionis, adguard: new StubAdGuardAdapter() });
    const tokens = await harness.signIn();

    const res = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/cameras/cam-front/stream-sessions`,
      headers: harness.auth(tokens.accessToken),
      payload: { preferredProtocols: ['mjpeg'] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('STREAM_UNAVAILABLE');
  });

  it('negotiates the best mutually supported protocol', async () => {
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const tokens = await harness.signIn();

    const res = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/cameras/cam-front/stream-sessions`,
      headers: harness.auth(tokens.accessToken),
      payload: { preferredProtocols: ['llhls', 'hls', 'mjpeg'] },
    });
    expect(res.statusCode).toBe(200);
    // The camera advertises webrtc + hls; llhls is unavailable, so hls wins.
    expect(res.json().data.protocol).toBe('hls');
  });
});

describe('stream authorisation', () => {
  it('issues a short-lived token and never returns the upstream media URL', async () => {
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const tokens = await harness.signIn();

    const res = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/cameras/cam-front/stream-sessions`,
      headers: harness.auth(tokens.accessToken),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.streamToken).toBeTruthy();
    expect(JSON.stringify(data)).not.toContain('media.internal.invalid');
    expect(data.playbackUrl).toContain('/api/mobile/v1/stream/');

    const ttlMs = new Date(data.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(120_000);
  });

  it('rejects playback without a token', async () => {
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const res = await harness.app.inject({ method: 'GET', url: `${API_PREFIX}/stream/str_x` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects playback once the owning session is revoked', async () => {
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const tokens = await harness.signIn();
    const created = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/cameras/cam-front/stream-sessions`,
      headers: harness.auth(tokens.accessToken),
      payload: {},
    });
    const { id, streamToken } = created.json().data;

    await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/logout`,
      headers: harness.auth(tokens.accessToken),
    });

    const res = await harness.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/stream/${id}`,
      headers: { authorization: `Bearer ${streamToken}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SESSION_REVOKED');
  });
});

describe('idempotency', () => {
  it('replays the stored response for a repeated key', async () => {
    const adguard = new StubAdGuardAdapter();
    harness = await createHarness({ orionis: new StubOrionisAdapter(), adguard });
    const tokens = await harness.signIn();

    const payload = { rule: 'repeat.invalid', kind: 'block' };
    const headers = { ...harness.auth(tokens.accessToken), 'idempotency-key': 'key-123' };

    const first = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/adguard/rules`,
      headers,
      payload,
    });
    const second = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/adguard/rules`,
      headers,
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.replayed).toBe(true);
    // The rule was added exactly once.
    expect(adguard.rules.filter((r) => r.includes('repeat.invalid'))).toHaveLength(1);
  });

  it('rejects a reused key carrying a different body', async () => {
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const tokens = await harness.signIn();
    const headers = { ...harness.auth(tokens.accessToken), 'idempotency-key': 'key-abc' };

    await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/adguard/rules`,
      headers,
      payload: { rule: 'one.invalid', kind: 'block' },
    });
    const conflict = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/adguard/rules`,
      headers,
      payload: { rule: 'two.invalid', kind: 'block' },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('protection pause safety', () => {
  it('refuses an unbounded pause', async () => {
    const adguard = new StubAdGuardAdapter();
    harness = await createHarness({ orionis: new StubOrionisAdapter(), adguard });
    const tokens = await harness.signIn();

    const res = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/adguard/protection`,
      headers: { ...harness.auth(tokens.accessToken), 'x-confirm-disruptive': 'true' },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Indefinite pauses are not permitted');
    expect(adguard.protectionCalls).toHaveLength(0);
  });

  it('refuses a resume time in the past', async () => {
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const tokens = await harness.signIn();
    const res = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/adguard/protection`,
      headers: { ...harness.auth(tokens.accessToken), 'x-confirm-disruptive': 'true' },
      payload: { enabled: false, until: '2020-01-01T00:00:00.000Z' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('in the past');
  });

  it('records who paused protection, why, and until when', async () => {
    const adguard = new StubAdGuardAdapter();
    harness = await createHarness({ orionis: new StubOrionisAdapter(), adguard });
    const tokens = await harness.signIn();

    await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/adguard/protection`,
      headers: { ...harness.auth(tokens.accessToken), 'x-confirm-disruptive': 'true' },
      payload: { enabled: false, durationSeconds: 900, reason: 'Testing a smart TV.' },
    });

    const status = await harness.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/adguard/status`,
      headers: harness.auth(tokens.accessToken),
    });
    const override = status.json().data.override;
    expect(override).not.toBeNull();
    expect(override.disabledBy).toBe('testuser');
    expect(override.reason).toBe('Testing a smart TV.');
    expect(new Date(override.resumeAt).getTime()).toBeGreaterThan(Date.now());

    const audit = harness.services.audit.list({ limit: 20, offset: 0 });
    const entry = audit.items.find((e) => e.action === 'adguard.protection.disabled');
    expect(entry).toBeDefined();
    expect(entry?.actorName).toBe('testuser');
    expect(entry?.reason).toBe('Testing a smart TV.');
  });
});

describe('rule validation at the boundary', () => {
  it('rejects malformed rules with a 422 and never forwards them', async () => {
    const adguard = new StubAdGuardAdapter();
    harness = await createHarness({ orionis: new StubOrionisAdapter(), adguard });
    const tokens = await harness.signIn();
    const before = [...adguard.rules];

    const res = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/adguard/rules`,
      headers: harness.auth(tokens.accessToken),
      payload: { rule: 'DROP TABLE filters;', kind: 'block' },
    });
    expect(res.statusCode).toBe(422);
    expect(adguard.rules).toEqual(before);
  });

  it('rejects a duplicate rule with a 409', async () => {
    const adguard = new StubAdGuardAdapter();
    harness = await createHarness({ orionis: new StubOrionisAdapter(), adguard });
    const tokens = await harness.signIn();

    const res = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/adguard/rules`,
      headers: harness.auth(tokens.accessToken),
      payload: { rule: 'ads.example.invalid', kind: 'block' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RULE_DUPLICATE');
  });

  it('normalises an allow rule into @@|| form', async () => {
    const adguard = new StubAdGuardAdapter();
    harness = await createHarness({ orionis: new StubOrionisAdapter(), adguard });
    const tokens = await harness.signIn();

    const res = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/adguard/rules`,
      headers: harness.auth(tokens.accessToken),
      payload: { rule: 'cdn.example.invalid', kind: 'allow' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.rule).toBe('@@||cdn.example.invalid^');
  });
});

describe('secret hygiene in responses', () => {
  it('never returns the client secret, service token or AdGuard password', async () => {
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const tokens = await harness.signIn();

    const paths = ['/meta', '/health'];
    const authedPaths = ['/me', '/dashboard', '/system/services', '/devices/current'];

    for (const p of paths) {
      const res = await harness.app.inject({ method: 'GET', url: `${API_PREFIX}${p}` });
      expect(res.body).not.toContain('test-client-secret');
      expect(res.body).not.toContain('test-signing-key');
    }
    for (const p of authedPaths) {
      const res = await harness.app.inject({
        method: 'GET',
        url: `${API_PREFIX}${p}`,
        headers: harness.auth(tokens.accessToken),
      });
      expect(res.body, p).not.toContain('test-client-secret');
      expect(res.body, p).not.toContain('test-signing-key');
      expect(res.body, p).not.toContain('auth.test.invalid');
    }
  });

  it('returns a 404 envelope for unknown endpoints without leaking routing detail', async () => {
    harness = await createHarness();
    const res = await harness.app.inject({ method: 'GET', url: `${API_PREFIX}/does-not-exist` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
