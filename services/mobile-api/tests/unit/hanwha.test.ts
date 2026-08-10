import { describe, expect, it } from 'vitest';
import { HanwhaProvider } from '../../src/adapters/connections/providers/hanwha.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';

function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    connectionId: 'conn-1',
    slug: 'hanwha',
    settings: { baseUrl: 'http://192.168.1.130', username: 'admin' },
    secrets: { password: 'pw' },
    fetchImpl: (async () => new Response('')) as unknown as typeof fetch,
    timeoutMs: 1000,
    ...overrides,
  };
}

const DEVICE_INFO = 'Model=XND-6080RV\r\nDeviceName=Lobby\r\nFirmwareVersion=2.21.03\r\n';

describe('HanwhaProvider', () => {
  it('parses SUNAPI deviceinfo key=value lines', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain('/stw-cgi/system.cgi?msubmenu=deviceinfo&action=view');
      return new Response(DEVICE_INFO, { status: 200 });
    }) as unknown as typeof fetch;
    const [camera] = await new HanwhaProvider(ctx({ fetchImpl })).listCameras();
    expect(camera!.model).toBe('XND-6080RV');
    expect(camera!.name).toBe('Lobby');
    expect(camera!.firmware).toBe('2.21.03');
    expect(camera!.health.status).toBe('online');
  });

  it('reports a login error on 401', async () => {
    const fetchImpl = (async () =>
      new Response('', {
        status: 401,
        headers: { 'www-authenticate': 'Digest realm="wisenet", nonce="n", qop="auth"' },
      })) as unknown as typeof fetch;
    const result = await new HanwhaProvider(ctx({ fetchImpl })).probe();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected the login/i);
  });

  it('requests the SUNAPI snapshot endpoint with the channel', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain('/stw-cgi/video.cgi?msubmenu=snapshot&action=view');
      expect(url).toContain('Channel=0');
      return new Response(Buffer.from([0xff, 0xd8]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }) as unknown as typeof fetch;
    const snap = await new HanwhaProvider(ctx({ fetchImpl })).getSnapshot('channel-0');
    expect(snap.contentType).toBe('image/jpeg');
  });

  it('builds the profileN/media.smp RTSP URL (main=2, sub=3)', async () => {
    const main = await new HanwhaProvider(ctx()).createStreamSession({
      cameraId: 'channel-0',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(main.playbackUrl).toBe('rtsp://admin:pw@192.168.1.130:554/profile2/media.smp');

    const sub = await new HanwhaProvider(
      ctx({ settings: { baseUrl: 'http://192.168.1.130', username: 'admin', stream: 'sub' } }),
    ).createStreamSession({
      cameraId: 'channel-0',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(sub.playbackUrl).toBe('rtsp://admin:pw@192.168.1.130:554/profile3/media.smp');
  });
});
