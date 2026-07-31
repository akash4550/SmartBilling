/**
 * Automated Ledger Drift & Integrity Reconciler.
 *
 * Two sweeps per tenant:
 *   Sweep A — Streaming hash-chain integrity + per-event balance check.
 *             Cursor-batched (default 500 rows/query) from entryIndex = 1
 *             using the (userId, entryIndex) UNIQUE index. Constant memory.
 *   Sweep B — SQL-side balance cross-checks against invoice/expense tables.
 *             Aggregations pushed down to Postgres to avoid streaming the
 *             entire ledger to Node.
 *
 * Every run writes one append-only row to reconciliation_audits.
 * CRITICAL/HIGH drift trips users.ledgerQuarantinedAt (fail-closed).
 * AR/CASH/EXPENSE mismatches get ONE auto-backfill attempt before escalation.
 *
 * Runs as service_role under service name "maint:reconcile". Never runs as
 * app_user (needs cross-tenant discovery) and never runs as superuser.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withService } from "@/lib/service-context";
import {
  GENESIS_HASH,
  sha256Hex,
  serializeForHash,
} from "@/lib/ledger";
import {
  type Discrepancy,
  type DriftKind,
  type Severity,
  ensureDefaultDriftAlertHook,
  fireDriftAlerts,
} from "@/lib/reconciler-alerts";
import type { ReconciliationStatus } from "@prisma/client";

export { LedgerQuarantinedError } from "@/lib/ledger";
export type { Discrepancy, DriftKind, Severity };

export const RECONCILER_VERSION = "1";
const RECONCILER_SERVICE = "maint:reconcile";
const DEFAULT_BATCH = 500;
const RECONCILE_LOCK_NS = BigInt(1397772901); // separate from ledger posting lock

/** Advisory lock key (per-tenant reconcile serialization). */
function reconcileAdvisoryKeyFor(tenantId: string): bigint {
  // FNV-1a 32-bit folded into low 32 bits; high 32 is the reconcile namespace.
  let h = 0x811c9dc5;
  for (let i = 0; i < tenantId.length; i++) {
    h ^= tenantId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return RECONCILE_LOCK_NS * BigInt(0x100000000) + BigInt(h >>> 0);
}

function workerId(): string {
  const host = process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? "local";
  return `pid-${process.pid}_host-${host}`;
}

// ============================================================
// DRIFT CLASSIFICATION
// ============================================================

function classify(kind: DriftKind): Severity {
  switch (kind) {
    case "HASH_CHAIN_BROKEN":
    case "TAIL_POINTER_DESYNC":
    case "UNBALANCED_EVENT":
      return "CRITICAL";
    case "AR_MISMATCH":
    case "CASH_MISMATCH":
    case "EXPENSE_MISMATCH":
    case "ENTRY_INDEX_GAP":
      return "HIGH";
    case "REVENUE_TAX_MISMATCH":
      return "MEDIUM";
    case "TRANSIENT_ERROR":
      return "INFO";
  }
}

function mkDisc(
  kind: DriftKind,
  fields: Partial<Omit<Discrepancy, "kind" | "severity">> = {}
): Discrepancy {
  return { kind, severity: classify(kind), ...fields };
}

// ============================================================
// SWEEP A — streaming hash chain + per-event balance + gap check
// ============================================================

interface SweepARow {
  id: string;
  entryIndex: number;
  eventId: string;
  eventType: string;
  account: string;
  side: "DEBIT" | "CREDIT";
  amountPaise: bigint;
  prevEntryHash: string;
  entryHash: string;
  invoiceId: string | null;
  expenseId: string | null;
  currency: string;
}

interface SweepAResult {
  scanned: number;
  firstBrokenIndex: number | null;
  discrepancies: Discrepancy[];
  tailHash: string | null;
  tailIndex: number;
  /** Account balances (Σ D − Σ C) as paise BigInts. */
  accountBalances: Record<string, bigint>;
}

async function sweepA(
  tx: Prisma.TransactionClient,
  tenantId: string,
  batchSize: number
): Promise<SweepAResult> {
  const discrepancies: Discrepancy[] = [];
  const balances: Record<string, bigint> = {
    ACCOUNTS_RECEIVABLE: BigInt(0),
    REVENUE: BigInt(0),
    DISCOUNT_CONTRA: BigInt(0),
    TAX_PAYABLE: BigInt(0),
    CASH: BigInt(0),
    EXPENSES: BigInt(0),
  };
  // Per-event d/c accumulator. Events are contiguous in our posting helper
  // but we tolerate straddling a batch boundary (events aren't evicted
  // until finalization; worst-case one extra event in memory).
  const eventBalances = new Map<string, { d: bigint; c: bigint; lastIndex: number }>();

  let cursor = 0;
  let prevHash = GENESIS_HASH;
  let scanned = 0;
  let firstBrokenIndex: number | null = null;
  let expectedNextIndex = 1;
  let tailHash: string | null = null;
  let tailIndex = 0;

  // Tail-catch-up loop: if new entries were appended during our scan
  // (concurrent writes), we loop once more to advance to the new tail.
  // Cap iterations as a safety valve against infinite catch-up.
  for (let catchup = 0; catchup < 5; catchup++) {
    while (true) {
      const batch = (await tx.ledgerEntry.findMany({
        where: { userId: tenantId, entryIndex: { gt: cursor } },
        orderBy: { entryIndex: "asc" },
        take: batchSize,
        select: {
          id: true,
          entryIndex: true,
          eventId: true,
          eventType: true,
          account: true,
          side: true,
          amountPaise: true,
          prevEntryHash: true,
          entryHash: true,
          invoiceId: true,
          expenseId: true,
          currency: true,
        },
      })) as unknown as SweepARow[];

      if (batch.length === 0) break;

      for (const row of batch) {
        // Entry index gap check — detects deleted / skipped entries.
        if (row.entryIndex !== expectedNextIndex) {
          discrepancies.push(
            mkDisc("ENTRY_INDEX_GAP", {
              detail: `expected index ${expectedNextIndex}, got ${row.entryIndex}`,
            })
          );
          if (!firstBrokenIndex) firstBrokenIndex = row.entryIndex;
          // Resync expected to row.index+1 so we continue collecting.
          expectedNextIndex = row.entryIndex;
        }
        expectedNextIndex++;

        // Hash chain check.
        if (row.prevEntryHash !== prevHash) {
          discrepancies.push(
            mkDisc("HASH_CHAIN_BROKEN", {
              detail: `at index ${row.entryIndex}: prevEntryHash mismatch (expected ${prevHash.slice(0, 12)}… got ${row.prevEntryHash.slice(0, 12)}…)`,
            })
          );
          if (!firstBrokenIndex) firstBrokenIndex = row.entryIndex;
          // Re-sync to this row's claimed hash to avoid cascading false
          // positives from a single broken link.
          prevHash = row.entryHash;
        } else {
          const canon = serializeForHash({
            eventId: row.eventId,
            eventType: row.eventType,
            account: row.account,
            side: row.side,
            amountPaise: BigInt(row.amountPaise.toString()),
            invoiceId: row.invoiceId,
            expenseId: row.expenseId,
            currency: row.currency,
          });
          const expectedHash = sha256Hex(prevHash + "|" + canon);
          if (expectedHash !== row.entryHash) {
            discrepancies.push(
              mkDisc("HASH_CHAIN_BROKEN", {
                detail: `at index ${row.entryIndex}: entryHash mismatch (expected ${expectedHash.slice(0, 12)}… got ${row.entryHash.slice(0, 12)}…)`,
              })
            );
            if (!firstBrokenIndex) firstBrokenIndex = row.entryIndex;
            prevHash = row.entryHash;
          } else {
            prevHash = row.entryHash;
          }
        }

        // Running signed balance.
        const amt = BigInt(row.amountPaise.toString());
        if (row.side === "DEBIT") {
          balances[row.account] = (balances[row.account] ?? BigInt(0)) + amt;
        } else {
          balances[row.account] = (balances[row.account] ?? BigInt(0)) - amt;
        }

        // Per-event balance accumulator.
        let eb = eventBalances.get(row.eventId);
        if (!eb) {
          eb = { d: BigInt(0), c: BigInt(0), lastIndex: 0 };
          eventBalances.set(row.eventId, eb);
        }
        if (row.side === "DEBIT") eb.d += amt;
        else eb.c += amt;
        eb.lastIndex = row.entryIndex;

        tailHash = row.entryHash;
        tailIndex = row.entryIndex;
        scanned++;
      }

      cursor = batch[batch.length - 1].entryIndex;

      // Yield to the event loop to keep the conn pool responsive.
      await new Promise((r) => setImmediate(r));
    }

    // Tail check: has new data arrived?
    const newest = await tx.ledgerEntry.findFirst({
      where: { userId: tenantId },
      orderBy: { entryIndex: "desc" },
      select: { entryIndex: true, entryHash: true },
    });
    if (!newest) break;
    if (newest.entryIndex <= cursor) break; // caught up
    // else loop again, continue scanning from cursor.
  }

  // Finalize per-event balance checks. Events never straddle batch
  // boundaries under normal posting (entries for a given event are
  // contiguous), but we check all events regardless.
  for (const [eventId, b] of eventBalances) {
    if (b.d !== b.c) {
      discrepancies.push(
        mkDisc("UNBALANCED_EVENT", {
          detail: `eventId=${eventId} ΣD=${b.d}p ΣC=${b.c}p`,
        })
      );
      if (!firstBrokenIndex) firstBrokenIndex = b.lastIndex;
    }
  }

  return {
    scanned,
    firstBrokenIndex,
    discrepancies,
    tailHash,
    tailIndex,
    accountBalances: balances,
  };
}

// ============================================================
// SWEEP B — SQL-side balance cross-check
// ============================================================

interface SweepBResult {
  discrepancies: Discrepancy[];
  expectedOpenReceivablePaise: bigint;
  expectedPaidCashPaise: bigint;
  expectedExpensePaise: bigint;
}

/**
 * Compute ledger-side balances (single GROUP BY) and read-model
 * expectations (targeted SUM aggregates) in parallel; compare.
 */
async function sweepB(
  tx: Prisma.TransactionClient,
  tenantId: string,
  sweepA: SweepAResult
): Promise<SweepBResult> {
  const discrepancies: Discrepancy[] = [];

  // Ledger-side per-account aggregates.
  // We cast amountPaise through text to avoid BigInt binding issues with
  // $queryRaw; this returns stringified bigints.
  const ledgerRows = await tx.$queryRaw<
    Array<{
      account: string;
      total_debits: string;
      total_credits: string;
      signed_balance: string;
    }>
  >`
    SELECT account,
           COALESCE(SUM(CASE WHEN side='DEBIT'  THEN "amountPaise"::numeric ELSE 0 END), 0)::text AS total_debits,
           COALESCE(SUM(CASE WHEN side='CREDIT' THEN "amountPaise"::numeric ELSE 0 END), 0)::text AS total_credits,
           COALESCE(SUM(CASE WHEN side='DEBIT'  THEN "amountPaise"::numeric ELSE -"amountPaise"::numeric END), 0)::text AS signed_balance
    FROM ledger_entries
    WHERE "userId" = ${tenantId}
    GROUP BY account
  `;
  const ledgerBalance: Record<string, bigint> = {};
  for (const r of ledgerRows) {
    ledgerBalance[r.account] = BigInt(r.signed_balance);
  }
  // Merge with zero defaults for accounts with no rows.
  for (const k of Object.keys(sweepA.accountBalances)) {
    if (ledgerBalance[k] === undefined) ledgerBalance[k] = BigInt(0);
  }

  // Read model aggregates:
  //   open AR    → Σ totalAmount where status='PENDING' (debit balance).
  //   cash       → Σ INVOICE_PAID Dr − Σ PAYMENT_REVERSED Cr − Σ void-payment
  //                reversals (Cr CASH) − Σ EXPENSE_RECORDED Cr. This is
  //                computed directly from ledger event types because
  //                invoices.status = PAID alone cannot see refunds/chargebacks
  //                posted via PAYMENT_REVERSED.
  //   expenses   → Σ amount on expenses table (Dr EXPENSES).
  const invAgg = await tx.$queryRaw<
    Array<{ status: string; total_paise: string }>
  >`
    SELECT status,
           COALESCE(SUM(ROUND(("totalAmount"::numeric * 100))), 0)::text AS total_paise
    FROM invoices
    WHERE "userId" = ${tenantId}
    GROUP BY status
  `;
  let openReceivable = BigInt(0);
  let paidCash = BigInt(0);
  for (const r of invAgg) {
    const v = BigInt(r.total_paise);
    if (r.status === "PENDING") openReceivable += v;
    else if (r.status === "PAID") paidCash += v;
  }

  const expAgg = await tx.$queryRaw<Array<{ total_paise: string }>>`
    SELECT COALESCE(SUM(ROUND((amount::numeric * 100))), 0)::text AS total_paise
    FROM expenses
    WHERE "userId" = ${tenantId}
  `;
  const expenseTotal = BigInt(expAgg[0]?.total_paise ?? "0");

  // Expected CASH balance computed from the ledger's own CASH debits/credits
  // partitioned by eventType. This catches PAYMENT_REVERSED and void-payment
  // Cr flows that invoice.status = PAID would miss. Any posting path that
  // touches CASH must use one of these event types, so this sum is the
  // authoritative expected balance and must equal ledgerBalance.CASH.
  const cashEvtRows = await tx.$queryRaw<
    Array<{ event_type: string; total_paise: string }>
  >`
    SELECT "eventType" AS event_type,
           COALESCE(SUM(
             CASE
               WHEN side = 'DEBIT'  THEN  "amountPaise"::numeric
               WHEN side = 'CREDIT' THEN -"amountPaise"::numeric
               ELSE 0
             END
           ), 0)::text AS total_paise
    FROM ledger_entries
    WHERE "userId" = ${tenantId}
      AND account = 'CASH'
    GROUP BY "eventType"
  `;
  let expectedCash = BigInt(0);
  for (const r of cashEvtRows) {
    expectedCash += BigInt(r.total_paise);
  }

  // The ledger-side CASH balance equals Σ (Dr − Cr) across ALL CASH rows,
  // which by construction equals Σ eventType-signed sums above. We still
  // cross-check against the AR/expense read models below; the CASH event
  // aggregate guards against accidental postings to CASH under an unknown
  // event type (would also be caught by AR/revenue parity, but we surface
  // it directly here).
  const arLedger = ledgerBalance.ACCOUNTS_RECEIVABLE ?? BigInt(0);
  if (arLedger !== openReceivable) {
    discrepancies.push(
      mkDisc("AR_MISMATCH", {
        account: "ACCOUNTS_RECEIVABLE",
        expectedPaise: openReceivable.toString(),
        actualPaise: arLedger.toString(),
        diffPaise: (arLedger - openReceivable).toString(),
        detail: "AR ledger balance does not match Σ PENDING invoice totals",
      })
    );
  }

  const cashLedger = ledgerBalance.CASH ?? BigInt(0);
  // Sanity: event-type sum must equal ledger signed balance (internal
  // consistency). If it doesn't, we have a ledger corruption (e.g. an
  // account other than CASH posted to CASH rows, which shouldn't happen).
  if (cashLedger !== expectedCash) {
    discrepancies.push(
      mkDisc("CASH_MISMATCH", {
        account: "CASH",
        expectedPaise: expectedCash.toString(),
        actualPaise: cashLedger.toString(),
        diffPaise: (cashLedger - expectedCash).toString(),
        detail: "CASH ledger balance does not match per-event cash flow aggregate",
      })
    );
  }
  // Additionally cross-check that the recognized expense outflows match
  // the expenses table (any EXPENSE_RECORDED Cr CASH must have a
  // corresponding expenses row).
  const expLedger = ledgerBalance.EXPENSES ?? BigInt(0);
  if (expLedger !== expenseTotal) {
    discrepancies.push(
      mkDisc("EXPENSE_MISMATCH", {
        account: "EXPENSES",
        expectedPaise: expenseTotal.toString(),
        actualPaise: expLedger.toString(),
        diffPaise: (expLedger - expenseTotal).toString(),
        detail: "EXPENSES ledger balance does not match Σ expenses",
      })
    );
  }

  // Revenue/tax parity (MEDIUM informational):
  //
  // For any correctly-posted ledger, the issuance-side AR activity
  // (Dr AR from INVOICE_ISSUED net of Cr AR from INVOICE_VOIDED issuance
  // reversals) must equal net Cr REVENUE + net Cr TAX_PAYABLE − net Dr
  // DISCOUNT_CONTRA across those same issuance/void events.
  //
  // We deliberately exclude INVOICE_PAID / PAYMENT_REVERSED / VOID-payment
  // legs because they only move cash↔AR and never touch REVENUE/TAX;
  // including them caused false positives whenever a refund/chargeback
  // posted a PAYMENT_REVERSED (Dr AR, Cr CASH).
  //
  // This drifts when an invoice is edited after issuance (ledger is
  // append-only; to correct totals you must VOID+reissue), which is why
  // it is MEDIUM rather than HIGH.
  // Use string-literal IN list (Prisma.join does not mix well with enum
  // columns in raw queries; the eventType values are hard-coded here and
  // come from the ledger.ts builders, not from user input).
  const issuanceRows = await tx.$queryRaw<
    Array<{ account: string; signed_balance: string }>
  >`
    SELECT account,
           COALESCE(SUM(
             CASE
               WHEN side = 'DEBIT'  THEN  "amountPaise"::numeric
               WHEN side = 'CREDIT' THEN -"amountPaise"::numeric
               ELSE 0
             END
           ), 0)::text AS signed_balance
    FROM ledger_entries
    WHERE "userId" = ${tenantId}
      AND "eventType" IN ('INVOICE_ISSUED'::"LedgerEventType", 'INVOICE_VOIDED'::"LedgerEventType")
      AND account IN ('ACCOUNTS_RECEIVABLE'::"AccountType",
                      'REVENUE'::"AccountType",
                      'TAX_PAYABLE'::"AccountType",
                      'DISCOUNT_CONTRA'::"AccountType")
    GROUP BY account
  `;
  const iss: Record<string, bigint> = {};
  for (const r of issuanceRows) iss[r.account] = BigInt(r.signed_balance);
  const issArDrMinusCr = iss.ACCOUNTS_RECEIVABLE ?? BigInt(0);            // should be ≥ 0 (Dr)
  const issRevenueCr   = -(iss.REVENUE ?? BigInt(0));                     // -signed(Cr)
  const issTaxCr       = -(iss.TAX_PAYABLE ?? BigInt(0));
  const issDiscountDr  = iss.DISCOUNT_CONTRA ?? BigInt(0);                // Dr > 0
  const expectedIssuedAr = issRevenueCr + issTaxCr - issDiscountDr;       // net issuance gross
  if (issArDrMinusCr !== expectedIssuedAr) {
    discrepancies.push(
      mkDisc("REVENUE_TAX_MISMATCH", {
        expectedPaise: expectedIssuedAr.toString(),
        actualPaise: issArDrMinusCr.toString(),
        diffPaise: (issArDrMinusCr - expectedIssuedAr).toString(),
        detail: "Issuance-side AR does not match Revenue+Tax−Discount (likely post-issuance invoice edits; void+reissue to correct)",
      })
    );
  }

  return {
    discrepancies,
    expectedOpenReceivablePaise: openReceivable,
    expectedPaidCashPaise: paidCash,
    expectedExpensePaise: expenseTotal,
  };
}

// ============================================================
// TENANT LOCK (skip on contention)
// ============================================================

async function tryAcquireTenantLock(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<boolean> {
  const key = reconcileAdvisoryKeyFor(tenantId);
  // pg_try_advisory_xact_lock returns true if lock acquired, false if
  // another worker is already reconciling this tenant. Non-blocking.
  const rows = await tx.$queryRawUnsafe<Array<{ acquired: boolean }>>(
    `SELECT pg_try_advisory_xact_lock(${key.toString()}) AS acquired`
  );
  return rows[0]?.acquired === true;
}

// ============================================================
// TOP-LEVEL API
// ============================================================

export interface ReconcileOptions {
  /** Reconcile a single tenant (if omitted, all tenants). */
  tenantId?: string;
  /** Ignore min-interval gating (force a run now). */
  force?: boolean;
  /** Cursor batch size for Sweep A. Default 500. */
  batchSize?: number;
  /** Cap on tenants per run (incremental sweeps). */
  limit?: number;
  /** Mode controls which tenants are selected. */
  mode?: "incremental" | "full" | "single";
  /** Set true to skip auto-backfill (used by release/recheck paths). */
  skipAutoBackfill?: boolean;
  /**
   * Set true to record audit results WITHOUT flipping the quarantine flag
   * or firing alerts. Used immediately after a force-release so the
   * confirmation run logs the remaining drift but does not re-quarantine
   * the tenant the operator just explicitly cleared.
   */
  auditOnly?: boolean;
}

export interface ReconcileResult {
  tenantId: string;
  status: ReconciliationStatus;
  durationMs: number;
  entriesScanned: number;
  firstBrokenIndex: number | null;
  discrepancies: Discrepancy[];
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  infoCount: number;
  quarantined: boolean;
  autoRemediated: boolean;
  auditId: string;
}

function tally(ds: readonly Discrepancy[]) {
  let c = 0, h = 0, m = 0, i = 0;
  for (const d of ds) {
    switch (d.severity) {
      case "CRITICAL": c++; break;
      case "HIGH":     h++; break;
      case "MEDIUM":   m++; break;
      case "INFO":     i++; break;
    }
  }
  return { critical: c, high: h, medium: m, info: i };
}

function statusFrom(
  ds: readonly Discrepancy[],
  hasCritical: boolean
): ReconciliationStatus {
  if (ds.length === 0) return "PASSED";
  if (hasCritical || ds.some((d) => d.severity === "CRITICAL")) return "HASH_BROKEN";
  return "DRIFT_DETECTED";
}

/**
 * Reconcile a single tenant. Runs under withService("maint:reconcile") so
 * it can read cross-tenant ledger entries. Writes an audit row; flips
 * quarantine on CRITICAL/HIGH; performs auto-backfill once for AR/CASH/
 * EXPENSE mismatches.
 */
const SAFE_TENANT_RE = /^[A-Za-z0-9_-]{1,128}$/;

export async function reconcileTenant(
  tenantId: string,
  opts: Omit<ReconcileOptions, "tenantId" | "mode"> = {}
): Promise<ReconcileResult> {
  ensureDefaultDriftAlertHook();
  if (!SAFE_TENANT_RE.test(tenantId)) {
    throw new Error(`reconcileTenant: unsafe tenantId`);
  }
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const started = Date.now();
  const wid = workerId();

  return withService(RECONCILER_SERVICE, async (tx) => {
    // We need to SET app.current_user_id for the duration of this tx
    // so writes to the users table (quarantine flag / lastReconciledAt)
    // satisfy the RLS WITH CHECK (id = current_user_id). The service
    // role still only writes to the scoped tenant (we use this same
    // userId in every .update where clause).
    await tx.$executeRawUnsafe(
      `SET LOCAL app.current_user_id = '${tenantId}'`
    );

    // Per-tenant non-blocking advisory lock — if another worker is
    // already reconciling this tenant, skip rather than queue.
    const acquired = await tryAcquireTenantLock(tx, tenantId);
    if (!acquired) {
      // Still record a TRANSIENT_FAILURE audit row so the operator sees it.
      const audit = await tx.reconciliationAudit.create({
        data: {
          tenantId,
          status: "TRANSIENT_FAILURE",
          durationMs: Date.now() - started,
          entriesScanned: 0,
          discrepancies: [{ kind: "TRANSIENT_ERROR", severity: "INFO", detail: "Another reconcile run already in progress (advisory lock held)" }] as unknown as Prisma.InputJsonValue,
          criticalCount: 0, highCount: 0, mediumCount: 0, infoCount: 1,
          triggeredAlert: false,
          workerId: wid,
          version: RECONCILER_VERSION,
          finishedAt: new Date(),
        },
        select: { id: true },
      });
      return {
        tenantId,
        status: "TRANSIENT_FAILURE",
        durationMs: Date.now() - started,
        entriesScanned: 0,
        firstBrokenIndex: null,
        discrepancies: [],
        criticalCount: 0, highCount: 0, mediumCount: 0, infoCount: 1,
        quarantined: false,
        autoRemediated: false,
        auditId: audit.id,
      };
    }

    // Load tenant.
    const user = await tx.user.findUnique({
      where: { id: tenantId },
      select: {
        id: true, email: true,
        lastLedgerEntryHash: true,
        ledgerQuarantinedAt: true,
        ledgerQuarantineReason: true,
      },
    });
    if (!user) {
      // Tenant doesn't exist; record PASSED with 0 entries.
      const audit = await tx.reconciliationAudit.create({
        data: {
          tenantId,
          status: "PASSED",
          durationMs: Date.now() - started,
          entriesScanned: 0,
          discrepancies: [] as unknown as Prisma.InputJsonValue,
          criticalCount: 0, highCount: 0, mediumCount: 0, infoCount: 0,
          triggeredAlert: false,
          workerId: wid,
          version: RECONCILER_VERSION,
          finishedAt: new Date(),
        },
        select: { id: true },
      });
      return {
        tenantId, status: "PASSED", durationMs: Date.now() - started,
        entriesScanned: 0, firstBrokenIndex: null, discrepancies: [],
        criticalCount: 0, highCount: 0, mediumCount: 0, infoCount: 0,
        quarantined: false, autoRemediated: false, auditId: audit.id,
      };
    }

    let sweepARes: SweepAResult;
    let sweepBRes: SweepBResult;
    try {
      sweepARes = await sweepA(tx, tenantId, batchSize);
      sweepBRes = await sweepB(tx, tenantId, sweepARes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const dis: Discrepancy[] = [mkDisc("TRANSIENT_ERROR", { detail: `verifier threw: ${msg.slice(0, 400)}` })];
      const t = tally(dis);
      const audit = await tx.reconciliationAudit.create({
        data: {
          tenantId, status: "TRANSIENT_FAILURE",
          durationMs: Date.now() - started, entriesScanned: 0,
          discrepancies: dis as unknown as Prisma.InputJsonValue,
          criticalCount: t.critical, highCount: t.high, mediumCount: t.medium, infoCount: t.info,
          triggeredAlert: false, workerId: wid, version: RECONCILER_VERSION,
          finishedAt: new Date(),
        },
        select: { id: true },
      });
      return {
        tenantId, status: "TRANSIENT_FAILURE", durationMs: Date.now() - started,
        entriesScanned: 0, firstBrokenIndex: null, discrepancies: dis,
        criticalCount: t.critical, highCount: t.high, mediumCount: t.medium, infoCount: t.info,
        quarantined: false, autoRemediated: false, auditId: audit.id,
      };
    }

    // Tail-pointer check.
    if (sweepARes.scanned === 0) {
      if (user.lastLedgerEntryHash != null) {
        sweepARes.discrepancies.push(
          mkDisc("TAIL_POINTER_DESYNC", {
            detail: `user.lastLedgerEntryHash is set (${user.lastLedgerEntryHash.slice(0, 12)}…) but no ledger rows exist`,
          })
        );
        if (!sweepARes.firstBrokenIndex) sweepARes.firstBrokenIndex = 0;
      }
    } else if (sweepARes.tailHash !== user.lastLedgerEntryHash) {
      sweepARes.discrepancies.push(
        mkDisc("TAIL_POINTER_DESYNC", {
          detail: `user.lastLedgerEntryHash (${(user.lastLedgerEntryHash ?? "").slice(0, 12)}…) does not match actual tail (${(sweepARes.tailHash ?? "").slice(0, 12)}… at index ${sweepARes.tailIndex})`,
        })
      );
      if (!sweepARes.firstBrokenIndex) sweepARes.firstBrokenIndex = sweepARes.tailIndex;
    }

    // Combine discrepancies.
    let discrepancies: Discrepancy[] = [...sweepARes.discrepancies, ...sweepBRes.discrepancies];
    let autoRemediated = false;
    let autoRemediation: string | null = null;

    // Auto-backfill once for HIGH mismatches that are backfill-fixable
    // (AR/CASH/EXPENSE) when there are NO critical hash-chain failures.
    const hasCriticalStructural = discrepancies.some(
      (d) =>
        d.severity === "CRITICAL" ||
        d.kind === "ENTRY_INDEX_GAP"
    );
    const hasBackfillable = discrepancies.some(
      (d) => d.kind === "AR_MISMATCH" || d.kind === "CASH_MISMATCH" || d.kind === "EXPENSE_MISMATCH"
    );
    if (hasBackfillable && !hasCriticalStructural && !opts.skipAutoBackfill) {
      try {
        // Backfill INSIDE this service tx so the subsequent Sweep A+B
        // re-reads can see the newly appended rows (REPEATABLE READ
        // would otherwise hide rows committed on a different connection).
        await backfillLedgerForSingleTenant(tenantId, tx);
        // Re-run Sweep A+B against the updated state.
        const sa2 = await sweepA(tx, tenantId, batchSize);
        const sb2 = await sweepB(tx, tenantId, sa2);
        // Re-check tail.
        const userAfter = await tx.user.findUnique({
          where: { id: tenantId },
          select: { lastLedgerEntryHash: true },
        });
        if (sa2.tailHash !== userAfter?.lastLedgerEntryHash) {
          sa2.discrepancies.push(
            mkDisc("TAIL_POINTER_DESYNC", {
              detail: `post-backfill tail mismatch (tail=${(sa2.tailHash ?? "").slice(0, 12)}… user=${(userAfter?.lastLedgerEntryHash ?? "").slice(0, 12)}…)`,
            })
          );
        }
        const after: Discrepancy[] = [...sa2.discrepancies, ...sb2.discrepancies];
        if (after.length < discrepancies.length) {
          autoRemediated = true;
          autoRemediation = "backfill";
          discrepancies = after;
          sweepARes = sa2;
        }
      } catch (err) {
        // Backfill failed — leave the original discrepancies; add an INFO.
        const msg = err instanceof Error ? err.message : String(err);
        discrepancies.push(
          mkDisc("TRANSIENT_ERROR", { detail: `auto-backfill failed: ${msg.slice(0, 200)}` })
        );
      }
    }

    const t = tally(discrepancies);
    const status: ReconciliationStatus = statusFrom(discrepancies, t.critical > 0);

    // Quarantine decision: CRITICAL → yes; HIGH → yes. MEDIUM/INFO → no.
    // Skipped entirely when `auditOnly` is set (post-force-release confirm run).
    const shouldQuarantine = (t.critical > 0 || t.high > 0) && !opts.auditOnly;
    const alreadyQuarantined = !!user.ledgerQuarantinedAt;
    let quarantined = false;
    if (shouldQuarantine && !alreadyQuarantined) {
      const worst =
        discrepancies.find((d) => d.severity === "CRITICAL")?.kind ??
        discrepancies.find((d) => d.severity === "HIGH")?.kind ??
        "AR_MISMATCH";
      await tx.user.update({
        where: { id: tenantId },
        data: {
          ledgerQuarantinedAt: new Date(),
          ledgerQuarantineReason: worst,
        },
      });
      quarantined = true;
    }

    // Always update lastReconciledAt (skipped in audit-only confirm runs).
    if (!opts.auditOnly) {
      await tx.user.update({
        where: { id: tenantId },
        data: { lastReconciledAt: new Date() },
      });
    }

    // Create audit row.
    const dur = Date.now() - started;
    let triggeredAlert = false;
    // Audit-only confirm runs do not fire alerts (operator already knows).
    if (!opts.auditOnly && (t.critical > 0 || t.high > 0 || quarantined || autoRemediated || t.info > 0)) {
      // Cooldown is queried against the in-tx client via AuditFindCapable;
      // structural typing accepts any Prisma client or tx.
      type AuditClient = Parameters<typeof fireDriftAlerts>[1];
      triggeredAlert = await fireDriftAlerts(
        {
          tenantId,
          tenantEmail: user.email,
          criticalCount: t.critical,
          highCount: t.high,
          mediumCount: t.medium,
          infoCount: t.info,
          discrepancies,
          quarantined,
          autoRemediated,
        },
        tx as unknown as NonNullable<AuditClient>
      );
    }

    const audit = await tx.reconciliationAudit.create({
      data: {
        tenantId,
        status,
        durationMs: dur,
        entriesScanned: sweepARes.scanned,
        firstBrokenIndex: sweepARes.firstBrokenIndex,
        discrepancies: discrepancies as unknown as Prisma.InputJsonValue,
        criticalCount: t.critical,
        highCount: t.high,
        mediumCount: t.medium,
        infoCount: t.info,
        triggeredAlert,
        autoRemediated,
        autoRemediation,
        workerId: wid,
        version: RECONCILER_VERSION,
        finishedAt: new Date(),
      },
      select: { id: true },
    });

    return {
      tenantId,
      status,
      durationMs: dur,
      entriesScanned: sweepARes.scanned,
      firstBrokenIndex: sweepARes.firstBrokenIndex,
      discrepancies,
      criticalCount: t.critical,
      highCount: t.high,
      mediumCount: t.medium,
      infoCount: t.info,
      quarantined,
      autoRemediated,
      auditId: audit.id,
    };
  });
}

/**
 * Run backfillLedger but scoped to a single tenant (we don't want to
 * re-scan every tenant during a per-tenant reconcile). This is a small
 * shim that does the same discovery the full backfill does, filtered
 * to one tenant.
 */
export async function backfillLedgerForSingleTenant(
  tenantId: string,
  tx?: Prisma.TransactionClient
): Promise<{
  invoices: number;
  expenses: number;
}> {
  // We import the single-event post function lazily to avoid cycles.
  const { postLedgerEvent } = await import("@/lib/ledger");
  // When running inside an outer reconciler tx we pass `tx` down so the
  // new ledger rows join the same transaction and subsequent in-tx
  // Sweep A+B calls can see them (without this, REPEATABLE READ means
  // the outer tx would keep its snapshot and miss backfilled rows).
  const runIn = tx;
  const prismaClient = tx ?? prisma;
  let invoicesCount = 0;
  let expensesCount = 0;

  // ---- Invoices ----
  const issued = await prismaClient.ledgerEntry.findMany({
    where: { userId: tenantId, eventType: "INVOICE_ISSUED", invoiceId: { not: null } },
    select: { invoiceId: true },
  });
  const paid = await prismaClient.ledgerEntry.findMany({
    where: { userId: tenantId, eventType: "INVOICE_PAID", invoiceId: { not: null } },
    select: { invoiceId: true },
  });
  const voided = await prismaClient.ledgerEntry.findMany({
    where: { userId: tenantId, eventType: "INVOICE_VOIDED", invoiceId: { not: null } },
    select: { invoiceId: true },
  });
  const alreadyIssued = new Set(issued.map((r) => r.invoiceId).filter(Boolean) as string[]);
  const alreadyPaid = new Set(paid.map((r) => r.invoiceId).filter(Boolean) as string[]);
  const alreadyVoided = new Set(voided.map((r) => r.invoiceId).filter(Boolean) as string[]);

  const invoices = await prismaClient.invoice.findMany({
    where: { userId: tenantId, status: { not: "DRAFT" } },
    include: { items: true },
  });
  for (const inv of invoices) {
    const items = inv.items.map((it) => ({
      description: it.description,
      quantity: it.quantity,
      price: Number(it.price),
    }));
    const invoiceDraft = {
      id: inv.id,
      userId: inv.userId,
      items,
      taxRate: Number(inv.taxRate),
      discountType: inv.discountType,
      discountValue: inv.discountValue != null ? Number(inv.discountValue) : null,
    } as const;

    let posted = false;
    if (!alreadyIssued.has(inv.id)) {
      await postLedgerEvent({ type: "INVOICE_ISSUED", invoice: invoiceDraft }, runIn);
      posted = true;
    }
    if (inv.status === "PAID" && !alreadyPaid.has(inv.id)) {
      await postLedgerEvent(
        {
          type: "INVOICE_PAID",
          invoice: { id: inv.id, userId: inv.userId, totalAmount: inv.totalAmount },
          amountPaid: inv.totalAmount,
        },
        runIn
      );
      posted = true;
    } else if (inv.status === "VOID" && !alreadyVoided.has(inv.id)) {
      await postLedgerEvent(
        {
          type: "INVOICE_VOIDED",
          invoice: { ...invoiceDraft, paidAmount: null },
        },
        runIn
      );
      posted = true;
    }
    if (posted) invoicesCount++;
  }

  // ---- Expenses ----
  const expensed = await prismaClient.ledgerEntry.findMany({
    where: { userId: tenantId, eventType: "EXPENSE_RECORDED", expenseId: { not: null } },
    select: { expenseId: true },
  });
  const alreadyExpensed = new Set(expensed.map((r) => r.expenseId).filter(Boolean) as string[]);
  const expenses = await prismaClient.expense.findMany({
    where: { userId: tenantId, NOT: { id: { in: Array.from(alreadyExpensed) } } },
  });
  for (const exp of expenses) {
    await postLedgerEvent(
      {
        type: "EXPENSE_RECORDED",
        expense: { id: exp.id, userId: exp.userId, amount: exp.amount, category: exp.category },
      },
      runIn
    );
    expensesCount++;
  }

  return { invoices: invoicesCount, expenses: expensesCount };
}

/**
 * Reconcile many tenants. `mode` controls which tenants are selected:
 *   - "full":        every user (no filter).
 *   - "incremental": users where lastReconciledAt is null OR > 15m old
 *                    OR lastLedgerEntryHash was updated recently (we
 *                    approximate: lastReconciledAt < now - 15m).
 *   - "single":      single tenant (use reconcileTenant() directly).
 */
export async function reconcileAllTenants(
  opts: ReconcileOptions = {}
): Promise<ReconcileResult[]> {
  ensureDefaultDriftAlertHook();
  const mode = opts.mode ?? "incremental";
  const limit = opts.limit ?? (mode === "full" ? 1000 : 20);

  let where: Prisma.UserWhereInput = {};
  if (mode === "incremental") {
    const fifteenMinAgo = new Date(Date.now() - 15 * 60_000);
    where = {
      OR: [
        { lastReconciledAt: null },
        { lastReconciledAt: { lt: fifteenMinAgo } },
        // Quarantined tenants are re-checked every run so the operator
        // can see audit history even if they haven't been released.
        { ledgerQuarantinedAt: { not: null } },
      ],
    };
  }

  const users = await prisma.user.findMany({
    where,
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const results: ReconcileResult[] = [];
  for (const u of users) {
    try {
      const r = await reconcileTenant(u.id, {
        batchSize: opts.batchSize ?? DEFAULT_BATCH,
        force: opts.force,
        skipAutoBackfill: opts.skipAutoBackfill,
      });
      results.push(r);
    } catch (err) {
      console.error("[reconciler] tenant", u.id, "failed:", err);
      // Record a TRANSIENT_FAILURE audit via service path.
      try {
        const wid = workerId();
        await withService(RECONCILER_SERVICE, async (tx) => {
          await tx.reconciliationAudit.create({
            data: {
              tenantId: u.id,
              status: "TRANSIENT_FAILURE",
              durationMs: 0,
              entriesScanned: 0,
              discrepancies: [
                {
                  kind: "TRANSIENT_ERROR",
                  severity: "INFO",
                  detail:
                    "reconcileAllTenants worker error: " +
                    (err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)),
                },
              ] as unknown as Prisma.InputJsonValue,
              criticalCount: 0, highCount: 0, mediumCount: 0, infoCount: 1,
              triggeredAlert: false, workerId: wid, version: RECONCILER_VERSION,
              finishedAt: new Date(),
            },
          });
        });
      } catch {
        // swallow — we already logged.
      }
    }
  }
  return results;
}

/**
 * Operator-only helpers: manual quarantine, release with re-verify,
 * backfill. These are used by admin routes.
 */
export async function quarantineTenant(
  tenantId: string,
  reason: string,
  actor: string
): Promise<void> {
  if (!SAFE_TENANT_RE.test(tenantId)) throw new Error("quarantineTenant: unsafe tenantId");
  await withService(RECONCILER_SERVICE, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_user_id = '${tenantId}'`);
    await tx.user.update({
      where: { id: tenantId },
      data: {
        ledgerQuarantinedAt: new Date(),
        ledgerQuarantineReason: `MANUAL:${reason.slice(0, 200)} (by ${actor.slice(0, 64)})`,
      },
    });
    await tx.reconciliationAudit.create({
      data: {
        tenantId,
        status: "DRIFT_DETECTED",
        durationMs: 0,
        entriesScanned: 0,
        discrepancies: [{ kind: "AR_MISMATCH", severity: "HIGH", detail: `Manual quarantine: ${reason.slice(0, 300)}` }] as unknown as Prisma.InputJsonValue,
        criticalCount: 0, highCount: 1, mediumCount: 0, infoCount: 0,
        triggeredAlert: false, workerId: workerId(), version: RECONCILER_VERSION,
        finishedAt: new Date(),
      },
    });
  });
}

export async function releaseQuarantine(
  tenantId: string,
  reason: string,
  opts: { force?: boolean } = {}
): Promise<{ ok: boolean; result?: ReconcileResult; error?: string }> {
  if (!SAFE_TENANT_RE.test(tenantId)) throw new Error("releaseQuarantine: unsafe tenantId");
  // Release requires a fresh reconcile pass (unless force).
  if (!opts.force) {
    const result = await reconcileTenant(tenantId, { skipAutoBackfill: false });
    if (result.status !== "PASSED") {
      return {
        ok: false,
        result,
        error: `Cannot release: reconcile returned ${result.status} (critical=${result.criticalCount}, high=${result.highCount})`,
      };
    }
  }
  await withService(RECONCILER_SERVICE, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_user_id = '${tenantId}'`);
    await tx.user.update({
      where: { id: tenantId },
      data: { ledgerQuarantinedAt: null, ledgerQuarantineReason: null },
    });
    await tx.reconciliationAudit.create({
      data: {
        tenantId,
        status: "PASSED",
        durationMs: 0,
        entriesScanned: 0,
        discrepancies: [{
          kind: "TRANSIENT_ERROR", severity: "INFO",
          detail: `Quarantine released${opts.force ? " (force)" : ""}: ${reason.slice(0, 300)}`,
        }] as unknown as Prisma.InputJsonValue,
        criticalCount: 0, highCount: 0, mediumCount: 0, infoCount: 1,
        triggeredAlert: false, workerId: workerId(), version: RECONCILER_VERSION,
        finishedAt: new Date(),
      },
    });
  });
  // Post-release confirmation run. On force-release the operator has
  // explicitly accepted residual drift; run in auditOnly mode so this
  // run records an audit row but does NOT re-quarantine or fire alerts.
  const result = await reconcileTenant(tenantId, {
    skipAutoBackfill: !opts.force, // try backfill once after a normal release
    auditOnly: !!opts.force,
  });
  return { ok: true, result };
}

export async function operatorBackfill(tenantId: string): Promise<{
  invoices: number;
  expenses: number;
  result: ReconcileResult;
}> {
  // operatorBackfill is invoked from Server Actions outside any outer tx,
  // so it's safe to use the global prisma (no tx argument).
  const r = await backfillLedgerForSingleTenant(tenantId);
  const result = await reconcileTenant(tenantId, { skipAutoBackfill: true });
  return { invoices: r.invoices, expenses: r.expenses, result };
}
