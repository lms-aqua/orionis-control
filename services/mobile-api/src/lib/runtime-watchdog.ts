import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

export interface RuntimeSnapshot {
  rssBytes: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
  heapUsedPercent: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  uptimeSeconds: number;
}

export interface RuntimeLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface RuntimeWatchdog {
  stop(): void;
}

export function runtimeWarningReasons(snapshot: RuntimeSnapshot): string[] {
  const reasons: string[] = [];
  if (snapshot.eventLoopP99Ms >= 200) reasons.push('event_loop_delay');
  if (snapshot.eventLoopMaxMs >= 1_000) reasons.push('event_loop_stall');
  if (snapshot.heapUsedPercent >= 85) reasons.push('heap_pressure');
  return reasons;
}

/**
 * Reports runtime pressure into the structured server log. Healthy samples are
 * emitted every ten minutes; pressure is emitted immediately every minute.
 */
export function startRuntimeWatchdog(logger: RuntimeLogger, intervalMs = 60_000): RuntimeWatchdog {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let healthySamples = 0;

  const sample = (): void => {
    const memory = process.memoryUsage();
    const heapLimitBytes = getHeapStatistics().heap_size_limit;
    const snapshot: RuntimeSnapshot = {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapLimitBytes,
      heapUsedPercent: heapLimitBytes > 0 ? (memory.heapUsed / heapLimitBytes) * 100 : 0,
      eventLoopP99Ms: Number((histogram.percentile(99) / 1_000_000).toFixed(1)),
      eventLoopMaxMs: Number((histogram.max / 1_000_000).toFixed(1)),
      uptimeSeconds: Math.floor(process.uptime()),
    };
    histogram.reset();
    const warningReasons = runtimeWarningReasons(snapshot);
    if (warningReasons.length > 0) {
      logger.warn({ runtime: snapshot, warningReasons }, 'gateway runtime pressure detected');
      return;
    }
    healthySamples += 1;
    if (healthySamples % 10 === 0) {
      logger.info({ runtime: snapshot }, 'gateway runtime health sample');
    }
  };

  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      histogram.disable();
    },
  };
}
