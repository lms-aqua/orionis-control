import { describe, expect, it } from 'vitest';
import { DahuaProvider } from '../../src/adapters/connections/providers/dahua.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';

function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    connectionId: 'conn-1',
    slug: 'dahua',
    settings: { baseUrl: 'http://192.168.1.70', username: 'admin' },
    secrets: { password: 'pw' },
    fetchImpl: (async () => new Response('')) as unknown as typeof fetch,
    timeoutMs: 1000,
    ...overrides,
  };
}

describe('DahuaProvider', () => {
  it('reads the model from getDeviceType (auth passes straight through on 200)', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain('magicBox.cgi?action=getDeviceType');
      return new Response('type=IPC-HDW3849H', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await new DahuaProvider(ctx({ fetchImpl })).probe();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('IPC-HDW3849H');
    const [camera] = await new DahuaProvider(ctx({ fetchImpl })).listCameras();
    expect(camera!.model).toBe('IPC-HDW3849H');
  });

  it('surfaces an unauthorized probe as a login error', async () => {
    // A camera that keeps challenging (401 both times) is unauthorized.
    const fetchImpl = (async () =>
      new Response('', {
        status: 401,
        headers: { 'www-authenticate': 'Digest realm="cam", nonce="n", qop="auth"' },
      })) as unknown as typeof fetch;
    const result = await new DahuaProvider(ctx({ fetchImpl })).probe();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected the login/i);
  });

  it('returns a JPEG snapshot from snapshot.cgi', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain('snapshot.cgi?channel=1');
      return new Response(Buffer.from([0xff, 0xd8]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }) as unknown as typeof fetch;
    const snap = await new DahuaProvider(ctx({ fetchImpl })).getSnapshot('channel-1');
    expect(snap.contentType).toBe('image/jpeg');
  });

  it('builds the realmonitor RTSP URL with channel and subtype', async () => {
    const provider = new DahuaProvider(
      ctx({
        settings: { baseUrl: 'http://192.168.1.70', username: 'admin', channel: 2, stream: 'sub' },
      }),
    );
    const session = await provider.createStreamSession({
      cameraId: 'channel-2',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(session.playbackUrl).toBe(
      'rtsp://admin:pw@192.168.1.70:554/cam/realmonitor?channel=2&subtype=1',
    );
  });
});
