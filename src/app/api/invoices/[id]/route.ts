import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { prisma } from "@/lib/prisma";
import { invoiceSchema } from "@/lib/validations";
import {
  calculateInvoiceTotals,
} from "@/lib/utils";
import {
  validationErrorResponse,
  jsonError,
  requireUser,
  unauthorized,
  getPrismaErrorCode,
} from "@/lib/api-helpers";
import { logActivity, clientIp } from "@/lib/activity";
import { rateLimit, requestKey } from "@/lib/rate-limit";
import { markInvoicePaid } from "@/lib/invoice-helpers";
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
    const rl = rateLimit(requestKey(request), {
      namespace: "public:get-invoice",
      limit: 60,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests — please try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
        }
      );
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
        // Public views attribute to the invoice owner so they appear in the
        // admin timeline (the client isn't authenticated, so we can't look
        // them up as a User).
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
 *   1. { status: "DRAFT"|"PENDING"|"PAID" }  — lightweight status update
 *      (used by Mark-as-Paid).
 *   2. Full invoice payload (clientId, issueDate, dueDate, taxRate, notes,
 *      items) — used by the Edit Invoice form. Line items are replaced:
 *      items present in the payload are upserted by id (if they match an
 *      existing item on this invoice), newly generated ids are created,
 *      and items that were removed in the form are deleted. Totals are
 *      recomputed server-side.
 *
 * Must own the invoice.
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const { id } = await params;

    // 🔒 Ownership check (load items for full-update replacement logic)
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
      if (validated.status === "PAID" && existing.status !== "PAID") {
        // Use shared helper → sets paidAt, logs activity, sends receipt email.
        const invoice = await markInvoicePaid(id, {
          provider: "manual",
          actorUserId: user.id,
          ip: clientIp(request),
        });
        if (!invoice) return jsonError("Invoice not found", 404);
        // Reload with relations for the response.
        const reloaded = await prisma.invoice.findUnique({
          where: { id },
          include: { client: true, items: true },
        });
        return NextResponse.json(reloaded, { status: 200 });
      }
      // Other status transitions (e.g. PAID → PENDING, PENDING → DRAFT, any → VOID).
      const now = new Date();
      const updateData: {
        status: "DRAFT" | "PENDING" | "PAID" | "VOID";
        paidAt?: Date | null;
      } = { status: validated.status };
      if (validated.status !== "PAID" && existing.status === "PAID") {
        updateData.paidAt = null;
      } else if (validated.status === "PAID") {
        updateData.paidAt = now;
      }
      const invoice = await prisma.invoice.update({
        where: { id },
        data: updateData,
        include: { client: true, items: true },
      });
      logActivity({
        invoiceId: id,
        userId: user.id,
        type: validated.status === "VOID" ? "VOIDED" : "EDITED",
        message: validated.status === "VOID"
          ? "Invoice voided (cancelled without payment)"
          : `Status changed to ${validated.status}`,
        ip: clientIp(request),
      });
      return NextResponse.json(invoice, { status: 200 });
    }

    // ---------- Full update ----------
    const validated = fullUpdateSchema.parse(body);

    // 🔒 Verify the (possibly changed) client still belongs to this user.
    const client = await prisma.client.findFirst({
      where: { id: validated.clientId, userId: user.id },
    });
    if (!client) return jsonError("Selected client does not exist", 404);

    const { subtotal, discountAmount, total } = calculateInvoiceTotals(
      validated.items,
      validated.taxRate,
      validated.discountType
        ? { type: validated.discountType, value: validated.discountValue ?? 0 }
        : {},
    );

    // Replace line items: diff incoming items vs existing.
    // Incoming items may carry either (a) a known existing id (edit), or
    // (b) a client-generated placeholder id (new item). We upsert known ids
    // and create new ones; then delete any existing ids not present in the
    // payload.
    const existingById = new Map(existing.items.map((it) => [it.id, it]));
    const keepIds = new Set<string>();
    const itemsData = validated.items.map((it, idx) => {
      const lineTotal =
        Math.round((it.quantity * it.price + Number.EPSILON) * 100) / 100;
      // Zod strips unknown keys unless we allow them, so incoming item `id`
      // values aren't on the validated output. We re-extract defensively from
      // the raw body items list so edits can upsert existing rows.
      const rawItem = Array.isArray(body?.items) ? (body.items[idx] as unknown) : null;
      const candidateId =
        rawItem &&
        typeof rawItem === "object" &&
        "id" in rawItem &&
        typeof (rawItem as { id?: unknown }).id === "string"
          ? (rawItem as { id: string }).id
          : undefined;
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

    // If the user is moving AWAY from PAID (e.g. editing totals), clear paidAt.
    // If they're moving TO PAID (including staying paid), preserve/set paidAt.
    const now = new Date();
    let paidAtValue: Date | null | undefined = undefined;
    if (validated.status === "PAID" && existing.status !== "PAID") {
      paidAtValue = now;
    } else if (validated.status !== "PAID" && existing.status === "PAID") {
      paidAtValue = null;
    }

    const invoice = await prisma.$transaction(async (tx) => {
      if (deleteIds.length > 0) {
        await tx.invoiceItem.deleteMany({
          where: { id: { in: deleteIds }, invoiceId: id },
        });
      }

      // Upsert each incoming item.
      for (const it of itemsData) {
        if (it.id) {
          await tx.invoiceItem.update({
            where: { id: it.id },
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
              invoiceId: id,
              description: it.description,
              quantity: it.quantity,
              price: it.price,
              total: it.total,
            },
          });
        }
      }

      return tx.invoice.update({
        where: { id },
        data: {
          clientId: validated.clientId,
          status: validated.status,
          issueDate: new Date(validated.issueDate),
          dueDate: new Date(validated.dueDate),
          subtotal,
          discountType: validated.discountType ?? null,
          discountValue: validated.discountType && validated.discountValue != null
            ? validated.discountValue
            : null,
          discountAmount,
          taxRate: validated.taxRate,
          taxLabel: (validated.taxLabel && validated.taxLabel.trim()) || existing.taxLabel || "GST",
          totalAmount: total,
          notes: validated.notes ?? null,
          ...(paidAtValue === undefined ? {} : { paidAt: paidAtValue }),
        },
        include: { client: true, items: { orderBy: { id: "asc" } } },
      });
    });

    // Activity event: detect what changed (status transition, details edit).
    const changedParts: string[] = [];
    if (existing.status !== invoice.status) {
      if (invoice.status === "PAID") changedParts.push(`status → Paid (${Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(invoice.totalAmount))})`);
      else changedParts.push(`status → ${invoice.status}`);
    }
    if (
      existing.clientId !== invoice.clientId ||
      Number(existing.taxRate) !== Number(invoice.taxRate) ||
      existing.notes !== invoice.notes ||
      deleteIds.length > 0 ||
      itemsData.some((it) => !it.id) // any newly added item
    ) {
      changedParts.push("details edited");
    }
    logActivity({
      invoiceId: id,
      userId: user.id,
      type: invoice.status === "PAID" && existing.status !== "PAID" ? "MARKED_PAID" : "EDITED",
      message: changedParts.length
        ? `Invoice updated — ${changedParts.join(", ")}`
        : "Invoice updated",
      ip: clientIp(request),
    });

    return NextResponse.json(invoice, { status: 200 });
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    if (error instanceof SyntaxError) return jsonError("Invalid JSON payload", 400);
    if (getPrismaErrorCode(error) === "P2025" || getPrismaErrorCode(error) === "P2016") {
      return jsonError("Invoice not found", 404);
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

    await prisma.invoice.delete({ where: { id } });
    return NextResponse.json({ success: true, message: "Invoice deleted" }, { status: 200 });
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2025" || getPrismaErrorCode(error) === "P2016") {
      return jsonError("Invoice not found", 404);
    }
    console.error("[DELETE /api/invoices/:id] Failed:", error);
    return jsonError("Failed to delete invoice", 500);
  }
}



function maskIp(ip: string): string {
  // Truncate the last octet for privacy in UI (e.g. 192.168.1.xxx).
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
