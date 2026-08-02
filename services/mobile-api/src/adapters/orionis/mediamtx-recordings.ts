/**
 * Recordings backed by MediaMTX's playback server.
 *
 * MediaMTX records continuously to disk and exposes two endpoints:
 *   GET /list?path=<camera>                        -> [{ start, duration, url }]
 *   GET /get?path=<camera>&start=<RFC3339>&duration=<seconds> -> video/mp4
 *
 * `/get` seeks to an arbitrary instant rather than only to segment boundaries, so
 * a recording id only has to name a camera and a time range. Ids are therefore
 * derived, not stored: there is no recording table to keep in step with what the
 * retention policy has already deleted.
 */
import { AppError } from '../../lib/errors.ts';
import { measureRecordingStorage, projectDailyBytes } from '../../lib/recording-storage.ts';
import { UNKNOWN_STORAGE } from './types.ts';
import type { Page, Recording, RecordingQuery, StorageStatus } from './types.ts';

interface PlaybackEntry {
  start?: string;
  duration?: number;
}

export interface RecordingRef {
  cameraId: string;
  start: string;
  durationSeconds: number;
}

/** Opaque, URL-safe, and self-describing so no server-side index is needed. */
export function encodeRecordingId(ref: RecordingRef): string {
  const raw = `${ref.cameraId}|${ref.start}|${ref.durationSeconds}`;
  return `rec_${Buffer.from(raw, 'utf8').toString('base64url')}`;
}

export function decodeRecordingId(id: string): RecordingRef {
  if (!id.startsWith('rec_')) {
    throw new AppError('NOT_FOUND', 'No such recording.');
  }
  let raw: string;
  try {
    raw = Buffer.from(id.slice(4), 'base64url').toString('utf8');
  } catch {
    throw new AppError('NOT_FOUND', 'No such recording.');
  }
  const parts = raw.split('|');
  const duration = Number(parts[2]);
  // A camera id containing '|' would split wrongly, so require exactly the shape
  // we wrote rather than accepting anything that decodes.
  if (parts.length !== 3 || !parts[0] || !parts[1] || !Number.isFinite(duration) || duration <= 0) {
    throw new AppError('NOT_FOUND', 'No such recording.');
  }
  return { cameraId: parts[0], start: parts[1], durationSeconds: duration };
}

export class MediaMtxRecordings {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly retentionDays: number | null,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Read-only mount of the recorder's volume; empty means sizes are unknown. */
    private readonly storagePath: string = '',
    /** Bytes recordings may occupy, or null when unbudgeted. */
    private readonly quotaBytes: number | null = null,
  ) {}

  private async segments(cameraId: string): Promise<RecordingRef[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/list?path=${encodeURIComponent(cameraId)}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'The recording store did not respond.');
    }
    // A camera that has never recorded is not an error; it simply has no history.
    // MediaMTX answers 400 for both "no recording directory yet" and "path is not
    // configured", so both statuses mean the same thing here: nothing to show for
    // this camera. One camera without footage must not fail the whole listing.
    if (response.status === 404 || response.status === 400) return [];
    if (!response.ok) {
      throw new AppError('UPSTREAM_ERROR', 'The recording store returned an error.');
    }
    const body = (await response.json().catch(() => [])) as PlaybackEntry[];
    if (!Array.isArray(body)) return [];
    return body
      .filter(
        (entry): entry is { start: string; duration: number } =>
          Boolean(entry?.start) && typeof entry?.duration === 'number' && entry.duration > 0,
      )
      .map((entry) => ({
        cameraId,
        start: entry.start,
        durationSeconds: entry.duration,
      }));
  }

  private toRecording(ref: RecordingRef, cameraName: string | null): Recording {
    const startedAt = new Date(ref.start);
    const endedAt = new Date(startedAt.getTime() + ref.durationSeconds * 1000);
    const id = encodeRecordingId(ref);
    return {
      id,
      cameraId: ref.cameraId,
      cameraName,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSeconds: ref.durationSeconds,
      // The playback server does not report file sizes, and guessing one from
      // bitrate would be inventing data.
      sizeBytes: null,
      hasAudio: true,
      retentionUntil:
        this.retentionDays === null
          ? null
          : new Date(startedAt.getTime() + this.retentionDays * 24 * 60 * 60 * 1000).toISOString(),
      playbackPath: `/recordings/${id}/clip`,
      // Markers need a detection source. Nothing here analyses video, so an
      // empty list is the honest answer rather than fabricated motion events.
      markers: [],
    };
  }

  async list(
    query: RecordingQuery,
    cameras: { id: string; name: string | null }[],
  ): Promise<Page<Recording>> {
    const wanted =
      query.cameraIds && query.cameraIds.length > 0
        ? cameras.filter((camera) => query.cameraIds!.includes(camera.id))
        : cameras;

    const from = query.from ? new Date(query.from).getTime() : null;
    const to = query.to ? new Date(query.to).getTime() : null;

    const all: Recording[] = [];
    for (const camera of wanted) {
      const refs = await this.segments(camera.id);
      for (const ref of refs) {
        const startedAt = new Date(ref.start).getTime();
        const endedAt = startedAt + ref.durationSeconds * 1000;
        // Overlap, not containment: a range that straddles the window boundary is
        // still footage the caller asked for.
        if (from !== null && endedAt < from) continue;
        if (to !== null && startedAt > to) continue;
        all.push(this.toRecording(ref, camera.name));
      }
    }

    all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return {
      items: all.slice(query.offset, query.offset + query.limit),
      total: all.length,
    };
  }

  async get(
    recordingId: string,
    cameraName: (cameraId: string) => string | null,
  ): Promise<Recording> {
    const ref = decodeRecordingId(recordingId);
    // Confirm the range still exists: retention may already have removed it.
    const refs = await this.segments(ref.cameraId);
    const startMs = new Date(ref.start).getTime();
    const covered = refs.some((candidate) => {
      const candidateStart = new Date(candidate.start).getTime();
      return (
        startMs >= candidateStart - 1000 &&
        startMs <= candidateStart + candidate.durationSeconds * 1000
      );
    });
    if (!covered) {
      throw new AppError('NOT_FOUND', 'That recording is no longer available.');
    }
    return this.toRecording(ref, cameraName(ref.cameraId));
  }

  /** Upstream URL for the clip bytes. Never handed to a client. */
  clipUrl(ref: RecordingRef): string {
    const params = new URLSearchParams({
      path: ref.cameraId,
      start: ref.start,
      duration: String(ref.durationSeconds),
    });
    return `${this.baseUrl}/get?${params.toString()}`;
  }

  async storage(cameras: { id: string; name?: string | null }[]): Promise<StorageStatus> {
    // Oldest footage comes from the playback API, which is authoritative about
    // what is actually playable — a file can exist on disk that the recorder will
    // not serve.
    let oldest: string | null = null;
    for (const camera of cameras) {
      const refs = await this.segments(camera.id).catch(() => []);
      for (const ref of refs) {
        if (oldest === null || ref.start < oldest) oldest = ref.start;
      }
    }

    const measured = await measureRecordingStorage(this.storagePath);
    const names = new Map(cameras.map((c) => [c.id, c.name ?? null]));
    const dailyBytes = projectDailyBytes(measured);

    // Headroom is whichever runs out first: the budget, or the disk. A 3 TB
    // budget on a disk with 40 GB left is not 3 TB of headroom.
    const quotaFreeBytes =
      this.quotaBytes === null
        ? null
        : Math.max(
            0,
            measured.freeBytes === null
              ? this.quotaBytes - measured.recordingsBytes
              : Math.min(this.quotaBytes - measured.recordingsBytes, measured.freeBytes),
          );

    const headroom = quotaFreeBytes ?? measured.freeBytes;

    return {
      ...UNKNOWN_STORAGE,
      totalBytes: measured.totalBytes,
      usedBytes: measured.usedBytes,
      freeBytes: measured.freeBytes,
      recordingsBytes: measured.recordingsBytes,
      quotaBytes: this.quotaBytes,
      quotaUsedRatio:
        this.quotaBytes === null || this.quotaBytes === 0
          ? null
          : Math.min(1, Math.round((measured.recordingsBytes / this.quotaBytes) * 10_000) / 10_000),
      quotaFreeBytes,
      fileCount: measured.fileCount,
      dailyBytes,
      // Measured against the budget when there is one, so the figure answers
      // "how long until recordings start being deleted" rather than "how long
      // until the whole server fills up".
      daysRemaining:
        dailyBytes && dailyBytes > 0 && headroom !== null
          ? Math.floor(headroom / dailyBytes)
          : null,
      retentionDays: this.retentionDays,
      oldestRecordingAt: oldest ? new Date(oldest).toISOString() : measured.oldestRecordingAt,
      newestRecordingAt: measured.newestRecordingAt,
      perCamera: measured.cameras.map((c) => ({
        cameraId: c.cameraId,
        cameraName: names.get(c.cameraId) ?? null,
        bytes: c.bytes,
        fileCount: c.fileCount,
        oldestAt: c.oldestAt,
        newestAt: c.newestAt,
      })),
    };
  }
}
