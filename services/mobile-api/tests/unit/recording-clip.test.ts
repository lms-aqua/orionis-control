import { describe, expect, it, vi } from 'vitest';
import { serveRecordingClip } from '../../src/lib/recording-clip.ts';

/** Distinct bytes per window, so a wrong cache hit is visible rather than subtle. */
function recorder(sizeByStart: Record<string, number> = {}) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const start = url.searchParams.get('start') ?? '';
    calls.push(start);
    const size = sizeByStart[start] ?? 1024;
    return new Response(Buffer.alloc(size, 7), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const BASE = {
  baseUrl: 'http://recorder.invalid:9996',
  cameraId: 'cam-clip-test',
  duration: 30,
  timeoutMs: 5000,
};

// Unique start per test: the cache is module-level and shared between tests.
let seq = 0;
const nextStart = () => `2026-08-01T0${seq++ % 10}:00:00.000Z`;

describe('serveRecordingClip', () => {
  it('serves the whole window when no range is asked for', async () => {
    const { impl } = recorder();
    const res = await serveRecordingClip({
      ...BASE,
      start: nextStart(),
      range: undefined,
      fetchImpl: impl,
    });
    expect(res.status).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.body.length).toBe(1024);
  });

  it('answers a byte range with 206 and the right slice', async () => {
    const { impl } = recorder();
    const res = await serveRecordingClip({
      ...BASE,
      start: nextStart(),
      range: 'bytes=100-199',
      fetchImpl: impl,
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 100-199/1024');
    expect(res.body.length).toBe(100);
  });

  it('answers a suffix range, which is how AVFoundation reads the moov atom', async () => {
    const { impl } = recorder();
    const res = await serveRecordingClip({
      ...BASE,
      start: nextStart(),
      range: 'bytes=-50',
      fetchImpl: impl,
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 974-1023/1024');
    expect(res.body.length).toBe(50);
  });

  it('clamps an oversized range end instead of falling back to a full 200 response', async () => {
    const { impl } = recorder();
    const res = await serveRecordingClip({
      ...BASE,
      start: nextStart(),
      range: 'bytes=100-999999',
      fetchImpl: impl,
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 100-1023/1024');
    expect(res.body.length).toBe(924);
  });

  it('pulls the window from the recorder only once across many range requests', async () => {
    const { impl, calls } = recorder();
    const start = nextStart();
    await Promise.all([
      serveRecordingClip({ ...BASE, start, range: 'bytes=0-9', fetchImpl: impl }),
      serveRecordingClip({ ...BASE, start, range: 'bytes=10-19', fetchImpl: impl }),
      serveRecordingClip({ ...BASE, start, range: 'bytes=-20', fetchImpl: impl }),
    ]);
    // Concurrent requests for one window must coalesce, not stampede the recorder.
    expect(calls.filter((c) => c === start)).toHaveLength(1);
  });

  it('is cacheable by the viewer, so seeking inside a window does not refetch', async () => {
    const { impl } = recorder();
    const res = await serveRecordingClip({
      ...BASE,
      start: nextStart(),
      range: undefined,
      fetchImpl: impl,
    });
    // A window is a fixed span of past time; its bytes cannot change.
    expect(res.headers['cache-control']).toContain('immutable');
    // Still private: recorded footage must never sit in a shared cache.
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers.etag).toBeTruthy();
  });

  it('briefly caches an active window but never marks changing footage immutable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    let calls = 0;
    const changing = vi.fn(async () => {
      calls += 1;
      return new Response(Buffer.alloc(32, calls));
    }) as unknown as typeof fetch;
    const start = '2026-08-03T11:59:59.000Z';
    try {
      const first = await serveRecordingClip({
        ...BASE,
        start,
        range: undefined,
        fetchImpl: changing,
        prefetch: false,
      });
      expect(first.headers['cache-control']).toBe('private, no-cache');
      vi.advanceTimersByTime(4_000);
      const changed = await serveRecordingClip({
        ...BASE,
        start,
        range: undefined,
        fetchImpl: changing,
        prefetch: false,
      });
      expect(calls).toBe(2);
      expect(changed.headers.etag).not.toBe(first.headers.etag);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers 304 when the viewer already holds the window', async () => {
    const { impl } = recorder();
    const start = nextStart();
    const first = await serveRecordingClip({
      ...BASE,
      start,
      range: undefined,
      fetchImpl: impl,
    });
    const again = await serveRecordingClip({
      ...BASE,
      start,
      range: undefined,
      ifNoneMatch: first.headers.etag,
      fetchImpl: impl,
    });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
  });

  it('gives different windows different etags', async () => {
    const { impl } = recorder();
    const a = await serveRecordingClip({
      ...BASE,
      start: nextStart(),
      range: undefined,
      fetchImpl: impl,
    });
    const b = await serveRecordingClip({
      ...BASE,
      start: nextStart(),
      range: undefined,
      fetchImpl: impl,
    });
    expect(a.headers.etag).not.toBe(b.headers.etag);
  });

  it('warms the following window so the next scrub is a cache hit', async () => {
    const { impl, calls } = recorder();
    const start = '2026-08-01T20:00:00.000Z';
    await serveRecordingClip({ ...BASE, start, range: undefined, fetchImpl: impl });
    // Give the fire-and-forget prefetch a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toContain('2026-08-01T20:00:30.000Z');
  });

  it('does not waste bandwidth prefetching after a one-shot download', async () => {
    const { impl, calls } = recorder();
    const start = '2026-08-01T20:01:00.000Z';
    await serveRecordingClip({
      ...BASE,
      start,
      range: undefined,
      fetchImpl: impl,
      prefetch: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([start]);
  });

  it('ignores malformed range syntax but returns 416 for a valid impossible range', async () => {
    const { impl } = recorder();
    const start = nextStart();
    for (const range of ['bytes=abc', 'nonsense']) {
      const res = await serveRecordingClip({ ...BASE, start, range, fetchImpl: impl });
      expect(res.status).toBe(200);
    }
    const impossible = await serveRecordingClip({
      ...BASE,
      start,
      range: 'bytes=5000-6000',
      fetchImpl: impl,
    });
    expect(impossible.status).toBe(416);
    expect(impossible.headers['content-range']).toBe('bytes */1024');
    expect(impossible.body.length).toBe(0);
  });

  it('rejects an empty recorder response as missing footage', async () => {
    const start = '2026-08-01T19:59:59.000Z';
    const empty = recorder({ [start]: 0 });
    await expect(
      serveRecordingClip({ ...BASE, start, range: undefined, fetchImpl: empty.impl }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
