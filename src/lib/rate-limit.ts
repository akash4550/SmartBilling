/**
 * @deprecated Use `src/lib/rate-limiter.ts` instead.
 *
 * Compatibility shim that re-exports the canonical rate-limiter under
 * the old API shape. Synchronous `rateLimit()` continues to run a
 * local in-process sliding window (matching pre-unification behavior);
 * async callers get the full Upstash + memory-fallback pipeline via
 * `rateLimitAsync()`.
 *
 * Once every call site has been migrated to:
 *     import { checkRateLimit, requestKey } from "@/lib/rate-limiter";
 * this file and `rate-limit-redis.ts` can be deleted.
 */

import { NextResponse as NextResponseClass } from "next/server";

import {
  checkRateLimit,
  requestKey as _requestKey,
  userKey as _userKey,
  type RateLimitConfig as _Cfg,
  type RateLimitResult as _Res,
} from "./rate-limiter";

export type RateLimitConfig = _Cfg;
export type RateLimitResult = _Res;

export const requestKey = _requestKey;
export const userKey = _userKey;

// ---------------------------------------------------------------------------
// Legacy synchronous in-memory backend (preserves pre-migration semantics)
// ---------------------------------------------------------------------------

interface _Bucket {
  hits: number[];
  windowMs: number;
  limit: number;
}
const _buckets = new Map<string, _Bucket>();

function _syncCheck(key: string, cfg: RateLimitConfig): _Res {
  const bucketKey = `${cfg.namespace}:${key}`;
  const now = Date.now();
  const windowMs = cfg.windowSec * 1000;
  const cutoff = now - windowMs;

  let b = _buckets.get(bucketKey);
  if (!b || b.windowMs !== windowMs || b.limit !== cfg.limit) {
    b = { hits: [], windowMs, limit: cfg.limit };
    _buckets.set(bucketKey, b);
  }
  while (b.hits.length && b.hits[0]! < cutoff) b.hits.shift();

  if (b.hits.length >= cfg.limit) {
    const oldest = b.hits[0] ?? now;
    const retryAfterMs = Math.max(0, oldest + windowMs - now);
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs,
      toResponse: (msg = "Too many requests — please try again later.") => {
        // Dynamic import is sync-unsafe at call time in CJS; we
        // construct a plain Response instead so this works in both
        // sync and async callers without pulling NextResponse into
        // every module that imports the limiter.
        const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
        return new NextResponseClass(JSON.stringify({ error: msg }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(secs),
          },
        });
      },
    };
  }
  b.hits.push(now);
  return {
    allowed: true,
    remaining: cfg.limit - b.hits.length,
    retryAfterMs: 0,
    toResponse: () => {
      throw new Error("toResponse() is only meaningful on rate-limited results");
    },
  };
}

// Periodic GC for the shim's memory buckets (mirrors old behavior).
if (typeof setInterval !== "undefined") {
  const iv = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of _buckets) {
      const newest = b.hits[b.hits.length - 1] ?? 0;
      if (newest < now - Math.max(b.windowMs, 60 * 60 * 1000)) _buckets.delete(k);
    }
  }, 10 * 60 * 1000);
  if (typeof (iv as NodeJS.Timeout).unref === "function") {
    (iv as NodeJS.Timeout).unref();
  }
}

/**
 * Legacy synchronous API. Matches pre-unification behavior exactly —
 * only consults an in-memory Map, never the Upstash backend. New code
 * should `await checkRateLimit(...)` from `@/lib/rate-limiter` to
 * benefit from distributed limits.
 */
export function rateLimit(key: string, cfg: RateLimitConfig): RateLimitResult {
  return _syncCheck(key, cfg);
}

/** Async-aware entry point — uses the full Upstash + memory pipeline. */
export async function rateLimitAsync(
  key: string,
  cfg: RateLimitConfig
): Promise<RateLimitResult> {
  return checkRateLimit(key, cfg);
}
