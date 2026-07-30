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
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withTenant } from "@/lib/tenant";
import { calcInvoiceTotals, toSubunit } from "@/lib/money";

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
        /** If the invoice had been PAID, pass totalAmount to reverse payment too. */
        paidAmount?: Prisma.Decimal | number | string | null;
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

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function serializeForHash(input: {
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

// ============================================================
// ENTRY BUILDERS — balanced sets per event type
// ============================================================

function toPaise(
  v: Prisma.Decimal | number | string | null | undefined,
  currency: string
): bigint {
  if (v === null || v === undefined) return BigInt(0);
  return BigInt(toSubunit(v as Prisma.Decimal | number | string, currency));
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

      // Reverse the INVOICE_ISSUED posting.
      const entries: EntryDraft[] = [
        { account: "REVENUE",             side: "DEBIT",  amountPaise: netP },
        { account: "TAX_PAYABLE",         side: "DEBIT",  amountPaise: taxP },
        { account: "ACCOUNTS_RECEIVABLE", side: "CREDIT", amountPaise: totalP },
      ];
      if (discountP > BigInt(0)) {
        entries.push({ account: "DISCOUNT_CONTRA", side: "CREDIT", amountPaise: discountP });
      }
      let note = "Invoice voided (issuance reversed)";
      if (ev.invoice.paidAmount != null) {
        // Reverse the payment too (refund / chargeback).
        const paidP = toPaise(ev.invoice.paidAmount, cur);
        if (paidP > BigInt(0)) {
          entries.push(
            { account: "ACCOUNTS_RECEIVABLE", side: "DEBIT",  amountPaise: paidP },
            { account: "CASH",               side: "CREDIT", amountPaise: paidP }
          );
          note += " (payment reversed)";
        }
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

export interface PostResult {
  eventId: string;
  entryCount: number;
  totalPaise: bigint;
  lastEntryId: string;
  lastEntryHash: string;
}

/**
 * Post a balanced ledger event. Runs inside withTenant() (RDS-enforced).
 * Accepts an existing `tx` to support callers already inside a
 * withTenant transaction.
 */
export async function postLedgerEvent(
  event: LedgerEventInput,
  tx?: Prisma.TransactionClient
): Promise<PostResult> {
  const userId =
    event.type === "EXPENSE_RECORDED" ? event.expense.userId : event.invoice.userId;

  const { entries, invoiceId, expenseId, currency, note } = buildEntriesFor(event);
  const { totalDebits } = assertBalanced(entries);

  const eventId = newEventId();
  const eventType = event.type;

  const run = async (txClient: Prisma.TransactionClient): Promise<PostResult> => {
    // Serialize chain appends per-user via a Postgres advisory lock. Use a
    // signed 32-bit FNV-1a of userId combined with a fixed namespace (1397)
    // for the first 32 bits; fits in int64 without overflow.
    let h = 0x811c9dc5;
    for (let i = 0; i < userId.length; i++) {
      h ^= userId.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    // Construct a 64-bit advisory lock key without BigInt literals
    // (tsconfig targets ES2017 which lacks them). Namespace in the high
    // 32 bits, FNV-1a(userId) in the low 32 bits.
    const ns = BigInt(1397772900);
    const lo = BigInt(h >>> 0);
    const lockKey = (ns * BigInt(0x100000000)) + lo;
    await txClient.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(${lockKey.toString()})`
    );

    const userRow = await txClient.user.findUnique({
      where: { id: userId },
      select: { lastLedgerEntryHash: true, lastLedgerEntryId: true },
    });
    // Also defend against lastLedgerEntryHash being out of sync with the
    // actual tail — use MAX(entryIndex) and the last entry's hash.
    const lastEntry = await txClient.ledgerEntry.findFirst({
      where: { userId },
      orderBy: { entryIndex: "desc" },
      select: { entryHash: true, entryIndex: true },
    });
    const hash = lastEntry?.entryHash ?? userRow?.lastLedgerEntryHash ?? null;
    const idx = lastEntry?.entryIndex ?? 0;
    let prevHash = hash ?? GENESIS_HASH;
    let nextIndex = Number(idx ?? 0) + 1;

    // Compute hashes for each entry in the balanced set.
    const rows: Array<{
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
      // Prisma wants BigInt for the column; it serializes to a pg bigint.
    }> = [];

    for (const e of entries) {
      const serialized = serializeForHash({
        eventId,
        eventType,
        account: e.account,
        side: e.side,
        amountPaise: e.amountPaise,
        invoiceId,
        expenseId,
        currency,
      });
      const entryHash = sha256Hex(prevHash + "|" + serialized);
      rows.push({
        id: "clg_" + crypto.randomBytes(10).toString("hex"),
        userId,
        eventId,
        eventType,
        account: e.account,
        side: e.side,
        amountPaise: e.amountPaise,
        prevEntryHash: prevHash,
        entryHash,
        entryIndex: nextIndex,
        invoiceId,
        expenseId,
        currency,
        note: note ?? null,
      });
      prevHash = entryHash;
      nextIndex++;
    }

    // Bulk insert the balanced set in a single statement for efficiency
    // (createMany is significantly faster than N create calls).
    // Prisma's createMany does not return inserted rows; we already
    // generated CUIDs client-side, so last entry id is known.
    //
    // NOTE: Prisma serializes BigInt to the bigint Postgres type directly.
    await txClient.ledgerEntry.createMany({
      data: rows.map((r) => ({
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

    const last = rows[rows.length - 1];

    // Advance user tail pointer.
    await txClient.user.update({
      where: { id: userId },
      data: {
        lastLedgerEntryHash: last.entryHash,
        lastLedgerEntryId: last.id,
      },
    });

    return {
      eventId,
      entryCount: rows.length,
      totalPaise: totalDebits,
      lastEntryId: last.id,
      lastEntryHash: last.entryHash,
    };
  };

  if (tx) return withTenant(userId, run, { tx });
  return withTenant(userId, run);
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
        // We don't know whether it was paid at the time of void from
        // current state; issue a simple reversal (no payment reversal)
        // so the books stay balanced.
        await postLedgerEvent({
          type: "INVOICE_VOIDED",
          invoice: {
            id: inv.id,
            userId: inv.userId,
            items: inv.items.map((it) => ({ description: it.description, quantity: it.quantity, price: Number(it.price) })),
            taxRate: Number(inv.taxRate),
            discountType: inv.discountType,
            discountValue: inv.discountValue != null ? Number(inv.discountValue) : null,
            paidAmount: null,
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
