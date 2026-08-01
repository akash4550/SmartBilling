import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { prisma } from "@/lib/prisma";
import { invoiceSchema } from "@/lib/validations";
import { calculateInvoiceTotals } from "@/lib/utils";
import {
  validationErrorResponse,
  jsonError,
  requireUser,
  unauthorized,
  getPrismaErrorCode,
} from "@/lib/api-helpers";
import { logActivity, clientIp } from "@/lib/activity";
import { checkRateLimit, requestKey } from "@/lib/rate-limiter";
import { markInvoicePaid, voidInvoice } from "@/lib/invoice-helpers";
import { withTenant } from "@/lib/tenant";
import { postLedgerEvent } from "@/lib/ledger";
import { z } from "zod";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// ---------- Schemas ----------

/** Lightweight status-only update (used by Mark-as-Paid, Void, etc.). */
const statusOnlySchema = z.object({
  status: z.enum(["DRAFT", "PENDING", "PAID", "VOID"], {
    message: "Status must be one of: DRAFT, PENDING, PAID, VOID",
  }),
});

/** Full invoice update (used by the Edit Invoice form). Reuses the create
 *  schema but relaxes `items` to be replaceable. We deliberately re-validate
 *  the entire shape so totals are recomputed server-side. */
const fullUpdateSchema = invoiceSchema;

// ---------- GET (public) ----------

/**
 * GET /api/invoices/:id
 *
 * Public (no auth required) so the emailed /view/:id link works without
 * logging in. Invoice IDs are non-guessable CUIDs and only READ access is
 * exposed here. Mutations below are protected.
 */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;

    // Rate-limit public invoice fetches (CUID brute-force protection).
    const rl = await checkRateLimit(requestKey(request), {
      namespace: "public:get-invoice",
      limit: 60,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return rl.toResponse('Too many requests — please try again later.');
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: { client: true, items: { orderBy: { id: "asc" } } },
    });
    if (!invoice) return jsonError("Invoice not found", 404);

    // Public view tracking — record a VIEWED event at most once per hour per
    // invoice/IP so reloading the page doesn't spam the timeline.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const ip = clientIp(request);
    const recentView = await prisma.invoiceActivity.findFirst({
      where: {
        invoiceId: id,
        type: "VIEWED",
        ip: ip ?? undefined,
        createdAt: { gte: oneHourAgo },
      },
      select: { id: true },
    });
    if (!recentView) {
      logActivity({
        invoiceId: id,
        userId: invoice.userId,
        type: "VIEWED",
        message: `Invoice viewed by client${ip ? ` (${maskIp(ip)})` : ""}`,
        ip,
        meta: { public: true },
      });
    }

    return NextResponse.json(invoice, { status: 200 });
  } catch (error) {
    console.error("[GET /api/invoices/:id] Failed:", error);
    return jsonError("Failed to fetch invoice", 500);
  }
}

// ---------- PATCH ----------

/**
 * PATCH /api/invoices/:id
 *
 * Supports two shapes:
 *   1. { status: "DRAFT"|"PENDING"|"PAID"|"VOID" }  — lightweight status update
 *      (used by Mark-as-Paid).
 *   2. Full invoice payload (clientId, issueDate, dueDate, taxRate, notes,
 *      items) — used by the Edit Invoice form. Line items are replaced:
 *      items present in the payload are upserted by id (if they match an
 *      existing item on THIS invoice — see C5 hardening below), newly
 *      generated ids are created, and items that were removed in the form
 *      are deleted. Totals are recomputed server-side.
 *
 * Must own the invoice.
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const { id } = await params;

    // Ownership check (load items for full-update replacement logic).
    const existing = await prisma.invoice.findFirst({
      where: { id, userId: user.id },
      include: { items: true },
    });
    if (!existing) return jsonError("Invoice not found", 404);

    const body = await request.json();

    // Heuristic: if payload is status-only and has no other invoice fields,
    // treat it as a status update.
    const keys = Object.keys(body ?? {});
    const isStatusOnly =
      keys.length === 1 && keys[0] === "status" && typeof body.status === "string";

    if (isStatusOnly) {
      const validated = statusOnlySchema.parse(body);
      // Cast to the full union to prevent TS from narrowing based on the
      // early-return branches below.
      const targetStatus = validated.status as "DRAFT" | "PENDING" | "PAID" | "VOID";

      if (targetStatus === "VOID") {
        // VOID: atomic status update + reversing ledger entries (issuance
        // reversed; payment reversed if PAID). voidInvoice is idempotent.
        const invoice = await voidInvoice(id, { actorUserId: user.id, ip: clientIp(request) });
        if (!invoice) return jsonError("Invoice not found", 404);
        // Reload with client for response.
        const reloaded = await prisma.invoice.findUnique({
          where: { id },
          include: { client: true, items: true },
        });
        return NextResponse.json(reloaded ?? invoice, { status: 200 });
      }

      if (targetStatus === "PAID" && existing.status !== "PAID") {
        // Shared atomic helper (already uses withTenant internally).
        const invoice = await markInvoicePaid(id, {
          provider: "manual",
          actorUserId: user.id,
          ip: clientIp(request),
        });
        if (!invoice) {
          const reloaded = await prisma.invoice.findUnique({
            where: { id },
            include: { client: true, items: true },
          });
          if (reloaded) return NextResponse.json(reloaded, { status: 200 });
          return jsonError("Invoice not found", 404);
        }
        const reloaded = await prisma.invoice.findUnique({
          where: { id },
          include: { client: true, items: true },
        });
        return NextResponse.json(reloaded, { status: 200 });
      }

      // Other status transitions (DRAFT/PENDING transitions; PAID is a
      // no-op if already PAID) — wrapped in withTenant for RLS.
      const now = new Date();
      const leavingPaid = existing.status === "PAID" && targetStatus !== "PAID";
      const becomingPaid = targetStatus === "PAID" && existing.status !== "PAID";
      const issuingFromDraft =
        existing.status === "DRAFT" &&
        (targetStatus === "PENDING" || targetStatus === "PAID");

      const updateData: {
        status: "DRAFT" | "PENDING" | "PAID" | "VOID";
        paidAt?: Date | null;
      } = { status: targetStatus };
      if (targetStatus !== "PAID" && existing.status === "PAID") {
        updateData.paidAt = null;
      } else if (becomingPaid) {
        updateData.paidAt = now;
      }

      const invoice = await withTenant(user.id, async (tx) => {
        const updated = await tx.invoice.update({
          where: { id },
          data: updateData,
          include: { client: true, items: true },
        });

        if (issuingFromDraft) {
          await postLedgerEvent(
            {
              type: "INVOICE_ISSUED",
              invoice: {
                id: updated.id,
                userId: updated.userId,
                items: existing.items.map((i) => ({
                  description: i.description,
                  quantity: i.quantity,
                  price: Number(i.price),
                })),
                taxRate: Number(updated.taxRate),
                discountType: existing.discountType,
                discountValue: existing.discountValue != null ? Number(existing.discountValue) : null,
              },
            },
            tx
          );
        }

        if (becomingPaid) {
          await postLedgerEvent(
            {
              type: "INVOICE_PAID",
              invoice: { id: updated.id, userId: updated.userId, totalAmount: updated.totalAmount },
              amountPaid: updated.totalAmount,
            },
            tx
          );
        }

        if (leavingPaid) {
          // PAID → PENDING/DRAFT: reverse the payment.
          await postLedgerEvent(
            {
              type: "PAYMENT_REVERSED",
              invoice: { id: updated.id, userId: updated.userId },
              amount: existing.totalAmount,
              note: "Payment unmarked via status change",
            },
            tx
          );
        }

        return updated;
      });
      logActivity({
        invoiceId: id,
        userId: user.id,
        type: "EDITED",
        message: `Status changed to ${targetStatus}`,
        ip: clientIp(request),
      });
      return NextResponse.json(invoice, { status: 200 });
    }

    // ---------- Full update ----------
    const validated = fullUpdateSchema.parse(body);

    // Verify the (possibly changed) client still belongs to this user.
    const client = await prisma.client.findFirst({
      where: { id: validated.clientId, userId: user.id },
    });
    if (!client) return jsonError("Selected client does not exist", 404);

    const { subtotal, discountAmount, total } = calculateInvoiceTotals(
      validated.items,
      validated.taxRate,
      validated.discountType
        ? { type: validated.discountType, value: validated.discountValue ?? 0 }
        : {}
    );

    // ---- C5 hardening: line-item ids must belong to THIS invoice ----
    //
    // Zod strips unknown keys, so incoming item `id` values aren't present
    // on `validated.items`. We re-extract from the raw body and WHITELIST
    // them: an id is only accepted for upsert if it refers to an existing
    // line item on the invoice being edited. Any other id (cross-tenant,
    // non-existent, or from a different invoice owned by the same user) is
    // discarded and treated as a new item (server will issue a fresh CUID).
    // As defense-in-depth, every tx.invoiceItem.update below additionally
    // scopes the WHERE clause to `{ id, invoiceId }` so a slipped id cannot
    // mutate rows outside this invoice.
    const existingById = new Map(existing.items.map((it) => [it.id, it]));
    const keepIds = new Set<string>();
    const itemsData = validated.items.map((it, idx) => {
      const lineTotal =
        Math.round((it.quantity * it.price + Number.EPSILON) * 100) / 100;

      const rawItem = Array.isArray(body?.items)
        ? (body.items[idx] as unknown)
        : null;
      const candidateId =
        rawItem &&
        typeof rawItem === "object" &&
        "id" in rawItem &&
        typeof (rawItem as { id?: unknown }).id === "string"
          ? ((rawItem as { id: string }).id as string)
          : undefined;

      // Whitelist: only accept ids that exist on THIS invoice.
      const existingId =
        candidateId && existingById.has(candidateId) ? candidateId : undefined;
      if (existingId) keepIds.add(existingId);

      return {
        ...(existingId ? { id: existingId } : {}),
        description: it.description,
        quantity: it.quantity,
        price: it.price,
        total: lineTotal,
      };
    });

    const deleteIds = existing.items
      .filter((it) => !keepIds.has(it.id))
      .map((it) => it.id);

    // Status transition ledger rules for full-edit PATCH:
    //   DRAFT → PENDING/PAID : issue INVOICE_ISSUED (first time it's sent out)
    //   *     → PAID         : post INVOICE_PAID (mark paid)
    //   PAID  → non-PAID     : post PAYMENT_REVERSED (un-pay / refund)
    //   *     → VOID         : post INVOICE_VOIDED (reverses issuance + payment)
    // Editing line items/totals on an already-issued (PENDING/PAID) invoice
    // without a status change is not back-propagated to the ledger — the
    // ledger is append-only. To correct a financial amount, void + reissue.
    const now = new Date();
    const prevStatus = existing.status as "DRAFT" | "PENDING" | "PAID" | "VOID";
    const newStatus = validated.status as "DRAFT" | "PENDING" | "PAID" | "VOID";
    const becomingVoid = newStatus === "VOID" && prevStatus !== "VOID";
    const becomingPaid = newStatus === "PAID" && prevStatus !== "PAID";
    // void handles its own payment reversal; leavingPaid is PAID → non-PAID non-VOID:
    const leavingPaid =
      newStatus !== "PAID" && newStatus !== "VOID" && prevStatus === "PAID";
    const issuingFromDraft =
      prevStatus === "DRAFT" && (newStatus === "PENDING" || newStatus === "PAID");

    let paidAtValue: Date | null | undefined = undefined;
    if (becomingPaid) paidAtValue = now;
    else if (newStatus !== "PAID" && prevStatus === "PAID") paidAtValue = null;

    // Build the post-update items snapshot for INVOICE_ISSUED posting. If
    // issuing from draft we use the newly-validated items; for VOID we use
    // the original items (since void reverses the original issuance).
    const newItems = validated.items.map((it) => ({
      description: it.description,
      quantity: it.quantity,
      price: it.price,
    }));

    // Full-update tx runs inside withTenant for RLS enforcement.
    const invoice = await withTenant(user.id, async (tx) => {
      if (deleteIds.length > 0) {
        await tx.invoiceItem.deleteMany({
          where: { id: { in: deleteIds }, invoiceId: id },
        });
      }

      for (const it of itemsData) {
        if (it.id) {
          await tx.invoiceItem.update({
            where: { id: it.id, invoiceId: id },
            data: {
              description: it.description,
              quantity: it.quantity,
              price: it.price,
              total: it.total,
            },
          });
        } else {
          await tx.invoiceItem.create({
            data: {
              userId: user.id,
              invoiceId: id,
              description: it.description,
              quantity: it.quantity,
              price: it.price,
              total: it.total,
            },
          });
        }
      }

      // When the target is VOID, we update status to VOID (clearing paidAt)
      // and post INVOICE_VOIDED which reverses issuance + any payment.
      const updated = await tx.invoice.update({
        where: { id },
        data: {
          clientId: validated.clientId,
          status: newStatus,
          issueDate: new Date(validated.issueDate),
          dueDate: new Date(validated.dueDate),
          subtotal,
          discountType: validated.discountType ?? null,
          discountValue:
            validated.discountType && validated.discountValue != null
              ? validated.discountValue
              : null,
          discountAmount,
          taxRate: validated.taxRate,
          taxLabel:
            (validated.taxLabel && validated.taxLabel.trim()) ||
            existing.taxLabel ||
            "GST",
          totalAmount: total,
          notes: validated.notes ?? null,
          ...(newStatus === "VOID"
            ? { paidAt: null, stripeCheckoutSessionId: null }
            : paidAtValue === undefined
            ? {}
            : { paidAt: paidAtValue }),
        },
        include: { client: true, items: { orderBy: { id: "asc" } } },
      });

      // --- Ledger postings (all inside this tx; failures roll back). ---
      if (issuingFromDraft) {
        await postLedgerEvent(
          {
            type: "INVOICE_ISSUED",
            invoice: {
              id: updated.id,
              userId: user.id,
              items: newItems,
              taxRate: validated.taxRate,
              discountType: validated.discountType,
              discountValue: validated.discountValue ?? null,
            },
          },
          tx
        );
      }

      if (becomingPaid && !issuingFromDraft) {
        // Was already issued (PENDING/VOID→PAID shouldn't happen from VOID
        // but guard anyway); post just the payment side.
        await postLedgerEvent(
          {
            type: "INVOICE_PAID",
            invoice: { id: updated.id, userId: user.id, totalAmount: updated.totalAmount },
            amountPaid: updated.totalAmount,
          },
          tx
        );
      } else if (becomingPaid && issuingFromDraft) {
        // After INVOICE_ISSUED, also post INVOICE_PAID for PAID create/save.
        await postLedgerEvent(
          {
            type: "INVOICE_PAID",
            invoice: { id: updated.id, userId: user.id, totalAmount: updated.totalAmount },
            amountPaid: updated.totalAmount,
          },
          tx
        );
      }

      if (leavingPaid) {
        // PAID → PENDING/DRAFT: reverse the payment ledger entry.
        await postLedgerEvent(
          {
            type: "PAYMENT_REVERSED",
            invoice: { id: updated.id, userId: user.id },
            amount: existing.totalAmount,
            note: "Payment unmarked via invoice edit",
          },
          tx
        );
      }

      if (becomingVoid && prevStatus !== "DRAFT") {
        // Reverse the issuance (and payment if previously PAID). Use the
        // pre-edit items/discount/tax because those are the values the
        // INVOICE_ISSUED event was originally posted with; reversing with
        // different totals would leave a residual balance in AR/Revenue/
        // TaxPayable. (If the invoice was DRAFT nothing was ever issued,
        // so no ledger reversal is needed.)
        const wasPaid = prevStatus === "PAID";
        await postLedgerEvent(
          {
            type: "INVOICE_VOIDED",
            invoice: {
              id: updated.id,
              userId: user.id,
              items: existing.items.map((it) => ({
                description: it.description,
                quantity: it.quantity,
                price: Number(it.price),
              })),
              taxRate: Number(existing.taxRate),
              discountType: existing.discountType,
              discountValue: existing.discountValue != null ? Number(existing.discountValue) : null,
              paidAmount: wasPaid ? existing.totalAmount : null,
            },
          },
          tx
        );
      }

      return updated;
    });

    // Activity event: detect what changed.
    const changedParts: string[] = [];
    if (existing.status !== invoice.status) {
      if (invoice.status === "PAID") {
        changedParts.push(
          `status → Paid (${new Intl.NumberFormat("en-IN", {
            style: "currency",
            currency: "INR",
          }).format(Number(invoice.totalAmount))})`
        );
      } else {
        changedParts.push(`status → ${invoice.status}`);
      }
    }
    if (
      existing.clientId !== invoice.clientId ||
      Number(existing.taxRate) !== Number(invoice.taxRate) ||
      existing.notes !== invoice.notes ||
      deleteIds.length > 0 ||
      itemsData.some((it) => !it.id)
    ) {
      changedParts.push("details edited");
    }
    logActivity({
      invoiceId: id,
      userId: user.id,
      type:
        invoice.status === "PAID" && existing.status !== "PAID"
          ? "MARKED_PAID"
          : "EDITED",
      message: changedParts.length
        ? `Invoice updated — ${changedParts.join(", ")}`
        : "Invoice updated",
      ip: clientIp(request),
    });

    return NextResponse.json(invoice, { status: 200 });
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    if (error instanceof SyntaxError)
      return jsonError("Invalid JSON payload", 400);
    if (
      getPrismaErrorCode(error) === "P2025" ||
      getPrismaErrorCode(error) === "P2016"
    ) {
      // P2025 from the tx.invoiceItem.update means an id failed the
      // invoiceId scoping check → treat as validation/auth failure.
      console.warn(
        "[PATCH /api/invoices/:id] Record not found — possible attempted cross-invoice item mutation"
      );
      return jsonError("Invoice or line item not found", 404);
    }
    console.error("[PATCH /api/invoices/:id] Failed:", error);
    return jsonError("Failed to update invoice", 500);
  }
}

// ---------- DELETE ----------

/** DELETE /api/invoices/:id — must own the invoice. */
export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const { id } = await params;

    const existing = await prisma.invoice.findFirst({
      where: { id, userId: user.id },
    });
    if (!existing) return jsonError("Invoice not found", 404);

    await withTenant(user.id, (tx) => tx.invoice.delete({ where: { id } }));
    return NextResponse.json(
      { success: true, message: "Invoice deleted" },
      { status: 200 }
    );
  } catch (error) {
    if (
      getPrismaErrorCode(error) === "P2025" ||
      getPrismaErrorCode(error) === "P2016"
    ) {
      return jsonError("Invoice not found", 404);
    }
    console.error("[DELETE /api/invoices/:id] Failed:", error);
    return jsonError("Failed to delete invoice", 500);
  }
}

function maskIp(ip: string): string {
  if (ip.includes(".")) {
    const parts = ip.split(".");
    parts[parts.length - 1] = "xxx";
    return parts.join(".");
  }
  if (ip.includes(":")) {
    const parts = ip.split(":");
    parts[parts.length - 1] = "xxxx";
    return parts.join(":");
  }
  return ip;
}
