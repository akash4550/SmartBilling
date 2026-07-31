/**
 * Immutable double-entry financial ledger.
 *
 * Properties:
 *  - Append-only. `LedgerEntry` rows are NEVER updated or deleted; RLS
 *    policies grant app_user SELECT + INSERT only (UPDATE/DELETE revoked).
 *    VOID, refund, and write-offs are modeled as reversing entries.
 *  - Balanced: for every eventId, Σ(DEBIT amounts) == Σ(CREDIT amounts) in
 *    integer paise. Enforced twice: (a) in this module at post time via
 *    assertBalanced(), and (b) by the Postgres AFTER INSERT statement
 *    trigger (prisma/ledger.sql) that re-checks per eventId at commit.
 *  - Hash-chained per user:
 *        entryHash = SHA256(prevEntryHash + "|" + canonicalPipeEntry)
 *    The users.lastLedgerEntryHash / lastLedgerEntryId tail pointers are
 *    updated in the same tx as the new entries. The user row is locked
 *    SELECT ... FOR UPDATE during posting so concurrent ledger writes
 *    serialize and cannot fork the chain.
 *  - All amounts are integer SUBUNITS (paise for INR) as BigInt — same
 *    scale used by calcInvoiceTotals() in src/lib/money.ts so there is no
 *    precision drift between invoice totals and ledger postings.
 *
 * Canonical pipe-delimited serialization (deterministic, no JSON):
 *   eventId|eventType|account|side|amountPaise|invoiceId|expenseId|currency
 *
 * Accounts (AccountType enum):
 *   ACCOUNTS_RECEIVABLE  (asset)     Dr when invoice issued,  Cr when paid
 *   REVENUE             (income)    Cr when invoice issued,  Dr when voided
 *   DISCOUNT_CONTRA     (contra-rev) Dr for discount amount (reduces net rev)
 *   TAX_PAYABLE         (liability) Cr when invoice issued,  Dr when voided
 *   CASH                (asset)     Dr when payment received, Cr for expenses
 *   EXPENSES            (expense)   Dr when expense recorded
 */
import "server-only";

import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withTenant } from "@/lib/tenant";
import { calcInvoiceTotals, toSubunit } from "@/lib/money";
import { LedgerQuarantinedError } from "@/lib/errors";

// Re-export for backwards compatibility. Some callers (integration tests,
// webhook processors, catch blocks) import this from @/lib/ledger; the
// canonical class lives in @/lib/errors so instanceof checks across
// modules agree.
export { LedgerQuarantinedError };

/** sha256("smartbill:ledger:genesis") — anchor prevEntryHash for user index 1. */
export const GENESIS_HASH = crypto
  .createHash("sha256")
  .update("smartbill:ledger:genesis")
  .digest("hex");

// ============================================================
// TYPES
// ============================================================

export type Account =
  | "ACCOUNTS_RECEIVABLE"
  | "REVENUE"
  | "DISCOUNT_CONTRA"
  | "TAX_PAYABLE"
  | "CASH"
  | "EXPENSES";

export type LedgerEventInput =
  | {
      type: "INVOICE_ISSUED";
      invoice: {
        id: string;
        userId: string;
        items: Array<{ description?: string; quantity: number; price: number }>;
        taxRate: number;
        discountType?: "PERCENT" | "FIXED" | null;
        discountValue?: number | null;
        currency?: string;
      };
    }
  | {
      type: "INVOICE_PAID";
      invoice: { id: string; userId: string; totalAmount: Prisma.Decimal | number | string; currency?: string };
      amountPaid?: Prisma.Decimal | number | string;
      note?: string;
    }
  | {
      type: "INVOICE_VOIDED";
      invoice: {
        id: string;
        userId: string;
        items: Array<{ description?: string; quantity: number; price: number }>;
        taxRate: number;
        discountType?: "PERCENT" | "FIXED" | null;
        discountValue?: number | null;
        /**
         * Cash amount (paise) to reverse as part of this void. Pass the
         * exact amount of CASH previously posted for this invoice (sum of
         * INVOICE_PAID Dr minus PAYMENT_REVERSED Cr). Use
         * `resolveCashPaidForInvoice()` to derive this from existing
         * ledger entries so partial payments, multiple payments, and
         * post-void reversals all cancel out cleanly.
         *
         * If omitted/nullish and zero, no cash reversal is posted (correct
         * for voiding a PENDING invoice that never received payment).
         */
        paidAmount?: Prisma.Decimal | number | string | bigint | null;
        currency?: string;
      };
    }
  | {
      type: "PAYMENT_REVERSED";
      invoice: { id: string; userId: string; currency?: string };
      amount: Prisma.Decimal | number | string;
      note?: string;
    }
  | {
      type: "EXPENSE_RECORDED";
      expense: { id: string; userId: string; amount: Prisma.Decimal | number | string; category?: string; currency?: string };
    };

interface EntryDraft {
  account: Account;
  side: "DEBIT" | "CREDIT";
  amountPaise: bigint;
}

// ============================================================
// HASHING
// ============================================================

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function serializeForHash(input: {
  eventId: string;
  eventType: string;
  account: string;
  side: string;
  amountPaise: bigint;
  invoiceId: string | null;
  expenseId: string | null;
  currency: string;
}): string {
  return [
    input.eventId,
    input.eventType,
    input.account,
    input.side,
    input.amountPaise.toString(),
    input.invoiceId ?? "",
    input.expenseId ?? "",
    input.currency,
  ].join("|");
}

/**
 * Check quarantine flag outside of a tenant tx (as superuser). Throws
 * the canonical LedgerQuarantinedError (from @/lib/errors) if the tenant
 * is currently locked out of writes. withTenant() / postLedgerEvent(s)
 * refuse further writes as a first line of defense; the Postgres
 * ledger_quarantine_guard() trigger is the third.
 */
async function assertNotQuarantined(userId: string, client: Pick<typeof prisma, "user"> = prisma) {
  const u = await client.user.findUnique({
    where: { id: userId },
    select: { ledgerQuarantinedAt: true, ledgerQuarantineReason: true },
  });
  if (u?.ledgerQuarantinedAt) {
    throw new LedgerQuarantinedError(userId, u.ledgerQuarantineReason ?? null);
  }
}

// ============================================================
// ENTRY BUILDERS — balanced sets per event type
// ============================================================

function toPaise(
  v: Prisma.Decimal | number | string | bigint | null | undefined,
  currency: string
): bigint {
  if (v === null || v === undefined) return BigInt(0);
  if (typeof v === "bigint") return v;
  return BigInt(toSubunit(v as Prisma.Decimal | number | string, currency));
}

/**
 * Compute the NET CASH that has been posted so far for an invoice, by
 * summing signed CASH movements across INVOICE_PAID (+), PAYMENT_REVERSED
 * (−), and any prior INVOICE_VOIDED cash legs (−). Used by the void flow
 * so that voiding a partially-paid invoice (or voiding an invoice that
 * has already had a chargeback) reverses exactly the outstanding cash
 * amount, keeping CASH and AR nets at zero without over-reversing.
 *
 * Returns 0n when there are no cash rows (PENDING invoice voided without
 * payment) or when the invoice can't be found.
 *
 * Accepts an optional tx client for composing inside an outer transaction;
 * otherwise uses the global prisma client. Runs under the caller's role
 * (callers open their own withTenant / withService context).
 */
export async function resolveCashPaidForInvoice(
  invoiceId: string,
  userId: string,
  tx?: Pick<
    typeof prisma,
    "ledgerEntry"
  >
): Promise<bigint> {
  const client = tx ?? prisma;
  const rows = await client.ledgerEntry.findMany({
    where: {
      userId,
      invoiceId,
      account: "CASH",
      eventType: { in: ["INVOICE_PAID", "PAYMENT_REVERSED", "INVOICE_VOIDED"] },
    },
    select: { side: true, amountPaise: true },
  });
  let net = BigInt(0);
  for (const r of rows) {
    const amt = BigInt(r.amountPaise.toString());
    net += r.side === "DEBIT" ? amt : -amt;
  }
  return net < BigInt(0) ? BigInt(0) : net;
}

function buildEntriesFor(ev: LedgerEventInput): {
  entries: EntryDraft[];
  invoiceId: string | null;
  expenseId: string | null;
  currency: string;
  note?: string;
} {
  switch (ev.type) {
    case "INVOICE_ISSUED": {
      const cur = ev.invoice.currency ?? "INR";
      const totals = calcInvoiceTotals(
        ev.invoice.items,
        ev.invoice.taxRate,
        ev.invoice.discountType
          ? { type: ev.invoice.discountType, value: ev.invoice.discountValue ?? 0 }
          : {}
      );
      const subtotalP = BigInt(totals._paise.subtotal);
      const discountP = BigInt(totals._paise.discountAmount);
      const taxP = BigInt(totals._paise.taxAmount);
      const totalP = BigInt(totals._paise.total);
      const netP = subtotalP - discountP; // revenue net of discounts

      const entries: EntryDraft[] = [
        { account: "ACCOUNTS_RECEIVABLE", side: "DEBIT",  amountPaise: totalP },
        { account: "REVENUE",             side: "CREDIT", amountPaise: netP },
        { account: "TAX_PAYABLE",         side: "CREDIT", amountPaise: taxP },
      ];
      if (discountP > BigInt(0)) {
        entries.push({ account: "DISCOUNT_CONTRA", side: "DEBIT", amountPaise: discountP });
      }
      return { entries, invoiceId: ev.invoice.id, expenseId: null, currency: cur };
    }

    case "INVOICE_PAID": {
      const cur = ev.invoice.currency ?? "INR";
      const amount = ev.amountPaid ?? ev.invoice.totalAmount;
      const paidP = toPaise(amount, cur);
      return {
        entries: [
          { account: "CASH",               side: "DEBIT",  amountPaise: paidP },
          { account: "ACCOUNTS_RECEIVABLE", side: "CREDIT", amountPaise: paidP },
        ],
        invoiceId: ev.invoice.id,
        expenseId: null,
        currency: cur,
        note: ev.note ?? "Payment received",
      };
    }

    case "INVOICE_VOIDED": {
      const cur = ev.invoice.currency ?? "INR";
      const totals = calcInvoiceTotals(
        ev.invoice.items,
        ev.invoice.taxRate,
        ev.invoice.discountType
          ? { type: ev.invoice.discountType, value: ev.invoice.discountValue ?? 0 }
          : {}
      );
      const subtotalP = BigInt(totals._paise.subtotal);
      const discountP = BigInt(totals._paise.discountAmount);
      const taxP = BigInt(totals._paise.taxAmount);
      const totalP = BigInt(totals._paise.total);
      const netP = subtotalP - discountP;

      // Net cash previously received for this invoice (from prior
      // INVOICE_PAID less any PAYMENT_REVERSED). Passed in by the caller
      // (see resolveCashPaidForInvoice) so partial payments, multiple
      // payments, and post-payment chargebacks all reverse correctly.
      // Clamp to [0, totalP] defensively: if more cash was posted than
      // the invoice total (which shouldn't happen via our helpers but
      // could via raw SQL), we reverse exactly the invoice total so
      // books stay balanced and the excess is visible as a CASH_MISMATCH
      // rather than generating a negative AR balance.
      let paidP = toPaise(ev.invoice.paidAmount, cur);
      if (paidP < BigInt(0)) paidP = BigInt(0);
      if (paidP > totalP) paidP = totalP;

      // Open (unpaid) AR at the moment of void. Crediting AR by this
      // amount zeros out the remaining receivable balance that was
      // created by INVOICE_ISSUED and never closed by INVOICE_PAID.
      const openArP = totalP - paidP;

      // --- Build balanced reversing entries ---
      //
      // Strategy: mirror-image of the original INVOICE_ISSUED posting
      // (every debit becomes a credit and vice versa so the issuance is
      // exactly nullified), PLUS a mirror of the INVOICE_PAID /
      // PAYMENT_REVERSED net cash effect (paidP of CASH debited → now
      // credited, AR credited → now debited by paidP).
      //
      // For a PENDING invoice (paidP=0): this is just the ISUED reversal.
      //   Dr REVENUE netP / Dr TAX_PAYABLE taxP / Cr DISCOUNT_CONTRA (if any)
      //   / Cr AR totalP.
      // For a fully-paid invoice (paidP=totalP): AR nets to zero after
      //   the cash-reversal debit, cash nets to zero.
      // For a partial payment: open receivable = totalP - paidP is
      //   credited by the ISUED-mirror leg, and paidP is re-debited by
      //   the cash-reversal leg — AR nets to zero and CASH reverses to
      //   zero the prior Dr.
      const entries: EntryDraft[] = [
        { account: "REVENUE",             side: "DEBIT",  amountPaise: netP },
        { account: "TAX_PAYABLE",         side: "DEBIT",  amountPaise: taxP },
        { account: "ACCOUNTS_RECEIVABLE", side: "CREDIT", amountPaise: totalP },
      ];
      if (discountP > BigInt(0)) {
        entries.push({ account: "DISCOUNT_CONTRA", side: "CREDIT", amountPaise: discountP });
      }
      let note = "Invoice voided (issuance reversed)";
      if (paidP > BigInt(0)) {
        entries.push(
          { account: "ACCOUNTS_RECEIVABLE", side: "DEBIT",  amountPaise: paidP },
          { account: "CASH",               side: "CREDIT", amountPaise: paidP }
        );
        note += openArP > BigInt(0)
          ? " (partial payment reversed; remaining balance written off)"
          : " (payment reversed)";
      }
      return { entries, invoiceId: ev.invoice.id, expenseId: null, currency: cur, note };
    }

    case "PAYMENT_REVERSED": {
      const cur = ev.invoice.currency ?? "INR";
      const p = toPaise(ev.amount, cur);
      return {
        entries: [
          { account: "ACCOUNTS_RECEIVABLE", side: "DEBIT",  amountPaise: p },
          { account: "CASH",               side: "CREDIT", amountPaise: p },
        ],
        invoiceId: ev.invoice.id,
        expenseId: null,
        currency: cur,
        note: ev.note ?? "Payment reversed / refunded",
      };
    }

    case "EXPENSE_RECORDED": {
      const cur = ev.expense.currency ?? "INR";
      const p = toPaise(ev.expense.amount, cur);
      return {
        entries: [
          { account: "EXPENSES", side: "DEBIT",  amountPaise: p },
          { account: "CASH",     side: "CREDIT", amountPaise: p },
        ],
        invoiceId: null,
        expenseId: ev.expense.id,
        currency: cur,
        note: ev.expense.category ? `Expense: ${ev.expense.category}` : "Expense",
      };
    }
  }
}

/**
 * Assert balanced entries: Σ debits == Σ credits, no negatives. Returns totals.
 */
export function assertBalanced(entries: readonly EntryDraft[]): {
  totalDebits: bigint;
  totalCredits: bigint;
} {
  let d = BigInt(0);
  let c = BigInt(0);
  for (const e of entries) {
    if (e.amountPaise < BigInt(0)) {
      throw new Error(`Ledger: negative amountPaise on ${e.account} (${e.amountPaise})`);
    }
    if (e.side === "DEBIT") d += e.amountPaise;
    else c += e.amountPaise;
  }
  if (d !== c) {
    throw new Error(`Ledger: unbalanced (D=${d}p, C=${c}p)`);
  }
  return { totalDebits: d, totalCredits: c };
}

// ============================================================
// POSTING
// ============================================================

function newEventId(): string {
  return "evt_" + crypto.randomBytes(12).toString("hex");
}

function advisoryKeyFor(userId: string): bigint {
  // Per-user advisory lock namespace. FNV-1a 32-bit folded into the low
  // 32 bits of a 64-bit key with a fixed high-32 namespace.
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const ns = BigInt(1397772900);
  return ns * BigInt(0x100000000) + BigInt(h >>> 0);
}

/** Postgres SQLSTATEs that indicate a transient retryable failure. */
const RETRYABLE_SQLSTATES = new Set([
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
  "40001", // serialization_failure
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "57P01", // admin_shutdown
]);

function isRetryablePgError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  if (typeof code === "string" && RETRYABLE_SQLSTATES.has(code)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  // pg-protocol sometimes surfaces these without a code on prepared tx abort.
  return /deadlock|could not obtain lock|serialization failure|canceling statement due to statement timeout/i.test(
    msg
  );
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseMs?: number; label?: string } = {}
): Promise<T> {
  const { maxRetries = 4, baseMs = 20, label = "ledger" } = opts;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !isRetryablePgError(err)) throw err;
      const jitter = Math.floor(Math.random() * 20);
      const waitMs = baseMs * Math.pow(2, attempt) + jitter;
      console.warn(
        `[${label}] transient error on attempt ${attempt + 1}, retrying in ${waitMs}ms:`,
        err instanceof Error ? err.message : String(err)
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

export interface PostResult {
  eventId: string;
  entryCount: number;
  totalPaise: bigint;
  lastEntryId: string;
  lastEntryHash: string;
}

export interface BatchPostResult {
  results: PostResult[];
  totalEntryCount: number;
  lastEntryId: string;
  lastEntryHash: string;
}

interface PreparedEvent {
  userId: string;
  eventId: string;
  eventType: LedgerEventInput["type"];
  entries: EntryDraft[];
  invoiceId: string | null;
  expenseId: string | null;
  currency: string;
  note: string | null;
  totalDebits: bigint;
}

function prepareEvent(event: LedgerEventInput): PreparedEvent {
  const userId =
    event.type === "EXPENSE_RECORDED" ? event.expense.userId : event.invoice.userId;
  const built = buildEntriesFor(event);
  const { totalDebits } = assertBalanced(built.entries);
  return {
    userId,
    eventId: newEventId(),
    eventType: event.type,
    entries: built.entries,
    invoiceId: built.invoiceId,
    expenseId: built.expenseId,
    currency: built.currency,
    note: built.note ?? null,
    totalDebits,
  };
}

/**
 * Build and insert ledger rows for a set of prepared events under a single
 * per-user advisory lock. Caller MUST be running inside the RLS tenant
 * tx (withTenant/withService+withTenant). Returns per-event PostResults
 * plus the new tail pointer.
 */
async function appendPreparedEvents(
  txClient: Prisma.TransactionClient,
  userId: string,
  prepared: PreparedEvent[]
): Promise<BatchPostResult> {
  if (prepared.length === 0) {
    throw new Error("appendPreparedEvents: empty event list");
  }
  for (const p of prepared) {
    if (p.userId !== userId) {
      throw new Error(
        `appendPreparedEvents: all events must belong to userId=${userId}, got ${p.userId}`
      );
    }
  }

  const lockKey = advisoryKeyFor(userId);
  await txClient.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(${lockKey.toString()})`
  );

  const userRow = await txClient.user.findUnique({
    where: { id: userId },
    select: { lastLedgerEntryHash: true, lastLedgerEntryId: true },
  });
  const lastEntry = await txClient.ledgerEntry.findFirst({
    where: { userId },
    orderBy: { entryIndex: "desc" },
    select: { entryHash: true, entryIndex: true },
  });
  const hash = lastEntry?.entryHash ?? userRow?.lastLedgerEntryHash ?? null;
  let prevHash = hash ?? GENESIS_HASH;
  let nextIndex = Number(lastEntry?.entryIndex ?? 0) + 1;

  type Row = {
    id: string;
    userId: string;
    eventId: string;
    eventType: string;
    account: Account;
    side: "DEBIT" | "CREDIT";
    amountPaise: bigint;
    prevEntryHash: string;
    entryHash: string;
    entryIndex: number;
    invoiceId: string | null;
    expenseId: string | null;
    currency: string;
    note: string | null;
  };
  const allRows: Row[] = [];
  const perEvent: PostResult[] = [];

  for (const p of prepared) {
    const firstId = "clg_" + crypto.randomBytes(10).toString("hex");
    // We don't know the last id until after the loop; track placeholder.
    let firstIdx = nextIndex;
    let eventRowCount = 0;
    for (const e of p.entries) {
      const serialized = serializeForHash({
        eventId: p.eventId,
        eventType: p.eventType,
        account: e.account,
        side: e.side,
        amountPaise: e.amountPaise,
        invoiceId: p.invoiceId,
        expenseId: p.expenseId,
        currency: p.currency,
      });
      const entryHash = sha256Hex(prevHash + "|" + serialized);
      const id =
        eventRowCount === 0
          ? firstId
          : "clg_" + crypto.randomBytes(10).toString("hex");
      allRows.push({
        id,
        userId,
        eventId: p.eventId,
        eventType: p.eventType,
        account: e.account,
        side: e.side,
        amountPaise: e.amountPaise,
        prevEntryHash: prevHash,
        entryHash,
        entryIndex: nextIndex,
        invoiceId: p.invoiceId,
        expenseId: p.expenseId,
        currency: p.currency,
        note: p.note,
      });
      prevHash = entryHash;
      nextIndex++;
      eventRowCount++;
    }
    const last = allRows[allRows.length - 1];
    perEvent.push({
      eventId: p.eventId,
      entryCount: eventRowCount,
      totalPaise: p.totalDebits,
      lastEntryId: last.id,
      lastEntryHash: last.entryHash,
    });
    void firstIdx;
  }

  if (allRows.length === 0) {
    throw new Error("appendPreparedEvents: no rows generated");
  }

  // Single bulk INSERT for the entire batch (1 round trip to the DB).
  await txClient.ledgerEntry.createMany({
    data: allRows.map((r) => ({
      id: r.id,
      userId: r.userId,
      eventId: r.eventId,
      eventType: r.eventType as unknown as import("@prisma/client").LedgerEventType,
      account: r.account as unknown as import("@prisma/client").AccountType,
      side: r.side as unknown as import("@prisma/client").EntrySide,
      amountPaise: r.amountPaise,
      prevEntryHash: r.prevEntryHash,
      entryHash: r.entryHash,
      entryIndex: r.entryIndex,
      invoiceId: r.invoiceId,
      expenseId: r.expenseId,
      currency: r.currency,
      note: r.note,
    })),
  });

  const lastRow = allRows[allRows.length - 1];
  await txClient.user.update({
    where: { id: userId },
    data: {
      lastLedgerEntryHash: lastRow.entryHash,
      lastLedgerEntryId: lastRow.id,
    },
  });

  return {
    results: perEvent,
    totalEntryCount: allRows.length,
    lastEntryId: lastRow.id,
    lastEntryHash: lastRow.entryHash,
  };
}

/**
 * Post a single balanced ledger event. Runs inside withTenant() (RLS).
 * Accepts an existing `tx` to compose with outer writes. On transient
 * lock/deadlock errors, retries with exponential backoff.
 */
export async function postLedgerEvent(
  event: LedgerEventInput,
  tx?: Prisma.TransactionClient
): Promise<PostResult> {
  const prepared = prepareEvent(event);
  const userId = prepared.userId;

  // Short-circuit before acquiring the advisory lock if the tenant is
  // quarantined. This avoids taking a lock we'll immediately reject.
  await assertNotQuarantined(userId);

  const doPost = async (txClient: Prisma.TransactionClient): Promise<PostResult> => {
    const batch = await appendPreparedEvents(txClient, userId, [prepared]);
    return batch.results[0];
  };

  // If a tx was supplied, we are already inside the caller's transaction;
  // do not wrap in retry (retrying requires a fresh tx). Lock waits on
  // pg_advisory_xact_lock are fine since the advisory lock is per-user
  // and held only for the duration of the short append.
  if (tx) {
    return withTenant(userId, (t) => doPost(t), { tx });
  }
  return retryWithBackoff(
    () => withTenant(userId, doPost),
    { label: "postLedgerEvent" }
  );
}

/**
 * Post multiple ledger events for the SAME userId under a single
 * advisory lock and a single bulk INSERT. This is the high-throughput
 * path used by bulk imports (CSV expense import) and recurring batch
 * generation — avoids acquiring/releasing the chain lock N times.
 *
 * Retries on transient lock contention. ALL events must belong to the
 * same user; mixed-user batches throw.
 */
export async function postLedgerEvents(
  events: readonly LedgerEventInput[],
  tx?: Prisma.TransactionClient
): Promise<BatchPostResult> {
  if (events.length === 0) {
    throw new Error("postLedgerEvents: empty event list");
  }
  const prepared = events.map(prepareEvent);
  const userId = prepared[0].userId;
  for (const p of prepared) {
    if (p.userId !== userId) {
      throw new Error("postLedgerEvents: all events must be for the same userId");
    }
  }

  await assertNotQuarantined(userId);

  const doPost = (txClient: Prisma.TransactionClient) =>
    appendPreparedEvents(txClient, userId, prepared);

  if (tx) {
    return withTenant(userId, (t) => doPost(t), { tx });
  }
  return retryWithBackoff(
    () => withTenant(userId, doPost),
    { label: "postLedgerEvents" }
  );
}

// ============================================================
// BACKFILL — populate ledger from existing DB rows
// ============================================================

/**
 * Backfill ledger entries for all existing invoices/expenses that have no
 * INVOICE_ISSUED / EXPENSE_RECORDED event yet. Uses PENDING-at-creation as
 * the issuance moment; uses current invoice.status (PAID → INVOICE_PAID,
 * VOID → INVOICE_VOIDED). This is safe to run multiple times (idempotent:
 * skips invoices that already have a ledger eventId).
 *
 * Runs as superuser (prisma) for discovery, then each postLedgerEvent
 * opens its own withTenant() RLS-scoped tx.
 */
export async function backfillLedger(): Promise<{
  users: number;
  invoices: number;
  expenses: number;
}> {
  const users = await prisma.user.findMany({ select: { id: true } });
  let invoicesCount = 0;
  let expensesCount = 0;

  for (const u of users) {
    // Find invoices that have no issuance ledger entry yet.
    const existingInvoiceEntries = await prisma.ledgerEntry.findMany({
      where: { userId: u.id, eventType: "INVOICE_ISSUED", invoiceId: { not: null } },
      select: { invoiceId: true },
    });
    const alreadyIssued = new Set(existingInvoiceEntries.map(r => r.invoiceId).filter(Boolean) as string[]);

    const unledgeredInvoices = await prisma.invoice.findMany({
      where: { userId: u.id, NOT: { id: { in: Array.from(alreadyIssued) } } },
      include: { items: true },
    });

    for (const inv of unledgeredInvoices) {
      // Post issuance entry for every invoice (DRAFT/PENDING/PAID/VOID). For
      // DRAFT we still post it? No — DRAFT hasn't been "issued" (no
      // economic event). Skip DRAFTs and post for PENDING/PAID/VOID.
      if (inv.status === "DRAFT") continue;

      await postLedgerEvent({
        type: "INVOICE_ISSUED",
        invoice: {
          id: inv.id,
          userId: inv.userId,
          items: inv.items.map((it) => ({ description: it.description, quantity: it.quantity, price: Number(it.price) })),
          taxRate: Number(inv.taxRate),
          discountType: inv.discountType,
          discountValue: inv.discountValue != null ? Number(inv.discountValue) : null,
        },
      });
      if (inv.status === "PAID") {
        await postLedgerEvent({
          type: "INVOICE_PAID",
          invoice: { id: inv.id, userId: inv.userId, totalAmount: inv.totalAmount },
          amountPaid: inv.totalAmount,
        });
      } else if (inv.status === "VOID") {
        // If INVOICE_PAID entries were already posted for this invoice
        // (e.g., backfill re-run after a partial failure), reverse that
        // cash too; otherwise reverse just the issuance so books balance.
        // We run inside withTenant as each postLedgerEvent does;
        // resolveCashPaidForInvoice runs as superuser for discovery.
        // Because we are running sequentially inside backfillLedger and
        // INVOICE_PAID is posted above only if not alreadyPaid, net cash
        // here is either 0 (never paid) or totalAmount (fully paid).
        const existingCash = await resolveCashPaidForInvoice(inv.id, inv.userId);
        await postLedgerEvent({
          type: "INVOICE_VOIDED",
          invoice: {
            id: inv.id,
            userId: inv.userId,
            items: inv.items.map((it) => ({ description: it.description, quantity: it.quantity, price: Number(it.price) })),
            taxRate: Number(inv.taxRate),
            discountType: inv.discountType,
            discountValue: inv.discountValue != null ? Number(inv.discountValue) : null,
            paidAmount: existingCash > BigInt(0) ? existingCash : null,
          },
        });
      }
      invoicesCount++;
    }

    // Expenses.
    const existingExpenseEntries = await prisma.ledgerEntry.findMany({
      where: { userId: u.id, eventType: "EXPENSE_RECORDED", expenseId: { not: null } },
      select: { expenseId: true },
    });
    const alreadyExpensed = new Set(existingExpenseEntries.map(r => r.expenseId).filter(Boolean) as string[]);

    const unledgeredExpenses = await prisma.expense.findMany({
      where: { userId: u.id, NOT: { id: { in: Array.from(alreadyExpensed) } } },
    });
    for (const exp of unledgeredExpenses) {
      await postLedgerEvent({
        type: "EXPENSE_RECORDED",
        expense: {
          id: exp.id,
          userId: exp.userId,
          amount: exp.amount,
          category: exp.category,
        },
      });
      expensesCount++;
    }
  }

  return { users: users.length, invoices: invoicesCount, expenses: expensesCount };
}

// ============================================================
// VERIFICATION
// ============================================================

export interface VerificationResult {
  userId: string;
  entryCount: number;
  eventCount: number;
  valid: boolean;
  firstBrokenIndex?: number;
  reason?: string;
  /** Account balances in paise (Σ DEBITs - Σ CREDITs per account). */
  accountBalances: Record<string, string>;
  /** Σ(ACCOUNTS_RECEIVABLE D-C) derived from invoices.status != PAID/VOID totals. */
  expectedReceivablePaise?: string;
  /** Σ(EXPENSES D-C) for cross-check with P&L. */
  totalExpensePaise?: string;
  /** Σ(REVENUE C-D) - Σ(TAX_PAYABLE C-D) = net revenue pre-tax collected? We
   *  expose revenue and tax separately for the P&L view. */
  totalRevenuePaise?: string;
  totalTaxPayablePaise?: string;
  totalCashPaise?: string;
}

/**
 * Verify a tenant's ledger end-to-end:
 *   1. Hash chain integrity (prevHash → next, recompute entryHash).
 *   2. Per-eventId balance (Σ D == Σ C).
 *   3. User tail pointer matches the last entry's hash.
 *   4. Returns account balances (paise, as string because BigInt) for
 *      reconciliation against the Invoice/Expense tables.
 */
export async function verifyUserLedger(userId: string): Promise<VerificationResult> {
  return withTenant(userId, async (tx) => {
    const rows = await tx.ledgerEntry.findMany({
      orderBy: { entryIndex: "asc" },
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
    });

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { lastLedgerEntryHash: true, lastLedgerEntryId: true },
    });

    const balances: Record<string, bigint> = {
      ACCOUNTS_RECEIVABLE: BigInt(0),
      REVENUE: BigInt(0),
      DISCOUNT_CONTRA: BigInt(0),
      TAX_PAYABLE: BigInt(0),
      CASH: BigInt(0),
      EXPENSES: BigInt(0),
    };
    const eventBalances = new Map<string, { d: bigint; c: bigint }>();

    let prev = GENESIS_HASH;
    for (const r of rows) {
      if (r.prevEntryHash !== prev) {
        return fail(r.entryIndex, `prevEntryHash mismatch at index ${r.entryIndex}`, balances);
      }
      const canon = serializeForHash({
        eventId: r.eventId,
        eventType: r.eventType,
        account: r.account,
        side: r.side,
        amountPaise: BigInt(r.amountPaise.toString()),
        invoiceId: r.invoiceId,
        expenseId: r.expenseId,
        currency: r.currency,
      });
      const expected = sha256Hex(prev + "|" + canon);
      if (expected !== r.entryHash) {
        return fail(r.entryIndex, `entryHash mismatch at index ${r.entryIndex}`, balances);
      }
      prev = r.entryHash;

      // Running balance (Debit = +, Credit = - by convention for asset/expense;
      // liability/income have natural credit balances so we use signed:
      //   Debit = +amountPaise, Credit = -amountPaise  (for all accounts)
      //   → assets/expenses are normally positive; liabilities/income negative.
      const amt = BigInt(r.amountPaise.toString());
      if (r.side === "DEBIT") balances[r.account] += amt;
      else balances[r.account] -= amt;

      // Per-event balance accumulator.
      let eb = eventBalances.get(r.eventId);
      if (!eb) { eb = { d: BigInt(0), c: BigInt(0) }; eventBalances.set(r.eventId, eb); }
      if (r.side === "DEBIT") eb.d += amt; else eb.c += amt;
    }

    // Verify tail pointer.
    if (rows.length > 0) {
      const last = rows[rows.length - 1];
      if (user?.lastLedgerEntryHash !== last.entryHash) {
        return fail(last.entryIndex, `user.lastLedgerEntryHash does not match last entry (stale tail pointer)`, balances);
      }
    } else {
      if (user?.lastLedgerEntryHash != null) {
        return fail(0, `user.lastLedgerEntryHash is set but no ledger rows exist`, balances);
      }
    }

    // Verify every eventId is balanced.
    for (const [eventId, b] of eventBalances) {
      if (b.d !== b.c) {
        return fail(0, `event ${eventId} unbalanced: D=${b.d}p C=${b.c}p`, balances);
      }
    }

    // Convert balances to strings.
    const asString = Object.fromEntries(
      Object.entries(balances).map(([k, v]) => [k, v.toString()])
    ) as Record<string, string>;

    return {
      userId,
      entryCount: rows.length,
      eventCount: eventBalances.size,
      valid: true,
      accountBalances: asString,
      totalRevenuePaise: (-balances.REVENUE).toString(), // revenue normally has credit balance
      totalTaxPayablePaise: (-balances.TAX_PAYABLE).toString(),
      totalExpensePaise: balances.EXPENSES.toString(),
      totalCashPaise: balances.CASH.toString(),
    };

    function fail(index: number, reason: string, bals: Record<string, bigint>): VerificationResult {
      const asString = Object.fromEntries(
        Object.entries(bals).map(([k, v]) => [k, v.toString()])
      ) as Record<string, string>;
      return {
        userId,
        entryCount: rows.length,
        eventCount: eventBalances.size,
        valid: false,
        firstBrokenIndex: index,
        reason,
        accountBalances: asString,
      };
    }
  });
}
