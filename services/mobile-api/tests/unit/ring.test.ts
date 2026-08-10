import { describe, expect, it } from 'vitest';
import { RingProvider } from '../../src/adapters/connections/providers/ring.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';

function ctx(
  settings: Record<string, unknown>,
  secrets: Record<string, string> = {},
): ProviderContext {
  return {
    connectionId: 'conn-1',
    slug: 'ring',
    settings,
    secrets,
    fetchImpl: (async () => new Response('')) as unknown as typeof fetch,
    timeoutMs: 1000,
  };
}

describe('RingProvider', () => {
  it('parses Name=device-id lines into cameras', async () => {
    const provider = new RingProvider(
      ctx({ cameras: 'Front Door=3452b19184fa\n# a comment\nDriveway=a1b2c3d4e5f6' }),
    );
    const cameras = await provider.listCameras();
    expect(cameras.map((c) => c.id)).toEqual(['3452b19184fa', 'a1b2c3d4e5f6']);
    expect(cameras[0]!.name).toBe('Front Door');
    expect(cameras[0]!.capabilities.snapshot).toBe(false);
  });

  it('probe reports the configured camera count', async () => {
    const empty = await new RingProvider(ctx({ cameras: '' })).probe();
    expect(empty.ok).toBe(false);
    const some = await new RingProvider(ctx({ cameras: 'Door=abc' })).probe();
    expect(some.ok).toBe(true);
    expect(some.cameraCount).toBe(1);
  });

  it('builds the _live RTSP URL against the bridge', async () => {
    const provider = new RingProvider(
      ctx({ rtspBaseUrl: 'rtsp://ring-mqtt:8554', cameras: 'Front Door=3452b19184fa' }),
    );
    const session = await provider.createStreamSession({
      cameraId: '3452b19184fa',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(session.playbackUrl).toBe('rtsp://ring-mqtt:8554/3452b19184fa_live');
  });

  it('uses the _event path and embeds RTSP credentials when configured', async () => {
    const provider = new RingProvider(
      ctx(
        {
          rtspBaseUrl: 'rtsp://ring-mqtt:8554',
          cameras: 'Door=abc',
          streamType: 'event',
          username: 'ring',
        },
        { password: 'pw' },
      ),
    );
    const session = await provider.createStreamSession({
      cameraId: 'abc',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(session.playbackUrl).toBe('rtsp://ring:pw@ring-mqtt:8554/abc_event');
  });

  it('reports snapshots as unsupported', async () => {
    await expect(new RingProvider(ctx({ cameras: 'Door=abc' })).getSnapshot()).rejects.toThrow(
      /MQTT only/i,
    );
  });
});
