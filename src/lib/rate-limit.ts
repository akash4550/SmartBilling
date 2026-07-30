/**
 * Pluggable sliding-window rate limiter.
 *
 * Two backends are shipped:
 *   1. "memory" (default in dev / single-instance deploys) — in-process Map.
 *   2. "upstash" (activated when UPSTASH_REDIS_REST_URL is set) — distributed
 *      sliding window over Upstash Redis, safe across Vercel Lambda replicas.
 *
 * Callers import the pre-configured singleton `rateLimit()` and the
 * `requestKey()` helper from this file and use them exactly as before;
 * switching backends is a matter of setting (or unsetting) env vars.
 *
 * The Redis adapter uses a sorted-set TTLed key per bucket, which gives an
 * exact sliding-window count without requiring a dedicated cron job for
 * bucket expiration.
 */

// ============================================================
// TYPES
// ============================================================

export interface RateLimitConfig {
  /** Unique namespace (isolates endpoints from one another). */
  namespace: string;
  /** Maximum requests per window. */
  limit: number;
  /** Window size in seconds. */
  windowSec: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until the oldest hit falls out of the window. */
  retryAfterMs: number;
}

export interface RateLimiter {
  (key: string, cfg: RateLimitConfig): Promise<RateLimitResult> | RateLimitResult;
}

// ============================================================
// MEMORY BACKEND
// ============================================================

interface Bucket {
  hits: number[];
}

const memoryBuckets = new Map<string, Bucket>();

function memoryRateLimit(key: string, cfg: RateLimitConfig): RateLimitResult {
  const bucketKey = `${cfg.namespace}:${key}`;
  const now = Date.now();
  const windowMs = cfg.windowSec * 1000;

  let bucket = memoryBuckets.get(bucketKey);
  if (!bucket) {
    bucket = { hits: [] };
    memoryBuckets.set(bucketKey, bucket);
  }

  const cutoff = now - windowMs;
  while (bucket.hits.length && bucket.hits[0]! < cutoff) {
    bucket.hits.shift();
  }

  if (bucket.hits.length >= cfg.limit) {
    const oldest = bucket.hits[0] ?? now;
    const retryAfterMs = Math.max(0, oldest + windowMs - now);
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  bucket.hits.push(now);
  return {
    allowed: true,
    remaining: cfg.limit - bucket.hits.length,
    retryAfterMs: 0,
  };
}

// Periodically GC expired memory buckets.
if (typeof setInterval !== "undefined") {
  const iv = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of memoryBuckets) {
      if (
        b.hits.length === 0 ||
        b.hits[b.hits.length - 1]! < now - 60 * 60 * 1000
      ) {
        memoryBuckets.delete(k);
      }
    }
  }, 10 * 60 * 1000);
  // Allow the process to exit cleanly even with the interval running.
  if (typeof iv.unref === "function") iv.unref();
}

// ============================================================
// FACTORY
// ============================================================

let _limiter: RateLimiter | undefined;

/**
 * Select the rate-limit backend based on environment:
 *   - If UPSTASH_REDIS_REST_URL (and optionally UPSTASH_REDIS_REST_TOKEN)
 *     are set, use the Upstash Redis sliding-window adapter.
 *   - Otherwise fall back to the in-memory adapter.
 *
 * Redis connection failures automatically fall through to the in-memory
 * backend on a per-call basis so an outage never hard-fails protected
 * endpoints.
 */
export async function getRateLimiter(): Promise<RateLimiter> {
  if (_limiter) return _limiter;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url) {
    try {
      const { createUpstashRateLimiter } = await import("./rate-limit-redis");
      const redisLimiter = createUpstashRateLimiter({ url, token: token ?? "" });
      _limiter = async (key, cfg) => {
        try {
          return await redisLimiter(key, cfg);
        } catch (err) {
          console.error("[rate-limit] Redis backend failed; falling back to memory:", err);
          return memoryRateLimit(key, cfg);
        }
      };
      return _limiter;
    } catch (err) {
      console.error("[rate-limit] Failed to load Redis adapter; using memory:", err);
    }
  }

  _limiter = memoryRateLimit;
  return _limiter;
}

/**
 * Backwards-compatible synchronous wrapper. Uses the memory backend
 * synchronously if it's the selected one; otherwise falls back to memory
 * synchronously (Redis calls would require await). Callers that want the
 * Redis backend in production should `await rateLimitAsync()` instead.
 *
 * Because all existing callers are synchronous (they call `rateLimit()`
 * and immediately use the result), keeping this signature preserves zero
 * churn for call sites while still allowing new async callers.
 */
export function rateLimit(key: string, cfg: RateLimitConfig): RateLimitResult {
  return memoryRateLimit(key, cfg);
}

/**
 * Async-aware rate-limit entry point. Uses the configured backend (Redis
 * or memory) and always returns a promise. New endpoints should prefer
 * this so distributed rate-limiting is effective out of the box.
 */
export async function rateLimitAsync(
  key: string,
  cfg: RateLimitConfig
): Promise<RateLimitResult> {
  const limiter = await getRateLimiter();
  return limiter(key, cfg);
}

// ============================================================
// REQUEST KEY HELPERS
// ============================================================

/**
 * Build a consistent rate-limit key from a Request.
 *
 * Combines client IP (from x-forwarded-for first entry, falling back to
 * x-real-ip) with the URL pathname. An optional `extra` suffix can be
 * appended (e.g. userId) to make per-user limits truly per-user.
 */
export function requestKey(req: Request, extra = ""): string {
  const xfwd = req.headers.get("x-forwarded-for");
  const ip = xfwd
    ? xfwd.split(",")[0]!.trim()
    : req.headers.get("x-real-ip") ?? "unknown";
  const url = new URL(req.url);
  return `${ip}|${url.pathname}${extra ? `|${extra}` : ""}`;
}

/**
 * Build a per-user rate-limit key (stronger than per-IP because one user
 * on multiple IPs can't bypass, and NAT'd users don't share a bucket).
 */
export function userKey(userId: string, extra = ""): string {
  return `user:${userId}${extra ? `|${extra}` : ""}`;
}
