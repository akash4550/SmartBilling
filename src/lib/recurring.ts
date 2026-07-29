/**
 * Shared logic for recurring invoices.
 *
 * A RecurringProfile is a template (clientId + line items + frequency). When
 * `active` is true and `nextRunAt <= now`, we:
 *   1. Create a new Invoice from the template (issue=today, due=today+dueInDays)
 *   2. Advance `nextRunAt` by the configured interval
 *   3. If autoSend: transition to PENDING, email client (reusing send logic)
 *
 * Designed to be idempotent: we re-check `nextRunAt` inside a transaction so
 * concurrent cron invocations never generate duplicate invoices for the same
 * profile run.
 */
import { prisma } from "@/lib/prisma";
import { calculateInvoiceTotals, generateInvoiceNumber } from "@/lib/utils";
import { getSiteUrl } from "@/lib/stripe";
import { sendInvoiceEmail } from "@/lib/send-invoice-email";
import { logActivity } from "@/lib/activity";
import type { RecurrenceFrequency, RecurringProfile } from "@prisma/client";

export interface RecurringRunResult {
  profileId: string;
  invoiceId?: string;
  invoiceNumber?: string;
  error?: string;
  sent: boolean;
}

/**
 * Compute the next run datetime for a profile given a "from" date.
 */
export function computeNextRun(from: Date, frequency: RecurrenceFrequency, intervalDays: number | null): Date {
  const next = new Date(from);
  switch (frequency) {
    case "WEEKLY":
      next.setDate(next.getDate() + 7);
      break;
    case "MONTHLY":
      next.setMonth(next.getMonth() + 1);
      break;
    case "YEARLY":
      next.setFullYear(next.getFullYear() + 1);
      break;
    case "CUSTOM_DAYS":
      next.setDate(next.getDate() + (intervalDays ?? 30));
      break;
  }
  return next;
}

/**
 * Run due recurring profiles for a single user (if userId supplied) or all
 * users. Intended to be called from the cron endpoint; protects against
 * double-generation using nextRunAt check + update.
 */
export async function processDueRecurringProfiles(opts: { userId?: string; maxProfiles?: number } = {}): Promise<RecurringRunResult[]> {
  const { userId, maxProfiles = 100 } = opts;
  const now = new Date();

  const profiles = await prisma.recurringProfile.findMany({
    where: {
      active: true,
      nextRunAt: { lte: now },
      ...(userId ? { userId } : {}),
      OR: [{ endDate: null }, { endDate: { gte: now } }],
    },
    include: { items: true, client: true, user: { include: { settings: true } } },
    orderBy: { nextRunAt: "asc" },
    take: maxProfiles,
  });

  const results: RecurringRunResult[] = [];

  for (const profile of profiles) {
    try {
      const result = await generateInvoiceFromProfile(profile, now);
      results.push(result);
    } catch (err) {
      console.error(`[recurring] Failed profile ${profile.id}:`, err);
      results.push({
        profileId: profile.id,
        sent: false,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return results;
}

type FullProfile = RecurringProfile & {
  items: Array<{ description: string; quantity: number; price: { toNumber: () => number } | number }>;
  client: { id: string; email: string; name: string };
  user: { id: string; email: string; name: string; settings?: { companyName?: string | null; companyEmail?: string | null; companyAddress?: string | null; companyPhone?: string | null; currency?: string } | null };
};

/**
 * Generate a single invoice for a profile and advance nextRunAt.
 */
export async function generateInvoiceFromProfile(profile: FullProfile, now: Date = new Date()): Promise<RecurringRunResult> {
  // Compute totals
  const lineItems = profile.items.map((i) => ({
    description: i.description,
    quantity: i.quantity,
    price: typeof i.price === "number" ? i.price : i.price.toNumber(),
  }));
  const totals = calculateInvoiceTotals(lineItems, Number(profile.taxRate));

  // Due date = issue date + dueInDays
  const dueDate = new Date(now);
  dueDate.setDate(dueDate.getDate() + Number(profile.dueInDays));

  // Count today's existing invoices for this user to get the next sequence.
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const [todayCount, userSettings] = await Promise.all([
    prisma.invoice.count({
      where: {
        userId: profile.userId,
        createdAt: { gte: startOfDay, lte: endOfDay },
      },
    }),
    prisma.settings.upsert({
      where: { userId: profile.userId },
      update: {},
      create: { userId: profile.userId },
      select: { invoicePrefix: true, invoiceSeparator: true, invoicePad: true, taxLabel: true },
    }),
  ]);
  const invoiceNumber = generateInvoiceNumber(todayCount, {
    prefix: userSettings.invoicePrefix,
    separator: userSettings.invoiceSeparator || "-",
    pad: Number(userSettings.invoicePad) || 4,
  });
  const taxLabel = userSettings.taxLabel || "GST";

  const nextRun = computeNextRun(now, profile.frequency, profile.intervalDays);

  // Create invoice + advance nextRunAt inside a transaction.
  const invoice = await prisma.$transaction(async (tx) => {
    const fresh = await tx.recurringProfile.findUnique({
      where: { id: profile.id },
      select: { nextRunAt: true, active: true },
    });
    if (!fresh || !fresh.active) {
      throw new Error("Profile is no longer active");
    }
    if (fresh.nextRunAt.getTime() > now.getTime()) {
      throw new Error("Profile already processed by another worker");
    }

    const inv = await tx.invoice.create({
      data: {
        userId: profile.userId,
        clientId: profile.clientId,
        invoiceNumber,
        status: profile.autoSend ? "PENDING" : "DRAFT",
        issueDate: now,
        dueDate,
        subtotal: totals.subtotal,
        taxRate: profile.taxRate,
        taxLabel,
        totalAmount: totals.total,
        notes: profile.notes ?? null,
        lastSentAt: profile.autoSend ? now : null,
        recurringProfileId: profile.id,
        items: {
          create: lineItems.map((li) => ({
            description: li.description,
            quantity: li.quantity,
            price: li.price,
            total: Math.round((li.quantity * li.price + Number.EPSILON) * 100) / 100,
          })),
        },
      },
      include: {
        client: true,
        items: true,
        user: { include: { settings: true } },
      },
    });

    await tx.recurringProfile.update({
      where: { id: profile.id },
      data: { lastRunAt: now, nextRunAt: nextRun },
    });

    return inv;
  });

  let sent = false;
  if (profile.autoSend && process.env.RESEND_API_KEY) {
    try {
      const siteUrl = getSiteUrl();
      const settings = invoice.user.settings;
      const fromEmail = process.env.FROM_EMAIL || `${settings?.companyName ?? "SmartBill"} <billing@smartbill.app>`;
      const viewLink = `${siteUrl}/view/${invoice.id}`;
      const pdfLink = `${siteUrl}/api/public/invoices/${invoice.id}/pdf`;
      const currency = settings?.currency || "INR";

      // Lazy-load branding here to avoid circular imports at module top.
      const { getBrandingForUser } = await import("@/lib/branding");
      const branding = await getBrandingForUser(invoice.userId);
      const logoAbsUrl = branding.logoUrl
        ? (branding.logoUrl.startsWith("http") ? branding.logoUrl : `${siteUrl}${branding.logoUrl}`)
        : null;

      const result = await sendInvoiceEmail({
        invoice,
        settings: {
          companyName: settings?.companyName ?? "SmartBill",
          companyEmail: settings?.companyEmail ?? invoice.user.email,
          companyAddress: settings?.companyAddress ?? null,
          companyPhone: settings?.companyPhone ?? null,
          currency,
          logoUrl: logoAbsUrl,
          logoBase64: branding.logoData,
          logoContentType: branding.logoContentType,
          brandColor: branding.brandColor,
        },
        to: invoice.client.email,
        from: fromEmail,
        variant: "new",
        viewLink,
        pdfLink,
        portalLink: invoice.client.portalToken ? `${siteUrl}/portal/${invoice.client.portalToken}` : null,
        personalMessage: "This invoice was generated automatically based on your recurring billing schedule.",
      });
      if (result.error) {
        console.error(`[recurring] Resend error for ${invoice.invoiceNumber}:`, result.error);
      } else {
        sent = true;
      }

      logActivity({
        invoiceId: invoice.id,
        userId: invoice.userId,
        type: "RECURRING_GENERATED",
        message: `Auto-generated by recurring profile${sent ? " and sent to client" : ""}${result.pdfAttached ? " (PDF attached)" : ""}`,
        meta: {
          profileId: profile.id,
          sent,
          pdfAttached: result.pdfAttached,
        },
      });
    } catch (err) {
      console.error(`[recurring] Failed to send email for invoice ${invoice.invoiceNumber}:`, err);
    }
  }

  return {
    profileId: profile.id,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    sent,
  };
}
