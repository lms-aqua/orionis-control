import { describe, expect, it } from 'vitest';
import { HikvisionProvider } from '../../src/adapters/connections/providers/hikvision.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';

function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    connectionId: 'conn-1',
    slug: 'hik',
    settings: { baseUrl: 'http://192.168.1.80', username: 'admin' },
    secrets: { password: 'pw' },
    fetchImpl: (async () => new Response('')) as unknown as typeof fetch,
    timeoutMs: 1000,
    ...overrides,
  };
}

const deviceInfoXml =
  '<?xml version="1.0"?><DeviceInfo>' +
  '<deviceName>Front Gate</deviceName>' +
  '<model>DS-2CD2385</model>' +
  '<firmwareVersion>V5.6.3</firmwareVersion>' +
  '</DeviceInfo>';

describe('HikvisionProvider', () => {
  it('parses deviceInfo XML into model, firmware and name', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain('/ISAPI/System/deviceInfo');
      return new Response(deviceInfoXml, {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    }) as unknown as typeof fetch;
    const [camera] = await new HikvisionProvider(ctx({ fetchImpl })).listCameras();
    expect(camera!.model).toBe('DS-2CD2385');
    expect(camera!.firmware).toBe('V5.6.3');
    expect(camera!.name).toBe('Front Gate');
    expect(camera!.health.status).toBe('online');
  });

  it('reports a login error when deviceInfo is unauthorized', async () => {
    const fetchImpl = (async () =>
      new Response('', {
        status: 401,
        headers: { 'www-authenticate': 'Digest realm="cam", nonce="n", qop="auth"' },
      })) as unknown as typeof fetch;
    const result = await new HikvisionProvider(ctx({ fetchImpl })).probe();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected the login/i);
  });

  it('requests the ISAPI picture endpoint for the channel', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain('/ISAPI/Streaming/channels/101/picture');
      return new Response(Buffer.from([0xff, 0xd8]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }) as unknown as typeof fetch;
    const snap = await new HikvisionProvider(ctx({ fetchImpl })).getSnapshot('channel-1');
    expect(snap.contentType).toBe('image/jpeg');
  });

  it('builds the RTSP URL with the channel id, sub stream as 02', async () => {
    const provider = new HikvisionProvider(
      ctx({
        settings: { baseUrl: 'http://192.168.1.80', username: 'admin', channel: 3, stream: 'sub' },
      }),
    );
    const session = await provider.createStreamSession({
      cameraId: 'channel-3',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(session.playbackUrl).toBe('rtsp://admin:pw@192.168.1.80:554/Streaming/Channels/302');
  });
});
