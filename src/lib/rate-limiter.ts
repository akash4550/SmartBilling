/**
 * Unified sliding-window rate limiter (server-only).
 *
 * This module is the single canonical rate-limit implementation for
 * SmartBill. It supersedes the earlier duplicate implementations
 * (synchronous in-memory + Redis-only variants) and provides a shared
 * eviction, error-handling, and HTTP-response contract. Any new code
 * MUST import from this module.
 *
 * Design
 * ------
 * - When `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are both
 *   present, every check issues a single SCRIPT LOAD + EVALSHA against
 *   Upstash's REST API. The Lua script implements a true sliding window
 *   over sorted sets and returns `{ allowed, remaining, retryAfterMs }`.
 *   Zero npm dependencies — keeps the server bundle small.
 * - If the env vars are absent (local dev / CI without Redis), OR if
 *   the network request fails, times out, or returns anything
 *   unexpected, we transparently fall back to an in-process sliding
 *   window. The app keeps working; multi-instance consistency simply
 *   degrades to per-instance limits until Upstash recovers.
 * - On fallback / misconfiguration we log ONCE per process
 *   (`[rate-limiter]`) to stderr so an outage doesn't flood logs.
 * - The in-memory Map has bounded growth: a passive sweep runs every
 *   5 minutes on check traffic, and an `unref()`d active interval runs
 *   every 10 minutes as a backstop so buckets from stopped traffic
 *   cannot leak memory in long-running Node processes.
 *
 * Two call shapes are supported:
 *
 *  1. Server Actions / programmatic guards:
 *       await assertRateLimit(key, cfg?)  → throws RateLimitExceededError
 *   For the admin-ledger mutations, a pre-configured
 *   `assertMutationRateLimit(userId)` helper is preserved.
 *
 *  2. HTTP route handlers:
 *       const rl = await checkRateLimit(key, cfg?)
 *       if (!rl.allowed) return rl.toResponse()  // HTTP 429 + Retry-After
 *
 * NOTE: This module reads `process.env` at the top of the call stack
 * and must never be imported from a "use client" bundle. Type-only
 * imports are safe. Enforced at build time by `import "server-only"`.
 */

import "server-only";

import { NextResponse } from "next/server";

import { RateLimitExceededError } from "./errors";

// Re-export the canonical error so callers can `instanceof` it from
// this import path without risk of prototype mismatch. The class is
// defined once in @/lib/errors to keep instanceof reliable across the
// entire codebase.
export { RateLimitExceededError };

// ============================================================
// TYPES / CONSTANTS
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
  /** Milliseconds until the oldest in-window hit expires. 0 when allowed. */
  retryAfterMs: number;
  /** Build a standards-compliant 429 JSON response with Retry-After. */
  toResponse: (message?: string) => NextResponse;
}

const UPSTASH_TIMEOUT_MS = 1500;

/**
 * Default per-user budget used by admin server-action mutations.
 * Matches the historical value (10 req / 60s).
 */
export const MUTATION_LIMIT: RateLimitConfig = {
  namespace: "mutation",
  limit: 10,
  windowSec: 60,
};

// ============================================================
// IN-MEMORY SLIDING-WINDOW FALLBACK (with bounded heap)
// ============================================================

interface Bucket {
  /** Timestamps (ms) of hits currently inside the window, ascending. */
  hits: number[];
  /** Config this bucket was created under — we recreate if the window/limit
   *  ever changes per-key (defensive; config is static). */
  windowMs: number;
  limit: number;
}

const memBuckets = new Map<string, Bucket>();

const MEMORY_SWEEP_INTERVAL_MS = 5 * 60_000;
const MEMORY_MAX_IDLE_MS = 60 * 60_000; // drop buckets idle > 1h
let lastPassiveSweep = 0;

function makeResult(
  allowed: boolean,
  remaining: number,
  retryAfterMs: number
): RateLimitResult {
  return {
    allowed,
    remaining,
    retryAfterMs,
    toResponse: (message = "Too many requests — please try again later.") => {
      const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
      return NextResponse.json(
        { error: message },
        {
          status: 429,
          headers: { "Retry-After": String(secs) },
        }
      );
    },
  };
}

function memoryCheck(
  key: string,
  cfg: RateLimitConfig,
  now: number
): RateLimitResult {
  const bucketKey = `${cfg.namespace}:${key}`;
  const windowMs = cfg.windowSec * 1000;
  const cutoff = now - windowMs;

  let b = memBuckets.get(bucketKey);
  if (!b || b.windowMs !== windowMs || b.limit !== cfg.limit) {
    b = { hits: [], windowMs, limit: cfg.limit };
    memBuckets.set(bucketKey, b);
  }

  while (b.hits.length && b.hits[0]! <= cutoff) b.hits.shift();

  if (b.hits.length >= cfg.limit) {
    const oldest = b.hits[0] ?? now;
    return makeResult(false, 0, Math.max(0, oldest + windowMs - now));
  }

  b.hits.push(now);
  return makeResult(true, Math.max(0, cfg.limit - b.hits.length), 0);
}

/** Passive sweep — piggybacks on check traffic; at most once per 5min. */
function passiveSweep(now: number) {
  if (now - lastPassiveSweep < MEMORY_SWEEP_INTERVAL_MS) return;
  lastPassiveSweep = now;
  evictMemoryBuckets(now);
}

/**
 * Active sweep — runs on an unref()d timer so the process can exit
 * cleanly and we never leak buckets from stopped traffic.
 */
function evictMemoryBuckets(now: number) {
  for (const [k, b] of memBuckets) {
    if (b.hits.length === 0) {
      memBuckets.delete(k);
      continue;
    }
    const newest = b.hits[b.hits.length - 1]!;
    const cutoff = now - Math.max(b.windowMs, MEMORY_MAX_IDLE_MS);
    if (newest <= cutoff) memBuckets.delete(k);
  }
}

if (typeof setInterval !== "undefined") {
  const iv = setInterval(() => evictMemoryBuckets(Date.now()), 10 * 60_000);
  if (typeof (iv as NodeJS.Timeout).unref === "function") {
    (iv as NodeJS.Timeout).unref();
  }
}

// ============================================================
// UPSTASH REDIS SLIDING WINDOW (zero-dependency EVALSHA)
// ============================================================

const SLIDING_WINDOW_LUA = /* lua */ `
local key     = KEYS[1]
local window  = tonumber(ARGV[1])
local limit   = tonumber(ARGV[2])
local now     = tonumber(ARGV[3])
local member  = ARGV[4]
local clear   = now - window

redis.call('ZREMRANGEBYSCORE', key, '-inf', clear)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = 0
  if oldest and #oldest >= 2 then
    retry = math.max(0, tonumber(oldest[2]) + window - now)
  end
  return {0, 0, retry}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, limit - count - 1, 0}
`;

interface UpstashHandle {
  baseUrl: string;
  token: string;
  sha: string | null;
}

let upstash: UpstashHandle | null | "unset" = "unset";
let fallbackLogged = false;

function initUpstash(): UpstashHandle | null {
  if (upstash !== "unset") return upstash;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    upstash = null;
    if (!fallbackLogged) {
      fallbackLogged = true;
      console.error(
        "[rate-limiter] UPSTASH_REDIS_REST_URL/TOKEN not set — using in-memory rate limiter (acceptable for dev/single-instance)."
      );
    }
    return null;
  }
  upstash = { baseUrl: url.replace(/\/+$/, ""), token, sha: null };
  return upstash;
}

async function loadScriptSha(h: UpstashHandle): Promise<string | null> {
  if (h.sha) return h.sha;
  try {
    const res = await upstashRaw(h, ["SCRIPT", "LOAD", SLIDING_WINDOW_LUA]);
    if (typeof res === "string" && res.length === 40) {
      h.sha = res;
      return h.sha;
    }
  } catch {
    /* handled by caller */
  }
  return null;
}

async function upstashRaw(
  h: UpstashHandle,
  args: readonly (string | number)[]
): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), UPSTASH_TIMEOUT_MS);
  try {
    const r = await fetch(`${h.baseUrl}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${h.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([args]),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`Upstash HTTP ${r.status}`);
    const json = (await r.json()) as unknown;
    if (Array.isArray(json) && json.length === 1) {
      const tuple = json[0] as unknown;
      if (Array.isArray(tuple) && tuple.length === 2) {
        const [err, result] = tuple as [unknown, unknown];
        if (err) {
          throw new Error(typeof err === "string" ? err : "Upstash pipeline error");
        }
        return result;
      }
    }
    throw new Error("Upstash unexpected response shape");
  } finally {
    clearTimeout(t);
  }
}

function randomSuffix(): string {
  const buf = new Uint8Array(4);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function upstashCheck(
  bucketKey: string,
  cfg: RateLimitConfig,
  now: number
): Promise<RateLimitResult> {
  const h = initUpstash();
  if (!h) throw new Error("upstash not configured");
  const key = `rl:${cfg.namespace}:${bucketKey}`;
  const windowMs = cfg.windowSec * 1000;

  let sha = await loadScriptSha(h);
  if (!sha) throw new Error("upstash SCRIPT LOAD failed");

  let result: unknown;
  try {
    result = await upstashRaw(h, [
      "EVALSHA",
      sha,
      "1",
      key,
      String(windowMs),
      String(cfg.limit),
      String(now),
      `${now}-${randomSuffix()}`,
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("NOSCRIPT")) {
      h.sha = null;
      sha = await loadScriptSha(h);
      if (!sha) throw err;
      result = await upstashRaw(h, [
        "EVALSHA",
        sha,
        "1",
        key,
        String(windowMs),
        String(cfg.limit),
        String(now),
        `${now}-${randomSuffix()}`,
      ]);
    } else {
      throw err;
    }
  }

  if (Array.isArray(result) && result.length >= 3) {
    const allowed = Number(result[0]) === 1;
    const remaining = allowed ? Math.max(0, Number(result[1])) : 0;
    const retryAfterMs = Math.max(0, Number(result[2]) | 0);
    return makeResult(allowed, remaining, retryAfterMs);
  }
  throw new Error("upstash malformed evalsha result");
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Generic rate-limit check. Works for HTTP handlers (returns a result
 * with .toResponse()) and internal callers.
 *
 * Failures of the distributed backend transparently fall through to
 * the in-memory limiter so the app never hard-fails on Redis outages.
 */
export async function checkRateLimit(
  key: string,
  cfg: RateLimitConfig = MUTATION_LIMIT
): Promise<RateLimitResult> {
  const now = Date.now();
  passiveSweep(now);

  const hasUpstash =
    !!process.env.UPSTASH_REDIS_REST_URL &&
    !!process.env.UPSTASH_REDIS_REST_TOKEN;

  if (hasUpstash) {
    try {
      return await upstashCheck(key, cfg, now);
    } catch (err) {
      console.error(
        "[rate-limiter] Upstash failure — falling back to in-memory limiter:",
        err instanceof Error ? err.message : err
      );
    }
  }

  return memoryCheck(key, cfg, now);
}

/**
 * Assert-style guard used by Server Actions. Returns normally on
 * success; throws a `RateLimitExceededError` (with retryAfterMs)
 * when the budget is exhausted.
 */
export async function assertRateLimit(
  key: string,
  cfg: RateLimitConfig = MUTATION_LIMIT,
  userMessage = "Too many requests — please wait a minute and retry."
): Promise<void> {
  const rl = await checkRateLimit(key, cfg);
  if (!rl.allowed) {
    throw new RateLimitExceededError(userMessage, rl.retryAfterMs, cfg.limit, cfg.windowSec);
  }
}

/**
 * Backwards-compatible alias for the admin-ledger server actions.
 * Uses the default 10/60s mutation budget keyed on userId.
 */
export async function assertMutationRateLimit(userId: string): Promise<void> {
  await assertRateLimit(userId, MUTATION_LIMIT);
}

// ============================================================
// REQUEST KEY HELPERS
// ============================================================

export function requestKey(req: Request, extra = ""): string {
  const xfwd = req.headers.get("x-forwarded-for");
  const ip = xfwd
    ? xfwd.split(",")[0]!.trim()
    : req.headers.get("x-real-ip") ?? "unknown";
  const url = new URL(req.url);
  return `${ip}|${url.pathname}${extra ? `|${extra}` : ""}`;
}

export function userKey(userId: string, extra = ""): string {
  return `user:${userId}${extra ? `|${extra}` : ""}`;
}
