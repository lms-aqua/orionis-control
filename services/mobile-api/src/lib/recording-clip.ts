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
import { AppError } from './errors.ts';

export interface ClipResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const CACHE_MAX = 3;
const clipCache = new Map<string, Buffer>();

async function loadClip(
  baseUrl: string,
  cameraId: string,
  start: string,
  duration: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Buffer> {
  const key = `${cameraId}|${start}|${duration}`;
  const cached = clipCache.get(key);
  if (cached) {
    clipCache.delete(key); // Re-insert to mark most-recently-used.
    clipCache.set(key, cached);
    return cached;
  }

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

  clipCache.set(key, buffer);
  while (clipCache.size > CACHE_MAX) {
    const oldest = clipCache.keys().next().value;
    if (oldest === undefined) break;
    clipCache.delete(oldest);
  }
  return buffer;
}

/** Parses a single `bytes=` range against a known size, or null if absent/invalid. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
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
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = hasEnd ? Number(match[2]) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end >= size || start > end) return null;
  return { start, end };
}

export async function serveRecordingClip(opts: {
  baseUrl: string;
  cameraId: string;
  start: string;
  duration: number;
  range: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}): Promise<ClipResponse> {
  const buffer = await loadClip(
    opts.baseUrl,
    opts.cameraId,
    opts.start,
    opts.duration,
    opts.fetchImpl ?? fetch,
    opts.timeoutMs,
  );

  const base: Record<string, string> = {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    // Recorded footage is sensitive; never let a shared cache hold it.
    'cache-control': 'private, no-store',
  };

  const range = parseRange(opts.range, buffer.length);
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
