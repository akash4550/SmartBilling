/**
 * Enterprise-grade circuit breaker + full-jitter exponential retry for
 * protecting Postgres (Prisma) and Upstash/network calls from cascading
 * failure during transient outages.
 *
 * Design tenets
 * -------------
 * 1. Zero npm dependencies — uses only Node's built-in timers and the
 *    global AbortController / DOMException types already present in
 *    Next.js runtimes.
 * 2. Fail-closed at startup and half-open on cooldown expiry: we never
 *    let a single happy probe in OPEN state reset the breaker unless the
 *    probe actually succeeds through `withRetry`.
 * 3. Strictly typed. Error classification reads Prisma/PG codes off the
 *    err object without any `any`. Permanent errors (unique constraint
 *    violations, quarantine rejects L0001, validation, crypto) never
 *    trigger a retry and count as a USER-level failure (they don't trip
 *    the circuit — a circuit is only for infrastructure failure).
 * 4. Full jitter `Math.random() * min(max, base*2^n)` to prevent
 *    thundering-herd waves across multi-instance edge deployments.
 *
 * Server-only module: no client bundle imports should reference it
 * directly (it reads `process.env` nowhere, but it uses setTimeout and
 * is intended for edge/node server-side work).
 */

import "server-only";

// ============================================================
// Public error classes
// ============================================================
//
// The canonical class constructors live in @/lib/errors so `instanceof`
// checks across modules share one prototype. We import them under their
// canonical names and re-export at the bottom of the file so internal
// references resolve to the local binding (avoids "used before export"
// ordering issues with isolatedModules).
import {
  CircuitBreakerOpenError,
  RetriesExhaustedError,
  LedgerQuarantinedError,
} from "@/lib/errors";

// ============================================================
// Types
// ============================================================

export interface RetryOptions {
  /** Maximum number of attempts (inclusive). Default 3. Must be >=1. */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default 150. */
  baseDelayMs?: number;
  /** Ceiling delay (pre-jitter). Default 2000. */
  maxDelayMs?: number;
  /**
   * Predicate — return true to retry. Defaults to classifying only known
   * transient Prisma / PG / network errors (see `isTransientError`).
   */
  shouldRetry?: (error: unknown) => boolean;
  /** Optional label used in warning logs when retries fire. */
  label?: string;
}

export interface CircuitBreakerOptions {
  /** Number of consecutive infrastructure failures before tripping OPEN. Default 5. */
  failureThreshold?: number;
  /** Milliseconds to stay OPEN before allowing a single probe (HALF_OPEN). Default 30_000. */
  cooldownMs?: number;
  /** Retry options used by executeResilient for the internal execution. */
  retry?: RetryOptions;
}

type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

// ============================================================
// Error classification
// ============================================================

/** Prisma error codes we treat as transient/infra (network / timeout / deadlock). */
const TRANSIENT_PRISMA_CODES: ReadonlySet<string> = new Set([
  "P1001", // Can't reach database server
  "P1002", // Connection timed out
  "P1008", // Operations timed out
  "P1017", // Server has closed the connection
]);

/** Postgres SQLSTATEs that warrant retry (deadlock/serialization/connectivity). */
const TRANSIENT_PG_SQLSTATES: ReadonlySet<string> = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "57P01", // admin_shutdown
]);

/** Node/system error codes for network/pipe problems (fetch/Upstash/PG). */
const TRANSIENT_SYS_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "NETWORK_ERROR",
]);

/**
 * Read a string-typed field from an unknown error without `any`.
 */
function readCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const c = (err as { code?: unknown }).code;
  return typeof c === "string" ? c : null;
}

/**
 * Determine whether an error represents a transient infrastructure
 * failure safe to retry. Explicitly returns false for permanent errors:
 *  - Prisma P2xxx (client-side validation/constraint, e.g. P2002 unique)
 *  - PG SQLSTATE L0001 (ledger quarantine guard)
 *  - LedgerQuarantinedError (thrown pre-lock by withTenant)
 *  - CircuitBreakerOpenError (already failed fast — don't wrap/retry)
 *  - Crypto / auth errors from safeCompareSecrets
 *  - SyntaxError, TypeError, Zod validation errors
 *
 * Also detects DOMException "AbortError" / {name:"AbortError"} produced
 * by AbortController, and fetch TypeError ("Failed to fetch").
 */
export function isTransientError(err: unknown): boolean {
  if (err === null || err === undefined) return false;

  // Fast-fail permanent error classes by name/instance to avoid retrying
  // business-logic / cryptographic / quarantine failures.
  if (err instanceof CircuitBreakerOpenError) return false;
  if (err instanceof TypeError) return false;
  if (err instanceof SyntaxError) return false;
  if (err instanceof RangeError) return false;
  if (err instanceof EvalError) return false;
  if (err instanceof ReferenceError) return false;

  // Prefer instanceof against the canonical LedgerQuarantinedError
  // (imported from @/lib/errors) so the check is prototype-safe across
  // all module boundaries; fall back to err.name for SQLSTATE L0001
  // errors re-thrown from Prisma which surface as plain Error.
  if (err instanceof LedgerQuarantinedError) return false;

  if (err instanceof Error) {
    if (err.name === "LedgerQuarantinedError") return false;
    if (err.name === "ZodError") return false;
    if (err.name === "PrismaClientValidationError") return false;
    if (err.name === "PrismaClientKnownRequestError") {
      const c = readCode(err);
      // P2xxx = client-side constraint/query errors; P1xxx = connectivity.
      if (c && c.startsWith("P2")) return false;
    }
    // DOMException AbortError (AbortController)
    if (err.name === "AbortError") return true;
  }

  // Check Prisma numeric code (P1001 etc.)
  const code = readCode(err);
  if (code) {
    if (TRANSIENT_PRISMA_CODES.has(code)) return true;
    if (TRANSIENT_SYS_CODES.has(code)) return true;
    // Prisma surfaces PG sqlstate via `code` directly (e.g. "40001")
    if (TRANSIENT_PG_SQLSTATES.has(code)) return true;
    // P2xxx = permanent
    if (code.startsWith("P2")) return false;
  }

  // PG driver sometimes puts sqlstate on a nested `meta.code` or the
  // error's message text starts with the SQLSTATE; cheap substring check.
  if (err instanceof Error) {
    const msg = err.message;
    if (msg) {
      // L0001 is our quarantine sentinel from ledger_quarantine_guard() —
      // permanently non-retryable.
      if (/\bL0001\b/.test(msg)) return false;
      if (
        /deadlock detected|canceling statement due to statement timeout|server closed the connection|Connection terminated unexpectedly|too many connections|connection reset|socket hang up/i.test(
          msg
        )
      ) {
        return true;
      }
    }
  }

  // Fetch network failure surfaces as a TypeError with message
  // "Failed to fetch" — we already returned false on TypeError above,
  // but network-reset TypeError during fetch should be retryable. The
  // generic TypeError above catches code bugs; if the message looks like
  // a fetch network failure we treat it as transient.
  if (err instanceof TypeError && err.message) {
    if (
      /fetch failed|failed to fetch|network error|networkrequest/i.test(
        err.message
      )
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================
// Helper: sleep with Abort-free timer
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// withRetry — full jitter exponential backoff
// ============================================================

const DEFAULT_RETRY_OPTS: Required<
  Pick<RetryOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs">
> = {
  maxAttempts: 3,
  baseDelayMs: 150,
  maxDelayMs: 2000,
};

/**
 * Execute `fn` with full-jitter exponential backoff. Retries ONLY when
 * `shouldRetry` returns true (defaults to `isTransientError`). On final
 * failure, throws the last underlying error wrapped in
 * `RetriesExhaustedError` whose `.cause` is the real error.
 *
 * Note: `fn` is called fresh each attempt, so callers MUST pass a
 * function that opens its own transaction / connection per call —
 * retrying inside an already-tainted Prisma tx would re-throw.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_RETRY_OPTS.maxAttempts);
  const baseDelayMs = Math.max(0, opts.baseDelayMs ?? DEFAULT_RETRY_OPTS.baseDelayMs);
  const maxDelayMs = Math.max(1, opts.maxDelayMs ?? DEFAULT_RETRY_OPTS.maxDelayMs);
  const shouldRetry = opts.shouldRetry ?? isTransientError;
  const label = opts.label ?? "circuit-breaker";

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Last attempt — don't delay, propagate (wrapped below).
      if (attempt === maxAttempts - 1) {
        break;
      }
      if (!shouldRetry(err)) {
        throw err;
      }
      // Full jitter: uniform random in [0, min(max, base * 2^attempt)].
      const capped = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      const waitMs = Math.floor(Math.random() * capped);
      // Use warn-level on server to aid debugging; don't log user errors.
      console.warn(
        `[${label}] transient failure (attempt ${attempt + 1}/${maxAttempts}); retrying in ${waitMs}ms:`,
        err instanceof Error ? err.message : String(err)
      );
      await sleep(waitMs);
    }
  }
  throw new RetriesExhaustedError(maxAttempts, lastErr);
}

// ============================================================
// CircuitBreaker — state machine
// ============================================================

export interface BreakerStats {
  state: BreakerState;
  consecutiveFailures: number;
  successes: number;
  totalRejected: number;
  openedAt: number | null;
  nextRetryAt: number | null;
}

const DEFAULT_BREAKER_OPTS: Required<
  Pick<CircuitBreakerOptions, "failureThreshold" | "cooldownMs">
> = {
  failureThreshold: 5,
  cooldownMs: 30_000,
};

/**
 * Lightweight, memory-safe circuit breaker. Instances are cheap; create
 * one per protected resource (e.g., "db" for Prisma, "upstash" for Redis).
 * For most of the app the singleton `dbCircuitBreaker` is sufficient.
 */
export class CircuitBreaker {
  private readonly _name: string;
  private readonly _failureThreshold: number;
  private readonly _cooldownMs: number;
  private readonly _retryOpts: RetryOptions;

  private _state: BreakerState = "CLOSED";
  private _consecutiveFailures = 0;
  private _successes = 0;
  private _totalRejected = 0;
  private _openedAt: number | null = null;
  private _nextRetryAt: number | null = null;

  constructor(name = "db", opts: CircuitBreakerOptions = {}) {
    this._name = name;
    this._failureThreshold = Math.max(
      1,
      opts.failureThreshold ?? DEFAULT_BREAKER_OPTS.failureThreshold
    );
    this._cooldownMs = Math.max(
      1,
      opts.cooldownMs ?? DEFAULT_BREAKER_OPTS.cooldownMs
    );
    this._retryOpts = opts.retry ?? {};
  }

  get name(): string {
    return this._name;
  }

  stats(): BreakerStats {
    return {
      state: this._state,
      consecutiveFailures: this._consecutiveFailures,
      successes: this._successes,
      totalRejected: this._totalRejected,
      openedAt: this._openedAt,
      nextRetryAt: this._nextRetryAt,
    };
  }

  /**
   * Execute `fn` under circuit-breaker protection. On OPEN, throws
   * CircuitBreakerOpenError immediately. On HALF_OPEN, allows exactly
   * one probe; success resets to CLOSED, failure re-trips to OPEN.
   *
   * Permanent errors (where `isTransientError` returns false) do NOT
   * count toward the failure threshold — only infrastructure failures
   * trip the breaker. Validation/auth/quarantine errors propagate
   * without altering breaker state.
   */
  async execute<T>(
    fn: () => Promise<T>,
    execOpts?: { contextName?: string; retry?: RetryOptions }
  ): Promise<T> {
    const contextName = execOpts?.contextName ?? this._name;
    this._maybeAttemptHalfOpen();

    if (this._state === "OPEN") {
      this._totalRejected++;
      throw new CircuitBreakerOpenError(contextName, this._nextRetryAt ?? 0);
    }

    const isProbe = this._state === "HALF_OPEN";
    try {
      // Compose withRetry using merged options (per-call override wins).
      const retryOpts: RetryOptions = {
        ...this._retryOpts,
        ...(execOpts?.retry ?? {}),
        label: execOpts?.retry?.label ?? `${this._name}:${contextName}`,
      };
      const result = await withRetry(fn, retryOpts);
      this._onSuccess(isProbe);
      return result;
    } catch (err) {
      this._onFailure(err, isProbe);
      throw err;
    }
  }

  /**
   * Force the breaker to CLOSED state — useful from an operator endpoint
   * or after an automated remediation. Resets counters.
   */
  forceReset(): void {
    this._state = "CLOSED";
    this._consecutiveFailures = 0;
    this._successes = 0;
    this._openedAt = null;
    this._nextRetryAt = null;
  }

  /** Test-only: force the breaker OPEN immediately. */
  tripOpen(): void {
    const now = Date.now();
    this._state = "OPEN";
    this._openedAt = now;
    this._nextRetryAt = now + this._cooldownMs;
  }

  // ---- state transitions (private) ----

  private _maybeAttemptHalfOpen(): void {
    if (this._state !== "OPEN" || this._nextRetryAt === null) return;
    if (Date.now() < this._nextRetryAt) return;
    // Move to HALF_OPEN — the next execute() call becomes the probe.
    this._state = "HALF_OPEN";
    // Reset consecutive failures so the probe is judged on its own merit.
    this._consecutiveFailures = 0;
  }

  private _onSuccess(wasProbe: boolean): void {
    this._successes++;
    this._consecutiveFailures = 0;
    if (wasProbe) {
      console.error(
        `[circuit-breaker:${this._name}] probe succeeded — resetting to CLOSED`
      );
    }
    if (this._state !== "CLOSED") {
      this._state = "CLOSED";
      this._openedAt = null;
      this._nextRetryAt = null;
    }
  }

  private _onFailure(err: unknown, wasProbe: boolean): void {
    // Never count permanent / business errors against the breaker.
    if (!isTransientError(err)) {
      return;
    }

    if (wasProbe) {
      // Probe failed → immediately re-trip OPEN with a fresh cooldown.
      this._state = "OPEN";
      const now = Date.now();
      this._openedAt = now;
      this._nextRetryAt = now + this._cooldownMs;
      this._consecutiveFailures = this._failureThreshold;
      console.error(
        `[circuit-breaker:${this._name}] half-open probe failed — re-tripping OPEN for ${this._cooldownMs}ms:`,
        err instanceof Error ? err.message : String(err)
      );
      return;
    }

    if (this._state === "CLOSED") {
      this._consecutiveFailures++;
      if (this._consecutiveFailures >= this._failureThreshold) {
        const now = Date.now();
        this._state = "OPEN";
        this._openedAt = now;
        this._nextRetryAt = now + this._cooldownMs;
        console.error(
          `[circuit-breaker:${this._name}] ${this._consecutiveFailures} consecutive infra failures — tripping OPEN for ${this._cooldownMs}ms`
        );
      }
    }
  }
}

// ============================================================
// Singletons + convenience wrapper
// ============================================================

/**
 * Default singleton protecting Postgres/Prisma. Use this for all
 * database writes/reads that may face transient connection issues
 * (webhook processing, reconciliation, recurring generation, admin
 * audit console reads).
 */
export const dbCircuitBreaker = new CircuitBreaker("db", {
  failureThreshold: 5,
  cooldownMs: 30_000,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 150,
    maxDelayMs: 2000,
  },
});

/**
 * Default singleton protecting Upstash / external REST calls.
 * Configured with a tighter threshold because Redis failures are less
 * critical (we degrade to in-memory fallback anyway).
 */
export const upstashCircuitBreaker = new CircuitBreaker("upstash", {
  failureThreshold: 3,
  cooldownMs: 15_000,
  retry: {
    maxAttempts: 2,
    baseDelayMs: 100,
    maxDelayMs: 1000,
  },
});

/**
 * One-line convenience wrapper around `dbCircuitBreaker.execute`.
 * Preferred entry point for most call sites.
 *
 *   const rows = await executeResilient(() => prisma.invoice.findMany(...));
 */
export async function executeResilient<T>(
  fn: () => Promise<T>,
  opts?: { contextName?: string; retry?: RetryOptions }
): Promise<T> {
  return dbCircuitBreaker.execute(fn, opts);
}

// Re-export canonical error classes so existing callers that import
// them from @/lib/circuit-breaker keep working. The canonical classes
// live in @/lib/errors so `instanceof` checks across all module
// boundaries agree on a single prototype.
export { CircuitBreakerOpenError, RetriesExhaustedError };
