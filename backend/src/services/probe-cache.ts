/**
 * A small stale-while-revalidate cache for the lookups behind /health.
 *
 * /health is Railway's healthcheck and is polled constantly, so the endpoint
 * cannot do a database round trip per request, and it must never fail: a 500
 * from a slow query would have the platform kill a service that is actually
 * healthy. This wrapper gives a probe three properties:
 *
 *  - **cached** — at most one refresh per `ttlMs`, however many callers arrive
 *  - **non-blocking after the first call** — a stale value is served straight
 *    away while a refresh runs behind it, so steady-state /health does no I/O
 *  - **fail-soft** — a refresh that throws or outruns `timeoutMs` becomes a
 *    caller-supplied fallback value, never a rejection
 */
export interface ProbeCacheOptions {
  /** How long a successful result is served without revalidating. */
  ttlMs: number;
  /** How long a failure is remembered, so a down dependency is not hammered. */
  errorTtlMs: number;
  /** Hard bound on how long a caller with no cached value will wait. */
  timeoutMs: number;
  /**
   * Age past which a cached value stops being served while revalidating. Keeps
   * a long outage from having /health quietly repeat week-old news.
   */
  maxStaleMs: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export interface CachedProbe<T> {
  /** Never rejects. */
  get(): Promise<T>;
  /** Kick off a refresh without waiting for it (used to warm the cache at boot). */
  warm(): void;
}

interface Entry<T> {
  value: T;
  freshUntil: number;
  staleUntil: number;
}

/** Longest failure reason /health will carry. */
const MAX_REASON = 200;

/**
 * A one-line, bounded description of a failure. Some clients (viem in
 * particular) throw multi-paragraph errors quoting the whole request body;
 * pasting that into a healthcheck response makes it unreadable and can leak
 * request detail, so only the first line survives.
 */
function describe(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split('\n', 1)[0].trim() || 'unknown error';
  return firstLine.length > MAX_REASON ? `${firstLine.slice(0, MAX_REASON - 1)}…` : firstLine;
}

export function createCachedProbe<T>(
  load: () => Promise<T>,
  /** Turns a failure into a value the caller can serve. Must not throw. */
  fallback: (reason: string) => T,
  options: ProbeCacheOptions
): CachedProbe<T> {
  const now = options.now ?? Date.now;
  let entry: Entry<T> | null = null;
  let inFlight: Promise<T> | null = null;

  function refresh(): Promise<T> {
    // Single-flight: a burst of healthcheck polls shares one query.
    if (inFlight) return inFlight;
    const started = now();
    inFlight = load()
      .then((value) => {
        entry = {
          value,
          freshUntil: started + options.ttlMs,
          staleUntil: started + options.maxStaleMs,
        };
        return value;
      })
      .catch((err) => {
        const value = fallback(describe(err));
        entry = {
          value,
          // Retried sooner than a success, because a dependency coming back is
          // news worth having quickly...
          freshUntil: started + options.errorTtlMs,
          // ...but still served while that retry runs. A dependency that is
          // hard-down would otherwise make every poll past errorTtlMs pay the
          // full timeout, which is exactly the slow healthcheck this avoids.
          staleUntil: started + options.maxStaleMs,
        };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function refreshInBackground(): void {
    // The catch above already absorbs failures; this guards against a
    // fallback() that throws becoming an unhandled rejection.
    void refresh().catch(() => undefined);
  }

  async function get(): Promise<T> {
    const at = now();
    if (entry && at < entry.freshUntil) return entry.value;
    if (entry && at < entry.staleUntil) {
      refreshInBackground();
      return entry.value;
    }

    // No usable value: wait, but only up to timeoutMs. The refresh keeps
    // running and will populate the cache for whoever asks next.
    const pending = refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(
        () => resolve(fallback(`lookup exceeded ${options.timeoutMs}ms`)),
        options.timeoutMs
      );
      // Never hold the process open on account of a health probe.
      timer.unref?.();
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { get, warm: refreshInBackground };
}
