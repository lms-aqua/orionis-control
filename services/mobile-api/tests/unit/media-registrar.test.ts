import { describe, expect, it, vi } from 'vitest';

import { ensureGo2rtcSource, isRegisterableSource } from '../../src/lib/media-registrar.ts';

const BASE = 'http://go2rtc.invalid:1984';

function fetchStub(existing: Record<string, unknown>, addStatus = 200) {
  const calls: { url: string; method: string }[] = [];
  const impl = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.includes('/api/streams?')) {
      return new Response('', { status: addStatus });
    }
    return new Response(JSON.stringify(existing), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('which sources are worth registering', () => {
  it('takes RTSP, which is what a bridge publishes', () => {
    expect(isRegisterableSource('rtsp://bridge:8554/driveway')).toBe(true);
    expect(isRegisterableSource('rtsps://bridge:8554/driveway')).toBe(true);
  });

  it('leaves anything already served over HTTP or WebRTC alone', () => {
    // Re-plumbing one of these would create a go2rtc stream that never carries
    // anything, which is worse than not registering it.
    expect(isRegisterableSource('http://go2rtc:1984/api/stream.m3u8?src=x')).toBe(false);
    expect(isRegisterableSource('https://host/playlist.m3u8')).toBe(false);
    expect(isRegisterableSource('')).toBe(false);
    expect(isRegisterableSource(null)).toBe(false);
  });
});

describe('registering a connection stream with the hub', () => {
  it('adds a stream the hub does not have, with PUT', async () => {
    const { impl, calls } = fetchStub({ '57': {} });

    const added = await ensureGo2rtcSource({
      go2rtcBaseUrl: BASE,
      name: 'driveway',
      rtspUrl: 'rtsp://bridge:8554/driveway',
      timeoutMs: 1000,
      fetchImpl: impl,
    });

    expect(added).toBe(true);
    const write = calls.find((c) => c.method === 'PUT');
    // POST answers 400 here; the verb is load-bearing.
    expect(write).toBeDefined();
    expect(write!.url).toContain('name=driveway');
    expect(write!.url).toContain(encodeURIComponent('rtsp://bridge:8554/driveway'));
  });

  it('does nothing when the hub already carries it', async () => {
    // Playback is far more frequent than provisioning, so the common path must
    // not write on every open.
    const { impl, calls } = fetchStub({ driveway: {} });

    const added = await ensureGo2rtcSource({
      go2rtcBaseUrl: BASE,
      name: 'driveway',
      rtspUrl: 'rtsp://bridge:8554/driveway',
      timeoutMs: 1000,
      fetchImpl: impl,
    });

    expect(added).toBe(false);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('reports a hub that refuses the stream', async () => {
    const { impl } = fetchStub({}, 400);

    await expect(
      ensureGo2rtcSource({
        go2rtcBaseUrl: BASE,
        name: 'driveway',
        rtspUrl: 'rtsp://bridge:8554/driveway',
        timeoutMs: 1000,
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/refused the stream/i);
  });

  it('tolerates a trailing slash on the configured hub address', async () => {
    const { impl, calls } = fetchStub({});

    await ensureGo2rtcSource({
      go2rtcBaseUrl: `${BASE}/`,
      name: 'road',
      rtspUrl: 'rtsp://bridge:8554/road',
      timeoutMs: 1000,
      fetchImpl: impl,
    });

    expect(calls.every((c) => !c.url.includes('//api/streams'))).toBe(true);
  });
});
