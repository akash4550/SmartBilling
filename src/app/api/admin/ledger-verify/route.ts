/**
 * GET /api/admin/ledger-verify
 *
 * Returns the result of verifyUserLedger() for the currently signed-in
 * tenant. Walks the SHA-256 hash chain, validates per-event balanced
 * postings, checks the user tail pointer, and reports account balances
 * (ACCOUNTS_RECEIVABLE vs open PENDING invoices, CASH, REVENUE, TAX_PAYABLE,
 * EXPENSES). Used by the Settings page "Verify Ledger" button and for
 * operational health checks.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized, jsonError } from "@/lib/api-helpers";
import { verifyUserLedger } from "@/lib/ledger";
import { toSubunit } from "@/lib/money";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const verification = await verifyUserLedger(user.id);

    // Cross-check AR balance against open (PENDING) invoice totals.
    // SmartBill currently uses a single currency per tenant (from settings),
    // defaulting to INR; subunit conversion uses the tenant currency.
    const settings = await prisma.settings.findUnique({
      where: { userId: user.id },
      select: { currency: true },
    });
    const currency = settings?.currency || "INR";
    const open = await prisma.invoice.findMany({
      where: { userId: user.id, status: "PENDING" },
      select: { totalAmount: true },
    });
    let openTotalPaise = BigInt(0);
    for (const inv of open) {
      openTotalPaise += BigInt(toSubunit(inv.totalAmount, currency));
    }

    const arBalance = BigInt(verification.accountBalances.ACCOUNTS_RECEIVABLE ?? "0");
    const arMatchesOpen = arBalance === openTotalPaise;

    return NextResponse.json({
      ...verification,
      openReceivablePaise: openTotalPaise.toString(),
      accountsReceivableMatchesOpenInvoices: arMatchesOpen,
      ok: verification.valid && arMatchesOpen,
    });
  } catch (error) {
    console.error("[GET /api/admin/ledger-verify] Failed:", error);
    return jsonError("Ledger verification failed", 500);
  }
}
