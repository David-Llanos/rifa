import {
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  rateLimit,
  type RateLimitResult,
} from "./decision.js";

/**
 * Storage for rate-limit state. Production can back this with Redis (for example a sorted set per key);
 * `consume` must be atomic so concurrent requests cannot exceed the limit.
 */
export interface RateLimitStore {
  /** Checks the limit for `key` at `nowMs` and records the request only when it is allowed. */
  consume(key: string, nowMs: number, limit?: number, windowMs?: number): Promise<RateLimitResult>;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();

  consume(
    key: string,
    nowMs: number,
    limit: number = RATE_LIMIT_MAX,
    windowMs: number = RATE_LIMIT_WINDOW_MS,
  ): Promise<RateLimitResult> {
    const current = (this.hits.get(key) ?? []).filter((t) => t > nowMs - windowMs);
    const result = rateLimit(current, nowMs, limit, windowMs);
    if (result.allowed) current.push(nowMs);
    if (current.length > 0) this.hits.set(key, current);
    else this.hits.delete(key);
    return Promise.resolve(result);
  }
}
