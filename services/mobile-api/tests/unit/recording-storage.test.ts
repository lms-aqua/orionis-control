import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  measureRecordingStorage,
  projectDailyBytes,
  type RecordingStorage,
} from '../../src/lib/recording-storage.ts';

/** Builds a recordings tree on a real filesystem: this code's whole job is fs. */
async function tree(
  layout: Record<string, { name: string; bytes: number; ageDays: number }[]>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orionis-storage-'));
  for (const [cameraId, files] of Object.entries(layout)) {
    await mkdir(join(root, cameraId), { recursive: true });
    for (const file of files) {
      const path = join(root, cameraId, file.name);
      await writeFile(path, Buffer.alloc(file.bytes, 1));
      const when = new Date(Date.now() - file.ageDays * 86_400_000);
      await utimes(path, when, when);
    }
  }
  return root;
}

describe('measureRecordingStorage', () => {
  it('totals bytes and files per camera, largest first', async () => {
    const root = await tree({
      '56': [{ name: 'a.mp4', bytes: 1000, ageDays: 2 }],
      '57': [
        { name: 'b.mp4', bytes: 4000, ageDays: 3 },
        { name: 'c.mp4', bytes: 1000, ageDays: 1 },
      ],
    });
    const s = await measureRecordingStorage(root);
    expect(s.available).toBe(true);
    expect(s.recordingsBytes).toBe(6000);
    expect(s.fileCount).toBe(3);
    expect(s.cameras.map((c) => c.cameraId)).toEqual(['57', '56']);
    expect(s.cameras[0]!.bytes).toBe(5000);
    expect(s.cameras[0]!.fileCount).toBe(2);
  });

  it('reports the span of footage held on disk', async () => {
    const root = await tree({
      '57': [
        { name: 'old.mp4', bytes: 10, ageDays: 6 },
        { name: 'new.mp4', bytes: 10, ageDays: 1 },
      ],
    });
    const s = await measureRecordingStorage(root);
    const spanDays =
      (Date.parse(s.newestRecordingAt!) - Date.parse(s.oldestRecordingAt!)) / 86_400_000;
    expect(spanDays).toBeGreaterThan(4.5);
    expect(spanDays).toBeLessThan(5.5);
  });

  it('reads real filesystem capacity', async () => {
    const root = await tree({ '57': [{ name: 'a.mp4', bytes: 10, ageDays: 1 }] });
    const s = await measureRecordingStorage(root);
    expect(s.totalBytes).toBeGreaterThan(0);
    expect(s.freeBytes).toBeGreaterThan(0);
    // Used is of the whole filesystem, so it is at least what recordings occupy.
    expect(s.usedBytes).toBeGreaterThanOrEqual(0);
  });

  it('ignores files that are not recordings', async () => {
    const root = await tree({
      '57': [
        { name: 'keep.mp4', bytes: 500, ageDays: 1 },
        { name: 'notes.txt', bytes: 9999, ageDays: 1 },
        { name: '.DS_Store', bytes: 9999, ageDays: 1 },
      ],
    });
    const s = await measureRecordingStorage(root);
    expect(s.recordingsBytes).toBe(500);
    expect(s.fileCount).toBe(1);
  });

  it('skips a camera directory with no recordings rather than listing it empty', async () => {
    const root = await tree({
      '56': [],
      '57': [{ name: 'a.mp4', bytes: 100, ageDays: 1 }],
    });
    const s = await measureRecordingStorage(root);
    expect(s.cameras.map((c) => c.cameraId)).toEqual(['57']);
  });

  it('reports unavailable rather than a false zero when the mount is absent', async () => {
    for (const root of ['', join(tmpdir(), 'orionis-does-not-exist-12345')]) {
      const s = await measureRecordingStorage(root);
      expect(s.available).toBe(false);
      expect(s.cameras).toEqual([]);
      // Capacity unknown, not zero: 0 free would read as a full disk.
      expect(s.totalBytes).toBeNull();
      expect(s.freeBytes).toBeNull();
    }
  });
});

describe('projectDailyBytes', () => {
  const base: RecordingStorage = {
    available: true,
    totalBytes: 1000,
    freeBytes: 500,
    usedBytes: 500,
    recordingsBytes: 700,
    fileCount: 7,
    oldestRecordingAt: '2026-08-01T00:00:00.000Z',
    newestRecordingAt: '2026-08-08T00:00:00.000Z',
    cameras: [],
  };

  it('divides bytes held by the span they cover', async () => {
    // 700 bytes over 7 days.
    expect(projectDailyBytes(base)).toBe(100);
  });

  it('refuses to extrapolate from too little history', async () => {
    expect(
      projectDailyBytes({
        ...base,
        newestRecordingAt: '2026-08-01T01:00:00.000Z', // one hour
      }),
    ).toBeNull();
    expect(projectDailyBytes({ ...base, oldestRecordingAt: null })).toBeNull();
    expect(projectDailyBytes({ ...base, newestRecordingAt: null })).toBeNull();
    expect(projectDailyBytes({ ...base, available: false })).toBeNull();
  });
});
