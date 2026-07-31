/**
 * Read-Only Disaster Recovery / Maintenance Mode.
 *
 * When `SMARTBILL_READ_ONLY` is set to `"1"` or `"true"` (case-insensitive,
 * trimmed), the entire application enters a read-only posture:
 *
 *   - Admin Server Action mutations are rejected *before* any rate-limit
 *     check or DB write, returning a user-friendly error surfaced via the
 *     existing Sonner toast.
 *   - Webhook cron workers short-circuit with HTTP 503 + Retry-After: 60,
 *     leaving rows in PENDING without consuming attempts (upstream
 *     providers will redeliver; we do not poison the queue during DR).
 *   - The reconciler produces TRANSIENT_FAILURE audit rows and skips
 *     quarantine flips, auto-backfills, and alert spam so that a read
 *     replica / failover window does not falsely mark tenants as broken.
 *
 * This module is ZERO DEPENDENCY and SERVER-ONLY (it reads process.env
 * directly). Importing it on the client is fine — the helper functions
 * are pure and only touch process.env on the server.
 */

import "server-only";

import { ReadOnlyModeError } from "./errors";

// Re-export the canonical ReadOnlyModeError so existing callers that
// `import { ReadOnlyModeError } from "@/lib/dr-mode"` keep working. The
// canonical class lives in @/lib/errors so instanceof checks across
// modules (reconciler, webhooks, mutations) agree on a single prototype.
// A class export covers both value and type positions; no separate
// `export type` is needed (it would collide under isolatedModules).
export { ReadOnlyModeError };

// ============================================================
// Internal helpers
// ============================================================

/**
 * Canonical truth value of SMARTBILL_READ_ONLY. We accept "1" or "true"
 * (case-insensitive, trimmed) to align with common container / PaaS
 * convention for boolean env flags. Anything else (unset, "0", "false",
 * arbitrary strings) is treated as read-write to avoid accidental
 * activation by a stray non-empty value.
 */
export function isReadOnlyMode(): boolean {
  const raw = process.env.SMARTBILL_READ_ONLY;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Retry-After value (seconds) used for HTTP 503 responses while DR. */
export const READ_ONLY_RETRY_AFTER_SECONDS = 60;

/**
 * Assert that the process is in read-write mode. If in read-only mode,
 * throws ReadOnlyModeError synchronously (no DB calls, no async work,
 * so we fail fast before rate-limit / auth / any DB operation that
 * would be wasted).
 */
export function assertReadWriteMode(opName?: string): void {
  if (isReadOnlyMode()) {
    throw new ReadOnlyModeError(opName);
  }
}
