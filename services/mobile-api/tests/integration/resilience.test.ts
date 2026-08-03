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

  it('prefers webrtc and points playback at the signalling endpoint', async () => {
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const tokens = await harness.signIn();

    const res = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/cameras/cam-front/stream-sessions`,
      headers: harness.auth(tokens.accessToken),
      // The default app preference order leads with webrtc.
      payload: { preferredProtocols: ['webrtc', 'llhls', 'hls'] },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.protocol).toBe('webrtc');
    // For webrtc, playbackUrl is where the client POSTs its SDP offer, not a
    // playlist — and it still never leaks the upstream media host.
    expect(data.playbackUrl).toMatch(/\/api\/mobile\/v1\/stream\/[^/]+\/webrtc$/);
    expect(JSON.stringify(data)).not.toContain('media.internal.invalid');
    // TURN credentials must ride along so the client can reach the relay.
    expect(Array.isArray(data.iceServers)).toBe(true);
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

    // Long enough that a normal look at a camera is not interrupted by a
    // renewal, but still bounded — and revocation does not depend on it, since
    // every relay request re-checks the row and the signed-in session.
    const ttlMs = new Date(data.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(7_200_000);
  });

  it('retires a superseded stream session instead of leaking it', async () => {
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const tokens = await harness.signIn();

    const open = async () =>
      harness!.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/cameras/cam-front/stream-sessions`,
        headers: harness!.auth(tokens.accessToken),
        payload: { preferredProtocols: ['hls'] },
      });

    const first = (await open()).json().data;
    const second = (await open()).json().data;
    expect(first.id).not.toBe(second.id);

    // The first session's playback must now be refused, and the second must work.
    const stale = await harness.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/stream/${first.id}/playlist.m3u8`,
      headers: { authorization: `Bearer ${first.streamToken}` },
    });
    expect(stale.statusCode).toBe(503);
    expect(stale.json().error.code).toBe('STREAM_UNAVAILABLE');
  });

  it('rejects playback without a token', async () => {
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const res = await harness.app.inject({ method: 'GET', url: `${API_PREFIX}/stream/str_x` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a WebRTC offer without a stream token', async () => {
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const res = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/stream/str_x/webrtc`,
      payload: { type: 'offer', sdp: 'v=0\r\n' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed WebRTC offer even with a valid token', async () => {
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const tokens = await harness.signIn();
    const session = (
      await harness.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/cameras/cam-front/stream-sessions`,
        headers: harness.auth(tokens.accessToken),
        payload: { preferredProtocols: ['hls'] },
      })
    ).json().data;

    const res = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/stream/${session.id}/webrtc`,
      headers: { authorization: `Bearer ${session.streamToken}` },
      payload: { type: 'offer' }, // no sdp — must fail before any upstream call
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('binds a stream token to the stream id in the playback URL', async () => {
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const tokens = await harness.signIn();
    const session = (
      await harness.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/cameras/cam-front/stream-sessions`,
        headers: harness.auth(tokens.accessToken),
        payload: { preferredProtocols: ['webrtc'] },
      })
    ).json().data;

    const res = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/stream/str_wrong/webrtc`,
      headers: { authorization: `Bearer ${session.streamToken}` },
      payload: { type: 'offer', sdp: 'v=0\r\nvalid' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('STREAM_TOKEN_EXPIRED');
  });

  it('only lets the creating device revoke a stream through its real camera path', async () => {
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const tokens = await harness.signIn();
    const session = (
      await harness.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/cameras/cam-front/stream-sessions`,
        headers: harness.auth(tokens.accessToken),
        payload: { preferredProtocols: ['hls'] },
      })
    ).json().data;

    const wrongCamera = await harness.app.inject({
      method: 'DELETE',
      url: `${API_PREFIX}/cameras/cam-yard/stream-sessions/${session.id}`,
      headers: harness.auth(tokens.accessToken),
    });
    expect(wrongCamera.statusCode).toBe(404);

    const correct = await harness.app.inject({
      method: 'DELETE',
      url: `${API_PREFIX}/cameras/cam-front/stream-sessions/${session.id}`,
      headers: harness.auth(tokens.accessToken),
    });
    expect(correct.statusCode).toBe(200);
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

  it('re-mints an expired upstream HLS session instead of failing playback', async () => {
    // Regression: go2rtc drops its HLS session id seconds after the last poll
    // (or the moment the source hiccups). The relay used to hand that id to
    // the player, so an expiry left the player pinned to a dead id and every
    // later poll returned 503 — video played, then went black permanently.
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const tokens = await harness.signIn();
    const created = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/cameras/cam-front/stream-sessions`,
      headers: harness.auth(tokens.accessToken),
      payload: { preferredProtocols: ['hls'] },
    });
    const { id, streamToken } = created.json().data;

    const realFetch = globalThis.fetch;
    const minted: string[] = [];
    let liveSid = 'sid-1';
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/stream.m3u8')) {
        // Each mint retires the previous session, as go2rtc does.
        liveSid = `sid-${minted.length + 2}`;
        minted.push(liveSid);
        return new Response(
          `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="avc1.640029"\nhls/playlist.m3u8?id=${liveSid}\n`,
          { status: 200 },
        );
      }
      if (url.includes('/api/hls/playlist.m3u8')) {
        const asked = new URL(url, 'http://x').searchParams.get('id');
        return asked === liveSid
          ? new Response('#EXTM3U\n#EXTINF:1,\nsegment.ts?id=' + liveSid + '&n=1\n', {
              status: 200,
            })
          : new Response('not found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof globalThis.fetch;

    try {
      const first = await harness.app.inject({
        method: 'GET',
        url: `${API_PREFIX}/stream/${id}/playlist.m3u8`,
        headers: { authorization: `Bearer ${streamToken}` },
      });
      expect(first.statusCode).toBe(200);
      expect(first.body).toContain('/segment.ts?');

      // Simulate go2rtc retiring the session the relay just minted.
      liveSid = 'sid-retired';
      const mintsBefore = minted.length;

      const playlist = await harness.app.inject({
        method: 'GET',
        url: `${API_PREFIX}/stream/${id}/playlist.m3u8?token=${encodeURIComponent(streamToken)}`,
      });

      expect(playlist.statusCode).toBe(200);
      expect(minted.length).toBe(mintsBefore + 1);
      expect(playlist.body).toContain('/segment.ts?');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('relays MediaMTX HLS and refuses a segment name outside the allowlist', async () => {
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
      env: { ORIONIS_HLS_BASE_URL: 'http://hls.invalid' },
    });
    const tokens = await harness.signIn();
    const created = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/cameras/cam-front/stream-sessions`,
      headers: harness.auth(tokens.accessToken),
      payload: { preferredProtocols: ['hls'] },
    });
    const { id, streamToken } = created.json().data;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/index.m3u8')) {
        return new Response(
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=899841,CODECS="avc1.4d0029"\nmain_stream.m3u8?session=abc-123\n',
          { status: 200 },
        );
      }
      if (url.includes('main_stream.m3u8')) {
        return new Response(
          '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:12\n#EXTINF:2.0,\nhost_main_seg12.ts?session=abc-123\n',
          { status: 200 },
        );
      }
      return new Response('', { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      const playlist = await harness.app.inject({
        method: 'GET',
        url: `${API_PREFIX}/stream/${id}/playlist.m3u8`,
        headers: { authorization: `Bearer ${streamToken}` },
      });
      expect(playlist.statusCode).toBe(200);
      expect(playlist.body).toContain('/segment.ts?');
      expect(playlist.body).toContain('f=host_main_seg12.ts');
      // The upstream session must not be reachable as a bare URL by the client.
      expect(playlist.body).not.toContain('main_stream.m3u8');

      const traversal = await harness.app.inject({
        method: 'GET',
        url: `${API_PREFIX}/stream/${id}/segment.ts?token=${encodeURIComponent(streamToken)}&f=${encodeURIComponent('../../../etc/passwd')}&s=abc-123`,
      });
      expect(traversal.statusCode).toBe(503);
      expect(traversal.json().error.code).toBe('STREAM_UNAVAILABLE');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('hands the player a .m3u8 playback URL', async () => {
    // Regression: an extension-less URL made AVFoundation re-request the same
    // URL in a loop and never fetch the playlist contents, so the camera view
    // connected and then showed nothing.
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const tokens = await harness.signIn();
    const created = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/cameras/cam-front/stream-sessions`,
      headers: harness.auth(tokens.accessToken),
      payload: { preferredProtocols: ['hls'] },
    });
    expect(created.json().data.playbackUrl).toMatch(/\/stream\/str_[a-z0-9]+\/playlist\.m3u8$/);
  });

  it('answers a retired segment with 404 so the player resyncs', async () => {
    // A 5xx makes AVPlayer abandon playback; a missing segment makes it reload
    // the playlist, which is the recovery path we want.
    harness = await createHarness({
      orionis: new StubOrionisAdapter(),
      adguard: new StubAdGuardAdapter(),
    });
    const tokens = await harness.signIn();
    const created = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/cameras/cam-front/stream-sessions`,
      headers: harness.auth(tokens.accessToken),
      payload: { preferredProtocols: ['hls'] },
    });
    const { id, streamToken } = created.json().data;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('gone', { status: 404 })) as typeof globalThis.fetch;

    try {
      const res = await harness.app.inject({
        method: 'GET',
        url: `${API_PREFIX}/stream/${id}/segment.ts?token=${encodeURIComponent(streamToken)}&id=sid-old&n=7`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      globalThis.fetch = realFetch;
    }
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
