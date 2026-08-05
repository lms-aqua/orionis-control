/**
 * Bound a promise to a hard deadline.
 *
 * A user-facing aggregate (the dashboard, the system-health screen) fans out to
 * several upstreams at once. Without a per-call ceiling, the slowest upstream
 * dictates the whole response time: one stalled probe turned a 350ms dashboard
 * into a 9s hang that blew the app's request timeout. Racing each call against a
 * deadline keeps a single slow dependency from holding the whole screen hostage —
 * the caller degrades that one section instead of failing everything.
 *
 * The underlying work is not aborted here (callers already carry their own
 * AbortSignal.timeout for socket cleanup); this only stops the caller waiting.
 */
export class DeadlineError extends Error {
  constructor(ms: number) {
    super(`Operation exceeded its ${ms}ms deadline`);
    this.name = 'DeadlineError';
  }
}

export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(ms)), ms);
    // Node keeps the event loop alive for a pending timer; a health probe should
    // never be the reason the process lingers on shutdown.
    if (typeof timer.unref === 'function') timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
