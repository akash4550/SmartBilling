import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized, jsonError } from "@/lib/api-helpers";
import { generateInvoiceNumber, calculateInvoiceTotals } from "@/lib/utils";
import { logActivity, clientIp } from "@/lib/activity";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/invoices/:id/duplicate
 *
 * Create a new DRAFT invoice that's a copy of an existing one (same client,
 * line items, tax rate, notes). Dates default to today / today+30 (to avoid
 * accidentally issuing an invoice with stale dates). The new invoice is
 * always DRAFT, regardless of the source's status.
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const { id } = await params;

    const source = await prisma.invoice.findFirst({
      where: { id, userId: user.id },
      include: { items: true },
    });
    if (!source) return jsonError("Invoice not found", 404);

    // Parse optional query params: ?clientId=<id> to clone for a different client
    const url = new URL(request.url);
    const overrideClientId = url.searchParams.get("clientId") ?? source.clientId;
    if (overrideClientId !== source.clientId) {
      const allowed = await prisma.client.findFirst({
        where: { id: overrideClientId, userId: user.id },
        select: { id: true },
      });
      if (!allowed) return jsonError("Target client not found", 404);
    }

    // Fetch user settings for default due days and invoice prefix (fall back
    // to source invoice's tax rate's defaults if missing).
    const settings = await prisma.settings.findUnique({
      where: { userId: user.id },
      select: { defaultDueDays: true, invoicePrefix: true, invoiceSeparator: true, invoicePad: true },
    });
    const dueDays = Number(settings?.defaultDueDays ?? 30);

    // New dates: today + default due days out
    const issueDate = new Date();
    issueDate.setHours(0, 0, 0, 0);
    const dueDate = new Date(issueDate);
    dueDate.setDate(dueDate.getDate() + dueDays);

    const lineItems = source.items.map((it) => ({
      description: it.description,
      quantity: it.quantity,
      price: Number(it.price),
      total: Number(it.total),
    }));

    const discount = source.discountType && source.discountValue != null
      ? { type: source.discountType, value: Number(source.discountValue) }
      : {};

    const totals = calculateInvoiceTotals(
      lineItems.map((li) => ({ quantity: li.quantity, price: li.price })),
      Number(source.taxRate),
      discount
    );

    // Generate next invoice number using today's count and user's prefix
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const todayCount = await prisma.invoice.count({
      where: { userId: user.id, createdAt: { gte: startOfDay, lte: endOfDay } },
    });
    const invoiceNumber = generateInvoiceNumber(todayCount, {
      prefix: settings?.invoicePrefix ?? "INV",
      separator: settings?.invoiceSeparator || "-",
      pad: Number(settings?.invoicePad) || 4,
    });

    const invoice = await prisma.invoice.create({
      data: {
        userId: user.id,
        invoiceNumber,
        clientId: overrideClientId,
        status: "DRAFT",
        issueDate,
        dueDate,
        subtotal: totals.subtotal,
        discountType: source.discountType,
        discountValue: source.discountValue,
        discountAmount: totals.discountAmount,
        taxRate: source.taxRate,
        taxLabel: source.taxLabel || "GST",
        totalAmount: totals.total,
        notes: source.notes,
        items: {
          create: lineItems.map((li) => ({
            description: li.description,
            quantity: li.quantity,
            price: li.price,
            total: li.total,
          })),
        },
      },
      include: { client: true, items: true },
    });

    logActivity({
      invoiceId: invoice.id,
      userId: user.id,
      type: "CREATED",
      message: `Invoice duplicated from ${source.invoiceNumber}`,
      ip: clientIp(request),
      meta: { duplicatedFrom: source.invoiceNumber },
    });

    // Also log a note on the source invoice that it was duplicated (optional
    // extra audit breadcrumb).
    logActivity({
      invoiceId: source.id,
      userId: user.id,
      type: "EDITED",
      message: `Duplicated to new invoice ${invoice.invoiceNumber}`,
      ip: clientIp(request),
      meta: { duplicatedTo: invoice.id },
    });

    return NextResponse.json(invoice, { status: 201 });
  } catch (error) {
    console.error("[POST /api/invoices/:id/duplicate] Failed:", error);
    return jsonError("Failed to duplicate invoice", 500);
  }
}
