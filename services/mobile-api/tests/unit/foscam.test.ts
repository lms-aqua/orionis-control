import { describe, expect, it } from 'vitest';
import { FoscamProvider } from '../../src/adapters/connections/providers/foscam.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';

function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    connectionId: 'conn-1',
    slug: 'foscam',
    settings: { baseUrl: 'http://192.168.1.50:88', username: 'admin' },
    secrets: { password: 'pw' },
    fetchImpl: (async () => new Response('')) as unknown as typeof fetch,
    timeoutMs: 1000,
    ...overrides,
  };
}

const devInfoXml = (result: string) =>
  `<CGI_Result><result>${result}</result>` +
  '<productName>FI9903P</productName>' +
  '<firmwareVer>2.11.1</firmwareVer>' +
  '<devName>Nursery</devName></CGI_Result>';

describe('FoscamProvider', () => {
  it('parses getDevInfo and treats result 0 as reachable', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain('CGIProxy.fcgi');
      expect(url).toContain('cmd=getDevInfo');
      expect(url).toContain('usr=admin');
      return new Response(devInfoXml('0'), {
        status: 200,
        headers: { 'content-type': 'text/xml' },
      });
    }) as unknown as typeof fetch;
    const [camera] = await new FoscamProvider(ctx({ fetchImpl })).listCameras();
    expect(camera!.model).toBe('FI9903P');
    expect(camera!.firmware).toBe('2.11.1');
    expect(camera!.name).toBe('Nursery');
    expect(camera!.health.status).toBe('online');
  });

  it('treats a non-zero CGI result as a login failure', async () => {
    const fetchImpl = (async () =>
      new Response(devInfoXml('-2'), {
        status: 200,
        headers: { 'content-type': 'text/xml' },
      })) as unknown as typeof fetch;
    const result = await new FoscamProvider(ctx({ fetchImpl })).probe();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected the login/i);
  });

  it('returns snapshot bytes from snapPicture2', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain('cmd=snapPicture2');
      return new Response(Buffer.from([0xff, 0xd8]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }) as unknown as typeof fetch;
    const snap = await new FoscamProvider(ctx({ fetchImpl })).getSnapshot('camera');
    expect(snap.contentType).toBe('image/jpeg');
  });

  it('builds the RTSP URL on port 88 with the substream path', async () => {
    const provider = new FoscamProvider(
      ctx({ settings: { baseUrl: 'http://192.168.1.50:88', username: 'admin', stream: 'sub' } }),
    );
    const session = await provider.createStreamSession({
      cameraId: 'camera',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(session.playbackUrl).toBe('rtsp://admin:pw@192.168.1.50:88/videoSub');
  });
});
