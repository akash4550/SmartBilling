/**
 * Minimal in-memory sliding-window rate limiter.
 *
 * NOTE: This is per-process memory, so it does NOT share state across
 * serverless function instances. For distributed / production deployments
 * (Vercel, AWS Lambda, multi-replica Docker) swap this for an Upstash Redis
 * or Cloudflare Durable Objects based limiter. It is still useful for
 * single-instance deploys and as a defense-in-depth backstop.
 */

interface Bucket {
  hits: number[]; // timestamps (ms) of hits within the window
}

const buckets = new Map<string, Bucket>();

export interface RateLimitConfig {
  /** Unique namespace for this limiter (keeps endpoints isolated). */
  namespace: string;
  /** How many requests are allowed per window. */
  limit: number;
  /** Window size in seconds. */
  windowSec: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until the oldest hit rolls out of the window. */
  retryAfterMs: number;
}

/**
 * Check whether the given key is within the configured limit.
 * Always call this on every request; it both records the hit and returns
 * the decision.
 */
export function rateLimit(
  key: string,
  cfg: RateLimitConfig
): RateLimitResult {
  const bucketKey = `${cfg.namespace}:${key}`;
  const now = Date.now();
  const windowMs = cfg.windowSec * 1000;

  let bucket = buckets.get(bucketKey);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(bucketKey, bucket);
  }

  // Drop timestamps outside the current window.
  const cutoff = now - windowMs;
  while (bucket.hits.length && bucket.hits[0] < cutoff) {
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

/**
 * Build a consistent key from a Request, combining IP (from X-Forwarded-For
 * if behind a proxy, otherwise the peer address) plus the URL pathname.
 */
export function requestKey(req: Request, extra = ""): string {
  const xfwd = req.headers.get("x-forwarded-for");
  const ip = xfwd
    ? xfwd.split(",")[0].trim()
    : req.headers.get("x-real-ip") ?? "unknown";
  const url = new URL(req.url);
  return `${ip}|${url.pathname}${extra ? `|${extra}` : ""}`;
}

// Periodically GC expired buckets so the map doesn't grow unbounded.
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      // If all hits are older than 1 hour, drop the bucket entirely.
      if (b.hits.length === 0 || b.hits[b.hits.length - 1] < now - 60 * 60 * 1000) {
        buckets.delete(k);
      }
    }
  }, 10 * 60 * 1000).unref?.();
}
