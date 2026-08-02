import { describe, expect, it } from 'vitest';
import { mergeCoverage, type Span } from '../../src/lib/coverage.ts';

const DAY_START = new Date('2026-08-02T00:00:00.000Z');
const DAY_END = new Date('2026-08-03T00:00:00.000Z');
const opts = { cameraId: '57', dayStart: DAY_START, dayEnd: DAY_END };

const span = (from: string, to: string): Span => ({ startedAt: from, endedAt: to });

describe('mergeCoverage', () => {
  it('joins the seam between consecutive segments instead of drawing a gap', () => {
    // The recorder closes one file and opens the next, leaving a sub-second seam.
    const c = mergeCoverage(
      [
        span('2026-08-02T10:00:00.000Z', '2026-08-02T10:10:00.000Z'),
        span('2026-08-02T10:10:00.400Z', '2026-08-02T10:20:00.000Z'),
      ],
      opts,
    );
    expect(c.runs).toHaveLength(1);
    expect(c.gaps).toHaveLength(0);
    expect(c.runs[0]!.startedAt).toBe('2026-08-02T10:00:00.000Z');
    expect(c.runs[0]!.endedAt).toBe('2026-08-02T10:20:00.000Z');
  });

  it('reports a real gap between runs', () => {
    const c = mergeCoverage(
      [
        span('2026-08-02T10:00:00.000Z', '2026-08-02T10:10:00.000Z'),
        span('2026-08-02T11:00:00.000Z', '2026-08-02T11:10:00.000Z'),
      ],
      opts,
    );
    expect(c.runs).toHaveLength(2);
    expect(c.gaps).toHaveLength(1);
    expect(c.gaps[0]!.startedAt).toBe('2026-08-02T10:10:00.000Z');
    expect(c.gaps[0]!.endedAt).toBe('2026-08-02T11:00:00.000Z');
    expect(c.gaps[0]!.durationSeconds).toBe(3000);
  });

  it('merges overlapping segments', () => {
    const c = mergeCoverage(
      [
        span('2026-08-02T10:00:00.000Z', '2026-08-02T10:15:00.000Z'),
        span('2026-08-02T10:05:00.000Z', '2026-08-02T10:20:00.000Z'),
      ],
      opts,
    );
    expect(c.runs).toHaveLength(1);
    expect(c.runs[0]!.durationSeconds).toBe(1200);
  });

  it('sorts unordered input before merging', () => {
    const c = mergeCoverage(
      [
        span('2026-08-02T11:00:00.000Z', '2026-08-02T11:10:00.000Z'),
        span('2026-08-02T10:00:00.000Z', '2026-08-02T10:10:00.000Z'),
      ],
      opts,
    );
    expect(c.runs.map((r) => r.startedAt)).toEqual([
      '2026-08-02T10:00:00.000Z',
      '2026-08-02T11:00:00.000Z',
    ]);
  });

  it('clips a segment that straddles midnight to the day being drawn', () => {
    const c = mergeCoverage([span('2026-08-01T23:50:00.000Z', '2026-08-02T00:10:00.000Z')], opts);
    expect(c.runs[0]!.startedAt).toBe('2026-08-02T00:00:00.000Z');
    expect(c.runs[0]!.durationSeconds).toBe(600);
  });

  it('drops segments entirely outside the day', () => {
    const c = mergeCoverage([span('2026-07-30T10:00:00.000Z', '2026-07-30T10:10:00.000Z')], opts);
    expect(c.runs).toEqual([]);
    expect(c.recordedSeconds).toBe(0);
    expect(c.earliestAt).toBeNull();
  });

  it('totals recorded time and the fraction of the day covered', () => {
    // Six hours of a 24-hour day.
    const c = mergeCoverage([span('2026-08-02T00:00:00.000Z', '2026-08-02T06:00:00.000Z')], opts);
    expect(c.recordedSeconds).toBe(21_600);
    expect(c.coverageRatio).toBeCloseTo(0.25, 4);
  });

  it('never reports more than full coverage', () => {
    const c = mergeCoverage([span('2026-08-01T00:00:00.000Z', '2026-08-04T00:00:00.000Z')], opts);
    expect(c.coverageRatio).toBe(1);
  });

  it('ignores malformed or zero-length spans rather than failing', () => {
    const c = mergeCoverage(
      [
        span('not a date', '2026-08-02T10:00:00.000Z'),
        span('2026-08-02T10:00:00.000Z', '2026-08-02T10:00:00.000Z'),
        // End before start.
        span('2026-08-02T12:00:00.000Z', '2026-08-02T11:00:00.000Z'),
        span('2026-08-02T13:00:00.000Z', '2026-08-02T13:05:00.000Z'),
      ],
      opts,
    );
    expect(c.runs).toHaveLength(1);
    expect(c.runs[0]!.durationSeconds).toBe(300);
  });

  it('reports an empty day honestly', () => {
    const c = mergeCoverage([], opts);
    expect(c.runs).toEqual([]);
    expect(c.gaps).toEqual([]);
    expect(c.recordedSeconds).toBe(0);
    expect(c.coverageRatio).toBe(0);
    expect(c.earliestAt).toBeNull();
    expect(c.latestAt).toBeNull();
  });

  it('honours a caller-supplied join tolerance', () => {
    const spans = [
      span('2026-08-02T10:00:00.000Z', '2026-08-02T10:10:00.000Z'),
      span('2026-08-02T10:10:30.000Z', '2026-08-02T10:20:00.000Z'),
    ];
    // 30s apart: a gap by default, joined when the caller is more forgiving.
    expect(mergeCoverage(spans, opts).runs).toHaveLength(2);
    expect(mergeCoverage(spans, { ...opts, joinToleranceSeconds: 60 }).runs).toHaveLength(1);
  });
});
