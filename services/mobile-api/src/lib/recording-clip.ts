/**
 * Serves recorded footage with real HTTP range support.
 *
 * MediaMTX's playback `/get` streams an mp4 chunked with `Accept-Ranges: none`
 * — it does not honour range requests. AVFoundation, however, plays remote mp4
 * by issuing range requests (it reads the moov atom, often from the end, before
 * anything decodes); handed a `200` full body in reply to a `Range:` header, it
 * simply refuses to play. So the gateway buffers each window once and answers
 * range requests itself, turning a non-seekable upstream into a seekable clip.
 *
 * Buffers are cached briefly (keyed by camera+start+duration) so the several
 * range requests AVFoundation makes for one window don't each re-pull the whole
 * clip from the recorder. Windows are short (the timeline asks for seconds, not
 * a whole recording), keeping the cache small.
 */
import { createHash } from 'node:crypto';
import { AppError } from './errors.ts';

export interface ClipResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Enough windows for the one being watched plus a few either side, so scrubbing
 * back and forth over the same stretch of timeline stops re-pulling from the
 * recorder. Measured: muxing a window costs 0.15-0.65s, so a hit here is the
 * difference between a scrub feeling instant and feeling sluggish.
 */
const CACHE_MAX = 8;
/** Bound memory as well as entry count: eight high-bitrate windows can be huge. */
const CACHE_MAX_BYTES = 128 * 1024 * 1024;
interface CachedClip {
  buffer: Buffer;
  /** Null only for a finalized historical interval whose bytes cannot change. */
  expiresAt: number | null;
}
const clipCache = new Map<string, CachedClip>();
let clipCacheBytes = 0;
/** In-flight loads, so N range requests for one window cause one upstream pull. */
const inFlight = new Map<string, Promise<Buffer>>();

const cacheKey = (cameraId: string, start: string, duration: number): string =>
  `${cameraId}|${start}|${duration}`;

async function loadClip(
  baseUrl: string,
  cameraId: string,
  start: string,
  duration: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  cacheTtlMs: number | null,
): Promise<Buffer> {
  const key = cacheKey(cameraId, start, duration);
  const cached = clipCache.get(key);
  if (cached && (cached.expiresAt === null || cached.expiresAt > Date.now())) {
    clipCache.delete(key); // Re-insert to mark most-recently-used.
    clipCache.set(key, cached);
    return cached.buffer;
  }
  if (cached) {
    clipCacheBytes -= cached.buffer.length;
    clipCache.delete(key);
  }

  // AVFoundation opens a window with several near-simultaneous range requests.
  // Without this they would each pull the whole clip from the recorder.
  const existing = inFlight.get(key);
  if (existing) return existing;

  const load = (async (): Promise<Buffer> => {
    const params = new URLSearchParams({ path: cameraId, start, duration: String(duration) });
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${baseUrl}/get?${params.toString()}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'The recording store did not respond.');
    }
    if (!upstream.ok) {
      throw new AppError('NOT_FOUND', 'No footage is available at that time.');
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length === 0) {
      throw new AppError('NOT_FOUND', 'No footage is available at that time.');
    }

    clipCache.set(key, {
      buffer,
      expiresAt: cacheTtlMs === null ? null : Date.now() + cacheTtlMs,
    });
    clipCacheBytes += buffer.length;
    // Keep one oversize window: AVPlayer asks for several sequential ranges and
    // evicting the only copy would re-download the whole MP4 for every range.
    while (clipCache.size > CACHE_MAX || (clipCacheBytes > CACHE_MAX_BYTES && clipCache.size > 1)) {
      const oldest = clipCache.keys().next().value;
      if (oldest === undefined) break;
      clipCacheBytes -= clipCache.get(oldest)?.buffer.length ?? 0;
      clipCache.delete(oldest);
    }
    return buffer;
  })();

  inFlight.set(key, load);
  try {
    return await load;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Warms the window immediately after this one.
 *
 * Scrubbing forward is the common case, and muxing is the slow part, so having
 * the next window already in memory turns the next scrub into a cache hit.
 * Deliberately fire-and-forget: a failed prefetch must never affect the request
 * the viewer is actually waiting on.
 */
function prefetchNext(
  baseUrl: string,
  cameraId: string,
  start: string,
  duration: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): void {
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) return;
  const nextStart = new Date(startMs + duration * 1000).toISOString();
  const key = cacheKey(cameraId, nextStart, duration);
  if (clipCache.has(key) || inFlight.has(key)) return;
  const nextEnd = startMs + duration * 2_000;
  const cacheTtlMs = nextEnd <= Date.now() - 5_000 ? null : 3_000;
  void loadClip(baseUrl, cameraId, nextStart, duration, fetchImpl, timeoutMs, cacheTtlMs).catch(
    () => undefined,
  );
}

/** Parses a single `bytes=` range against a known size, or null if absent/invalid. */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  if (!hasStart && !hasEnd) return null;

  let start: number;
  let end: number;
  if (!hasStart) {
    // Suffix range: last N bytes.
    const n = Number(match[2]);
    if (!Number.isFinite(n) || n <= 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(match[1]);
    if (!Number.isFinite(start) || start >= size) return 'unsatisfiable';
    end = hasEnd ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start > end) return 'unsatisfiable';
  return { start, end };
}

export async function serveRecordingClip(opts: {
  baseUrl: string;
  cameraId: string;
  start: string;
  duration: number;
  range: string | undefined;
  ifNoneMatch?: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  /** Playback benefits from warming the next window; one-shot downloads do not. */
  prefetch?: boolean;
}): Promise<ClipResponse> {
  const startMs = Date.parse(opts.start);
  const finalized =
    Number.isFinite(startMs) && startMs + opts.duration * 1_000 <= Date.now() - 5_000;
  const buffer = await loadClip(
    opts.baseUrl,
    opts.cameraId,
    opts.start,
    opts.duration,
    opts.fetchImpl ?? fetch,
    opts.timeoutMs,
    finalized ? null : 3_000,
  );

  if (opts.prefetch !== false) {
    prefetchNext(
      opts.baseUrl,
      opts.cameraId,
      opts.start,
      opts.duration,
      opts.fetchImpl ?? fetch,
      opts.timeoutMs,
    );
  }

  // A finalized past window is immutable. A near-live request can still grow,
  // so it receives a content ETag and must revalidate after its short server-side
  // range cache. `private` keeps every recording out of shared caches.
  const etagInput = finalized ? cacheKey(opts.cameraId, opts.start, opts.duration) : buffer;
  const etag = `"${createHash('sha1').update(etagInput).digest('base64url')}-${buffer.length}"`;

  const base: Record<string, string> = {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': finalized ? 'private, max-age=300, immutable' : 'private, no-cache',
    etag,
  };

  if (opts.ifNoneMatch && opts.ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
    return { status: 304, headers: base, body: Buffer.alloc(0) };
  }

  const range = parseRange(opts.range, buffer.length);
  if (range === 'unsatisfiable') {
    return {
      status: 416,
      headers: { ...base, 'content-range': `bytes */${buffer.length}`, 'content-length': '0' },
      body: Buffer.alloc(0),
    };
  }
  if (range) {
    const slice = buffer.subarray(range.start, range.end + 1);
    return {
      status: 206,
      headers: {
        ...base,
        'content-range': `bytes ${range.start}-${range.end}/${buffer.length}`,
        'content-length': String(slice.length),
      },
      body: slice,
    };
  }

  return {
    status: 200,
    headers: { ...base, 'content-length': String(buffer.length) },
    body: buffer,
  };
}
