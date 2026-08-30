export const RATE_LIMITER = Symbol("RATE_LIMITER");

export interface RateLimitCheck {
  allowed: boolean;
  /** Attempts remaining in the current window, floored at 0. Useful for a `Retry-After`-style hint. */
  remaining: number;
}

/**
 * A generic fixed-window counter, not a per-endpoint concept: `LoginHandler` and
 * `VerifyMfaHandler` each call this with their own key scheme and limits (see those
 * handlers), rather than this port encoding any auth-specific policy itself.
 */
export interface RateLimiterPort {
  /**
   * Atomically increments the counter for `key` and reports whether it's still within
   * `maxAttempts` for a rolling `windowSeconds` fixed window (the window starts on first use
   * of a fresh key and resets `windowSeconds` after that, not a true sliding window -- exact
   * enough for brute-force protection without needing a sorted-set-based sliding
   * implementation).
   */
  checkAndIncrement(key: string, maxAttempts: number, windowSeconds: number): Promise<RateLimitCheck>;
}
