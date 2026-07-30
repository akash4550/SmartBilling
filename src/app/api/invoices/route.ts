import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { invoiceSchema } from "@/lib/validations";
import { calculateInvoiceTotals, generateInvoiceNumber } from "@/lib/utils";
import {
  getPrismaErrorCode,
  validationErrorResponse,
  jsonError,
  requireUser,
  unauthorized,
} from "@/lib/api-helpers";
import { logActivity, clientIp } from "@/lib/activity";
import { withTenant } from "@/lib/tenant";
import { postLedgerEvent } from "@/lib/ledger";
import { z } from "zod";

// ============================================================
// Query parameter validation schema (for GET)
// ============================================================
const invoiceQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(10),
  status: z.enum(["DRAFT", "PENDING", "PAID", "VOID", "OVERDUE"]).optional(),
  clientId: z.string().optional(),
  q: z
    .string()
    .trim()
    .max(100, "Search query too long")
    .optional()
    .transform((s) => (s === "" ? undefined : s)),
  overdue: z
    .enum(["true", "false"])
    .optional()
    .transform((v) =>
      v === "true" ? true : v === "false" ? false : undefined
    ),
  sortBy: z
    .enum(["issueDate", "createdAt", "dueDate", "totalAmount"])
    .default("issueDate"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

// ============================================================
// GET /api/invoices — paginated, filterable, searchable list
// ============================================================
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const { searchParams } = new URL(request.url);

    const parsed = invoiceQuerySchema.safeParse({
      page: searchParams.get("page") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      clientId: searchParams.get("clientId") ?? undefined,
      q: searchParams.get("q") ?? undefined,
      overdue: searchParams.get("overdue") ?? undefined,
      sortBy: searchParams.get("sortBy") ?? undefined,
      sortOrder: searchParams.get("sortOrder") ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid query parameters",
          details: parsed.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 400 }
      );
    }

    const { page, limit, status, clientId, q, overdue, sortBy, sortOrder } =
      parsed.data;
    const skip = (page - 1) * limit;

    // Tenant scope: always restrict to the signed-in user
    const where: Prisma.InvoiceWhereInput = { userId: user.id };
    if (status && status !== "OVERDUE") where.status = status;
    if (clientId)
      where.clientId = clientId;

    // Compute today in IST (Asia/Calcutta) — midnight boundary.
    const now = new Date();
    const istParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Calcutta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (t: string) =>
      Number(istParts.find((p) => p.type === t)?.value);
    const todayIst = new Date(
      Date.UTC(get("year"), get("month") - 1, get("day"))
    );

    if (status === "OVERDUE" || overdue === true) {
      where.status = "PENDING";
      where.dueDate = { lt: todayIst };
    }

    if (q) {
      where.OR = [
        { invoiceNumber: { contains: q, mode: "insensitive" } },
        { client: { name: { contains: q, mode: "insensitive" } } },
        { client: { email: { contains: q, mode: "insensitive" } } },
      ];
    }

    const [total, invoices, allCount, draftCount, pendingCount, paidCount, voidCount] =
      await Promise.all([
        prisma.invoice.count({ where }),
        prisma.invoice.findMany({
          where,
          orderBy: { [sortBy]: sortOrder },
          skip,
          take: limit,
          include: { client: true, items: true },
        }),
        prisma.invoice.count({ where: { userId: user.id } }),
        prisma.invoice.count({ where: { userId: user.id, status: "DRAFT" } }),
        prisma.invoice.count({
          where: { userId: user.id, status: "PENDING" },
        }),
        prisma.invoice.count({ where: { userId: user.id, status: "PAID" } }),
        prisma.invoice.count({ where: { userId: user.id, status: "VOID" } }),
      ]);

    const overdueCount = await prisma.invoice.count({
      where: { userId: user.id, status: "PENDING", dueDate: { lt: todayIst } },
    });

    const totalPages = Math.max(1, Math.ceil(total / limit));

    return NextResponse.json(
      {
        data: invoices,
        metadata: {
          total,
          page,
          limit,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
        counts: {
          all: allCount,
          draft: draftCount,
          pending: pendingCount,
          overdue: overdueCount,
          paid: paidCount,
          void: voidCount,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[GET /api/invoices] Failed:", error);
    return jsonError("Failed to fetch invoices", 500);
  }
}

// ============================================================
// POST /api/invoices — create a new invoice with nested items
// ============================================================

const MAX_INVOICE_NUMBER_RETRIES = 3;

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const body = await request.json();
    const validated = invoiceSchema.parse(body);

    const client = await prisma.client.findFirst({
      where: { id: validated.clientId, userId: user.id },
    });
    if (!client) return jsonError("Selected client does not exist", 404);

    const totals = calculateInvoiceTotals(
      validated.items,
      validated.taxRate,
      validated.discountType
        ? { type: validated.discountType, value: validated.discountValue ?? 0 }
        : {}
    );

    const itemsData = validated.items.map((item) => ({
      userId: user.id,
      description: item.description,
      quantity: item.quantity,
      price: item.price,
      total: Math.round((item.quantity * item.price + Number.EPSILON) * 100) / 100,
    }));

    const settings = await prisma.settings.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id },
      select: {
        invoicePrefix: true,
        invoiceSeparator: true,
        invoicePad: true,
        taxLabel: true,
      },
    });
    const taxLabel =
      (validated.taxLabel && validated.taxLabel.trim()) ||
      settings.taxLabel ||
      "GST";

    // M6: retry loop on invoiceNumber unique-constraint collisions.
    // Concurrent creates (manual + recurring, or two tabs) can race for the
    // same sequence number; on P2002 we re-read "today's count" (now one
    // higher) and try again.
    //
    // All writes run through withTenant() so Postgres RLS enforces tenant
    // isolation at the DB level (defense-in-depth alongside our where: { userId }).
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_INVOICE_NUMBER_RETRIES; attempt++) {
      try {
        const now = new Date();
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 999);

        const invoice = await withTenant(user.id, async (tx) => {
          const todayCount = await tx.invoice.count({
            where: {
              createdAt: { gte: startOfDay, lte: endOfDay },
            },
          });
          const invoiceNumber = generateInvoiceNumber(todayCount + attempt, {
            prefix: settings.invoicePrefix,
            separator: settings.invoiceSeparator || "-",
            pad: Number(settings.invoicePad) || 4,
          });

          const created = await tx.invoice.create({
            data: {
              userId: user.id,
              invoiceNumber,
              clientId: validated.clientId,
              status: validated.status,
              issueDate: new Date(validated.issueDate),
              dueDate: new Date(validated.dueDate),
              subtotal: totals.subtotal,
              discountType: validated.discountType ?? null,
              discountValue:
                validated.discountType && validated.discountValue != null
                  ? validated.discountValue
                  : null,
              discountAmount: totals.discountAmount,
              taxRate: validated.taxRate,
              taxLabel,
              totalAmount: totals.total,
              notes: validated.notes ?? null,
              items: { create: itemsData },
              ...(validated.status === "PAID" ? { paidAt: new Date() } : {}),
            },
            include: { client: true, items: true },
          });

          // Ledger: INVOICE_ISSUED for every non-DRAFT invoice (a DRAFT hasn't
          // been "sent out" yet so it's not an economic event; PENDING/PAID
          // represent an accounts-receivable owed to the merchant).
          if (validated.status !== "DRAFT") {
            await postLedgerEvent(
              {
                type: "INVOICE_ISSUED",
                invoice: {
                  id: created.id,
                  userId: created.userId,
                  items: itemsData.map((i) => ({
                    description: i.description,
                    quantity: i.quantity,
                    price: i.price,
                  })),
                  taxRate: validated.taxRate,
                  discountType: validated.discountType,
                  discountValue: validated.discountValue ?? null,
                },
              },
              tx
            );

            if (validated.status === "PAID") {
              await postLedgerEvent(
                {
                  type: "INVOICE_PAID",
                  invoice: { id: created.id, userId: created.userId, totalAmount: created.totalAmount },
                  amountPaid: created.totalAmount,
                },
                tx
              );
            }
          }

          return created;
        });

        logActivity({
          invoiceId: invoice.id,
          userId: user.id,
          type: validated.status === "PAID" ? "MARKED_PAID" : "CREATED",
          message:
            validated.status === "PAID"
              ? `Invoice created and marked paid (${new Intl.NumberFormat(
                  "en-IN",
                  { style: "currency", currency: "INR" }
                ).format(totals.total)})`
              : validated.status === "PENDING"
              ? "Invoice created and marked as sent"
              : "Invoice created as draft",
          ip: clientIp(request),
          meta: { total: totals.total, status: validated.status },
        });

        return NextResponse.json(invoice, { status: 201 });
      } catch (err) {
        lastError = err;
        const code = getPrismaErrorCode(err);
        if (code === "P2002") {
          // Unique constraint violation — assumed to be invoiceNumber since
          // it's the only unique field we write here. Retry with an
          // incremented count.
          const meta = (err as { meta?: { target?: string[] } }).meta;
          const target = meta?.target;
          if (target && Array.isArray(target) && target.includes("invoiceNumber")) {
            continue;
          }
          // Some other unique constraint — don't retry.
          break;
        }
        // Non-retryable error.
        break;
      }
    }

    // Out of retries or non-retryable error.
    if (lastError instanceof ZodError) return validationErrorResponse(lastError);
    if (lastError instanceof SyntaxError)
      return jsonError("Invalid JSON payload", 400);

    const code = getPrismaErrorCode(lastError);
    if (code === "P2002")
      return jsonError(
        "An invoice with this number already exists — please retry",
        409
      );
    if (code === "P2003")
      return jsonError("Referenced client does not exist", 400);

    console.error("[POST /api/invoices] Failed:", lastError);
    return jsonError("Failed to create invoice", 500);
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    if (error instanceof SyntaxError)
      return jsonError("Invalid JSON payload", 400);

    const code = getPrismaErrorCode(error);
    if (code === "P2002")
      return jsonError("An invoice with this number already exists", 409);
    if (code === "P2003")
      return jsonError("Referenced client does not exist", 400);

    console.error("[POST /api/invoices] Failed:", error);
    return jsonError("Failed to create invoice", 500);
  }
}
