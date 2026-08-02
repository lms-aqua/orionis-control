/**
 * Measures what recordings actually occupy on disk.
 *
 * The recorder writes to its own volume, which the gateway mounts read-only. That
 * mount is the only way to answer "how much space are my recordings using" with a
 * real number: the playback API reports neither file sizes nor capacity, and
 * multiplying duration by bitrate would be an invented figure dressed up as data.
 *
 * Read-only by design — the gateway reports on the recorder's storage, it never
 * deletes from it. Retention is the recorder's job.
 */
import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';

export interface CameraStorage {
  cameraId: string;
  bytes: number;
  fileCount: number;
  oldestAt: string | null;
  newestAt: string | null;
}

export interface RecordingStorage {
  /** Size of the filesystem holding recordings. */
  totalBytes: number | null;
  freeBytes: number | null;
  /** Used by everything on that filesystem, not only recordings. */
  usedBytes: number | null;
  /** Used by recordings specifically — the number a viewer actually asked for. */
  recordingsBytes: number;
  fileCount: number;
  oldestRecordingAt: string | null;
  newestRecordingAt: string | null;
  cameras: CameraStorage[];
}

const EMPTY: RecordingStorage = {
  totalBytes: null,
  freeBytes: null,
  usedBytes: null,
  recordingsBytes: 0,
  fileCount: 0,
  oldestRecordingAt: null,
  newestRecordingAt: null,
  cameras: [],
};

/** Recording file extensions the recorder produces. */
const MEDIA = /\.(mp4|ts|mkv)$/i;

async function measureCamera(root: string, cameraId: string): Promise<CameraStorage | null> {
  let entries: string[];
  try {
    entries = await readdir(join(root, cameraId));
  } catch {
    return null;
  }

  let bytes = 0;
  let fileCount = 0;
  let oldest: number | null = null;
  let newest: number | null = null;

  for (const entry of entries) {
    if (!MEDIA.test(entry)) continue;
    try {
      const info = await stat(join(root, cameraId, entry));
      if (!info.isFile()) continue;
      bytes += info.size;
      fileCount += 1;
      // mtime is when the recorder last wrote the segment. Segment filenames carry
      // the start instant, but parsing those would couple this to the recorder's
      // naming; mtime is good enough to describe the span held on disk.
      const at = info.mtimeMs;
      if (oldest === null || at < oldest) oldest = at;
      if (newest === null || at > newest) newest = at;
    } catch {
      // A segment deleted by retention mid-walk is normal, not an error.
      continue;
    }
  }

  if (fileCount === 0) return null;
  return {
    cameraId,
    bytes,
    fileCount,
    oldestAt: oldest === null ? null : new Date(oldest).toISOString(),
    newestAt: newest === null ? null : new Date(newest).toISOString(),
  };
}

/**
 * Walks the recordings root. Returns zeroed totals when the mount is absent, so a
 * gateway without the volume degrades to "nothing to report" rather than failing.
 */
export async function measureRecordingStorage(root: string): Promise<RecordingStorage> {
  if (!root) return { ...EMPTY };

  let cameraDirs: string[];
  try {
    cameraDirs = await readdir(root);
  } catch {
    return { ...EMPTY };
  }

  const cameras: CameraStorage[] = [];
  for (const cameraId of cameraDirs) {
    const measured = await measureCamera(root, cameraId);
    if (measured) cameras.push(measured);
  }
  cameras.sort((a, b) => b.bytes - a.bytes);

  const recordingsBytes = cameras.reduce((sum, c) => sum + c.bytes, 0);
  const fileCount = cameras.reduce((sum, c) => sum + c.fileCount, 0);
  const oldest = cameras
    .map((c) => c.oldestAt)
    .filter((v): v is string => v !== null)
    .sort()[0];
  const newest = cameras
    .map((c) => c.newestAt)
    .filter((v): v is string => v !== null)
    .sort()
    .at(-1);

  let totalBytes: number | null = null;
  let freeBytes: number | null = null;
  let usedBytes: number | null = null;
  try {
    const fs = await statfs(root);
    // bsize is the preferred block size; blocks/bavail are counts of it.
    totalBytes = Number(fs.blocks) * Number(fs.bsize);
    freeBytes = Number(fs.bavail) * Number(fs.bsize);
    usedBytes = totalBytes - Number(fs.bfree) * Number(fs.bsize);
  } catch {
    // Capacity is unknown rather than zero: reporting 0 free would read as full.
  }

  return {
    totalBytes,
    freeBytes,
    usedBytes,
    recordingsBytes,
    fileCount,
    oldestRecordingAt: oldest ?? null,
    newestRecordingAt: newest ?? null,
    cameras,
  };
}

/**
 * Projects how long retention can be sustained at the current rate.
 *
 * Deliberately returns null rather than a guess when there is too little history
 * to divide by — a made-up "days remaining" is worse than no figure.
 */
export function projectDailyBytes(storage: RecordingStorage): number | null {
  if (storage.oldestRecordingAt === null || storage.newestRecordingAt === null) return null;
  const spanMs = Date.parse(storage.newestRecordingAt) - Date.parse(storage.oldestRecordingAt);
  const spanDays = spanMs / 86_400_000;
  if (!Number.isFinite(spanDays) || spanDays < 0.25) return null;
  return Math.round(storage.recordingsBytes / spanDays);
}
