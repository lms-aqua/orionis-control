import { describe, expect, it } from 'vitest';

import { RTSP_DESCRIPTOR, RtspProvider } from '../../src/adapters/connections/providers/rtsp.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';

/** A context whose fetch answers `/api/streams` with whatever go2rtc would. */
function ctx(
  settings: Record<string, unknown>,
  streams: Record<string, unknown> = {},
): ProviderContext {
  return {
    connectionId: 'conn-1',
    slug: 'rtsp',
    settings,
    secrets: {},
    fetchImpl: (async () =>
      new Response(JSON.stringify(streams), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    timeoutMs: 1000,
  };
}

describe('RTSP bridge declaration', () => {
  // The go2rtc this provider can start is deliberately empty, so the editor
  // must keep showing the address it would otherwise fill in. Without this the
  // "start one for me" path is a dead end: an empty go2rtc, and no field left
  // to point the source anywhere that has cameras on it.
  it('marks its bridge optional, because manual mode needs nothing running', () => {
    expect(RTSP_DESCRIPTOR.bridge?.optional).toBe(true);
  });

  it('still declares the address the bridge would supply', () => {
    expect(RTSP_DESCRIPTOR.bridge?.provides).toContain('baseUrl');
    expect(RTSP_DESCRIPTOR.fields.map((f) => f.key)).toContain('baseUrl');
  });
});

describe('RtspProvider.probe in go2rtc mode', () => {
  it('refuses to call an empty go2rtc healthy', async () => {
    const result = await new RtspProvider(
      ctx({ mode: 'go2rtc', baseUrl: 'http://go2rtc.invalid:1984' }, {}),
    ).probe();

    // Reaching it is not the same as it being usable: a freshly provisioned
    // go2rtc always answers and always publishes nothing.
    expect(result.ok).toBe(false);
    expect(result.cameraCount).toBe(0);
    expect(result.message).toMatch(/publishes no streams/i);
    // The message has to name the way out, not just the symptom.
    expect(result.message).toMatch(/manual/i);
  });

  it('reports a go2rtc that publishes streams as healthy', async () => {
    const result = await new RtspProvider(
      ctx({ mode: 'go2rtc', baseUrl: 'http://go2rtc.invalid:1984' }, { front: {}, back: {} }),
    ).probe();

    expect(result.ok).toBe(true);
    expect(result.cameraCount).toBe(2);
    expect(result.message).toMatch(/2 stream/);
  });

  it('says so when no go2rtc address is set at all', async () => {
    const result = await new RtspProvider(ctx({ mode: 'go2rtc' })).probe();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no go2rtc url/i);
  });
});

describe('RtspProvider.probe in manual mode', () => {
  it('counts the streams the operator listed, reaching nothing', async () => {
    const result = await new RtspProvider(
      ctx({
        mode: 'manual',
        streams: 'front=rtsp://cam.invalid/1\n# a comment\nback=rtsp://cam.invalid/2',
      }),
    ).probe();

    expect(result.ok).toBe(true);
    expect(result.cameraCount).toBe(2);
  });

  it('is not healthy with nothing listed', async () => {
    const result = await new RtspProvider(ctx({ mode: 'manual', streams: '' })).probe();
    expect(result.ok).toBe(false);
    expect(result.cameraCount).toBe(0);
  });
});

describe('renditions of one camera are not four cameras', () => {
  // go2rtc lists a camera's alternate encodings as ordinary streams, so one
  // Wyze camera arrived as 57, 57_aac, 57_hq and 57_ll — four tiles on the
  // wall for one camera.
  it('lists the base camera and hides its renditions', async () => {
    const cameras = await new RtspProvider(
      ctx(
        { mode: 'go2rtc', baseUrl: 'http://go2rtc.invalid:1984' },
        {
          '57': {},
          '57_aac': {},
          '57_hq': {},
          '57_ll': {},
          driveway: {},
        },
      ),
    ).listCameras();

    expect(cameras.map((c) => c.id).sort()).toEqual(['57', 'driveway']);
  });

  it('keeps a camera whose name merely ends that way', async () => {
    // The suffixes are a convention, not something go2rtc models. Without a
    // base stream beside it, `front_ll` is just a camera called front_ll.
    const cameras = await new RtspProvider(
      ctx(
        { mode: 'go2rtc', baseUrl: 'http://go2rtc.invalid:1984' },
        {
          front_ll: {},
          garden_aac: {},
        },
      ),
    ).listCameras();

    expect(cameras.map((c) => c.id).sort()).toEqual(['front_ll', 'garden_aac']);
  });
});
