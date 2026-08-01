/**
 * Canonical domain-error classes for SmartBill.
 *
 * Every custom error thrown across the ledger/tenant/reconciler/circuit-
 * breaker/DR-mode/rate-limiter/service-context layers lives here so that:
 *
 *   1. `instanceof` checks work reliably across module boundaries. When
 *      two files define a class with the same name independently, Node/
 *      Next treats them as distinct prototypes — `err instanceof
 *      LedgerQuarantinedError` silently returns false in any module that
 *      imported the wrong copy. Centralising the classes eliminates
 *      that latent hazard.
 *   2. Error names are set in one place (and fixed up via
 *      Object.setPrototypeOf for Node/CJS cross-realm safety — this is
 *      the standard pattern recommended by TypeScript and used by
 *      libraries like @prisma/client).
 *   3. Tests, Server Actions, cron workers, and API route handlers all
 *      import the same constructors, so `instanceof` checks in test
 *      assertions and webhook-worker catch blocks are trustworthy.
 *
 * All errors are plain ES2022 `Error` subclasses with a stable `name`
 * field and carry domain-specific readonly metadata (userId, retryAfterMs,
 * etc.) on the instance so callers can branch on structured data rather
 * than string-matching messages.
 *
 * Naming convention: every error class carries the `Error` suffix
 * (e.g. `LedgerQuarantinedError`, `ReadOnlyModeError`,
 * `RateLimitExceededError`). The suffix is omitted from the `name`
 * string only where a stable wire/log identifier would otherwise change
 * — here we keep them aligned (name === class name) for consistency.
 */

// ---------------------------------------------------------------------------
// Ledger / tenant errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a mutating call is attempted against a quarantined tenant.
 *
 * The Postgres `ledger_quarantine_guard()` trigger raises SQLSTATE L0001
 * as a defense-in-depth third line; the application layer (withTenant,
 * postLedgerEvent, reconciler) throws this synchronously before acquiring
 * the advisory lock so we don't waste a DB round-trip on a blocked write.
 *
 * Reads (withTenant({ allowQuarantinedRead: true })) are permitted so
 * operators can diagnose the tenant; writes are refused.
 */
export class LedgerQuarantinedError extends Error {
  public readonly userId: string;
  public readonly reason: string | null;
  constructor(userId: string, reason: string | null) {
    super(
      `Ledger quarantined for tenant ${userId} (reason=${reason ?? "unspecified"}). Writes blocked.`
    );
    this.name = "LedgerQuarantinedError";
    this.userId = userId;
    this.reason = reason;
    Object.setPrototypeOf(this, LedgerQuarantinedError.prototype);
  }
}

/**
 * Thrown when a tenant-isolation invariant is violated (e.g. a missing
 * userId on a tenanted call, a SET LOCAL app.current_user_id mismatch,
 * or a `where` clause missing the tenant predicate). These are always
 * programmer errors — never user-facing — and must be logged loudly.
 */
export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantIsolationError";
    Object.setPrototypeOf(this, TenantIsolationError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Service / infrastructure errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the withService() context is misused (invalid service name,
 * nested SET LOCAL ROLE mismatch, etc.). Programmer error.
 */
export class ServiceContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceContextError";
    Object.setPrototypeOf(this, ServiceContextError.prototype);
  }
}

/**
 * Thrown immediately (no network call) when the circuit breaker is OPEN
 * and callers invoke `executeResilient()`. Operators/route handlers
 * should catch this and return HTTP 503 / a fail-fast UI state rather
 * than hammering a backend known to be unhealthy.
 */
export class CircuitBreakerOpenError extends Error {
  public readonly contextName: string;
  public readonly nextRetryAt: number;
  constructor(contextName: string, nextRetryAt: number) {
    super(
      "Database circuit breaker is OPEN — fast-failing to protect infrastructure"
    );
    this.name = "CircuitBreakerOpenError";
    this.contextName = contextName;
    this.nextRetryAt = nextRetryAt;
    Object.setPrototypeOf(this, CircuitBreakerOpenError.prototype);
  }
}

/**
 * Thrown when `withRetry()` exhausts all attempts. The `.cause` property
 * (ES2022) holds the last underlying error so callers / logs can
 * inspect the real failure.
 */
export class RetriesExhaustedError extends Error {
  public readonly attempts: number;
  public override readonly cause: unknown;
  constructor(attempts: number, cause: unknown) {
    super(`Retry exhausted after ${attempts} attempts`);
    this.name = "RetriesExhaustedError";
    this.attempts = attempts;
    this.cause = cause;
    Object.setPrototypeOf(this, RetriesExhaustedError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Operational / disaster-recovery errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a write-path is invoked while SMARTBILL_READ_ONLY is
 * active. Callers (Server Actions, cron routes) should catch this and
 * translate to either a user-facing error message (mutations) or an
 * HTTP 503 + Retry-After (webhook / API workers).
 */
export class ReadOnlyModeError extends Error {
  public readonly operation: string;
  constructor(operationName?: string) {
    super(
      "SmartBill is currently in Read-Only Mode for scheduled maintenance or disaster recovery. Writes will resume shortly."
    );
    this.name = "ReadOnlyModeError";
    this.operation = operationName ?? "unknown";
    Object.setPrototypeOf(this, ReadOnlyModeError.prototype);
  }
}

/**
 * Thrown by `assertRateLimit()` when the caller has exhausted their
 * budget for the configured window. HTTP handlers can call
 * `rl.toResponse()` on the accompanying RateLimitResult for a
 * standards-compliant 429; Server Actions can surface `err.message`
 * to Sonner.
 *
 * Renamed from `RateLimitExceeded` → `RateLimitExceededError` to align
 * with the `*Error` suffix used by every other class in this module.
 */
export class RateLimitExceededError extends Error {
  public readonly retryAfterMs: number;
  public readonly limit: number;
  public readonly windowSec: number;
  constructor(message: string, retryAfterMs: number, limit: number, windowSec: number) {
    super(message);
    this.name = "RateLimitExceededError";
    this.retryAfterMs = retryAfterMs;
    this.limit = limit;
    this.windowSec = windowSec;
    Object.setPrototypeOf(this, RateLimitExceededError.prototype);
  }
}
