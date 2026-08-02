/**
 * A minimal per-origin rate limiter. One instance should be shared across
 * all requests to the same target during a crawl session so that the
 * configured delay is actually enforced between consecutive requests,
 * rather than reset per-call.
 */
export class PoliteRateLimiter {
  private lastRequestAt = 0;

  constructor(private readonly delayMs: number) {}

  /** Waits, if necessary, so that calls are spaced at least `delayMs` apart. */
  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    const remaining = this.delayMs - elapsed;
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    this.lastRequestAt = Date.now();
  }
}
