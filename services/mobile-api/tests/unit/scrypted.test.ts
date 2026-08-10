import { describe, expect, it, vi, beforeEach } from 'vitest';

// Scrypted speaks engine.io/RPC, not REST, so the official client is mocked
// here rather than an injected fetch — the runtime connection is proven against
// a real server, and these tests pin how the provider maps what the client
// returns onto the gateway's camera model.
vi.mock('@scrypted/client', () => ({ connectScryptedClient: vi.fn() }));

import { connectScryptedClient } from '@scrypted/client';
import { ScryptedProvider } from '../../src/adapters/connections/providers/scrypted.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';

const connectMock = vi.mocked(connectScryptedClient);

interface FakeDevice {
  id: string;
  name?: string;
  room?: string;
  interfaces?: string[];
  info?: { model?: string; firmware?: string };
  takePicture?: () => Promise<unknown>;
}

function fakeClient(devices: Record<string, FakeDevice>) {
  const state = Object.fromEntries(Object.keys(devices).map((id) => [id, {}]));
  return {
    systemManager: {
      getSystemState: () => state,
      getDeviceById: (id: string) => devices[id],
    },
    mediaManager: {
      convertMediaObjectToBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    },
  };
}

function ctx(): ProviderContext {
  return {
    connectionId: 'conn-1',
    slug: 'scrypted',
    settings: { baseUrl: 'https://scrypted.invalid:10443', username: 'pat' },
    secrets: { password: 'token' },
    fetchImpl: (async () => new Response('')) as unknown as typeof fetch,
    timeoutMs: 1000,
  };
}

const cam = (id: string, extra: Partial<FakeDevice> = {}): FakeDevice => ({
  id,
  name: `Camera ${id}`,
  interfaces: ['Camera', 'VideoCamera'],
  takePicture: async () => ({}),
  ...extra,
});

beforeEach(() => {
  connectMock.mockReset();
});

describe('ScryptedProvider discovery', () => {
  it('lists only camera devices, skipping everything else', async () => {
    connectMock.mockResolvedValue(
      fakeClient({
        front: cam('front'),
        light: { id: 'light', name: 'Porch Light', interfaces: ['OnOff'] },
        doorbell: cam('doorbell', { interfaces: ['VideoCamera'] }),
      }) as never,
    );
    const cameras = await new ScryptedProvider(ctx()).listCameras();
    expect(cameras.map((c) => c.id).sort()).toEqual(['doorbell', 'front']);
  });

  it('derives capabilities from the device interfaces', async () => {
    connectMock.mockResolvedValue(
      fakeClient({
        ptz: cam('ptz', {
          interfaces: ['Camera', 'VideoCamera', 'PanTiltZoom', 'Intercom'],
          info: { model: 'PTZ-1', firmware: '2.0' },
          room: 'Garage',
        }),
      }) as never,
    );
    const [camera] = await new ScryptedProvider(ctx()).listCameras();
    expect(camera!.capabilities.ptz).toBe(true);
    expect(camera!.capabilities.zoom).toBe(true);
    expect(camera!.capabilities.twoWayAudio).toBe(true);
    expect(camera!.capabilities.snapshot).toBe(true);
    expect(camera!.capabilities.protocols).toEqual(['hls']);
    expect(camera!.model).toBe('PTZ-1');
    expect(camera!.firmware).toBe('2.0');
    expect(camera!.location).toBe('Garage');
  });

  it('getCamera rejects an id that is not a camera', async () => {
    connectMock.mockResolvedValue(
      fakeClient({ light: { id: 'light', interfaces: ['OnOff'] } }) as never,
    );
    await expect(new ScryptedProvider(ctx()).getCamera('light')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('ScryptedProvider snapshots and streams', () => {
  it('returns a JPEG buffer from takePicture', async () => {
    connectMock.mockResolvedValue(fakeClient({ front: cam('front') }) as never);
    const snap = await new ScryptedProvider(ctx()).getSnapshot('front');
    expect(snap.contentType).toBe('image/jpeg');
    expect(snap.bytes.length).toBeGreaterThan(0);
  });

  it('reports a device that cannot take a picture as unsupported', async () => {
    connectMock.mockResolvedValue(
      fakeClient({ front: cam('front', { takePicture: undefined }) }) as never,
    );
    await expect(new ScryptedProvider(ctx()).getSnapshot('front')).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    });
  });

  it('negotiates an HLS session the relay can carry', async () => {
    connectMock.mockResolvedValue(fakeClient({ front: cam('front') }) as never);
    const session = await new ScryptedProvider(ctx()).createStreamSession({
      cameraId: 'front',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(session.protocol).toBe('hls');
    expect(session.cameraId).toBe('front');
  });
});

describe('ScryptedProvider connection failures', () => {
  it('probe reports unreachable rather than throwing', async () => {
    connectMock.mockRejectedValue(new Error('refused'));
    const result = await new ScryptedProvider(ctx()).probe();
    expect(result.ok).toBe(false);
    expect(result.cameraCount).toBeNull();
  });

  it('surfaces a connection failure as UPSTREAM_UNAVAILABLE', async () => {
    connectMock.mockRejectedValue(new Error('refused'));
    await expect(new ScryptedProvider(ctx()).listCameras()).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('refuses to connect without a server URL', async () => {
    const provider = new ScryptedProvider({ ...ctx(), settings: { username: 'pat' } });
    await expect(provider.listCameras()).rejects.toMatchObject({ code: 'SERVICE_NOT_CONFIGURED' });
    expect(connectMock).not.toHaveBeenCalled();
  });
});

describe('ScryptedProvider unsupported surfaces', () => {
  it('declares events, recordings and controls unsupported', async () => {
    connectMock.mockResolvedValue(fakeClient({ front: cam('front') }) as never);
    const provider = new ScryptedProvider(ctx());
    await expect(provider.listEvents({ limit: 10, offset: 0 })).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    });
    await expect(provider.listRecordings({ limit: 10, offset: 0 })).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    });
    await expect(
      provider.invokeControl('front', { action: 'ptz', direction: 'left' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  });
});
