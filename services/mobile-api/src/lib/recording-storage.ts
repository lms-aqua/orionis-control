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
import type { Dirent } from 'node:fs';

export interface CameraStorage {
  cameraId: string;
  bytes: number;
  fileCount: number;
  oldestAt: string | null;
  newestAt: string | null;
}

export interface RecordingStorage {
  /** False when the configured read-only recordings mount cannot be inspected. */
  available: boolean;
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
  available: false,
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

async function mapBatches<Input, Output>(
  values: Input[],
  concurrency: number,
  work: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output: Output[] = [];
  for (let index = 0; index < values.length; index += concurrency) {
    output.push(...(await Promise.all(values.slice(index, index + concurrency).map(work))));
  }
  return output;
}

async function measureCamera(root: string, cameraId: string): Promise<CameraStorage | null> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(root, cameraId), { withFileTypes: true });
  } catch {
    return null;
  }

  let bytes = 0;
  let fileCount = 0;
  let oldest: number | null = null;
  let newest: number | null = null;

  // Do not follow symbolic links out of the read-only recordings tree; only
  // regular files directly produced in the camera directory are measurements.
  const mediaEntries = entries.filter((entry) => entry.isFile() && MEDIA.test(entry.name));
  const measured = await mapBatches(mediaEntries, 32, async (entry) => {
    try {
      const info = await stat(join(root, cameraId, entry.name));
      return info.isFile() ? { bytes: info.size, at: info.mtimeMs } : null;
    } catch {
      // A segment deleted by retention mid-walk is normal, not an error.
      return null;
    }
  });
  for (const item of measured) {
    if (!item) continue;
    bytes += item.bytes;
    fileCount += 1;
    // mtime is when the recorder last wrote the segment. Segment filenames carry
    // the start instant, but parsing those would couple this to the recorder's
    // naming; mtime is good enough to describe the span held on disk.
    if (oldest === null || item.at < oldest) oldest = item.at;
    if (newest === null || item.at > newest) newest = item.at;
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
 * Walks the recordings root. An absent/unreadable mount is explicitly unavailable;
 * a mounted but empty root is the only state allowed to report zero recordings.
 */
export async function measureRecordingStorage(root: string): Promise<RecordingStorage> {
  if (!root) return { ...EMPTY };

  let cameraEntries: Dirent[];
  try {
    cameraEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return { ...EMPTY };
  }

  const cameraDirs = cameraEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const cameras = (await mapBatches(cameraDirs, 8, (id) => measureCamera(root, id))).filter(
    (camera): camera is CameraStorage => camera !== null,
  );
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
    available: true,
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
  if (!storage.available) return null;
  if (storage.oldestRecordingAt === null || storage.newestRecordingAt === null) return null;
  const spanMs = Date.parse(storage.newestRecordingAt) - Date.parse(storage.oldestRecordingAt);
  const spanDays = spanMs / 86_400_000;
  if (!Number.isFinite(spanDays) || spanDays < 0.25) return null;
  return Math.round(storage.recordingsBytes / spanDays);
}
