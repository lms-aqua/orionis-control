import { describe, expect, it } from 'vitest';
import { AxisProvider } from '../../src/adapters/connections/providers/axis.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';

function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    connectionId: 'conn-1',
    slug: 'axis',
    settings: { baseUrl: 'http://192.168.1.100', username: 'viewer' },
    secrets: { password: 'pw' },
    fetchImpl: (async () => new Response('')) as unknown as typeof fetch,
    timeoutMs: 1000,
    ...overrides,
  };
}

describe('AxisProvider', () => {
  it('reads the model from the Brand.ProdFullName param', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain('/axis-cgi/param.cgi?action=list&group=Brand.ProdFullName');
      return new Response('root.Brand.ProdFullName=AXIS M3057-PLVE', { status: 200 });
    }) as unknown as typeof fetch;
    const [camera] = await new AxisProvider(ctx({ fetchImpl })).listCameras();
    expect(camera!.model).toBe('AXIS M3057-PLVE');
    expect(camera!.health.status).toBe('online');
  });

  it('reports a login error on 401', async () => {
    const fetchImpl = (async () =>
      new Response('', {
        status: 401,
        headers: { 'www-authenticate': 'Digest realm="axis", nonce="n", qop="auth"' },
      })) as unknown as typeof fetch;
    const result = await new AxisProvider(ctx({ fetchImpl })).probe();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected the login/i);
  });

  it('requests the jpg CGI with the sensor number', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain('/axis-cgi/jpg/image.cgi?camera=2');
      return new Response(Buffer.from([0xff, 0xd8]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }) as unknown as typeof fetch;
    const provider = new AxisProvider(
      ctx({
        fetchImpl,
        settings: { baseUrl: 'http://192.168.1.100', username: 'viewer', camera: 2 },
      }),
    );
    const snap = await provider.getSnapshot('sensor-2');
    expect(snap.contentType).toBe('image/jpeg');
  });

  it('builds the axis-media RTSP URL with the sensor number', async () => {
    const provider = new AxisProvider(
      ctx({ settings: { baseUrl: 'http://192.168.1.100', username: 'viewer', camera: 1 } }),
    );
    const session = await provider.createStreamSession({
      cameraId: 'sensor-1',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(session.playbackUrl).toBe(
      'rtsp://viewer:pw@192.168.1.100:554/axis-media/media.amp?camera=1',
    );
  });
});
