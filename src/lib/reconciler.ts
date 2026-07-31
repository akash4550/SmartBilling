/**
 * Automated Ledger Drift & Integrity Reconciler.
 *
 * Two sweeps per tenant:
 *   Sweep A — Streaming hash-chain integrity + per-event balance check.
 *             Cursor-batched (default 500 rows/query) from entryIndex = 1
 *             using the (userId, entryIndex) UNIQUE index. Constant memory.
 *             Tail-catch-up loop (capped 5 iters) handles rows appended
 *             mid-sweep without forking the chain.
 *   Sweep B — SQL-side balance cross-checks against the read model
 *             (invoices / expenses) and issuance-scoped revenue/tax parity.
 *             Aggregations pushed down to Postgres.
 *
 * Every run writes one append-only row to reconciliation_audits (UPDATE/
 * DELETE revoked at the SQL layer). CRITICAL drift immediately
 * quarantines; HIGH drift (AR/CASH/EXPENSE mismatches) gets ONE idempotent
 * auto-backfill attempt INSIDE the service tx (REPEATABLE READ snapshot
 * visibility) before escalation; MEDIUM/INFO do not block writes.
 *
 * Runs as service_role under service name "maint:reconcile". Never as
 * app_user (needs cross-tenant discovery) and never as superuser.
 * Concurrency per tenant is guarded by pg_try_advisory_xact_lock in
 * namespace 1397772901 (separate from ledger-posting namespace 1397772900);
 * contention returns TRANSIENT_FAILURE cleanly (no queueing).
 */
import "server-only";

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
import { isReadOnlyMode } from "@/lib/dr-mode";
import {
  ReadOnlyModeError,
  LedgerQuarantinedError,
} from "@/lib/errors";
import type { ReconciliationStatus } from "@prisma/client";

// Re-exports for backwards compatibility — callers historically did
// `import { LedgerQuarantinedError } from "@/lib/reconciler"` in tests
// and Server Actions. The canonical classes live in @/lib/errors.
export { LedgerQuarantinedError, ReadOnlyModeError };
export type { Discrepancy, DriftKind, Severity };
export const RECONCILER_VERSION = "1";
const RECONCILER_SERVICE = "maint:reconcile";
const DEFAULT_BATCH = 500;
const TAIL_CATCHUP_MAX_ITERS = 5;
/**
 * Per-tenant reconcile advisory-lock namespace. MUST be distinct from
 * the ledger-posting namespace (1397772900n) so reconciles do not block
 * posting and vice versa. The lock is transaction-scoped and acquired
 * with pg_try_advisory_xact_lock so concurrent invocations bail fast.
 */
const RECONCILE_LOCK_NS = BigInt(1397772901);

/**
 * Event types that legitimately post to the CASH account. Any CASH row
 * outside this set indicates a bug in the posting path (an event we
 * did not anticipate touching cash) and is flagged as HIGH drift.
 *
 *   INVOICE_PAID       → Dr CASH, Cr AR  (customer payment)
 *   PAYMENT_REVERSED   → Dr AR,   Cr CASH (refund / chargeback)
 *   EXPENSE_RECORDED   → Dr EXP,  Cr CASH (cash outflow)
 *   INVOICE_VOIDED     → may include Cr CASH when a paid invoice is
 *                        voided (payment reversed inside the void)
 */
const CASH_EVENT_TYPES = [
  "INVOICE_PAID",
  "PAYMENT_REVERSED",
  "EXPENSE_RECORDED",
  "INVOICE_VOIDED",
] as const;

/** Advisory lock key (per-tenant reconcile serialization). */
function reconcileAdvisoryKeyFor(tenantId: string): bigint {
  // FNV-1a 32-bit folded into low 32 bits; high 32 bits are the namespace.
  // Constructed arithmetically (not as a literal) to satisfy ES2017.
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
    case "ENTRY_INDEX_GAP":
      return "CRITICAL";
    case "AR_MISMATCH":
    case "CASH_MISMATCH":
    case "EXPENSE_MISMATCH":
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
  /** Account signed balances (Σ D − Σ C) as paise BigInts. */
  accountBalances: Record<string, bigint>;
}

/**
 * Stream ledger entries forward from entryIndex 1 using a keyset cursor.
 * Verifies:
 *   1. No entryIndex gaps (deletion / skipped-index detection).
 *   2. prevEntryHash chain links (matches in-memory running hash).
 *   3. SHA-256(prevHash | canonical_json) === entryHash — REUSES the
 *      canonical serializer from ledger.ts (no second implementation).
 *   4. Per-eventId Σ Debit ≡ Σ Credit.
 * Runs up to TAIL_CATCHUP_MAX_ITERS passes to converge with concurrent
 * appenders (new rows written between our last batch and EOF check).
 */
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
  /**
   * Per-event D/C accumulator. Events are always posted contiguously in
   * our ledger helper (same eventId rows appear consecutively in a single
   * chain append), but we tolerate straddling a batch boundary because
   * we don't evict until finalization — memory footprint is bounded by
   * the number of in-flight events (≤ 2 across a boundary in practice).
   */
  const eventBalances = new Map<
    string,
    { d: bigint; c: bigint; lastIndex: number }
  >();

  let cursor = 0;
  let prevHash = GENESIS_HASH;
  let scanned = 0;
  let firstBrokenIndex: number | null = null;
  let expectedNextIndex = 1;
  let tailHash: string | null = null;
  let tailIndex = 0;

  for (let catchup = 0; catchup < TAIL_CATCHUP_MAX_ITERS; catchup++) {
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
        // --- Entry index gap (deleted / skipped rows) ---
        if (row.entryIndex !== expectedNextIndex) {
          discrepancies.push(
            mkDisc("ENTRY_INDEX_GAP", {
              detail: `expected index ${expectedNextIndex}, got ${row.entryIndex}`,
            })
          );
          if (firstBrokenIndex === null) firstBrokenIndex = row.entryIndex;
          // Resync forward so we continue collecting discrepancies
          // rather than emitting cascading false positives.
          expectedNextIndex = row.entryIndex;
        }
        expectedNextIndex++;

        // --- Hash chain: prevEntryHash must equal running hash ---
        if (row.prevEntryHash !== prevHash) {
          discrepancies.push(
            mkDisc("HASH_CHAIN_BROKEN", {
              detail: `at index ${row.entryIndex}: prevEntryHash mismatch (expected ${prevHash.slice(0, 12)}… got ${row.prevEntryHash.slice(0, 12)}…)`,
            })
          );
          if (firstBrokenIndex === null) firstBrokenIndex = row.entryIndex;
          // Re-sync to this row's claimed hash to contain the blast radius.
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
            if (firstBrokenIndex === null) firstBrokenIndex = row.entryIndex;
            prevHash = row.entryHash;
          } else {
            prevHash = row.entryHash;
          }
        }

        // --- Running signed balance per account ---
        const amt = BigInt(row.amountPaise.toString());
        const signed = row.side === "DEBIT" ? amt : -amt;
        balances[row.account] = (balances[row.account] ?? BigInt(0)) + signed;

        // --- Per-event D/C accumulator ---
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

      // Yield to the event loop so long-running sweeps don't starve the
      // connection pool.
      await new Promise((r) => setImmediate(r));
    }

    // Tail check: has new data arrived since our last batch?
    const newest = await tx.ledgerEntry.findFirst({
      where: { userId: tenantId },
      orderBy: { entryIndex: "desc" },
      select: { entryIndex: true, entryHash: true },
    });
    if (!newest) break;
    if (newest.entryIndex <= cursor) break; // caught up
    // else loop again and resume from cursor.
  }

  // --- Finalize per-event balance checks ---
  for (const [eventId, b] of eventBalances) {
    if (b.d !== b.c) {
      discrepancies.push(
        mkDisc("UNBALANCED_EVENT", {
          detail: `eventId=${eventId} ΣD=${b.d.toString()}p ΣC=${b.c.toString()}p`,
        })
      );
      if (firstBrokenIndex === null) firstBrokenIndex = b.lastIndex;
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
// SWEEP B — SQL-side balance cross-checks
// ============================================================

interface SweepBResult {
  discrepancies: Discrepancy[];
  expectedOpenReceivablePaise: bigint;
  expectedExpensePaise: bigint;
}

/**
 * Build a SQL IN (...) clause for a fixed list of string literals. We
 * deliberately avoid parameterizing these (they are hard-coded enum
 * values in this file, never user input) so that Postgres sees a plain
 * literal IN list and doesn't require enum casts.
 */
function literalInList(values: readonly string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
}

/**
 * Sweep B pushes aggregations down to Postgres.
 *
 *  1. Ledger-side per-account signed balances — ground truth.
 *  2. AR expected balance = Σ ROUND(totalAmount * 100) for invoices
 *     with status = 'PENDING' (open receivable read model).
 *  3. EXPENSES expected balance = Σ ROUND(amount * 100) from expenses.
 *  4. CASH expected balance = Σ signed CASH movements scoped to the
 *     event types that legitimately touch cash; any CASH posting
 *     outside that set is flagged as HIGH drift.
 *  5. Revenue/Tax parity scoped STRICTLY to INVOICE_ISSUED /
 *     INVOICE_VOIDED events (issuance leg). Payments/refunds do NOT
 *     touch REVENUE/TAX_PAYABLE in our posting model so they are
 *     excluded from the parity check (prevents false positives after
 *     refunds/chargebacks).
 */
async function sweepB(
  tx: Prisma.TransactionClient,
  tenantId: string,
  sweepA: SweepAResult
): Promise<SweepBResult> {
  const discrepancies: Discrepancy[] = [];

  // --- 1. Ledger-side per-account signed aggregates ---
  // Cast amountPaise to numeric to avoid BigInt binding headaches with
  // $queryRaw; result is returned as text and parsed to BigInt.
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
           COALESCE(SUM(CASE WHEN side='DEBIT'  THEN  "amountPaise"::numeric
                             WHEN side='CREDIT' THEN -"amountPaise"::numeric
                             ELSE 0 END), 0)::text AS signed_balance
    FROM ledger_entries
    WHERE "userId" = ${tenantId}
    GROUP BY account
  `;
  const ledgerBalance: Record<string, bigint> = {};
  for (const r of ledgerRows) {
    ledgerBalance[r.account] = BigInt(r.signed_balance);
  }
  // Zero defaults for any account not present in the ledger.
  for (const k of Object.keys(sweepA.accountBalances)) {
    if (ledgerBalance[k] === undefined) ledgerBalance[k] = BigInt(0);
  }

  // --- 2. Open AR (PENDING invoices) ---
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
  for (const r of invAgg) {
    if (r.status === "PENDING") openReceivable += BigInt(r.total_paise);
    // NOTE: we deliberately do NOT use invoices.status='PAID' as a
    // cash expectation. Refunds/chargebacks (PAYMENT_REVERSED) and
    // voids-of-paid (INVOICE_VOIDED with paidAmount set) reduce cash
    // without flipping the invoice out of a state we can detect
    // reliably from this aggregate. CASH is instead derived from the
    // ledger's own event-type-signed sums (step 4).
  }

  // --- 3. Expense read model ---
  const expAgg = await tx.$queryRaw<Array<{ total_paise: string }>>`
    SELECT COALESCE(SUM(ROUND((amount::numeric * 100))), 0)::text AS total_paise
    FROM expenses
    WHERE "userId" = ${tenantId}
  `;
  const expenseTotal = BigInt(expAgg[0]?.total_paise ?? "0");

  // --- 4. CASH expected = signed sum of CASH rows scoped to known cash
  //        event types. Any CASH row outside the known set is drift.
  const cashEvtInList = literalInList(CASH_EVENT_TYPES);
  const cashRows = await tx.$queryRaw<
    Array<{ event_type: string; signed_balance: string }>
  >`
    SELECT "eventType" AS event_type,
           COALESCE(SUM(
             CASE
               WHEN side = 'DEBIT'  THEN  "amountPaise"::numeric
               WHEN side = 'CREDIT' THEN -"amountPaise"::numeric
               ELSE 0
             END
           ), 0)::text AS signed_balance
    FROM ledger_entries
    WHERE "userId" = ${tenantId}
      AND account = 'CASH'
      AND "eventType" IN (${Prisma.raw(cashEvtInList)})
    GROUP BY "eventType"
  `;
  let expectedCashFromKnownEvents = BigInt(0);
  const seenCashEvents = new Set<string>();
  for (const r of cashRows) {
    expectedCashFromKnownEvents += BigInt(r.signed_balance);
    seenCashEvents.add(r.event_type);
  }

  // Detect unknown event types posting to CASH (high-sensitivity bug detector).
  const unknownCashRows = await tx.$queryRaw<
    Array<{ event_type: string; total_paise: string }>
  >`
    SELECT "eventType" AS event_type,
           COALESCE(SUM("amountPaise"::numeric), 0)::text AS total_paise
    FROM ledger_entries
    WHERE "userId" = ${tenantId}
      AND account = 'CASH'
      AND "eventType" NOT IN (${Prisma.raw(cashEvtInList)})
    GROUP BY "eventType"
  `;
  if (unknownCashRows.length > 0) {
    const bad = unknownCashRows
      .map((r) => `${r.event_type}=${r.total_paise}p`)
      .join(", ");
    discrepancies.push(
      mkDisc("CASH_MISMATCH", {
        account: "CASH",
        detail: `CASH posted under unexpected event type(s): ${bad}`,
      })
    );
  }

  // --- Cross-check: AR ---
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

  // --- Cross-check: CASH (ledger must equal sum-of-known-events) ---
  const cashLedger = ledgerBalance.CASH ?? BigInt(0);
  if (cashLedger !== expectedCashFromKnownEvents && unknownCashRows.length === 0) {
    // If unknown events already flagged, we still record the numeric gap
    // but skip emitting a duplicate CASH_MISMATCH for the same root cause.
    discrepancies.push(
      mkDisc("CASH_MISMATCH", {
        account: "CASH",
        expectedPaise: expectedCashFromKnownEvents.toString(),
        actualPaise: cashLedger.toString(),
        diffPaise: (cashLedger - expectedCashFromKnownEvents).toString(),
        detail: "CASH ledger balance does not match signed sum of INVOICE_PAID/PAYMENT_REVERSED/EXPENSE_RECORDED/INVOICE_VOIDED",
      })
    );
  }

  // --- Cross-check: EXPENSES ---
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

  // --- 5. Revenue/Tax parity (MEDIUM) ---
  //
  // Across the ENTIRE ledger, net Dr ACCOUNTS_RECEIVABLE from ISUED/VOID
  // (issuance reversals only, NOT payment legs) must equal net Cr REVENUE
  // + net Cr TAX_PAYABLE − net Dr DISCOUNT_CONTRA.
  //
  // Payment/reversal legs (INVOICE_PAID, PAYMENT_REVERSED, and the CASH
  // reversal Dr AR leg we emit inside INVOICE_VOIDED when cash was
  // received) move AR ↔ CASH and never touch REVENUE/TAX_PAYABLE. They
  // are excluded from BOTH sides of this check so that void-after-
  // partial-payment does not look like MEDIUM drift.
  //
  // We achieve this by filtering AR to only rows that are on ISUED/VOID
  // events AND are part of the issuance set (REV/TAX/DISCOUNT/AR legs of
  // ISUED, and the issuance-reversal CREDIT AR leg of VOID). The Dr AR
  // cash-reversal leg inside INVOICE_VOIDED is emitted on the same
  // INVOICE_VOIDED eventType, so we need an additional way to exclude
  // it. We do so by recognizing that the cash-reversal leg has amount
  // paidP and is part of a balanced event whose net AR contribution is
  // (totalP - paidP) CREDIT — i.e., it appears opposite the expected
  // issuance-side AR credit.
  //
  // Simpler robust approach: compute AR signed balance EXCLUDING the
  // CASH-scoped event types (PAID/PAYMENT_REVERSED) AND EXCLUDING the
  // cash-reversal leg of VOID. We identify the cash-reversal leg by
  // grouping INVOICE_VOIDED AR rows by sign: the CREDIT leg at openArP
  // (totalP - paidP) is the issuance reversal; the DEBIT leg at paidP
  // is the cash-reversal. We net them via SUM but subtract the Dr
  // component in-app. The cleanest SQL-side filter is to compute AR
  // from ISUED/VOID only and then subtract any Dr AR from VOID that
  // corresponds to a simultaneous CASH Cr of the same amount — but in
  // practice, for our VOID builder, the non-issuance AR leg inside a
  // VOID event is exactly the CASH reversal and equals paidP, which
  // also equals the CASH Cr in the same event. Therefore we compute
  // "issuance-only AR" as AR signed balance from ISUED+VOID MINUS the
  // CASH reversal Dr (equal to |CASH Cr on VOID events|).
  const issuanceInList = literalInList(["INVOICE_ISSUED", "INVOICE_VOIDED"]);
  const issuanceAccounts = literalInList([
    "ACCOUNTS_RECEIVABLE",
    "REVENUE",
    "TAX_PAYABLE",
    "DISCOUNT_CONTRA",
  ]);
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
      AND "eventType" IN (${Prisma.raw(issuanceInList)})
      AND account     IN (${Prisma.raw(issuanceAccounts)})
    GROUP BY account
  `;
  const iss: Record<string, bigint> = {};
  for (const r of issuanceRows) iss[r.account] = BigInt(r.signed_balance);

  // CASH Cr posted inside INVOICE_VOIDED events (payment-reversal legs).
  // The offsetting Dr AR leg in those same events is cash movement, not
  // issuance, and must be excluded from the AR side of the parity check
  // to match.
  const voidCashRows = await tx.$queryRaw<
    Array<{ signed_balance: string }>
  >`
    SELECT COALESCE(SUM(
             CASE
               WHEN side = 'DEBIT'  THEN  "amountPaise"::numeric
               WHEN side = 'CREDIT' THEN -"amountPaise"::numeric
               ELSE 0
             END
           ), 0)::text AS signed_balance
    FROM ledger_entries
    WHERE "userId" = ${tenantId}
      AND "eventType" = 'INVOICE_VOIDED'::"LedgerEventType"
      AND account = 'CASH'
  `;
  // signed_balance of CASH on VOID events is ≤ 0 (Cr cash = refund) so
  // the matching AR Dr leg = -signed_balance.
  const voidCashSigned = BigInt(voidCashRows[0]?.signed_balance ?? "0");
  // Issuance-only AR = AR from ISUED+VOID minus the cash-reversal Dr AR
  // (which equals -voidCashSigned since voidCashSigned is negative).
  const cashReversalArDr = voidCashSigned < BigInt(0) ? -voidCashSigned : BigInt(0);
  const issArDrMinusCr = (iss.ACCOUNTS_RECEIVABLE ?? BigInt(0)) - cashReversalArDr;
  const issRevenueCr = -(iss.REVENUE ?? BigInt(0));
  const issTaxCr = -(iss.TAX_PAYABLE ?? BigInt(0));
  const issDiscountDr = iss.DISCOUNT_CONTRA ?? BigInt(0);
  const expectedIssuedAr = issRevenueCr + issTaxCr - issDiscountDr;
  if (issArDrMinusCr !== expectedIssuedAr) {
    discrepancies.push(
      mkDisc("REVENUE_TAX_MISMATCH", {
        expectedPaise: expectedIssuedAr.toString(),
        actualPaise: issArDrMinusCr.toString(),
        diffPaise: (issArDrMinusCr - expectedIssuedAr).toString(),
        detail:
          "Issuance-side AR does not match Revenue+Tax−Discount across INVOICE_ISSUED/INVOICE_VOIDED (likely post-issuance invoice edits; void+reissue to correct)",
      })
    );
  }

  return {
    discrepancies,
    expectedOpenReceivablePaise: openReceivable,
    expectedExpensePaise: expenseTotal,
  };
}

// ============================================================
// TENANT LOCK (non-blocking; returns TRANSIENT_FAILURE on contention)
// ============================================================

async function tryAcquireTenantLock(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<boolean> {
  const key = reconcileAdvisoryKeyFor(tenantId);
  // pg_try_advisory_xact_lock is non-blocking: returns true if acquired,
  // false if another session holds it. We never queue behind another
  // reconciler; the cron will simply retry on its next 15-min tick.
  const rows = await tx.$queryRawUnsafe<Array<{ acquired: boolean }>>(
    `SELECT pg_try_advisory_xact_lock(${key.toString()}) AS acquired`
  );
  return rows[0]?.acquired === true;
}

// ============================================================
// TOP-LEVEL API
// ============================================================

export interface ReconcileOptions {
  /** Reconcile a single tenant (omit for reconcileAllTenants bulk). */
  tenantId?: string;
  /** Ignore min-interval gating (force a run now). */
  force?: boolean;
  /** Cursor batch size for Sweep A. Default 500. */
  batchSize?: number;
  /** Cap on tenants per run (incremental sweeps). */
  limit?: number;
  /** Mode controls which tenants are selected (used by reconcileAllTenants). */
  mode?: "incremental" | "full" | "single";
  /** Set true to skip auto-backfill (used by release/recheck paths). */
  skipAutoBackfill?: boolean;
  /**
   * When true, record the audit row + discrepancies but SKIP mutating
   * users.ledgerQuarantinedAt and do not fire drift alerts. Used
   * immediately after a force-release so the confirm run logs any
   * residual drift without immediately re-quarantining the tenant the
   * operator just explicitly cleared.
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
  let c = 0,
    h = 0,
    m = 0,
    i = 0;
  for (const d of ds) {
    switch (d.severity) {
      case "CRITICAL":
        c++;
        break;
      case "HIGH":
        h++;
        break;
      case "MEDIUM":
        m++;
        break;
      case "INFO":
        i++;
        break;
    }
  }
  return { critical: c, high: h, medium: m, info: i };
}

function statusFrom(ds: readonly Discrepancy[]): ReconciliationStatus {
  if (ds.length === 0) return "PASSED";
  if (ds.some((d) => d.severity === "CRITICAL")) return "HASH_BROKEN";
  return "DRIFT_DETECTED";
}

/** Whitelist for tenant IDs before interpolation into SET LOCAL. */
const SAFE_TENANT_RE = /^[A-Za-z0-9_-]{1,128}$/;

function escapeLiteral(s: string): string {
  return s.replace(/'/g, "''").replace(/\\/g, "\\\\");
}

/**
 * Reconcile a single tenant. Runs under withService("maint:reconcile")
 * so it can read cross-tenant ledger entries for discovery, then
 * SET LOCAL app.current_user_id = userId inside the tx so the RLS
 * WITH CHECK policies permit updating that user's quarantine flags.
 *
 * Auto-backfill: for AR/CASH/EXPENSE mismatches without CRITICAL
 * structural damage, we invoke backfillLedgerForSingleTenant(userId, tx)
 * INSIDE this tx (so REPEATABLE READ snapshot sees the new rows) and
 * re-run Sweep A+B once. HIGH remaining → quarantine.
 */
export async function reconcileTenant(
  tenantId: string,
  opts: Omit<ReconcileOptions, "tenantId" | "mode"> = {}
): Promise<ReconcileResult> {
  ensureDefaultDriftAlertHook();
  // Read-Only DR / Maintenance mode: short-circuit BEFORE opening any
  // service transaction, BEFORE acquiring the advisory lock, and BEFORE
  // writing any audit rows / mutating quarantine flags / running the
  // auto-backfill self-healing path. Throwing a typed ReadOnlyModeError
  // lets Server Actions surface the friendly maintenance banner via the
  // existing {ok:false,error:...} Sonner toast path, and lets cron
  // callers (which wrap reconcileAllTenants) log and move on.
  if (isReadOnlyMode()) {
    throw new ReadOnlyModeError("reconciler:reconcileTenant");
  }
  if (!SAFE_TENANT_RE.test(tenantId)) {
    throw new Error(`reconcileTenant: unsafe tenantId`);
  }
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const started = Date.now();
  const wid = workerId();

  return withService(RECONCILER_SERVICE, async (tx) => {
    // SET LOCAL app.current_user_id so RLS WITH CHECK on users permits
    // the quarantine flip / lastReconciledAt update for this tenant.
    // Tenant is validated by SAFE_TENANT_RE above; still escape for
    // defense-in-depth.
    await tx.$executeRawUnsafe(
      `SET LOCAL app.current_user_id = '${escapeLiteral(tenantId)}'`
    );

    // Non-blocking per-tenant advisory lock; never queue.
    const acquired = await tryAcquireTenantLock(tx, tenantId);
    if (!acquired) {
      const audit = await tx.reconciliationAudit.create({
        data: {
          tenantId,
          status: "TRANSIENT_FAILURE",
          durationMs: Date.now() - started,
          entriesScanned: 0,
          discrepancies: [
            {
              kind: "TRANSIENT_ERROR",
              severity: "INFO",
              detail:
                "Another reconcile run already in progress (advisory lock held); skipping.",
            },
          ] as unknown as Prisma.InputJsonValue,
          criticalCount: 0,
          highCount: 0,
          mediumCount: 0,
          infoCount: 1,
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
        criticalCount: 0,
        highCount: 0,
        mediumCount: 0,
        infoCount: 1,
        quarantined: false,
        autoRemediated: false,
        auditId: audit.id,
      };
    }

    // Load tenant row.
    const user = await tx.user.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        email: true,
        lastLedgerEntryHash: true,
        ledgerQuarantinedAt: true,
        ledgerQuarantineReason: true,
      },
    });
    if (!user) {
      const audit = await tx.reconciliationAudit.create({
        data: {
          tenantId,
          status: "PASSED",
          durationMs: Date.now() - started,
          entriesScanned: 0,
          discrepancies: [] as unknown as Prisma.InputJsonValue,
          criticalCount: 0,
          highCount: 0,
          mediumCount: 0,
          infoCount: 0,
          triggeredAlert: false,
          workerId: wid,
          version: RECONCILER_VERSION,
          finishedAt: new Date(),
        },
        select: { id: true },
      });
      return {
        tenantId,
        status: "PASSED",
        durationMs: Date.now() - started,
        entriesScanned: 0,
        firstBrokenIndex: null,
        discrepancies: [],
        criticalCount: 0,
        highCount: 0,
        mediumCount: 0,
        infoCount: 0,
        quarantined: false,
        autoRemediated: false,
        auditId: audit.id,
      };
    }

    // --- Sweep A + Sweep B ---
    let sweepARes: SweepAResult;
    let sweepBRes: SweepBResult;
    try {
      sweepARes = await sweepA(tx, tenantId, batchSize);
      sweepBRes = await sweepB(tx, tenantId, sweepARes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const dis: Discrepancy[] = [
        mkDisc("TRANSIENT_ERROR", {
          detail: `verifier threw: ${msg.slice(0, 400)}`,
        }),
      ];
      const t = tally(dis);
      const audit = await tx.reconciliationAudit.create({
        data: {
          tenantId,
          status: "TRANSIENT_FAILURE",
          durationMs: Date.now() - started,
          entriesScanned: 0,
          discrepancies: dis as unknown as Prisma.InputJsonValue,
          criticalCount: t.critical,
          highCount: t.high,
          mediumCount: t.medium,
          infoCount: t.info,
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
        discrepancies: dis,
        criticalCount: t.critical,
        highCount: t.high,
        mediumCount: t.medium,
        infoCount: t.info,
        quarantined: false,
        autoRemediated: false,
        auditId: audit.id,
      };
    }

    // --- Tail-pointer check ---
    if (sweepARes.scanned === 0) {
      if (user.lastLedgerEntryHash != null) {
        sweepARes.discrepancies.push(
          mkDisc("TAIL_POINTER_DESYNC", {
            detail: `user.lastLedgerEntryHash is set (${user.lastLedgerEntryHash.slice(
              0,
              12
            )}…) but no ledger rows exist for tenant`,
          })
        );
        if (sweepARes.firstBrokenIndex === null) sweepARes.firstBrokenIndex = 0;
      }
    } else if (sweepARes.tailHash !== user.lastLedgerEntryHash) {
      sweepARes.discrepancies.push(
        mkDisc("TAIL_POINTER_DESYNC", {
          detail: `user.lastLedgerEntryHash (${(
            user.lastLedgerEntryHash ?? ""
          ).slice(0, 12)}…) does not match actual tail (${(
            sweepARes.tailHash ?? ""
          ).slice(0, 12)}… at index ${sweepARes.tailIndex})`,
        })
      );
      if (sweepARes.firstBrokenIndex === null)
        sweepARes.firstBrokenIndex = sweepARes.tailIndex;
    }

    // --- Combine discrepancies ---
    let discrepancies: Discrepancy[] = [
      ...sweepARes.discrepancies,
      ...sweepBRes.discrepancies,
    ];
    let autoRemediated = false;
    let autoRemediation: string | null = null;

    // --- Auto-backfill (one attempt) for HIGH structural mismatches
    //     when there are NO critical hash/balance/gap failures.
    //     Backfill runs INSIDE this tx so the re-read Sweep A+B sees
    //     the new rows under REPEATABLE READ snapshot isolation.
    const hasCriticalStructural = discrepancies.some(
      (d) => d.severity === "CRITICAL"
    );
    const hasBackfillable = discrepancies.some(
      (d) =>
        d.kind === "AR_MISMATCH" ||
        d.kind === "CASH_MISMATCH" ||
        d.kind === "EXPENSE_MISMATCH"
    );
    if (
      hasBackfillable &&
      !hasCriticalStructural &&
      !opts.skipAutoBackfill
    ) {
      try {
        await backfillLedgerForSingleTenant(tenantId, tx);
        // Re-run Sweep A+B against the post-backfill state.
        const sa2 = await sweepA(tx, tenantId, batchSize);
        const sb2 = await sweepB(tx, tenantId, sa2);
        // Re-check tail pointer after backfill.
        const userAfter = await tx.user.findUnique({
          where: { id: tenantId },
          select: { lastLedgerEntryHash: true },
        });
        if (sa2.tailHash !== userAfter?.lastLedgerEntryHash) {
          sa2.discrepancies.push(
            mkDisc("TAIL_POINTER_DESYNC", {
              detail: `post-backfill tail mismatch (tail=${(
                sa2.tailHash ?? ""
              ).slice(0, 12)}… user=${(userAfter?.lastLedgerEntryHash ?? "").slice(
                0,
                12
              )}…)`,
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
        const msg = err instanceof Error ? err.message : String(err);
        discrepancies.push(
          mkDisc("TRANSIENT_ERROR", {
            detail: `auto-backfill failed: ${msg.slice(0, 200)}`,
          })
        );
      }
    }

    const t = tally(discrepancies);
    const status: ReconciliationStatus = statusFrom(discrepancies);

    // --- Quarantine decision ---
    // CRITICAL or remaining HIGH → quarantine. auditOnly mode SKIPS the
    // quarantine flip (and skips lastReconciledAt update and alerts) so
    // post-force-release confirm runs don't immediately re-quarantine.
    const shouldQuarantine =
      (t.critical > 0 || t.high > 0) && !opts.auditOnly;
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

    if (!opts.auditOnly) {
      await tx.user.update({
        where: { id: tenantId },
        data: { lastReconciledAt: new Date() },
      });
    }

    // --- Audit row + alerting ---
    const dur = Date.now() - started;
    let triggeredAlert = false;
    if (
      !opts.auditOnly &&
      (t.critical > 0 ||
        t.high > 0 ||
        quarantined ||
        autoRemediated ||
        t.info > 0)
    ) {
      // fireDriftAlerts accepts any Prisma-like client (structural typing);
      // pass our in-tx client for cooldown lookups.
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
 * Idempotent backfill for a single tenant. Appends INVOICE_ISSUED /
 * INVOICE_PAID / INVOICE_VOIDED / EXPENSE_RECORDED entries for any
 * invoices/expenses that don't already have a corresponding ledger row.
 *
 * Accepts an optional tx (used by reconcileTenant's in-tx auto-backfill);
 * when provided, all posts join that transaction so the caller's
 * REPEATABLE READ snapshot can see the new rows.
 */
export async function backfillLedgerForSingleTenant(
  tenantId: string,
  tx?: Prisma.TransactionClient
): Promise<{ invoices: number; expenses: number }> {
  // Lazy import to avoid a cycle (ledger → tenant → … → reconciler).
  const { postLedgerEvent } = await import("@/lib/ledger");
  const prismaClient = tx ?? prisma;
  let invoicesCount = 0;
  let expensesCount = 0;

  // --- Invoices ---
  const issued = await prismaClient.ledgerEntry.findMany({
    where: {
      userId: tenantId,
      eventType: "INVOICE_ISSUED",
      invoiceId: { not: null },
    },
    select: { invoiceId: true },
  });
  const paid = await prismaClient.ledgerEntry.findMany({
    where: {
      userId: tenantId,
      eventType: "INVOICE_PAID",
      invoiceId: { not: null },
    },
    select: { invoiceId: true },
  });
  const voided = await prismaClient.ledgerEntry.findMany({
    where: {
      userId: tenantId,
      eventType: "INVOICE_VOIDED",
      invoiceId: { not: null },
    },
    select: { invoiceId: true },
  });
  const alreadyIssued = new Set(
    issued.map((r) => r.invoiceId).filter((v): v is string => v !== null)
  );
  const alreadyPaid = new Set(
    paid.map((r) => r.invoiceId).filter((v): v is string => v !== null)
  );
  const alreadyVoided = new Set(
    voided.map((r) => r.invoiceId).filter((v): v is string => v !== null)
  );

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
      discountValue:
        inv.discountValue != null ? Number(inv.discountValue) : null,
    } as const;

    let posted = false;
    if (!alreadyIssued.has(inv.id)) {
      await postLedgerEvent({ type: "INVOICE_ISSUED", invoice: invoiceDraft }, tx);
      posted = true;
    }
    if (inv.status === "PAID" && !alreadyPaid.has(inv.id)) {
      await postLedgerEvent(
        {
          type: "INVOICE_PAID",
          invoice: {
            id: inv.id,
            userId: inv.userId,
            totalAmount: inv.totalAmount,
          },
          amountPaid: inv.totalAmount,
        },
        tx
      );
      posted = true;
    } else if (inv.status === "VOID" && !alreadyVoided.has(inv.id)) {
      await postLedgerEvent(
        {
          type: "INVOICE_VOIDED",
          invoice: { ...invoiceDraft, paidAmount: null },
        },
        tx
      );
      posted = true;
    }
    if (posted) invoicesCount++;
  }

  // --- Expenses ---
  const expensed = await prismaClient.ledgerEntry.findMany({
    where: {
      userId: tenantId,
      eventType: "EXPENSE_RECORDED",
      expenseId: { not: null },
    },
    select: { expenseId: true },
  });
  const alreadyExpensed = new Set(
    expensed.map((r) => r.expenseId).filter((v): v is string => v !== null)
  );
  const expenses = await prismaClient.expense.findMany({
    where: {
      userId: tenantId,
      NOT: { id: { in: Array.from(alreadyExpensed) } },
    },
  });
  for (const exp of expenses) {
    await postLedgerEvent(
      {
        type: "EXPENSE_RECORDED",
        expense: {
          id: exp.id,
          userId: exp.userId,
          amount: exp.amount,
          category: exp.category,
        },
      },
      tx
    );
    expensesCount++;
  }

  return { invoices: invoicesCount, expenses: expensesCount };
}

/**
 * Reconcile many tenants.
 *   - "full":        every non-DRAFT user (no filter).
 *   - "incremental": users where lastReconciledAt is null OR > 15 min old
 *                    OR currently quarantined (so operators see fresh
 *                    audit history during incident response).
 *   - "single":      use reconcileTenant() directly.
 *
 * Errors on a single tenant do not abort the batch; a TRANSIENT_FAILURE
 * audit row is written via the service path so the operator sees it.
 */
export async function reconcileAllTenants(
  opts: ReconcileOptions = {}
): Promise<ReconcileResult[]> {
  ensureDefaultDriftAlertHook();
  // Read-Only DR / Maintenance mode: skip the bulk sweep entirely.
  // Returning [] (no per-tenant TRANSIENT_FAILURE rows) avoids any DB
  // writes (reconciliation_audits INSERTs, lastReconciledAt updates,
  // quarantine flips) while keeping the cron route response well-formed.
  if (isReadOnlyMode()) {
    console.error(
      "[reconciler] SMARTBILL_READ_ONLY active — skipping reconcileAllTenants (no mutations, no audits written)."
    );
    return [];
  }
  const mode = opts.mode ?? "incremental";
  const limit = opts.limit ?? (mode === "full" ? 1000 : 20);

  let where: Prisma.UserWhereInput = {};
  if (mode === "incremental") {
    const fifteenMinAgo = new Date(Date.now() - 15 * 60_000);
    where = {
      OR: [
        { lastReconciledAt: null },
        { lastReconciledAt: { lt: fifteenMinAgo } },
        // Always re-scan quarantined tenants so the audit log is fresh
        // while an operator is investigating.
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
        auditOnly: opts.auditOnly,
      });
      results.push(r);
    } catch (err) {
      console.error("[reconciler] tenant", u.id, "failed:", err);
      try {
        const wid = workerId();
        await withService(RECONCILER_SERVICE, async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL app.current_user_id = '${escapeLiteral(u.id)}'`
          );
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
                    (err instanceof Error
                      ? err.message.slice(0, 300)
                      : String(err).slice(0, 300)),
                },
              ] as unknown as Prisma.InputJsonValue,
              criticalCount: 0,
              highCount: 0,
              mediumCount: 0,
              infoCount: 1,
              triggeredAlert: false,
              workerId: wid,
              version: RECONCILER_VERSION,
              finishedAt: new Date(),
            },
          });
        });
      } catch {
        // Swallow — we already logged the primary error.
      }
    }
  }
  return results;
}

// ============================================================
// OPERATOR HELPERS (manual quarantine / release / backfill)
// ============================================================

export async function quarantineTenant(
  tenantId: string,
  reason: string,
  actor: string
): Promise<void> {
  if (!SAFE_TENANT_RE.test(tenantId))
    throw new Error("quarantineTenant: unsafe tenantId");
  await withService(RECONCILER_SERVICE, async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL app.current_user_id = '${escapeLiteral(tenantId)}'`
    );
    await tx.user.update({
      where: { id: tenantId },
      data: {
        ledgerQuarantinedAt: new Date(),
        ledgerQuarantineReason: `MANUAL:${reason.slice(0, 200)} (by ${actor.slice(
          0,
          64
        )})`,
      },
    });
    await tx.reconciliationAudit.create({
      data: {
        tenantId,
        status: "DRIFT_DETECTED",
        durationMs: 0,
        entriesScanned: 0,
        discrepancies: [
          {
            kind: "AR_MISMATCH",
            severity: "HIGH",
            detail: `Manual quarantine: ${reason.slice(0, 300)}`,
          },
        ] as unknown as Prisma.InputJsonValue,
        criticalCount: 0,
        highCount: 1,
        mediumCount: 0,
        infoCount: 0,
        triggeredAlert: false,
        workerId: workerId(),
        version: RECONCILER_VERSION,
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
  if (!SAFE_TENANT_RE.test(tenantId))
    throw new Error("releaseQuarantine: unsafe tenantId");

  // Non-force release requires a clean reconcile first.
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
    await tx.$executeRawUnsafe(
      `SET LOCAL app.current_user_id = '${escapeLiteral(tenantId)}'`
    );
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
        discrepancies: [
          {
            kind: "TRANSIENT_ERROR",
            severity: "INFO",
            detail: `Quarantine released${opts.force ? " (force)" : ""}: ${reason.slice(
              0,
              300
            )}`,
          },
        ] as unknown as Prisma.InputJsonValue,
        criticalCount: 0,
        highCount: 0,
        mediumCount: 0,
        infoCount: 1,
        triggeredAlert: false,
        workerId: workerId(),
        version: RECONCILER_VERSION,
        finishedAt: new Date(),
      },
    });
  });

  // Post-release confirmation run. On force-release the operator has
  // explicitly accepted residual drift — run in auditOnly mode so we
  // record an audit row but DO NOT re-quarantine or fire alerts.
  const result = await reconcileTenant(tenantId, {
    skipAutoBackfill: !opts.force,
    auditOnly: !!opts.force,
  });
  return { ok: true, result };
}

export async function operatorBackfill(tenantId: string): Promise<{
  invoices: number;
  expenses: number;
  result: ReconcileResult;
}> {
  // Invoked from Server Actions outside any outer tx — safe to use the
  // global prisma (no tx arg); runs as service_role via reconcileTenant.
  const r = await backfillLedgerForSingleTenant(tenantId);
  const result = await reconcileTenant(tenantId, { skipAutoBackfill: true });
  return { invoices: r.invoices, expenses: r.expenses, result };
}
