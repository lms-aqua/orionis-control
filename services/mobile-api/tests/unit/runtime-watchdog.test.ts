import { describe, expect, it } from 'vitest';
import { runtimeWarningReasons, type RuntimeSnapshot } from '../../src/lib/runtime-watchdog.ts';

const snapshot = (overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  rssBytes: 32 * 1024 * 1024,
  heapUsedBytes: 8 * 1024 * 1024,
  heapLimitBytes: 512 * 1024 * 1024,
  heapUsedPercent: 10,
  eventLoopP99Ms: 10,
  eventLoopMaxMs: 20,
  uptimeSeconds: 60,
  ...overrides,
});

describe('runtime watchdog thresholds', () => {
  it.each([
    ['healthy baseline', {}, []],
    ['p99 just below threshold', { eventLoopP99Ms: 199.9 }, []],
    ['p99 threshold', { eventLoopP99Ms: 200 }, ['event_loop_delay']],
    ['p99 above threshold', { eventLoopP99Ms: 450 }, ['event_loop_delay']],
    ['max just below threshold', { eventLoopMaxMs: 999.9 }, []],
    ['max threshold', { eventLoopMaxMs: 1_000 }, ['event_loop_stall']],
    ['heap just below threshold', { heapUsedPercent: 84.9 }, []],
    ['heap threshold', { heapUsedPercent: 85 }, ['heap_pressure']],
    [
      'combined event-loop pressure',
      { eventLoopP99Ms: 250, eventLoopMaxMs: 1_200 },
      ['event_loop_delay', 'event_loop_stall'],
    ],
    [
      'all pressure signals',
      { eventLoopP99Ms: 250, eventLoopMaxMs: 1_200, heapUsedPercent: 90 },
      ['event_loop_delay', 'event_loop_stall', 'heap_pressure'],
    ],
  ] as const)('%s', (_name, overrides, expected) => {
    expect(runtimeWarningReasons(snapshot(overrides))).toEqual(expected);
  });
});
