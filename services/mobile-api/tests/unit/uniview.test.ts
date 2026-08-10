import { describe, expect, it } from 'vitest';
import { UniviewProvider } from '../../src/adapters/connections/providers/uniview.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';

function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    connectionId: 'conn-1',
    slug: 'uniview',
    settings: { baseUrl: 'http://192.168.1.120', username: 'admin' },
    secrets: { password: 'pw' },
    fetchImpl: (async () => new Response('')) as unknown as typeof fetch,
    timeoutMs: 1000,
    ...overrides,
  };
}

describe('UniviewProvider', () => {
  it('requests the configured snapshot path and returns the image', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toBe('http://192.168.1.120/images/snapshot.jpg');
      return new Response(Buffer.from([0xff, 0xd8]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }) as unknown as typeof fetch;
    const snap = await new UniviewProvider(ctx({ fetchImpl })).getSnapshot('camera');
    expect(snap.contentType).toBe('image/jpeg');
  });

  it('probe soft-succeeds when the snapshot path is not an image (RTSP unaffected)', async () => {
    const fetchImpl = (async () =>
      new Response('<html>not found</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    const result = await new UniviewProvider(ctx({ fetchImpl })).probe();
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/snapshot path differs/i);
  });

  it('probe reports a login error on 401', async () => {
    const fetchImpl = (async () =>
      new Response('', {
        status: 401,
        headers: { 'www-authenticate': 'Digest realm="unv", nonce="n", qop="auth"' },
      })) as unknown as typeof fetch;
    const result = await new UniviewProvider(ctx({ fetchImpl })).probe();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected the login/i);
  });

  it('builds the media/videoN RTSP URL', async () => {
    const main = await new UniviewProvider(ctx()).createStreamSession({
      cameraId: 'camera',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(main.playbackUrl).toBe('rtsp://admin:pw@192.168.1.120:554/media/video1');

    const sub = await new UniviewProvider(
      ctx({ settings: { baseUrl: 'http://192.168.1.120', username: 'admin', stream: 'sub' } }),
    ).createStreamSession({
      cameraId: 'camera',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(sub.playbackUrl).toBe('rtsp://admin:pw@192.168.1.120:554/media/video2');
  });
});
