/**
 * Server data getters for the Admin Ledger Audit Console (RSC READ-ONLY).
 *
 * -------------------------------------------------------------------
 * BOUNDARY NOTE: this module is intentionally NOT marked `"use server"`.
 * All exports are plain async server functions intended to be called
 * from:
 *   - The RSC page at src/app/(dashboard)/admin/ledger/page.tsx (server)
 *   - Server Actions in ./mutations.ts (server → server, for post-
 *     mutation hydration)
 *
 * They are NOT imported directly by any `"use client"` component — all
 * client-triggered work (pagination "Load More", reconcile/release/
 * quarantine/backfill) goes through the explicit Server Actions in
 * ./mutations.ts, which carries the module-level `"use server"` directive.
 *
 * Keeping pure data loaders OUT of the Server Action boundary avoids
 * bundling them into the client action manifest, keeps the RSC→client
 * payload smaller, and gives a clean semantic split:
 *   actions.ts    → queries (read-only, RSC-callable, server-only module)
 *   mutations.ts  → commands (state-mutating + client-invoked pagination,
 *                   wrapped as `"use server"` Server Actions)
 *
 * Every getter enforces its own auth + tenant isolation regardless of
 * the lack of a directive — defense in depth.
 * -------------------------------------------------------------------
 *
 * Every getter:
 *   1. Authenticates via requireUser() (NextAuth session); redirects /login
 *      on miss.
 *   2. Enforces tenant isolation — validates tenantId against the CUID-safe
 *      regex and asserts tenantId === session.user.id (no cross-tenant
 *      reads; no IDOR).
 *   3. Runs under withTenant(uid, fn, { allowQuarantinedRead: true }) so
 *      quarantined tenants CAN READ their own diagnostic state (writes
 *      remain blocked at the helper + Postgres trigger layers).
 *
 * Monetary values are returned as STRINGIFIED integer paise (BigInt
 * .toString()) — no JavaScript floating-point math is used anywhere in
 * the read model, and BigInts never cross the RSC/Server-Action boundary
 * directly (they are not JSON-serializable across React's flight layer).
 */
import "server-only";

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
// TYPES  (Serializable across RSC — no BigInts; paise are strings)
// ============================================================

export interface TenantAuditOverview {
  tenantId: string;
  tenantEmail: string;
  /** Ledger tail pointer state. */
  lastLedgerEntryHash: string | null;
  lastLedgerEntryId: string | null;
  /** Quarantine state (null = healthy / not quarantined). */
  ledgerQuarantinedAt: string | null;
  ledgerQuarantineReason: string | null;
  /** Timestamp of the most recent reconciler run (any status). */
  lastReconciledAt: string | null;
  /** Latest audit run (most recent by startedAt). */
  latestAudit: AuditRunSummary | null;
  /** Last-30-day run counts by status. */
  runCounts: {
    passed: number;
    driftDetected: number;
    hashBroken: number;
    transientFailure: number;
  };
  /** Open AR balance (Σ PENDING invoice totals) in paise. */
  openReceivablePaise: string;
  /** Ledger AR balance (ΣD − ΣC on ACCOUNTS_RECEIVABLE) in paise. */
  ledgerArPaise: string;
  /** Ledger CASH balance (ΣD − ΣC on CASH) in paise. */
  ledgerCashPaise: string;
  /** Σ PAID-invoice totals (read-model reference point) in paise. */
  paidTotalPaise: string;
  /** Σ expenses in paise. */
  expenseTotalPaise: string;
  /**
   * Expected CASH balance derived from signed ledger movements across
   * recognized cash event types (INVOICE_PAID, PAYMENT_REVERSED,
   * EXPENSE_RECORDED, INVOICE_VOIDED). Compared to ledgerCashPaise by
   * Sweep B; surfaced here for the HealthBanner Δ indicator.
   */
  expectedCashPaise: string;
  /** Tenant currency (default INR). */
  currency: string;
}

export interface AuditRunSummary {
  id: string;
  startedAt: string;
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
  amountPaise: string;
  prevEntryHash: string;
  entryHash: string;
  invoiceId: string | null;
  expenseId: string | null;
  currency: string;
  note: string | null;
  createdAt: string;
}

/**
 * Paginated hash-chain result. Entries are always ordered entryIndex DESC
 * (newest first) so the UI's table starts at the chain tail.
 */
export interface LedgerChainPage {
  entries: LedgerChainEntry[];
  /**
   * Cursor to pass to the next loadMoreLedgerEntriesAction call. Null when
   * the client has reached the genesis entry (no older rows remain).
   */
  nextCursor: string | null;
}

// ============================================================
// VALIDATION / SERIALIZATION
// ============================================================

const SAFE_USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_CURRENCY = "INR";

/**
 * Normalize and enforce tenant isolation: returns the uid the caller
 * may access. If tenantId is provided it must match the session user id
 * (strict equality after regex validation); otherwise defaults to the
 * session user. On mismatch, redirect to /login rather than leaking a
 * sibling tenant's data.
 */
function assertUserId(
  sessionUserId: string,
  tenantId: string | undefined
): string {
  const uid =
    typeof tenantId === "string" && tenantId.length > 0
      ? tenantId
      : sessionUserId;
  if (!SAFE_USER_ID_RE.test(uid) || uid !== sessionUserId) {
    redirect("/login");
  }
  return uid;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function serializeAudit(a: ReconciliationAudit): AuditRunSummary {
  type Disc = AuditRunSummary["discrepancies"][number];
  let discrepancies: Disc[] = [];
  if (Array.isArray(a.discrepancies)) {
    discrepancies = (a.discrepancies as unknown as Disc[]).map((d) => ({
      kind: typeof d?.kind === "string" ? d.kind : "UNKNOWN",
      severity:
        d &&
        typeof d === "object" &&
        "severity" in d &&
        (d.severity === "CRITICAL" ||
          d.severity === "HIGH" ||
          d.severity === "MEDIUM" ||
          d.severity === "INFO")
          ? d.severity
          : "INFO",
      account:
        d && typeof d === "object" && "account" in d && typeof d.account === "string"
          ? d.account
          : undefined,
      expectedPaise:
        d && typeof d === "object" && "expectedPaise" in d && typeof d.expectedPaise === "string"
          ? d.expectedPaise
          : undefined,
      actualPaise:
        d && typeof d === "object" && "actualPaise" in d && typeof d.actualPaise === "string"
          ? d.actualPaise
          : undefined,
      diffPaise:
        d && typeof d === "object" && "diffPaise" in d && typeof d.diffPaise === "string"
          ? d.diffPaise
          : undefined,
      detail:
        d && typeof d === "object" && "detail" in d && typeof d.detail === "string"
          ? d.detail
          : undefined,
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

/**
 * Clamp a user-supplied limit to the legal integer range [1, 200].
 * Non-numeric, NaN, negative, zero, and over-cap inputs are folded to
 * sensible defaults so a poisoned query parameter cannot trigger a
 * pathological `take: 1e9` Prisma query or a `take: 0` empty result.
 */
function clampLimit(raw: unknown, fallback: number = 50): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return Math.min(Math.max(fallback | 0, 1), 200);
  return Math.min(Math.max(Math.trunc(n), 1), 200);
}

// ============================================================
// PUBLIC GETTERS
// ============================================================

/**
 * Overview: quarantine state, latest audit summary, last-30-day run
 * counts, and the key balance cross-check numbers used by the UI's
 * HealthBanner + metric grid. All balances are stringified integer
 * paise (BigInt-safe serialization).
 *
 * If tenantId is omitted, defaults to the signed-in user's own id.
 */
export async function getTenantAuditOverview(
  tenantId?: string
): Promise<TenantAuditOverview> {
  const session = await requireUser();
  if (!session) redirect("/login");
  const uid = assertUserId(session.id, tenantId);

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

      // Latest audit run.
      const latest = await tx.reconciliationAudit.findFirst({
        where: { tenantId: uid },
        orderBy: { startedAt: "desc" },
      });

      // Last-30-day run counts by status.
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recent = await tx.reconciliationAudit.findMany({
        where: { tenantId: uid, startedAt: { gte: since } },
        select: { status: true },
      });
      const counts = {
        passed: 0,
        driftDetected: 0,
        hashBroken: 0,
        transientFailure: 0,
      };
      for (const r of recent) {
        switch (r.status) {
          case "PASSED":
            counts.passed++;
            break;
          case "DRIFT_DETECTED":
            counts.driftDetected++;
            break;
          case "HASH_BROKEN":
            counts.hashBroken++;
            break;
          case "TRANSIENT_FAILURE":
            counts.transientFailure++;
            break;
        }
      }

      // ---- Read-model aggregates (integer paise, no float math) ----
      //
      // openReceivable = Σ ROUND(totalAmount * 100) for PENDING invoices.
      // paidTotal      = Σ ROUND(totalAmount * 100) for PAID invoices
      //                  (reference point; CASH balance is derived from
      //                  signed ledger movements below, because refunds/
      //                  chargebacks post PAYMENT_REVERSED Cr CASH that
      //                  invoice.status alone cannot see).
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

      // Ledger-side per-account signed balances (D − C), cast to numeric
      // in SQL to keep BigInt binding out of $queryRaw; parsed back to
      // BigInt from the returned text column.
      const ledgerRows = await tx.$queryRaw<
        Array<{ account: string; signed_balance: string }>
      >`
        SELECT account,
          COALESCE(SUM(CASE
            WHEN side='DEBIT'  THEN  "amountPaise"::numeric
            WHEN side='CREDIT' THEN -"amountPaise"::numeric
            ELSE 0 END), 0)::text AS signed_balance
        FROM ledger_entries WHERE "userId" = ${uid} GROUP BY account
      `;
      const ledger: Record<string, bigint> = {};
      for (const r of ledgerRows) ledger[r.account] = BigInt(r.signed_balance);
      const ar = ledger.ACCOUNTS_RECEIVABLE ?? BigInt(0);
      const cash = ledger.CASH ?? BigInt(0);

      // Expected CASH = signed sum of CASH movements across the event types
      // legitimately allowed to post to cash (INVOICE_PAID Dr,
      // PAYMENT_REVERSED Cr, EXPENSE_RECORDED Cr, INVOICE_VOIDED Cr when
      // a paid invoice is voided). Mirrors Sweep B's CASH logic.
      const cashEvtRows = await tx.$queryRaw<
        Array<{ signed_balance: string }>
      >`
        SELECT COALESCE(SUM(CASE
                 WHEN side='DEBIT'  THEN  "amountPaise"::numeric
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

/**
 * Fetch a page of the hash chain, ordered by entryIndex DESC (newest first —
 * the UI shows the chain tail at the top). Default `limit` 50; hard cap 200
 * (clamped via clampLimit()).
 *
 * Keyset pagination: when `opts.cursor` is provided (a LedgerEntry.id),
 * resolve that entry's entryIndex and return rows strictly older
 * (entryIndex < cursorIndex). The caller does not need to know about
 * entryIndex; opaque id-based cursors keep the UI code simple.
 *
 * We fetch LIMIT+1 rows internally to detect "has more" without a separate
 * COUNT query: if we get back LIMIT+1 rows we drop the last one from the
 * returned payload and set nextCursor to that row's id. Otherwise
 * nextCursor is null (reached genesis).
 *
 * Invalid-cursor hardening:
 *   - Non-string / non-CUID-shape cursors are treated as "first page"
 *     rather than reaching the DB with a garbage predicate.
 *   - Cursors that reference a missing/already-deleted/cross-tenant row
 *     return `{ entries: [], nextCursor: null }` after emitting one
 *     server-side warning. This is the cleanest fail-safe: the UI's
 *     "Load More" button hides (nextCursor === null) so we cannot enter
 *     an infinite loop of "cursor not found → retry same cursor"; a
 *     subsequent refreshChain() (which uses cursor=null) resets to the
 *     real tail. Falling back to tail-fetch here would race with the
 *     UI's append-mode rendering and risk duplicating entries.
 */
export async function getLedgerChainEntries(
  tenantId: string,
  opts?: number | { limit?: number; cursor?: string | null }
): Promise<LedgerChainPage> {
  const session = await requireUser();
  if (!session) redirect("/login");
  const uid = assertUserId(session.id, tenantId);

  // Normalize legacy positional `limit` argument into the opts object.
  let rawLimit: unknown = 50;
  let cursorId: string | null = null;
  if (typeof opts === "number") {
    rawLimit = opts;
    cursorId = null;
  } else if (opts && typeof opts === "object") {
    rawLimit = opts.limit ?? 50;
    const c = opts.cursor;
    // Treat empty/whitespace strings and explicit null as "no cursor".
    if (typeof c === "string") {
      const trimmed = c.trim();
      if (trimmed.length > 0) cursorId = trimmed;
    }
  }
  const capped = clampLimit(rawLimit, 50);
  // Fetch one extra row as a "has more" sentinel.
  const take = capped + 1;

  return withTenant(
    uid,
    async (tx) => {
      // Shape-check cursors before hitting the DB. Matches the same
      // CUID-safe regex used for user ids; rejects URLs, JSON blobs, and
      // other client-side garbage without a round-trip.
      let cursorInvalid = false;
      if (cursorId !== null && !SAFE_USER_ID_RE.test(cursorId)) {
        cursorInvalid = true;
      }

      let cursorIndex: number | null = null;
      if (!cursorInvalid && cursorId !== null) {
        // Resolve the cursor row's entryIndex to drive the keyset filter.
        // Filtering BOTH by userId and id guarantees the (userId,
        // entryIndex) composite index is used and prevents cross-tenant
        // cursor reuse — a cursor from tenant A cannot page tenant B's
        // chain even if the id happens to collide.
        const cursorRow = await tx.ledgerEntry.findFirst({
          where: { id: cursorId, userId: uid },
          select: { entryIndex: true },
        });
        if (!cursorRow) {
          cursorInvalid = true;
        } else {
          cursorIndex = cursorRow.entryIndex;
        }
      }

      if (cursorInvalid) {
        console.error(
          `[admin/ledger] getLedgerChainEntries: invalid or unresolvable cursor for tenant ${uid}` +
            (cursorId ? ` (cursor id="${cursorId.slice(0, 12)}…")` : "") +
            " — returning terminal empty page to break pagination loop."
        );
        return { entries: [], nextCursor: null };
      }

      const where =
        cursorIndex !== null
          ? { userId: uid, entryIndex: { lt: cursorIndex } }
          : { userId: uid };

      const rows = await tx.ledgerEntry.findMany({
        where,
        orderBy: { entryIndex: "desc" },
        take,
      });

      let nextCursor: string | null = null;
      let page = rows;
      if (rows.length > capped) {
        // The extra row signals more data exists; it becomes the next
        // cursor. Guard against the pathological case (should be
        // impossible with the LIMIT+1 idiom, but belt-and-braces).
        const sentinel = rows[capped];
        if (sentinel) {
          page = rows.slice(0, capped);
          nextCursor = sentinel.id;
        }
      }

      return { entries: page.map(serializeEntry), nextCursor };
    },
    { allowQuarantinedRead: true }
  );
}

/**
 * Fetch recent reconciliation audits ordered by startedAt DESC. Default
 * `limit` 25; hard cap 200.
 */
export async function listReconciliationAudits(
  tenantId: string,
  limit: number = 25
): Promise<AuditRunSummary[]> {
  const session = await requireUser();
  if (!session) redirect("/login");
  const uid = assertUserId(session.id, tenantId);
  const capped = clampLimit(limit, 25);

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
