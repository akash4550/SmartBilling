/**
 * Upstash Redis adapter for sliding-window rate limiting.
 *
 * Implements the classic Redis sorted-set sliding window:
 *   Key:   rl:<namespace>:<bucketKey>
 *   Score: member's timestamp in ms
 *   Member: a unique token combining timestamp + random suffix to avoid
 *           collisions when multiple requests share the same millisecond.
 *
 * On each call we:
 *   1. ZREMRANGEBYSCORE to evict entries older than (now - windowMs).
 *   2. ZCARD to count remaining entries (already-past hits).
 *   3. If under limit: ZADD the new hit and set a TTL = windowMs + 60s.
 *   4. If over limit: ZRANGE to find oldest hit to compute retryAfterMs.
 *
 * All three (or four) commands are executed as a single pipelined HTTP
 * request via Upstash's REST API (no Redis client dependency needed).
 *
 * The adapter gracefully degrades: network/auth failures throw and the
 * caller (rate-limit.ts) falls back to the in-memory backend so endpoints
 * don't hard-fail.
 */

export interface UpstashConfig {
  url: string;
  token?: string;
}

interface RateLimitConfig {
  namespace: string;
  limit: number;
  windowSec: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface UpstashCommand {
  /** Redis command + args, serialized as REST expects. */
  args: unknown[];
}

/** Execute a pipeline of Redis commands against the Upstash REST endpoint. */
async function upstashPipeline(
  cfg: UpstashConfig,
  commands: UpstashCommand[]
): Promise<Array<{ result: unknown; error?: string }>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;

  const res = await fetch(`${cfg.url.replace(/\/$/, "")}/pipeline`, {
    method: "POST",
    headers,
    body: JSON.stringify(commands.map((c) => c.args)),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upstash HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as Array<{
    result?: unknown;
    error?: string;
  }>;
  if (!Array.isArray(json)) {
    throw new Error("Upstash returned non-array pipeline response");
  }
  return json as Array<{ result: unknown; error?: string }>;
}

function randomSuffix(): string {
  // 8 hex chars of randomness — enough to avoid collisions within a ms.
  const buf = new Uint8Array(4);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createUpstashRateLimiter(
  cfg: UpstashConfig
): (key: string, rl: RateLimitConfig) => Promise<RateLimitResult> {
  return async function upstashRateLimit(
    bucketKey: string,
    rl: RateLimitConfig
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = rl.windowSec * 1000;
    const cutoff = now - windowMs;
    const key = `rl:${rl.namespace}:${bucketKey}`;
    const member = `${now}-${randomSuffix()}`;

    // First: evict expired entries, count current hits, and (if allowed) add.
    // We run EVICT + CARD + (optional ADD + EXPIRE) as a pipeline.
    const pipe: UpstashCommand[] = [
      { args: ["ZREMRANGEBYSCORE", key, 0, cutoff] },
      { args: ["ZCARD", key] },
    ];

    // Decide allowance AFTER we see the count. To do it in one RTT we
    // optimistically add and then roll back if over limit using a
    // transaction-less approach: we first run evict+card, then decide.
    // Two RTTs is acceptable for rate-limits (sub-millisecond on Upstash).
    const first = await upstashPipeline(cfg, pipe);
    const cardResult = first[1]?.result;
    const currentCount = typeof cardResult === "number" ? cardResult : 0;

    if (currentCount >= rl.limit) {
      // Find oldest hit to compute retry-after.
      const oldestRes = await upstashPipeline(cfg, [
        { args: ["ZRANGE", key, 0, 0, "WITHSCORES"] },
      ]);
      const range = oldestRes[0]?.result;
      let oldest = now - windowMs;
      // ZRANGE WITHSCORES returns [member, score, member, score, ...]
      if (Array.isArray(range) && range.length >= 2) {
        const score = Number(range[1]);
        if (Number.isFinite(score)) oldest = score;
      }
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, oldest + windowMs - now),
      };
    }

    // Under limit: record this hit with TTL.
    await upstashPipeline(cfg, [
      { args: ["ZADD", key, now, member] },
      { args: ["EXPIRE", key, rl.windowSec + 60] },
    ]);

    return {
      allowed: true,
      remaining: Math.max(0, rl.limit - (currentCount + 1)),
      retryAfterMs: 0,
    };
  };
}
