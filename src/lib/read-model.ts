/**
 * CQRS Read Model — Redis-backed projection of `TenantAuditOverview`.
 *
 * The dashboard UI (src/app/(dashboard)/admin/ledger) reads the
 * HealthBanner + metric grid from this module rather than hitting
 * Postgres directly. The projection is a single JSON blob per tenant:
 *
 *     key:  rm:overview:<tenantId>
 *     val:  JSON-serialized TenantAuditOverview (all paise as strings,
 *           same wire shape previously returned by getTenantAuditOverview)
 *     TTL:  1 hour (wall-clock safety if the Temporal invalidation path
 *           somehow misses a write; primary invalidation is explicit)
 *
 * Cache policy:
 *   - Cache-first: Redis GET on every read.
 *   - On miss, transparently COMPUTE from Postgres
 *     (computeTenantAuditOverview), write back to Redis, return.
 *   - On Redis connectivity failure, degrade gracefully to Postgres
 *     (no UI outage; slightly higher latency).
 *   - Single-flight (in-flight Promise map): concurrent requests for
 *     the same tenantId that miss Redis together all await a SINGLE
 *     Postgres computation. Prevents cache stampedes / thundering
 *     herd after a TTL expiry or Redis blip. Single-flight is scoped
 *     per Node process; in serverless runtimes cross-instance
 *     stampedes are blunted by Redis itself being the hot path.
 *   - Cache invalidation is STRICTLY driven by Temporal workflows:
 *     every workflow that mutates the ledger calls the
 *     `refreshTenantReadModel` activity to recompute + overwrite Redis.
 *     The edge/webhook path NEVER writes to Redis directly.
 *
 * This module is `server-only`; imported by RSCs and the Temporal
 * worker. Never imported from client code.
 */
import "server-only";

import { Redis } from "@upstash/redis";
import { prisma } from "@/lib/prisma";
import { withTenant } from "@/lib/tenant";
import { env } from "@/env";
import type { TenantAuditOverview as TenantAuditOverviewShape } from "@/app/(dashboard)/admin/ledger/actions";

export type TenantAuditOverview = TenantAuditOverviewShape;

// ---------------------------------------------------------------------------
// Redis singleton
// ---------------------------------------------------------------------------

const READ_MODEL_TTL_SECONDS = 60 * 60; // 1h safety TTL
const KEY_PREFIX = "rm:overview:";

let _redis: Redis | null = null;
let _redisWarned = false;

function getRedis(): Redis | null {
  if (typeof process === "undefined") return null;
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (!_redisWarned) {
      _redisWarned = true;
      console.error(
        "[read-model] UPSTASH_REDIS_REST_URL/TOKEN not set — read-model cache disabled; falling through to Postgres."
      );
    }
    return null;
  }
  if (_redis) return _redis;
  _redis = new Redis({ url, token });
  return _redis;
}

function overviewKey(tenantId: string): string {
  return `${KEY_PREFIX}${tenantId}`;
}

// ---------------------------------------------------------------------------
// Single-flight in-flight map (cache stampede defense)
//
// When a Redis miss occurs, we insert a Promise into this map keyed by
// tenantId. Any subsequent concurrent read for the same tenantId while
// that Promise is pending awaits the SAME promise instead of spawning a
// duplicate Postgres aggregation. When the promise settles (success or
// failure), we delete it from the map so the NEXT miss recomputes fresh
// — this is critical after an error: a transient Postgres blip must not
// cache a rejected Promise forever.
//
// Process-scoped is intentional (see header comment): cross-process
// stampedes are absorbed by Redis being hot; single-flight only needs
// to collapse concurrent requests within an instance.
// ---------------------------------------------------------------------------
const inFlight: Map<string, Promise<TenantAuditOverview>> = new Map();

// ---------------------------------------------------------------------------
// Compute: authoritative Postgres aggregation (single source of truth)
//
// Auth is enforced by callers (the RSC query and the Temporal activity
// always pass a validated tenant id). This function runs under
// withTenant(uid, ..., { allowQuarantinedRead: true }) so quarantined
// tenants can still read their diagnostic dashboard.
// ---------------------------------------------------------------------------

const DEFAULT_CURRENCY = "INR";

export async function computeTenantAuditOverview(
  uid: string
): Promise<TenantAuditOverview> {
  return withTenant(
    uid,
    async (tx) => {
      const u = await tx.user.findUnique({
        where: { id: uid },
        select: {
          id: true,
          email: true,
          lastLedgerEntryHash: true,
          lastLedgerEntryId: true,
          ledgerQuarantinedAt: true,
          ledgerQuarantineReason: true,
          lastReconciledAt: true,
        },
      });
      if (!u) {
        throw new Error(`computeTenantAuditOverview: tenant ${uid} not found`);
      }

      const settings = await tx.settings.findUnique({
        where: { userId: uid },
        select: { currency: true },
      });
      const currency = settings?.currency || DEFAULT_CURRENCY;

      const latest = await tx.reconciliationAudit.findFirst({
        where: { tenantId: uid },
        orderBy: { startedAt: "desc" },
      });

      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recent = await tx.reconciliationAudit.findMany({
        where: { tenantId: uid, startedAt: { gte: since } },
        select: { status: true },
      });
      const counts = { passed: 0, driftDetected: 0, hashBroken: 0, transientFailure: 0 };
      for (const r of recent) {
        switch (r.status) {
          case "PASSED": counts.passed++; break;
          case "DRIFT_DETECTED": counts.driftDetected++; break;
          case "HASH_BROKEN": counts.hashBroken++; break;
          case "TRANSIENT_FAILURE": counts.transientFailure++; break;
        }
      }

      const invAgg = await tx.$queryRaw<Array<{ status: string; total_paise: string }>>`
        SELECT status,
               COALESCE(SUM(ROUND("totalAmount"::numeric * 100)), 0)::text AS total_paise
        FROM invoices WHERE "userId" = ${uid}
        GROUP BY status
      `;
      let openReceivable = BigInt(0);
      let paidInvoiceTotal = BigInt(0);
      for (const r of invAgg) {
        const v = BigInt(r.total_paise);
        if (r.status === "PENDING") openReceivable += v;
        else if (r.status === "PAID") paidInvoiceTotal += v;
      }

      const expAgg = await tx.$queryRaw<Array<{ total_paise: string }>>`
        SELECT COALESCE(SUM(ROUND((amount::numeric * 100))), 0)::text AS total_paise
        FROM expenses WHERE "userId" = ${uid}
      `;
      const expenseTotal = BigInt(expAgg[0]?.total_paise ?? "0");

      const ledgerRows = await tx.$queryRaw<Array<{ account: string; signed_balance: string }>>`
        SELECT account,
          COALESCE(SUM(CASE
            WHEN side='DEBIT'  THEN "amountPaise"::numeric
            WHEN side='CREDIT' THEN -"amountPaise"::numeric
            ELSE 0 END), 0)::text AS signed_balance
        FROM ledger_entries WHERE "userId" = ${uid} GROUP BY account
      `;
      const ledger: Record<string, bigint> = {};
      for (const r of ledgerRows) ledger[r.account] = BigInt(r.signed_balance);
      const ar = ledger.ACCOUNTS_RECEIVABLE ?? BigInt(0);
      const cash = ledger.CASH ?? BigInt(0);

      const cashEvtRows = await tx.$queryRaw<Array<{ signed_balance: string }>>`
        SELECT COALESCE(SUM(CASE
                 WHEN side='DEBIT'  THEN "amountPaise"::numeric
                 WHEN side='CREDIT' THEN -"amountPaise"::numeric
                 ELSE 0 END), 0)::text AS signed_balance
        FROM ledger_entries
        WHERE "userId" = ${uid}
          AND account = 'CASH'
          AND "eventType" IN ('INVOICE_PAID'::"LedgerEventType",
                              'PAYMENT_REVERSED'::"LedgerEventType",
                              'EXPENSE_RECORDED'::"LedgerEventType",
                              'INVOICE_VOIDED'::"LedgerEventType")
      `;
      const expectedCash = BigInt(cashEvtRows[0]?.signed_balance ?? "0");

      const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

      return {
        tenantId: u.id,
        tenantEmail: u.email,
        lastLedgerEntryHash: u.lastLedgerEntryHash,
        lastLedgerEntryId: u.lastLedgerEntryId,
        ledgerQuarantinedAt: iso(u.ledgerQuarantinedAt),
        ledgerQuarantineReason: u.ledgerQuarantineReason,
        lastReconciledAt: iso(u.lastReconciledAt),
        latestAudit: latest ? serializeAudit(latest) : null,
        runCounts: counts,
        openReceivablePaise: openReceivable.toString(),
        ledgerArPaise: ar.toString(),
        ledgerCashPaise: cash.toString(),
        paidTotalPaise: paidInvoiceTotal.toString(),
        expenseTotalPaise: expenseTotal.toString(),
        expectedCashPaise: expectedCash.toString(),
        currency,
      } satisfies TenantAuditOverview;
    },
    { allowQuarantinedRead: true }
  );
}

// ---------------------------------------------------------------------------
// Redis write primitives (used by the Temporal invalidation activity)
// ---------------------------------------------------------------------------

export async function writeTenantOverview(
  tenantId: string,
  overview: TenantAuditOverview
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(overviewKey(tenantId), JSON.stringify(overview), {
      ex: READ_MODEL_TTL_SECONDS,
    });
  } catch (err) {
    // Never let a Redis failure bubble up past a Temporal activity
    // after the business write has already succeeded — log and move on.
    // Redis is a latency optimization; read-through recompute preserves
    // correctness.
    console.error(
      `[read-model] writeTenantOverview failed for tenant ${tenantId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

export async function invalidateTenantOverview(tenantId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(overviewKey(tenantId));
  } catch (err) {
    console.error(
      `[read-model] invalidateTenantOverview failed for tenant ${tenantId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

// ---------------------------------------------------------------------------
// Public read: cache-first, single-flight compute-on-miss, Redis fallback
// ---------------------------------------------------------------------------

export async function getTenantOverview(
  tenantId: string
): Promise<TenantAuditOverview> {
  const redis = getRedis();

  // --- Cache hit path ---
  if (redis) {
    try {
      const cached = await redis.get<TenantAuditOverview>(overviewKey(tenantId));
      if (cached && typeof cached === "object" && "tenantId" in cached) {
        return cached as TenantAuditOverview;
      }
    } catch (err) {
      // Redis outage → fall through to Postgres.
      console.error(
        `[read-model] Redis GET failed for tenant ${tenantId} — recomputing from Postgres:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // --- Cache miss / Redis down: single-flight compute ---
  const existing = inFlight.get(tenantId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const fresh = await computeTenantAuditOverview(tenantId);
      // Best-effort repopulate; swallow failures.
      if (redis) {
        await writeTenantOverview(tenantId, fresh);
      }
      return fresh;
    } finally {
      // Always drop the in-flight record when done, whether we
      // succeeded or failed — a rejected promise must not poison future
      // reads (the next caller should retry Postgres).
      inFlight.delete(tenantId);
    }
  })();

  inFlight.set(tenantId, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Audit serializer (avoids circular import with actions.ts)
// ---------------------------------------------------------------------------

type Disc = NonNullable<TenantAuditOverview["latestAudit"]>["discrepancies"][number];

interface RawAuditLike {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  status: string;
  entriesScanned: number;
  firstBrokenIndex: number | null;
  discrepancies: unknown;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  infoCount: number;
  autoRemediated: boolean;
  workerId: string | null;
  version: string;
}

function serializeAudit(
  a: RawAuditLike
): NonNullable<TenantAuditOverview["latestAudit"]> {
  let discrepancies: Disc[] = [];
  if (Array.isArray(a.discrepancies)) {
    discrepancies = (a.discrepancies as unknown[]).map((d) => {
      const obj = d && typeof d === "object" ? (d as Record<string, unknown>) : {};
      const sev = obj.severity;
      return {
        kind: typeof obj.kind === "string" ? obj.kind : "UNKNOWN",
        severity:
          sev === "CRITICAL" || sev === "HIGH" || sev === "MEDIUM" || sev === "INFO"
            ? sev
            : "INFO",
        account: typeof obj.account === "string" ? obj.account : undefined,
        expectedPaise: typeof obj.expectedPaise === "string" ? obj.expectedPaise : undefined,
        actualPaise: typeof obj.actualPaise === "string" ? obj.actualPaise : undefined,
        diffPaise: typeof obj.diffPaise === "string" ? obj.diffPaise : undefined,
        detail: typeof obj.detail === "string" ? obj.detail : undefined,
      } satisfies Disc;
    });
  }
  type Audit = NonNullable<TenantAuditOverview["latestAudit"]>;
  return {
    id: a.id,
    startedAt: a.startedAt.toISOString(),
    finishedAt: a.finishedAt ? a.finishedAt.toISOString() : null,
    durationMs: a.durationMs,
    status: a.status as Audit["status"],
    entriesScanned: a.entriesScanned,
    firstBrokenIndex: a.firstBrokenIndex,
    discrepancies,
    criticalCount: a.criticalCount,
    highCount: a.highCount,
    mediumCount: a.mediumCount,
    infoCount: a.infoCount,
    autoRemediated: a.autoRemediated,
    workerId: a.workerId,
    version: a.version,
  };
}
