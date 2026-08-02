import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/errors.ts';
import { readRetention, requestRetention } from '../../src/lib/retention.ts';

const dir = () => mkdtemp(join(tmpdir(), 'orionis-retention-'));

describe('readRetention', () => {
  it('falls back to the configured value before the applier has written anything', async () => {
    const d = await dir();
    const state = await readRetention(d, 7);
    expect(state.appliedDays).toBe(7);
    expect(state.requestedDays).toBeNull();
    expect(state.pending).toBe(false);
  });

  it('prefers what the applier actually applied over the configured value', async () => {
    const d = await dir();
    await writeFile(join(d, 'applied-retention.json'), JSON.stringify({ days: 14 }));
    // The env still says 7, but 14 is what is in force.
    expect((await readRetention(d, 7)).appliedDays).toBe(14);
  });

  it('reports a request that has not been applied yet as pending', async () => {
    const d = await dir();
    await writeFile(join(d, 'applied-retention.json'), JSON.stringify({ days: 7 }));
    await requestRetention(d, 30, 'tester');
    const state = await readRetention(d, 7);
    expect(state.appliedDays).toBe(7);
    expect(state.requestedDays).toBe(30);
    expect(state.pending).toBe(true);
  });

  it('stops reporting pending once the applier catches up', async () => {
    const d = await dir();
    await requestRetention(d, 30, 'tester');
    await writeFile(join(d, 'applied-retention.json'), JSON.stringify({ days: 30 }));
    const state = await readRetention(d, 7);
    // The request file still exists, but it no longer differs from reality.
    expect(state.pending).toBe(false);
    expect(state.appliedDays).toBe(30);
  });

  it('ignores a corrupt or out-of-range file rather than trusting it', async () => {
    const d = await dir();
    await writeFile(join(d, 'applied-retention.json'), 'not json at all');
    expect((await readRetention(d, 7)).appliedDays).toBe(7);

    await writeFile(join(d, 'applied-retention.json'), JSON.stringify({ days: 99999 }));
    expect((await readRetention(d, 7)).appliedDays).toBe(7);

    await writeFile(join(d, 'applied-retention.json'), JSON.stringify({ days: 2.5 }));
    expect((await readRetention(d, 7)).appliedDays).toBe(7);
  });

  it('reports unchangeable when no control directory is configured', async () => {
    const state = await readRetention('', 7);
    expect(state.appliedDays).toBe(7);
    expect(state.pending).toBe(false);
  });
});

describe('requestRetention', () => {
  it('writes a request the applier can read', async () => {
    const d = await dir();
    await requestRetention(d, 21, 'aqua');
    const written = JSON.parse(await readFile(join(d, 'requested-retention.json'), 'utf8'));
    expect(written.days).toBe(21);
    expect(written.by).toBe('aqua');
    expect(typeof written.at).toBe('string');
  });

  it('leaves no temp file behind, so the applier never sees a partial write', async () => {
    const d = await dir();
    await requestRetention(d, 21, 'aqua');
    await expect(readFile(join(d, 'requested-retention.json.tmp'), 'utf8')).rejects.toThrow();
  });

  it('rejects values outside the guard rails', async () => {
    const d = await dir();
    for (const days of [0, -5, 366, 10_000]) {
      await expect(requestRetention(d, days, 'aqua')).rejects.toThrow(AppError);
    }
  });

  it('rejects a fractional day count', async () => {
    const d = await dir();
    await expect(requestRetention(d, 7.5, 'aqua')).rejects.toThrow(AppError);
  });

  it('refuses when the deployment has no control directory', async () => {
    // Better to say "not configured" than to accept a change that silently
    // never happens.
    await expect(requestRetention('', 14, 'aqua')).rejects.toThrow(AppError);
  });
});
