import { describe, expect, it } from 'vitest';
import { ReolinkProvider } from '../../src/adapters/connections/providers/reolink.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';

function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    connectionId: 'conn-1',
    slug: 'reolink',
    settings: { baseUrl: 'http://192.168.1.60', username: 'admin' },
    secrets: { password: 'hunter2' },
    fetchImpl: (async () => new Response('')) as unknown as typeof fetch,
    timeoutMs: 1000,
    ...overrides,
  };
}

const devInfo = (extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify([
      {
        cmd: 'GetDevInfo',
        code: 0,
        value: { DevInfo: { model: 'RLC-810A', firmVer: 'v3.1.0', name: 'Driveway' } },
      },
    ]),
    { headers: { 'content-type': 'application/json' }, ...extra },
  );

describe('ReolinkProvider', () => {
  it('reports model and firmware from GetDevInfo', async () => {
    const fetchImpl = (async () => devInfo()) as unknown as typeof fetch;
    const [camera] = await new ReolinkProvider(ctx({ fetchImpl })).listCameras();
    expect(camera!.model).toBe('RLC-810A');
    expect(camera!.firmware).toBe('v3.1.0');
    // The configured name wins over the reported one only when set; here it is not.
    expect(camera!.name).toBe('Driveway');
    expect(camera!.health.status).toBe('online');
    expect(camera!.capabilities.snapshot).toBe(true);
  });

  it('probe fails clearly when the camera rejects the login', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify([{ cmd: 'GetDevInfo', code: 1, error: { rspCode: -6 } }]), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const result = await new ReolinkProvider(ctx({ fetchImpl })).probe();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected the login/i);
  });

  it('returns snapshot bytes only for an image content-type', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain('cmd=Snap');
      expect(url).toContain('channel=0');
      return new Response(Buffer.from([0xff, 0xd8, 0xff]), {
        headers: { 'content-type': 'image/jpeg' },
      });
    }) as unknown as typeof fetch;
    const snap = await new ReolinkProvider(ctx({ fetchImpl })).getSnapshot('channel-0');
    expect(snap.contentType).toBe('image/jpeg');
    expect(snap.bytes.length).toBe(3);
  });

  it('treats a JSON body from Snap as an error, not an image', async () => {
    const fetchImpl = (async () =>
      new Response('[{"error":{}}]', {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    await expect(new ReolinkProvider(ctx({ fetchImpl })).getSnapshot('channel-0')).rejects.toThrow(
      /did not return an image/i,
    );
  });

  it('builds an RTSP URL with credentials and the 1-based channel', async () => {
    const provider = new ReolinkProvider(
      ctx({ settings: { baseUrl: 'http://192.168.1.60', username: 'admin', channel: 2 } }),
    );
    const session = await provider.createStreamSession({
      cameraId: 'channel-2',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(session.protocol).toBe('hls');
    expect(session.playbackUrl).toBe('rtsp://admin:hunter2@192.168.1.60:554/h264Preview_03_main');
  });
});
