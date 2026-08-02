/**
 * Merged recording coverage for a day.
 *
 * The timeline needs to draw "where is there footage", not "list every segment".
 * Asking for raw recordings makes the app page through hundreds of ten-minute
 * segments and stitch them itself, and the segment boundaries are an artefact of
 * how the recorder rotates files — they are not gaps and must not be drawn as
 * gaps.
 *
 * So this merges adjacent segments into continuous runs and reports the real gaps
 * between them, which is what a scrubber actually renders.
 */

export interface Span {
  startedAt: string;
  endedAt: string;
}

export interface CoverageRun {
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
}

export interface Coverage {
  cameraId: string;
  dayStart: string;
  dayEnd: string;
  runs: CoverageRun[];
  gaps: CoverageRun[];
  /** Seconds of footage held for the day, and that as a fraction of the day. */
  recordedSeconds: number;
  coverageRatio: number;
  earliestAt: string | null;
  latestAt: string | null;
}

/**
 * Segments closer together than this are treated as continuous.
 *
 * The recorder closes one file and opens the next, which leaves a sub-second seam.
 * Drawing that as a gap would litter the timeline with hairline breaks that do not
 * correspond to anything a viewer could notice, let alone act on.
 */
const JOIN_TOLERANCE_SECONDS = 3;

export function mergeCoverage(
  spans: Span[],
  options: {
    cameraId: string;
    dayStart: Date;
    dayEnd: Date;
    joinToleranceSeconds?: number;
  },
): Coverage {
  const tolerance = (options.joinToleranceSeconds ?? JOIN_TOLERANCE_SECONDS) * 1000;
  const windowStart = options.dayStart.getTime();
  const windowEnd = options.dayEnd.getTime();

  const clipped = spans
    .map((span) => ({
      start: Date.parse(span.startedAt),
      end: Date.parse(span.endedAt),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    // Clamp to the day: a segment that straddles midnight belongs to both days,
    // but only the part inside this one should be drawn.
    .map((s) => ({
      start: Math.max(s.start, windowStart),
      end: Math.min(s.end, windowEnd),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const runs: { start: number; end: number }[] = [];
  for (const span of clipped) {
    const last = runs.at(-1);
    // Overlapping or touching within tolerance extends the run rather than
    // starting a new one.
    if (last && span.start - last.end <= tolerance) {
      last.end = Math.max(last.end, span.end);
    } else {
      runs.push({ ...span });
    }
  }

  const gaps: { start: number; end: number }[] = [];
  for (let i = 1; i < runs.length; i += 1) {
    gaps.push({ start: runs[i - 1]!.end, end: runs[i]!.start });
  }

  const toRun = (r: { start: number; end: number }): CoverageRun => ({
    startedAt: new Date(r.start).toISOString(),
    endedAt: new Date(r.end).toISOString(),
    durationSeconds: Math.round((r.end - r.start) / 1000),
  });

  const recordedMs = runs.reduce((sum, r) => sum + (r.end - r.start), 0);
  const windowMs = Math.max(1, windowEnd - windowStart);

  return {
    cameraId: options.cameraId,
    dayStart: new Date(windowStart).toISOString(),
    dayEnd: new Date(windowEnd).toISOString(),
    runs: runs.map(toRun),
    gaps: gaps.map(toRun),
    recordedSeconds: Math.round(recordedMs / 1000),
    // Rounded to a sensible precision: the app shows this as a percentage, and
    // more digits would imply an accuracy the segment boundaries do not have.
    coverageRatio: Math.min(1, Math.round((recordedMs / windowMs) * 10_000) / 10_000),
    earliestAt: runs.length > 0 ? new Date(runs[0]!.start).toISOString() : null,
    latestAt: runs.length > 0 ? new Date(runs.at(-1)!.end).toISOString() : null,
  };
}
