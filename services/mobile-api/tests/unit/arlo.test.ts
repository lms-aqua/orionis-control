import { describe, expect, it, vi } from 'vitest';
import { ArloProvider } from '../../src/adapters/connections/providers/arlo.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';

function ctx(fetchImpl: typeof fetch, settings: Record<string, unknown> = {}): ProviderContext {
  return {
    connectionId: 'conn-1',
    slug: 'arlo',
    settings: { baseUrl: 'http://arlo-cam-api:5000', ...settings },
    secrets: {},
    fetchImpl,
    timeoutMs: 1000,
  };
}

const CAMERAS = [
  { ip: '192.168.1.40', hostname: 'ARLO-A', serial_number: 'ABC123', friendly_name: 'Front Door' },
  { ip: '192.168.1.41', hostname: 'ARLO-B', serial_number: 'DEF456', friendly_name: 'Garden' },
];

describe('ArloProvider', () => {
  it('lists cameras from GET /camera', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toBe('http://arlo-cam-api:5000/camera');
      return new Response(JSON.stringify(CAMERAS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const cameras = await new ArloProvider(ctx(fetchImpl)).listCameras();
    expect(cameras.map((c) => c.id)).toEqual(['ABC123', 'DEF456']);
    expect(cameras[0]!.name).toBe('Front Door');
    expect(cameras[0]!.capabilities.snapshot).toBe(false);
    expect(cameras[0]!.health.status).toBe('unknown');
  });

  it('probe reports the paired camera count', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(CAMERAS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const result = await new ArloProvider(ctx(fetchImpl)).probe();
    expect(result.ok).toBe(true);
    expect(result.cameraCount).toBe(2);
  });

  it('activates the stream then returns the camera-IP RTSP URL', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
      if (url.endsWith('/camera')) {
        return new Response(JSON.stringify(CAMERAS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // userstreamactive
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const session = await new ArloProvider(ctx(fetchImpl)).createStreamSession({
      cameraId: 'DEF456',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(session.playbackUrl).toBe('rtsp://192.168.1.41:554/live');

    const activate = calls.find((c) => c.url.includes('/userstreamactive'));
    expect(activate?.url).toBe('http://arlo-cam-api:5000/camera/DEF456/userstreamactive');
    expect(activate?.method).toBe('POST');
    expect(JSON.parse(String(activate?.body))).toEqual({ active: 1 });
  });

  it('does not activate a stream for an unknown camera', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/camera')) {
        return new Response(JSON.stringify(CAMERAS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      new ArloProvider(ctx(fetchImpl)).createStreamSession({
        cameraId: 'NOPE',
        preferredProtocols: ['hls'],
        quality: 'auto',
        ttlSeconds: 60,
      }),
    ).rejects.toThrow();
    // Only the camera list was fetched; no userstreamactive POST went out.
    const urls = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls.map(
      (c) => c[0],
    );
    expect(urls.some((u) => String(u).includes('/userstreamactive'))).toBe(false);
  });

  it('reports snapshots as unsupported', async () => {
    const fetchImpl = (async () => new Response('')) as unknown as typeof fetch;
    await expect(new ArloProvider(ctx(fetchImpl)).getSnapshot()).rejects.toThrow(/callback/i);
  });
});
