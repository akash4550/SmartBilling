"use server";

/**
 * Server data getters for the Admin Ledger Audit Console.
 *
 * Every function:
 *   1. Authenticates the caller via requireUser() (NextAuth session).
 *   2. Redirects to /login if no session.
 *   3. Enforces tenant scoping — users only see their OWN ledger state
 *      (we never expose cross-tenant data to the UI).
 *   4. Runs under `withTenant(allowQuarantinedRead:true)` so quarantined
 *      tenants CAN READ their own state (operators need visibility to
 *      diagnose; writes are still blocked at the helper + trigger layers).
 *
 * Monetary values are returned as STRINGIFIED integer paise — no floats
 * cross the wire. Client components format them with Intl.NumberFormat.
 */
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { withTenant } from "@/lib/tenant";
import { requireUser } from "@/lib/api-helpers";
import type {
  AccountType,
  EntrySide,
  LedgerEventType,
  ReconciliationAudit,
  ReconciliationStatus,
  LedgerEntry,
} from "@prisma/client";

// ============================================================
// TYPES  (Serializable — no BigInts; all paise are strings)
// ============================================================

export interface TenantAuditOverview {
  tenantId: string;
  tenantEmail: string;
  /** Ledger tail pointer state. */
  lastLedgerEntryHash: string | null;
  lastLedgerEntryId: string | null;
  /** Quarantine state (null = healthy). */
  ledgerQuarantinedAt: string | null;          // ISO string or null
  ledgerQuarantineReason: string | null;
  /** Timestamp of the most recent reconciler run (any status). */
  lastReconciledAt: string | null;            // ISO string or null
  /** Latest audit run (most recent by startedAt). */
  latestAudit: AuditRunSummary | null;
  /** Recent 30-day run counts by status. */
  runCounts: {
    passed: number;
    driftDetected: number;
    hashBroken: number;
    transientFailure: number;
  };
  /** Current open AR balance (Σ PENDING invoices) in paise. */
  openReceivablePaise: string;
  /** Ledger AR balance (Σ D − Σ C on ACCOUNTS_RECEIVABLE) in paise. */
  ledgerArPaise: string;
  /** Ledger CASH balance in paise. */
  ledgerCashPaise: string;
  /** Σ PAID invoices in paise. */
  paidTotalPaise: string;
  /** Σ expenses in paise. */
  expenseTotalPaise: string;
  /** Tenant currency (default INR). */
  currency: string;
}

export interface AuditRunSummary {
  id: string;
  startedAt: string;          // ISO
  finishedAt: string | null;
  durationMs: number | null;
  status: ReconciliationStatus;
  entriesScanned: number;
  firstBrokenIndex: number | null;
  discrepancies: Array<{
    kind: string;
    severity: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
    account?: string;
    expectedPaise?: string;
    actualPaise?: string;
    diffPaise?: string;
    detail?: string;
  }>;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  infoCount: number;
  autoRemediated: boolean;
  workerId: string | null;
  version: string;
}

export interface LedgerChainEntry {
  id: string;
  entryIndex: number;
  eventId: string;
  eventType: LedgerEventType;
  account: AccountType;
  side: EntrySide;
  amountPaise: string;       // BigInt → string
  prevEntryHash: string;
  entryHash: string;
  invoiceId: string | null;
  expenseId: string | null;
  currency: string;
  note: string | null;
  createdAt: string;         // ISO
}

// ============================================================
// VALIDATION
// ============================================================

const SAFE_USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_CURRENCY = "INR";

function assertUserId(
  sessionUserId: string,
  tenantId: string | undefined
): string {
  const uid =
    typeof tenantId === "string" && tenantId.length > 0
      ? tenantId
      : sessionUserId;
  if (!SAFE_USER_ID_RE.test(uid) || uid !== sessionUserId) {
    // Tenant isolation violation or bad input — redirect to login rather
    // than leaking another tenant's data.
    redirect("/login");
  }
  return uid;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function serializeAudit(a: ReconciliationAudit): AuditRunSummary {
  // discrepancies is Prisma.Json — narrow to the expected shape.
  type Disc = AuditRunSummary["discrepancies"][number];
  let discrepancies: Disc[] = [];
  if (Array.isArray(a.discrepancies)) {
    discrepancies = (a.discrepancies as unknown as Disc[]).map((d) => ({
      kind: String(d.kind ?? "UNKNOWN"),
      severity: (d.severity as Disc["severity"]) ?? "INFO",
      account: typeof d.account === "string" ? d.account : undefined,
      expectedPaise: typeof d.expectedPaise === "string" ? d.expectedPaise : undefined,
      actualPaise: typeof d.actualPaise === "string" ? d.actualPaise : undefined,
      diffPaise: typeof d.diffPaise === "string" ? d.diffPaise : undefined,
      detail: typeof d.detail === "string" ? d.detail : undefined,
    }));
  }
  return {
    id: a.id,
    startedAt: a.startedAt.toISOString(),
    finishedAt: iso(a.finishedAt),
    durationMs: a.durationMs,
    status: a.status,
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

function serializeEntry(e: LedgerEntry): LedgerChainEntry {
  return {
    id: e.id,
    entryIndex: e.entryIndex,
    eventId: e.eventId,
    eventType: e.eventType,
    account: e.account,
    side: e.side,
    amountPaise: e.amountPaise.toString(),
    prevEntryHash: e.prevEntryHash,
    entryHash: e.entryHash,
    invoiceId: e.invoiceId,
    expenseId: e.expenseId,
    currency: e.currency,
    note: e.note,
    createdAt: e.createdAt.toISOString(),
  };
}

// ============================================================
// PUBLIC GETTERS
// ============================================================

/**
 * Overview: quarantine state, latest audit, and key balance cross-checks.
 * If tenantId is omitted the signed-in user's id is used. All balance
 * numbers are returned as stringified paise BigInts.
 */
export async function getTenantAuditOverview(
  tenantId?: string
): Promise<TenantAuditOverview> {
  const user = await requireUser();
  if (!user) redirect("/login");
  const uid = assertUserId(user.id, tenantId);

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
      if (!u) redirect("/login");

      const settings = await tx.settings.findUnique({
        where: { userId: uid },
        select: { currency: true },
      });
      const currency = settings?.currency || DEFAULT_CURRENCY;

      // Latest audit.
      const latest = await tx.reconciliationAudit.findFirst({
        where: { tenantId: uid },
        orderBy: { startedAt: "desc" },
      });

      // Last-30-day counts by status.
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recent = await tx.reconciliationAudit.findMany({
        where: { tenantId: uid, startedAt: { gte: since } },
        select: { status: true },
      });
      const counts = { passed: 0, driftDetected: 0, hashBroken: 0, transientFailure: 0 };
      for (const r of recent) {
        if (r.status === "PASSED") counts.passed++;
        else if (r.status === "DRIFT_DETECTED") counts.driftDetected++;
        else if (r.status === "HASH_BROKEN") counts.hashBroken++;
        else if (r.status === "TRANSIENT_FAILURE") counts.transientFailure++;
      }

      // ---- Balance cross-checks (matches sweepB logic exactly) ----
      // Note: the expected CASH balance = Σ INVOICE_PAID Dr − Σ PAYMENT_REVERSED Cr −
      // Σ EXPENSE_RECORDED Cr. We compute these from the ledger directly rather
      // than relying on invoice.status = PAID, because refunds/chargebacks post
      // PAYMENT_REVERSED (Cr CASH) that invoice.status alone cannot see.
      const invAgg = await tx.$queryRaw<
        Array<{ status: string; total_paise: string }>
      >`
        SELECT status,
               COALESCE(SUM(ROUND(("totalAmount"::numeric * 100))), 0)::text AS total_paise
        FROM invoices
        WHERE "userId" = ${uid}
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

      // Ledger aggregates: account signed balance (D-C) AND event-type
      // subtotals so expected cash can be computed from the ledger itself
      // rather than relying on invoice.status.
      const ledgerRows = await tx.$queryRaw<
        Array<{ account: string; signed_balance: string }>
      >`
        SELECT account,
          COALESCE(SUM(CASE WHEN side='DEBIT' THEN "amountPaise"::numeric ELSE -"amountPaise"::numeric END), 0)::text
            AS signed_balance
        FROM ledger_entries WHERE "userId" = ${uid} GROUP BY account
      `;
      const ledger: Record<string, bigint> = {};
      for (const r of ledgerRows) ledger[r.account] = BigInt(r.signed_balance);
      const ar = ledger.ACCOUNTS_RECEIVABLE ?? BigInt(0);
      const cash = ledger.CASH ?? BigInt(0);

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
        currency,
      } satisfies TenantAuditOverview;
    },
    { allowQuarantinedRead: true }
  );
}

/**
 * Fetch the tail of the hash chain, ordered newest-first. `limit` caps at 200.
 */
export async function getLedgerChainEntries(
  tenantId: string,
  limit: number = 50
): Promise<LedgerChainEntry[]> {
  const user = await requireUser();
  if (!user) redirect("/login");
  const uid = assertUserId(user.id, tenantId);
  const capped = Math.max(1, Math.min(limit | 0, 200));

  return withTenant(
    uid,
    async (tx) => {
      // Select newest first for UI, then reverse for chronological display?
      // We return newest-first so the table shows the tail at the top.
      const rows = await tx.ledgerEntry.findMany({
        where: { userId: uid },
        orderBy: { entryIndex: "desc" },
        take: capped,
      });
      return rows.map(serializeEntry);
    },
    { allowQuarantinedRead: true }
  );
}

/**
 * Fetch recent reconciliation audits, newest-first.
 */
export async function listReconciliationAudits(
  tenantId: string,
  limit: number = 25
): Promise<AuditRunSummary[]> {
  const user = await requireUser();
  if (!user) redirect("/login");
  const uid = assertUserId(user.id, tenantId);
  const capped = Math.max(1, Math.min(limit | 0, 200));

  return withTenant(
    uid,
    async (tx) => {
      const rows = await tx.reconciliationAudit.findMany({
        where: { tenantId: uid },
        orderBy: { startedAt: "desc" },
        take: capped,
      });
      return rows.map(serializeAudit);
    },
    { allowQuarantinedRead: true }
  );
}
