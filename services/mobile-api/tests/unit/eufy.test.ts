import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EufyProvider } from '../../src/adapters/connections/providers/eufy.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';
import type { EufyWsDevice, MinimalWebSocket } from '../../src/lib/eufy-ws.ts';

/** Scripted bridge socket, driven by the module-level `state` below. */
class FakeEufyWs implements MinimalWebSocket {
  #listeners: Record<string, Array<(ev: { data?: unknown }) => void>> = {};
  constructor(public url: string) {
    setTimeout(() => {
      this.#emit('open', {});
      this.#emit('message', {
        data: JSON.stringify({ type: 'version', minSchemaVersion: 0, maxSchemaVersion: 13 }),
      });
    }, 0);
  }
  addEventListener(type: string, cb: (ev: { data?: unknown }) => void): void {
    (this.#listeners[type] ??= []).push(cb);
  }
  #emit(type: string, ev: { data?: unknown }): void {
    for (const cb of this.#listeners[type] ?? []) cb(ev);
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { command: string; messageId: string; serialNumber?: string };
    setTimeout(() => {
      let result: unknown = {};
      if (msg.command === 'start_listening')
        result = { state: { devices: state.devices, stations: [] } };
      else if (msg.command === 'device.get_properties')
        result = { properties: state.properties[msg.serialNumber ?? ''] ?? {} };
      this.#emit('message', {
        data: JSON.stringify({ type: 'result', messageId: msg.messageId, success: true, result }),
      });
    }, 0);
  }
  close(): void {
    this.#emit('close', {});
  }
}

const state: { devices: EufyWsDevice[]; properties: Record<string, Record<string, unknown>> } = {
  devices: [],
  properties: {},
};

function ctx(fetchImpl?: typeof fetch): ProviderContext {
  return {
    connectionId: 'conn-1',
    slug: 'eufy',
    settings: { wsUrl: 'ws://eufy-security-ws:3000' },
    secrets: {},
    fetchImpl: fetchImpl ?? ((async () => new Response('')) as unknown as typeof fetch),
    timeoutMs: 1000,
  };
}

beforeEach(() => {
  state.devices = [];
  state.properties = {};
  vi.stubGlobal('WebSocket', FakeEufyWs);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EufyProvider', () => {
  it('lists only camera-like devices, skipping locks/sensors', async () => {
    state.devices = [
      { serialNumber: 'CAM1', name: 'Front Door', model: 'T8210', pictureUrl: 'https://c/1.jpg' },
      { serialNumber: 'LOCK1', name: 'Door Lock', model: 'T8500' }, // no imaging/stream signal
      { serialNumber: 'CAM2', name: 'Yard', model: 'T8410', rtspStream: false },
    ];
    const cameras = await new EufyProvider(ctx()).listCameras();
    expect(cameras.map((c) => c.id).sort()).toEqual(['CAM1', 'CAM2']);
    // Only CAM1 advertises a still image.
    expect(cameras.find((c) => c.id === 'CAM1')!.capabilities.snapshot).toBe(true);
    expect(cameras.find((c) => c.id === 'CAM2')!.capabilities.snapshot).toBe(false);
  });

  it('fetches the snapshot from the device pictureUrl', async () => {
    state.devices = [{ serialNumber: 'CAM1', name: 'Front', pictureUrl: 'https://cloud/last.jpg' }];
    const fetchImpl = (async (url: string) => {
      expect(url).toBe('https://cloud/last.jpg');
      return new Response(Buffer.from([0xff, 0xd8]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }) as unknown as typeof fetch;
    const snap = await new EufyProvider(ctx(fetchImpl)).getSnapshot('CAM1');
    expect(snap.contentType).toBe('image/jpeg');
  });

  it('rejects a bridge-supplied snapshot URL that targets link-local metadata', async () => {
    state.devices = [
      {
        serialNumber: 'CAM1',
        name: 'Front',
        pictureUrl: 'http://169.254.169.254/latest/meta-data/',
      },
    ];
    const fetchImpl = vi.fn(
      async () => new Response('should not be fetched'),
    ) as unknown as typeof fetch;

    await expect(new EufyProvider(ctx(fetchImpl)).getSnapshot('CAM1')).rejects.toThrow(
      /link-local|metadata/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws when the camera has no recent image', async () => {
    state.devices = [{ serialNumber: 'CAM2', name: 'Yard', rtspStream: true }];
    await expect(new EufyProvider(ctx()).getSnapshot('CAM2')).rejects.toThrow(/no recent image/i);
  });

  it('uses an already-present rtspStreamUrl for the stream', async () => {
    state.devices = [
      {
        serialNumber: 'CAM1',
        name: 'Front',
        rtspStreamUrl: 'rtsp://homebase.local/live0',
        pictureUrl: 'x',
      },
    ];
    const session = await new EufyProvider(ctx()).createStreamSession({
      cameraId: 'CAM1',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(session.playbackUrl).toBe('rtsp://homebase.local/live0');
  });

  it('starts RTSP and reads the URL back when not already streaming', async () => {
    state.devices = [{ serialNumber: 'CAM3', name: 'Side', rtspStream: false, pictureUrl: 'x' }];
    state.properties = { CAM3: { rtspStreamUrl: 'rtsp://homebase.local/live3' } };
    const session = await new EufyProvider(ctx()).createStreamSession({
      cameraId: 'CAM3',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(session.playbackUrl).toBe('rtsp://homebase.local/live3');
  });

  it('reports unsupported when RTSP cannot be obtained', async () => {
    state.devices = [{ serialNumber: 'CAM4', name: 'Attic', rtspStream: false, pictureUrl: 'x' }];
    state.properties = { CAM4: {} }; // no rtspStreamUrl after start
    await expect(
      new EufyProvider(ctx()).createStreamSession({
        cameraId: 'CAM4',
        preferredProtocols: ['hls'],
        quality: 'auto',
        ttlSeconds: 60,
      }),
    ).rejects.toThrow(/did not return an RTSP stream/i);
  });
});
