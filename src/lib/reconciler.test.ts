/**
 * Integration tests for the Automated Ledger Drift & Integrity Reconciler.
 *
 * These tests exercise the real PostgreSQL database (no mocks). Each test
 * operates on an isolated test tenant that is created in beforeAll and
 * wiped clean at the start of every test, so state from one case cannot
 * contaminate the next.
 *
 * Coverage (four core invariants):
 *   A. Clean baseline   → reconcile returns PASSED, no quarantine.
 *   B. Auto-backfill    → missed posting is detected and remediated in-tx.
 *   C. Hash tampering   → HASH_BROKEN + quarantine; L0001 blocks writes.
 *   D. Force release    → clears flag, auditOnly confirm run does NOT
 *                         re-quarantine; non-force release is refused.
 *
 * Runner: Vitest (see vitest.config.ts). Run with:
 *   npx vitest run src/lib/reconciler.test.ts
 *
 * Preconditions:
 *   - PostgreSQL 17 running locally with smart_billing DB + app_user /
 *     service_role NOINHERIT NOBYPASSRLS roles (prisma/rls-setup.sql,
 *     prisma/service-role.sql, prisma/ledger.sql, prisma/reconciler.sql
 *     already applied).
 *   - DATABASE_URL points to the test database.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import crypto from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withTenant } from "@/lib/tenant";
import {
  LedgerQuarantinedError,
  postLedgerEvent,
  resolveCashPaidForInvoice,
} from "@/lib/ledger";
import {
  reconcileTenant,
  releaseQuarantine,
  backfillLedgerForSingleTenant,
  operatorBackfill,
  RECONCILER_VERSION,
} from "@/lib/reconciler";

/**
 * A separate PrismaClient for the parts of Test C that intentionally
 * trigger SQLSTATE L0001 from the DB kernel. The shared `prisma` client
 * logs errors to stderr via the dev logger, which produces noisy output
 * for an exception we are asserting on. A silent client keeps test
 * output clean while still throwing the error.
 */
const silentPrisma = new PrismaClient({ log: [] });

// ============================================================
// TEST TENANT
// ============================================================

const TEST_EMAIL = "reconciler-ci@smartbill.test";
const TEST_PASSWORD = "ci-argon2id-dummy-hash";
let testUserId: string;

/** Reset the test tenant: (re)create user, delete prior ledger/audits. */
async function resetTenant(): Promise<void> {
  // Wipe prior data as the table owner (superuser) so RLS/quarantine
  // triggers don't block cleanup. We delete in FK order.
  await prisma.$transaction([
    prisma.reconciliationAudit.deleteMany({ where: { tenantId: testUserId } }),
    prisma.ledgerEntry.deleteMany({ where: { userId: testUserId } }),
    prisma.invoiceActivity.deleteMany({ where: { userId: testUserId } }),
    prisma.invoiceItem.deleteMany({
      where: { invoice: { userId: testUserId } },
    }),
    prisma.invoice.deleteMany({ where: { userId: testUserId } }),
    prisma.expense.deleteMany({ where: { userId: testUserId } }),
    prisma.recurringItem.deleteMany({
      where: { profile: { userId: testUserId } },
    }),
    prisma.recurringProfile.deleteMany({ where: { userId: testUserId } }),
    prisma.client.deleteMany({ where: { userId: testUserId } }),
    prisma.settings.deleteMany({ where: { userId: testUserId } }),
  ]);

  // Quarantine-reset the user row. We do this via a raw UPDATE running as
  // the table owner (prisma client is superuser in tests) because
  // withTenant() refuses writes when quarantined.
  await prisma.user.update({
    where: { id: testUserId },
    data: {
      ledgerQuarantinedAt: null,
      ledgerQuarantineReason: null,
      lastReconciledAt: null,
      lastLedgerEntryHash: null,
      lastLedgerEntryId: null,
    },
  });

  // Seed settings (currency defaults to INR).
  await prisma.settings.create({
    data: { userId: testUserId, currency: "INR", taxLabel: "GST" },
  });
}

/**
 * Build a balanced ledger baseline for the test tenant:
 *   1 INVOICE_ISSUED (AR Dr / Revenue Cr / Tax Cr, optional discount)
 *   1 INVOICE_PAID   (Cash Dr / AR Cr)
 *   1 EXPENSE        (Expenses Dr / Cash Cr)
 *
 * Uses postLedgerEvent() so the hash chain is computed correctly and
 * user.lastLedgerEntryHash is updated.
 */
async function seedBalancedLedger(): Promise<{
  clientId: string;
  invoiceId: string;
  expenseId: string;
}> {
  const clientId = "cli_" + crypto.randomBytes(6).toString("hex");
  const invoiceId = "inv_" + crypto.randomBytes(6).toString("hex");
  const expenseId = "exp_" + crypto.randomBytes(6).toString("hex");
  const today = new Date();
  const due = new Date(today.getTime() + 30 * 86400_000);

  // Client row (required FK).
  await prisma.client.create({
    data: { id: clientId, userId: testUserId, name: "CI Client", email: "ci@example.com" },
  });

  // Issue a ₹1,000 + 18% GST invoice (total ₹1,180).
  const items = [{ description: "Consulting", quantity: 1, price: 1000 }];
  const inv = await prisma.invoice.create({
    data: {
      id: invoiceId,
      userId: testUserId,
      clientId,
      invoiceNumber: "CI-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
      status: "PAID", // we will post both ISUED and PAID events
      issueDate: today,
      dueDate: due,
      subtotal: new Prisma.Decimal("1000.00"),
      taxRate: new Prisma.Decimal("18.00"),
      taxLabel: "GST",
      totalAmount: new Prisma.Decimal("1180.00"),
      discountAmount: new Prisma.Decimal("0.00"),
      items: {
        create: items.map((it) => ({
          id: "itm_" + crypto.randomBytes(4).toString("hex"),
          userId: testUserId,
          description: it.description,
          quantity: it.quantity,
          price: new Prisma.Decimal(it.price.toFixed(2)),
          total: new Prisma.Decimal(it.price.toFixed(2)),
        })),
      },
    },
  });

  // Record an expense of ₹300.
  await prisma.expense.create({
    data: {
      id: expenseId,
      userId: testUserId,
      date: today,
      category: "Software",
      description: "CI SaaS subscription",
      amount: new Prisma.Decimal("300.00"),
    },
  });

  // Post ledger events via the real posting path (hash chain valid).
  await postLedgerEvent({
    type: "INVOICE_ISSUED",
    invoice: {
      id: inv.id,
      userId: testUserId,
      items,
      taxRate: 18,
      currency: "INR",
    },
  });
  await postLedgerEvent({
    type: "INVOICE_PAID",
    invoice: {
      id: inv.id,
      userId: testUserId,
      totalAmount: 1180,
      currency: "INR",
    },
    amountPaid: 1180,
  });
  await postLedgerEvent({
    type: "EXPENSE_RECORDED",
    expense: {
      id: expenseId,
      userId: testUserId,
      amount: 300,
      category: "Software",
      currency: "INR",
    },
  });

  return { clientId, invoiceId: inv.id, expenseId };
}

// ============================================================
// SETUP / TEARDOWN
// ============================================================

beforeAll(async () => {
  // The reconciler writes reconciliation_audits as service_role. That role
  // is granted SELECT/INSERT on reconciliation_audits by the reconciler
  // setup; we issue a defensive GRANT here so the test suite can bootstrap
  // even on a DB where service-role.sql was applied before the audits
  // table existed. This is a no-op if the grant already exists.
  await prisma.$executeRawUnsafe(
    "GRANT SELECT, INSERT ON TABLE reconciliation_audits TO service_role"
  );

  // Ensure test user exists (id is stable so audit rows accumulate
  // under a known FK target). Password is a non-argon2 placeholder
  // because we never sign in as this user — we bypass auth by calling
  // engine functions directly.
  testUserId = "usr_reconciler_ci";
  const existing = await prisma.user.findUnique({ where: { id: testUserId } });
  if (!existing) {
    await prisma.user.create({
      data: {
        id: testUserId,
        name: "Reconciler CI",
        email: TEST_EMAIL,
        passwordHash: TEST_PASSWORD,
      },
    });
  }
});

beforeEach(async () => {
  await resetTenant();
});

afterAll(async () => {
  // Best-effort cleanup: leave tenant in a clean state for local dev
  // re-runs. We do not drop the user itself to keep the id stable.
  try {
    await resetTenant();
  } catch {
    /* ignore */
  }
  await silentPrisma.$disconnect();
  await prisma.$disconnect();
});

// ============================================================
// HELPERS
// ============================================================

/** True iff the error is a quarantine error from our app layer OR a
 *  PG QUARANTINE sqlstate L0001 from the DB kernel.
 *
 *  LedgerQuarantinedError is now canonical in @/lib/errors (re-exported
 *  through @/lib/ledger and @/lib/tenant), so `instanceof` reliably
 *  catches throws from every module boundary. We still match err.name
 *  as defense-in-depth against plain-Error re-throws and for the raw
 *  PG RAISE EXCEPTION path which surfaces as a Prisma-wrapped Error. */
function isQuarantineError(err: unknown): boolean {
  if (err instanceof LedgerQuarantinedError) return true;
  if (err instanceof Error && err.name === "LedgerQuarantinedError") return true;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (/L0001/.test(err.message)) return true;
  }
  // Prisma surfaces raw PG errors (RAISE EXCEPTION) as PrismaClientUnknownRequestError.
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    if (/L0001/.test(err.message)) return true;
  }
  if (err instanceof Error && /L0001/.test(err.message)) return true;
  return false;
}

// ============================================================
// TESTS
// ============================================================

describe("Reconciler invariants", () => {
  // ---------------------------------------------------------------
  // TEST A — clean baseline
  // ---------------------------------------------------------------
  it("A: clean balanced ledger → PASSED, no quarantine, no drift", async () => {
    await seedBalancedLedger();

    const result = await reconcileTenant(testUserId, { force: true });

    expect(result.status).toBe("PASSED");
    expect(result.criticalCount).toBe(0);
    expect(result.highCount).toBe(0);
    expect(result.mediumCount).toBe(0);
    expect(result.entriesScanned).toBeGreaterThan(0);
    expect(result.quarantined).toBe(false);
    expect(result.autoRemediated).toBe(false);
    expect(result.auditId).toBeTruthy();

    // Audit row is persisted and marked PASSED.
    const audit = await prisma.reconciliationAudit.findUnique({
      where: { id: result.auditId },
    });
    expect(audit).not.toBeNull();
    expect(audit!.status).toBe("PASSED");
    expect(audit!.version).toBe(RECONCILER_VERSION);

    // User state: not quarantined; lastReconciledAt stamped.
    const user = await prisma.user.findUnique({ where: { id: testUserId } });
    expect(user).not.toBeNull();
    expect(user!.ledgerQuarantinedAt).toBeNull();
    expect(user!.ledgerQuarantineReason).toBeNull();
    expect(user!.lastReconciledAt).toBeInstanceOf(Date);
  });

  // ---------------------------------------------------------------
  // TEST B — idempotent auto-backfill closes an un-ledgered invoice
  // ---------------------------------------------------------------
  it("B: un-ledgered PENDING invoice → AR_MISMATCH detected, auto-backfilled in-tx → PASSED", async () => {
    // Seed a small balanced baseline then insert an UN-LEDGERED pending
    // invoice directly via Prisma (simulates a missed-posting bug).
    const { clientId } = await seedBalancedLedger();
    const ghostId = "inv_ghost_" + crypto.randomBytes(4).toString("hex");
    const ghostItemId = "itm_ghost_" + crypto.randomBytes(4).toString("hex");

    await prisma.invoice.create({
      data: {
        id: ghostId,
        userId: testUserId,
        clientId,
        invoiceNumber: "GHOST-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
        status: "PENDING",
        issueDate: new Date(),
        dueDate: new Date(Date.now() + 15 * 86400_000),
        subtotal: new Prisma.Decimal("500.00"),
        taxRate: new Prisma.Decimal("18.00"),
        taxLabel: "GST",
        totalAmount: new Prisma.Decimal("590.00"),
        discountAmount: new Prisma.Decimal("0.00"),
        items: {
          create: [
            {
              id: ghostItemId,
              userId: testUserId,
              description: "Ghost line",
              quantity: 1,
              price: new Prisma.Decimal("500.00"),
              total: new Prisma.Decimal("500.00"),
            },
          ],
        },
      },
    });

    const result = await reconcileTenant(testUserId, { force: true });

    // The engine must notice the mismatch, backfill inside the service
    // tx, re-sweep, and come out PASSED with autoRemediated=true.
    expect(result.autoRemediated).toBe(true);
    expect(result.status).toBe("PASSED");
    expect(result.criticalCount).toBe(0);
    expect(result.highCount).toBe(0);
    expect(result.quarantined).toBe(false);

    // The ghost invoice now has a corresponding INVOICE_ISSUED ledger entry.
    const ghostEntries = await prisma.ledgerEntry.findMany({
      where: { userId: testUserId, invoiceId: ghostId },
      orderBy: { entryIndex: "asc" },
    });
    expect(ghostEntries.length).toBeGreaterThanOrEqual(3); // AR/Revenue/Tax lines
    expect(ghostEntries.some((e) => e.eventType === "INVOICE_ISSUED")).toBe(true);

    // Running the reconciler a second time must be idempotent: no new
    // auto-remediation, still PASSED.
    const second = await reconcileTenant(testUserId, { force: true });
    expect(second.status).toBe("PASSED");
    expect(second.autoRemediated).toBe(false);
    expect(second.highCount).toBe(0);
  });

  // ---------------------------------------------------------------
  // TEST C — cryptographic tampering → HASH_BROKEN + quarantine + L0001
  // ---------------------------------------------------------------
  it("C: tampered entryHash → HASH_BROKEN, quarantined, writes blocked at both layers", async () => {
    const { invoiceId } = await seedBalancedLedger();

    // Tamper with a real entry's hash (silent DB compromise simulation).
    // We find the PAID event's CASH row so the chain clearly breaks.
    const target = await prisma.ledgerEntry.findFirst({
      where: {
        userId: testUserId,
        invoiceId,
        eventType: "INVOICE_PAID",
        account: "CASH",
      },
      orderBy: { entryIndex: "asc" },
    });
    expect(target).not.toBeNull();
    const tamperedHash = "deadbeef" + "0".repeat(56); // 64-char hex, invalid chain link
    await prisma.$executeRawUnsafe(
      `UPDATE ledger_entries SET "entryHash" = '${tamperedHash}' WHERE id = '${target!.id}'`
    );

    const result = await reconcileTenant(testUserId, { force: true });

    expect(result.status).toBe("HASH_BROKEN");
    expect(result.criticalCount).toBeGreaterThanOrEqual(1);
    expect(result.quarantined).toBe(true);
    expect(result.discrepancies.some((d) => d.kind === "HASH_CHAIN_BROKEN")).toBe(true);

    // User row must be flagged with HASH_CHAIN_BROKEN reason.
    const user = await prisma.user.findUnique({ where: { id: testUserId } });
    expect(user).not.toBeNull();
    expect(user!.ledgerQuarantinedAt).toBeInstanceOf(Date);
    expect(user!.ledgerQuarantineReason).toBe("HASH_CHAIN_BROKEN");

    // Layer 1 (app): postLedgerEvent / withTenant must throw
    // LedgerQuarantinedError BEFORE acquiring the advisory lock.
    let threwAppLayer = false;
    try {
      await postLedgerEvent({
        type: "EXPENSE_RECORDED",
        expense: {
          id: "exp_blocked_" + crypto.randomBytes(3).toString("hex"),
          userId: testUserId,
          amount: 50,
          category: "Should be blocked",
        },
      });
    } catch (err) {
      threwAppLayer = isQuarantineError(err);
    }
    expect(threwAppLayer).toBe(true);

    // Layer 3 (DB kernel): even if an attacker bypassed the app check
    // (e.g., direct SQL via service_role with app.current_user_id set),
    // the BEFORE-row trigger raises L0001. We simulate this by running
    // INSERT inside withTenant (which SETs the GUC) using raw SQL.
    let threwDbLayer = false;
    let dbErr: unknown = null;
    try {
      // Bypass the withTenant pre-check by running as superuser and
      // SET LOCAL ROLE app_user + app.current_user_id ourselves via the
      // silent prisma client, then issue a raw INSERT. This exercises
      // the Postgres kernel trigger directly without going through the
      // app-layer assertNotQuarantined() short-circuit.
      await silentPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_user_id = '${testUserId}'`
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO expenses (id, "userId", date, category, description, amount, "createdAt", "updatedAt")
           VALUES ('exp_raw_blocked','${testUserId}', CURRENT_DATE, 'x', 'x', 0::numeric, now(), now())`
        );
      });
    } catch (err) {
      dbErr = err;
      threwDbLayer = isQuarantineError(err);
    }
    if (!threwDbLayer) {
      // eslint-disable-next-line no-console
      console.error("DB-layer insert did not throw L0001:", dbErr);
    }
    expect(threwDbLayer).toBe(true);
  });

  // ---------------------------------------------------------------
  // TEST D — force-release clears the flag; non-force release refuses
  // ---------------------------------------------------------------
  it("D: force-release clears quarantine and does not re-quarantine; non-force release is refused", async () => {
    // Set up a tampered / quarantined tenant using the same pattern as
    // Test C, then verify both release paths.
    const { invoiceId } = await seedBalancedLedger();
    const target = await prisma.ledgerEntry.findFirst({
      where: {
        userId: testUserId,
        invoiceId,
        eventType: "INVOICE_ISSUED",
        account: "ACCOUNTS_RECEIVABLE",
      },
    });
    expect(target).not.toBeNull();
    await prisma.$executeRawUnsafe(
      `UPDATE ledger_entries SET "entryHash" = 'cafebabe' || LPAD('',56,'0') WHERE id = '${target!.id}'`
    );
    const bad = await reconcileTenant(testUserId, { force: true });
    expect(bad.status).toBe("HASH_BROKEN");
    expect(bad.quarantined).toBe(true);

    // --- Non-force release must be refused (hash is still broken) ---
    const refused = await releaseQuarantine(
      testUserId,
      "Attempting release on broken chain — should be refused",
      { force: false }
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toBeTruthy();
    // Quarantine flag must still be set.
    const stillQ = await prisma.user.findUnique({ where: { id: testUserId } });
    expect(stillQ!.ledgerQuarantinedAt).not.toBeNull();

    // --- Force release must clear flag and NOT re-quarantine ---
    const released = await releaseQuarantine(
      testUserId,
      "Emergency CI override — investigating hash break offline",
      { force: true }
    );
    expect(released.ok).toBe(true);
    expect(released.error).toBeFalsy();
    // The confirm run ran in auditOnly mode → result exists but did not
    // set quarantine flag (we can't read internal options, but we assert
    // below that ledgerQuarantinedAt is null after the call).
    expect(released.result).toBeTruthy();

    const after = await prisma.user.findUnique({ where: { id: testUserId } });
    expect(after).not.toBeNull();
    expect(after!.ledgerQuarantinedAt).toBeNull();
    expect(after!.ledgerQuarantineReason).toBeNull();

    // There must be two fresh audit rows from the force path:
    //  1) the INFO "Quarantine released (force)" row
    //  2) the auditOnly confirm-run recording the (still-broken) state
    const postReleaseAudits = await prisma.reconciliationAudit.findMany({
      where: { tenantId: testUserId },
      orderBy: { startedAt: "desc" },
      take: 3,
    });
    expect(postReleaseAudits.length).toBeGreaterThanOrEqual(2);
    // The confirm run must NOT have tripped quarantine again.
    const confirmRun = postReleaseAudits[0];
    expect(confirmRun.tenantId).toBe(testUserId);

    // And the tenant is genuinely writable again (no L0001 on a benign insert).
    // We create a trivial expense via backfill's path (which is
    // quarantined-check-gated) to prove writes are open.
    await expect(
      backfillLedgerForSingleTenant(testUserId)
    ).resolves.toBeDefined();
  });

  // ---------------------------------------------------------------
  // TEST E — void after partial payment → zero AR and zero CASH
  //          delta (no false CASH_MISMATCH / AR_MISMATCH).
  //
  // Regression guard against a prior bug where INVOICE_VOIDED only
  // reversed cash when the caller passed paidAmount=totalAmount (the
  // full-payment case). A partial payment (or an invoice that had a
  // prior PAYMENT_REVERSED) would leave CASH out of balance and
  // trigger a false-positive HIGH drift. The ledger builder now
  // reverses exactly the NET cash posted for the invoice (via
  // resolveCashPaidForInvoice) so voided invoices always net to 0
  // on both AR and CASH.
  // ---------------------------------------------------------------
  it("E: void after partial/full payment → PASSED, zero AR/CASH drift (no false HIGH)", async () => {
    // Build a fresh invoice directly via Prisma, then post events
    // through the real ledger path (which updates the tail hash and
    // exercises the balanced-entry guards).
    const clientId = "cli_void_" + crypto.randomBytes(4).toString("hex");
    const invoiceId = "inv_void_" + crypto.randomBytes(4).toString("hex");
    const today = new Date();
    const due = new Date(today.getTime() + 30 * 86400_000);
    await prisma.client.create({
      data: { id: clientId, userId: testUserId, name: "Void CI", email: "void-ci@example.com" },
    });

    // ₹2000 + 18% GST = ₹2360 total. We will pay ₹1000 (partial) then
    // void — the void must reverse the ₹1000 CASH Dr and zero out the
    // full issuance AR so the books read: AR=0, CASH offset to 0, and
    // PENDING aggregate = 0 (status=VOID excluded from AR expectation).
    const items = [{ description: "Partial-pay services", quantity: 1, price: 2000 }];
    await prisma.invoice.create({
      data: {
        id: invoiceId,
        userId: testUserId,
        clientId,
        invoiceNumber: "VOID-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
        status: "VOID",
        issueDate: today,
        dueDate: due,
        subtotal: new Prisma.Decimal("2000.00"),
        taxRate: new Prisma.Decimal("18.00"),
        taxLabel: "GST",
        totalAmount: new Prisma.Decimal("2360.00"),
        discountAmount: new Prisma.Decimal("0.00"),
        items: {
          create: [
            {
              id: "itm_v_" + crypto.randomBytes(3).toString("hex"),
              userId: testUserId,
              description: items[0].description,
              quantity: items[0].quantity,
              price: new Prisma.Decimal("2000.00"),
              total: new Prisma.Decimal("2000.00"),
            },
          ],
        },
      },
    });

    // 1) Issuance: full ₹2360 AR Dr.
    await postLedgerEvent({
      type: "INVOICE_ISSUED",
      invoice: { id: invoiceId, userId: testUserId, items, taxRate: 18 },
    });
    // 2) Partial payment: ₹1000 Cash Dr / ₹1000 AR Cr.
    await postLedgerEvent({
      type: "INVOICE_PAID",
      invoice: { id: invoiceId, userId: testUserId, totalAmount: 1000 },
      amountPaid: 1000,
    });

    // Sanity pre-void: CASH ledger has exactly ₹1000 Dr, AR has 2360-1000 = 1360 Dr.
    const preVoidCash = await resolveCashPaidForInvoice(invoiceId, testUserId);
    expect(preVoidCash).toBe(BigInt(100000)); // 1000 * 100 paise

    // 3) Void — reverse issuance + reverse only the partial cash receipt.
    //    We post through the same path the voidInvoice helper uses:
    //    INVOICE_VOIDED with paidAmount=net cash paid (resolveCashPaidForInvoice).
    const netCash = await resolveCashPaidForInvoice(invoiceId, testUserId);
    await postLedgerEvent({
      type: "INVOICE_VOIDED",
      invoice: {
        id: invoiceId,
        userId: testUserId,
        items,
        taxRate: 18,
        paidAmount: netCash,
      },
    });

    // Sweep B sanity: AR expected from invoices should be 0 (VOID is
    // excluded; no PENDING rows for this tenant beyond what we seeded).
    // Ledger AR balance should also be 0; CASH balance should equal
    // 0 - baseline-expense-drift because there are no expenses yet → 0.
    // Invoke the real reconciler (Sweep A must pass: hash chain,
    // per-event balance, no gaps; Sweep B must report zero HIGH/CRITICAL).
    const res = await reconcileTenant(testUserId, { force: true });

    expect(res.status).toBe("PASSED");
    expect(res.criticalCount).toBe(0);
    expect(res.highCount).toBe(0);
    expect(res.mediumCount).toBe(0);
    expect(res.quarantined).toBe(false);
    expect(res.autoRemediated).toBe(false);

    // Assert no AR_MISMATCH / CASH_MISMATCH in discrepancies explicitly
    // (belt-and-braces: a medium REVENUE_TAX drift shouldn't fire either,
    // since our VOID posting fully reverses the issuance).
    const kinds = res.discrepancies.map((d) => d.kind);
    expect(kinds).not.toContain("AR_MISMATCH");
    expect(kinds).not.toContain("CASH_MISMATCH");
    expect(kinds).not.toContain("EXPENSE_MISMATCH");
    expect(kinds).not.toContain("REVENUE_TAX_MISMATCH");

    // Also test the full-payment path to ensure we didn't regress that:
    // create another invoice, pay in full, void → should also net 0.
    const inv2 = "inv_void_full_" + crypto.randomBytes(4).toString("hex");
    const itm2 = "itm_vf_" + crypto.randomBytes(3).toString("hex");
    await prisma.invoice.create({
      data: {
        id: inv2,
        userId: testUserId,
        clientId,
        invoiceNumber: "VOIDF-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
        status: "VOID",
        issueDate: today,
        dueDate: due,
        subtotal: new Prisma.Decimal("500.00"),
        taxRate: new Prisma.Decimal(0),
        taxLabel: "GST",
        totalAmount: new Prisma.Decimal("500.00"),
        discountAmount: new Prisma.Decimal("0.00"),
        items: {
          create: [
            {
              id: itm2,
              userId: testUserId,
              description: "Full-pay then void",
              quantity: 1,
              price: new Prisma.Decimal("500.00"),
              total: new Prisma.Decimal("500.00"),
            },
          ],
        },
      },
    });
    const items2 = [{ description: "Full-pay then void", quantity: 1, price: 500 }];
    await postLedgerEvent({
      type: "INVOICE_ISSUED",
      invoice: { id: inv2, userId: testUserId, items: items2, taxRate: 0 },
    });
    await postLedgerEvent({
      type: "INVOICE_PAID",
      invoice: { id: inv2, userId: testUserId, totalAmount: 500 },
      amountPaid: 500,
    });
    const netCash2 = await resolveCashPaidForInvoice(inv2, testUserId);
    await postLedgerEvent({
      type: "INVOICE_VOIDED",
      invoice: {
        id: inv2,
        userId: testUserId,
        items: items2,
        taxRate: 0,
        paidAmount: netCash2,
      },
    });
    const res2 = await reconcileTenant(testUserId, { force: true });
    expect(res2.status).toBe("PASSED");
    expect(res2.highCount).toBe(0);
    expect(res2.criticalCount).toBe(0);
    expect(res2.discrepancies.map((d) => d.kind)).not.toContain("CASH_MISMATCH");
  });
});
