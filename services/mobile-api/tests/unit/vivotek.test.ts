import { describe, expect, it } from 'vitest';
import { VivotekProvider } from '../../src/adapters/connections/providers/vivotek.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';

function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    connectionId: 'conn-1',
    slug: 'vivotek',
    settings: { baseUrl: 'http://192.168.1.110', username: 'viewer' },
    secrets: { password: 'pw' },
    fetchImpl: (async () => new Response('')) as unknown as typeof fetch,
    timeoutMs: 1000,
    ...overrides,
  };
}

describe('VivotekProvider', () => {
  it('parses the model name from getparam.cgi', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain('/cgi-bin/viewer/getparam.cgi?system_info_modelname');
      return new Response("system_info_modelname='IB9389-EH'", { status: 200 });
    }) as unknown as typeof fetch;
    const [camera] = await new VivotekProvider(ctx({ fetchImpl })).listCameras();
    expect(camera!.model).toBe('IB9389-EH');
    expect(camera!.health.status).toBe('online');
  });

  it('reports a login error on 401', async () => {
    const fetchImpl = (async () =>
      new Response('', {
        status: 401,
        headers: { 'www-authenticate': 'Digest realm="vivotek", nonce="n", qop="auth"' },
      })) as unknown as typeof fetch;
    const result = await new VivotekProvider(ctx({ fetchImpl })).probe();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected the login/i);
  });

  it('requests the video.jpg snapshot endpoint', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain('/cgi-bin/viewer/video.jpg');
      return new Response(Buffer.from([0xff, 0xd8]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }) as unknown as typeof fetch;
    const snap = await new VivotekProvider(ctx({ fetchImpl })).getSnapshot('camera');
    expect(snap.contentType).toBe('image/jpeg');
  });

  it('uses live.sdp for the primary stream and liveN.sdp beyond it', async () => {
    const primary = await new VivotekProvider(ctx()).createStreamSession({
      cameraId: 'camera',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(primary.playbackUrl).toBe('rtsp://viewer:pw@192.168.1.110:554/live.sdp');

    const secondary = await new VivotekProvider(
      ctx({ settings: { baseUrl: 'http://192.168.1.110', username: 'viewer', streamIndex: 2 } }),
    ).createStreamSession({
      cameraId: 'camera',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(secondary.playbackUrl).toBe('rtsp://viewer:pw@192.168.1.110:554/live2.sdp');
  });
});
