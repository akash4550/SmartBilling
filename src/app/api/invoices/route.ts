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
    .transform((v) => (v === "true" ? true : v === "false" ? false : undefined)),
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

    const { page, limit, status, clientId, q, overdue, sortBy, sortOrder } = parsed.data;
    const skip = (page - 1) * limit;

    // 🔒 Tenant scope: always restrict to the signed-in user
    const where: Prisma.InvoiceWhereInput = { userId: user.id };
    if (status && status !== "OVERDUE") where.status = status;
    if (clientId) where.clientId = clientId; // clientId alone isn't enough — userId guard above prevents cross-tenant reads

    // Compute today in IST (Asia/Calcutta) — midnight boundary so an invoice
    // due "today" isn't flagged overdue until the next calendar day.
    const now = new Date();
    const istParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Calcutta", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => Number(istParts.find((p) => p.type === t)?.value);
    const todayIst = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));

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

    const [total, invoices, allCount, draftCount, pendingCount, paidCount, voidCount] = await Promise.all([
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
      prisma.invoice.count({ where: { userId: user.id, status: "PENDING" } }),
      prisma.invoice.count({ where: { userId: user.id, status: "PAID" } }),
      prisma.invoice.count({ where: { userId: user.id, status: "VOID" } }),
    ]);

    // Compute overdue count using same IST logic (date-only compare).
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
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const body = await request.json();
    const validated = invoiceSchema.parse(body);

    // 🔒 Verify the referenced client belongs to this user
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

    const itemsData = validated.items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      price: item.price,
      total: Math.round((item.quantity * item.price + Number.EPSILON) * 100) / 100,
    }));

    // Load user settings for invoice number prefix/separator/pad and default tax label
    // (upsert ensures a row exists).
    const settings = await prisma.settings.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id },
      select: { invoicePrefix: true, invoiceSeparator: true, invoicePad: true, taxLabel: true },
    });
    // Prefer what was passed in the payload (form), otherwise fall back to the
    // user's saved tax label default.
    const taxLabel = (validated.taxLabel && validated.taxLabel.trim()) || settings.taxLabel || "GST";

    // Generate next invoice number scoped to this user, today (per-day sequence
    // so numbers look natural: PREFIX-YYYYMMDD-0001, -0002, ...).
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const todayCount = await prisma.invoice.count({
      where: { userId: user.id, createdAt: { gte: startOfDay, lte: endOfDay } },
    });
    const invoiceNumber = generateInvoiceNumber(todayCount, {
      prefix: settings.invoicePrefix,
      separator: settings.invoiceSeparator || "-",
      pad: Number(settings.invoicePad) || 4,
    });

    const invoice = await prisma.invoice.create({
      data: {
        userId: user.id,
        invoiceNumber,
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
        taxLabel,
        totalAmount: total,
        notes: validated.notes ?? null,
        items: { create: itemsData },
      },
      include: { client: true, items: true },
    });

    logActivity({
      invoiceId: invoice.id,
      userId: user.id,
      type: validated.status === "PAID" ? "MARKED_PAID" : "CREATED",
      message: validated.status === "PAID"
        ? `Invoice created and marked paid (${Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(total)})`
        : validated.status === "PENDING"
        ? `Invoice created and marked as sent`
        : "Invoice created as draft",
      ip: clientIp(request),
      meta: { total, status: validated.status },
    });

    return NextResponse.json(invoice, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    if (error instanceof SyntaxError) return jsonError("Invalid JSON payload", 400);

    const code = getPrismaErrorCode(error);
    if (code === "P2002") return jsonError("An invoice with this number already exists", 409);
    if (code === "P2003") return jsonError("Referenced client does not exist", 400);

    console.error("[POST /api/invoices] Failed:", error);
    return jsonError("Failed to create invoice", 500);
  }
}
