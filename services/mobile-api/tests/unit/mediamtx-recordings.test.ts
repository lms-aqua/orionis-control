import { describe, expect, it, vi } from 'vitest';
import {
  MediaMtxRecordings,
  decodeRecordingId,
  encodeRecordingId,
} from '../../src/adapters/orionis/mediamtx-recordings.ts';
import { AppError } from '../../src/lib/errors.ts';

const CAMERAS = [
  { id: '56', name: 'Shed' },
  { id: '57', name: 'Driveway' },
];

/** Stub playback server. */
function playback(byPath: Record<string, { start: string; duration: number }[]>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = url.searchParams.get('path') ?? '';
    if (!(path in byPath)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(byPath[path]), { status: 200 });
  }) as typeof fetch;
}

describe('recording ids', () => {
  it('round-trips a camera, instant and duration', () => {
    const ref = { cameraId: '57', start: '2026-08-01T14:41:51.362Z', durationSeconds: 82.264 };
    expect(decodeRecordingId(encodeRecordingId(ref))).toEqual(ref);
  });

  it('rejects anything that is not one of ours', () => {
    for (const bad of ['', 'nope', 'rec_', 'rec_!!!!', encodeRecordingId as unknown as string]) {
      expect(() => decodeRecordingId(String(bad))).toThrow(AppError);
    }
  });

  it('rejects a decodable id with a nonsensical duration', () => {
    const forged = `rec_${Buffer.from('57|2026-08-01T00:00:00Z|-5', 'utf8').toString('base64url')}`;
    expect(() => decodeRecordingId(forged)).toThrow(AppError);
    const oversized = `rec_${Buffer.from('57|2026-08-01T00:00:00Z|999999999', 'utf8').toString('base64url')}`;
    expect(() => decodeRecordingId(oversized)).toThrow(AppError);
  });

  it('rejects a decodable id with an invalid start instant', () => {
    const forged = `rec_${Buffer.from('57|not-a-date|60', 'utf8').toString('base64url')}`;
    expect(() => decodeRecordingId(forged)).toThrow(AppError);
  });
});

describe('MediaMtxRecordings.recordingStatus', () => {
  const store = (fetchImpl: typeof fetch) =>
    new MediaMtxRecordings('http://hls.invalid:9996', 2000, 7, fetchImpl);
  const at = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

  it('reports a camera as recording when its newest footage is fresh', async () => {
    // Segment started 30s ago and runs a minute: its end is in the future, well
    // inside the live window, so the recorder is actively writing.
    const status = await store(playback({ '56': [{ start: at(-30_000), duration: 60 }] })) //
      .recordingStatus(['56']);
    expect(status.get('56')).toBe(true);
  });

  it('reports not-recording once the newest footage is older than the window', async () => {
    const status = await store(playback({ '56': [{ start: at(-3_600_000), duration: 600 }] })) //
      .recordingStatus(['56']);
    expect(status.get('56')).toBe(false);
  });

  it('reports not-recording for a camera with no footage at all', async () => {
    expect((await store(playback({ '56': [] })).recordingStatus(['56'])).get('56')).toBe(false);
  });

  it('reports unknown (null) when the recorder cannot be reached', async () => {
    const status = await store((async () => new Response('boom', { status: 500 })) as typeof fetch) //
      .recordingStatus(['56']);
    expect(status.get('56')).toBeNull();
  });

  it('judges each camera independently across a batch', async () => {
    const status = await store(
      playback({
        '56': [{ start: at(-10_000), duration: 60 }], // live
        '57': [{ start: at(-7_200_000), duration: 600 }], // stale
      }),
    ).recordingStatus(['56', '57']);
    expect(status.get('56')).toBe(true);
    expect(status.get('57')).toBe(false);
  });
});

describe('MediaMtxRecordings.list', () => {
  const store = (fetchImpl: typeof fetch, retention: number | null = 7) =>
    new MediaMtxRecordings('http://hls.invalid:9996', 2000, retention, fetchImpl);

  it('maps recorded ranges to recordings, newest first', async () => {
    const s = store(
      playback({
        '56': [{ start: '2026-08-01T10:00:00Z', duration: 600 }],
        '57': [
          { start: '2026-08-01T11:00:00Z', duration: 600 },
          { start: '2026-08-01T12:00:00Z', duration: 300 },
        ],
      }),
    );
    const page = await s.list({ limit: 50, offset: 0 }, CAMERAS);
    expect(page.total).toBe(3);
    expect(page.items.map((r) => r.startedAt)).toEqual([
      '2026-08-01T12:00:00.000Z',
      '2026-08-01T11:00:00.000Z',
      '2026-08-01T10:00:00.000Z',
    ]);
    const newest = page.items[0]!;
    expect(newest.cameraId).toBe('57');
    expect(newest.cameraName).toBe('Driveway');
    expect(newest.endedAt).toBe('2026-08-01T12:05:00.000Z');
    expect(newest.playbackPath).toBe(`/recordings/${newest.id}/clip`);
    // Nothing analyses the video, so markers must stay empty rather than invented.
    expect(newest.markers).toEqual([]);
    // The playback server reports no size; guessing one would be fabrication.
    expect(newest.sizeBytes).toBeNull();
    // Its index also omits track metadata; silence is unknown, not proof of audio.
    expect(newest.hasAudio).toBeNull();
  });

  it('skips malformed recorder entries without breaking valid timeline footage', async () => {
    const s = store(
      playback({
        '57': [
          { start: 'not-a-date', duration: 60 },
          { start: '2026-08-01T11:00:00Z', duration: Number.POSITIVE_INFINITY },
          { start: '2026-08-01T11:30:00Z', duration: 999_999_999 },
          { start: '2026-08-01T12:00:00Z', duration: 60 },
        ],
      }),
    );
    const page = await s.list({ limit: 10, offset: 0 }, CAMERAS);
    expect(page.total).toBe(1);
    expect(page.items[0]!.startedAt).toBe('2026-08-01T12:00:00.000Z');
  });

  it('keeps a multi-hour continuous run — the timeline needs every run', async () => {
    // MediaMTX reports continuous recording as one long run. Capping it (the old
    // 30-minute clip cap) dropped whole days as "no recordings this day".
    const s = store(playback({ '57': [{ start: '2026-08-01T00:00:00Z', duration: 12 * 3600 }] }));
    const page = await s.list({ limit: 10, offset: 0 }, CAMERAS);
    expect(page.total).toBe(1);
    expect(page.items[0]!.durationSeconds).toBe(12 * 3600);
  });

  it('derives retentionUntil from the configured retention', async () => {
    const s = store(playback({ '57': [{ start: '2026-08-01T00:00:00Z', duration: 60 }] }), 7);
    const page = await s.list({ limit: 10, offset: 0 }, CAMERAS);
    expect(page.items[0]!.retentionUntil).toBe('2026-08-08T00:00:00.000Z');
  });

  it('reports no retention when none is configured', async () => {
    const s = store(playback({ '57': [{ start: '2026-08-01T00:00:00Z', duration: 60 }] }), null);
    const page = await s.list({ limit: 10, offset: 0 }, CAMERAS);
    expect(page.items[0]!.retentionUntil).toBeNull();
  });

  it('keeps ranges that straddle the requested window', async () => {
    const s = store(playback({ '57': [{ start: '2026-08-01T09:55:00Z', duration: 600 }] }));
    // Window starts after the range began but before it ended.
    const page = await s.list(
      { limit: 10, offset: 0, from: '2026-08-01T10:00:00Z', to: '2026-08-01T11:00:00Z' },
      CAMERAS,
    );
    expect(page.total).toBe(1);
  });

  it('excludes ranges wholly outside the window', async () => {
    const s = store(playback({ '57': [{ start: '2026-08-01T08:00:00Z', duration: 60 }] }));
    const page = await s.list({ limit: 10, offset: 0, from: '2026-08-01T10:00:00Z' }, CAMERAS);
    expect(page.total).toBe(0);
  });

  it('filters to the requested cameras', async () => {
    const s = store(
      playback({
        '56': [{ start: '2026-08-01T10:00:00Z', duration: 60 }],
        '57': [{ start: '2026-08-01T11:00:00Z', duration: 60 }],
      }),
    );
    const page = await s.list({ limit: 10, offset: 0, cameraIds: ['56'] }, CAMERAS);
    expect(page.total).toBe(1);
    expect(page.items[0]!.cameraId).toBe('56');
  });

  it('treats a camera with no history as empty rather than failing', async () => {
    // '56' is absent from the stub, so the playback server 404s for it.
    const s = store(playback({ '57': [{ start: '2026-08-01T11:00:00Z', duration: 60 }] }));
    const page = await s.list({ limit: 10, offset: 0 }, CAMERAS);
    expect(page.total).toBe(1);
  });

  it('treats the recorder 400 for an unrecorded camera as empty, not a failure', async () => {
    // Observed against MediaMTX: a camera with no recording directory yet answers
    // 400 ("lstat /recordings/55: no such file or directory"), as does an unknown
    // path. One such camera must not fail the whole listing.
    const s = store((async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.searchParams.get('path') === '57') {
        return new Response(JSON.stringify([{ start: '2026-08-01T11:00:00Z', duration: 60 }]), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          status: 'error',
          error: 'lstat /recordings/56: no such file or directory',
        }),
        { status: 400 },
      );
    }) as typeof fetch);
    const page = await s.list({ limit: 10, offset: 0 }, CAMERAS);
    expect(page.total).toBe(1);
    expect(page.items[0]!.cameraId).toBe('57');
  });

  it('still surfaces a genuine recorder error', async () => {
    const s = store((async () => new Response('boom', { status: 500 })) as typeof fetch);
    await expect(s.list({ limit: 10, offset: 0 }, CAMERAS)).rejects.toThrow(AppError);
  });

  it('paginates', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      start: `2026-08-01T1${i}:00:00Z`,
      duration: 60,
    }));
    const s = store(playback({ '57': entries }));
    const page = await s.list({ limit: 2, offset: 2 }, CAMERAS);
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
  });

  it('surfaces an unreachable recorder as an upstream error', async () => {
    const s = store((async () => {
      throw new Error('connection refused');
    }) as typeof fetch);
    await expect(s.list({ limit: 10, offset: 0 }, CAMERAS)).rejects.toThrow(AppError);
  });
});

describe('MediaMtxRecordings.get', () => {
  it('refuses a range retention has already removed', async () => {
    const s = new MediaMtxRecordings(
      'http://hls.invalid:9996',
      2000,
      7,
      playback({ '57': [{ start: '2026-08-01T12:00:00Z', duration: 60 }] }),
    );
    const gone = encodeRecordingId({
      cameraId: '57',
      start: '2026-07-01T00:00:00Z',
      durationSeconds: 60,
    });
    await expect(s.get(gone, () => 'Driveway')).rejects.toThrow(AppError);
  });

  it('does not treat the exact segment end as playable footage', async () => {
    const s = new MediaMtxRecordings(
      'http://hls.invalid:9996',
      2000,
      7,
      playback({ '57': [{ start: '2026-08-01T12:00:00Z', duration: 60 }] }),
    );
    const boundary = encodeRecordingId({
      cameraId: '57',
      start: '2026-08-01T12:01:00Z',
      durationSeconds: 60,
    });
    await expect(s.get(boundary, () => 'Driveway')).rejects.toThrow(AppError);
  });

  it('returns a recording still covered by the store', async () => {
    const s = new MediaMtxRecordings(
      'http://hls.invalid:9996',
      2000,
      7,
      playback({ '57': [{ start: '2026-08-01T12:00:00Z', duration: 600 }] }),
    );
    const id = encodeRecordingId({
      cameraId: '57',
      start: '2026-08-01T12:05:00Z',
      durationSeconds: 60,
    });
    const recording = await s.get(id, () => 'Driveway');
    expect(recording.cameraId).toBe('57');
    expect(recording.cameraName).toBe('Driveway');
  });

  it('never puts the recorder URL in anything a client receives', async () => {
    const s = new MediaMtxRecordings(
      'http://hls.invalid:9996',
      2000,
      7,
      playback({ '57': [{ start: '2026-08-01T12:00:00Z', duration: 60 }] }),
    );
    const page = await s.list({ limit: 10, offset: 0 }, CAMERAS);
    expect(JSON.stringify(page)).not.toContain('hls.invalid');
    expect(JSON.stringify(page)).not.toContain('9996');
  });
});

describe('MediaMtxRecordings.storage caching', () => {
  it('reuses a complete storage snapshot instead of rescanning every refresh', async () => {
    const fetchImpl = vi.fn(playback({ '56': [], '57': [] }));
    const store = new MediaMtxRecordings('http://hls.invalid:9996', 2000, 7, fetchImpl);

    const first = await store.storage(CAMERAS);
    const second = await store.storage([...CAMERAS].reverse());

    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent storage scans into one upstream probe per camera', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return Response.json([]);
    });
    const store = new MediaMtxRecordings(
      'http://hls.invalid:9996',
      2000,
      7,
      fetchImpl as typeof fetch,
    );

    const first = store.storage(CAMERAS);
    const second = store.storage(CAMERAS);
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
