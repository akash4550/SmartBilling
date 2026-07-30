/**
 * Shared logic for recurring invoices.
 *
 * Concurrency safety:
 *   - Per-profile Postgres advisory lock (`pg_advisory_xact_lock`) inside
 *     REPEATABLE READ transactions serializes workers per profile.
 *   - Invoice-number collisions (P2002) are retried up to 3 times with a
 *     fresh sequence count (M6).
 *   - The RECURRING_GENERATED activity row is written inside the same
 *     transaction as the invoice + nextRunAt update.
 *   - addMonthsClamped fixes Jan-31 + 1-month → March-3 date pitfall.
 */
import { prisma } from "@/lib/prisma";
import { calculateInvoiceTotals, generateInvoiceNumber } from "@/lib/utils";
import { getSiteUrl } from "@/lib/stripe";
import { sendInvoiceEmail } from "@/lib/send-invoice-email";
import type { RecurrenceFrequency, RecurringProfile, Invoice, Prisma } from "@prisma/client";
import { getPrismaErrorCode } from "@/lib/api-helpers";
import { withTenant } from "@/lib/tenant";
import { withService } from "@/lib/service-context";
import { postLedgerEvent } from "@/lib/ledger";

export interface RecurringRunResult {
  profileId: string;
  invoiceId?: string;
  invoiceNumber?: string;
  error?: string;
  sent: boolean;
}

const MAX_INVOICE_NUMBER_RETRIES = 3;

function addMonthsClamped(d: Date, months: number): Date {
  const day = d.getDate();
  const next = new Date(d);
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
}

export function computeNextRun(
  from: Date,
  frequency: RecurrenceFrequency,
  intervalDays: number | null
): Date {
  const next = new Date(from);
  switch (frequency) {
    case "WEEKLY":
      next.setDate(next.getDate() + 7);
      break;
    case "MONTHLY":
      return addMonthsClamped(next, 1);
    case "YEARLY":
      next.setFullYear(next.getFullYear() + 1);
      break;
    case "CUSTOM_DAYS":
      next.setDate(next.getDate() + (intervalDays ?? 30));
      break;
  }
  return next;
}

export async function processDueRecurringProfiles(
  opts: { userId?: string; maxProfiles?: number } = {}
): Promise<RecurringRunResult[]> {
  const { userId, maxProfiles = 100 } = opts;
  const now = new Date();

  // Run discovery under service_role (cross-tenant read) so cron workers
  // don't need to connect as superuser. Per-profile writes still go
  // through withTenant inside generateInvoiceFromProfile.
  const profiles = await withService("cron:generate-recurring", (tx) =>
    tx.recurringProfile.findMany({
      where: {
        active: true,
        nextRunAt: { lte: now },
        ...(userId ? { userId } : {}),
        OR: [{ endDate: null }, { endDate: { gte: now } }],
      },
      include: { items: true, client: true, user: { include: { settings: true } } },
      orderBy: { nextRunAt: "asc" },
      take: maxProfiles,
    })
  );

  const results: RecurringRunResult[] = [];

  for (const profile of profiles) {
    try {
      const result = await generateInvoiceFromProfile(profile, now);
      results.push(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already processed|no longer active/i.test(msg)) {
        results.push({ profileId: profile.id, sent: false });
        continue;
      }
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
  items: Array<{
    description: string;
    quantity: number;
    price: { toNumber: () => number } | number;
  }>;
  client: { id: string; email: string; name: string; portalToken: string | null };
  user: {
    id: string;
    email: string;
    name: string;
    settings?: {
      companyName?: string | null;
      companyEmail?: string | null;
      companyAddress?: string | null;
      companyPhone?: string | null;
      currency?: string;
    } | null;
  };
};

export async function generateInvoiceFromProfile(
  profile: FullProfile,
  now: Date = new Date()
): Promise<RecurringRunResult> {
  const lineItems = profile.items.map((i) => ({
    description: i.description,
    quantity: i.quantity,
    price: typeof i.price === "number" ? i.price : i.price.toNumber(),
  }));
  const totals = calculateInvoiceTotals(lineItems, Number(profile.taxRate));

  const dueDate = new Date(now);
  dueDate.setDate(dueDate.getDate() + Number(profile.dueInDays));

  const userSettings = await withTenant(profile.userId, (tx) =>
    tx.settings.upsert({
      where: { userId: profile.userId },
      update: {},
      create: { userId: profile.userId },
      select: {
        invoicePrefix: true,
        invoiceSeparator: true,
        invoicePad: true,
        taxLabel: true,
      },
    })
  );
  const taxLabel = userSettings.taxLabel || "GST";
  const nextRun = computeNextRun(now, profile.frequency, profile.intervalDays);
  const lockKey = hashProfileToLockKey(profile.id);

  // Attempt invoice creation with P2002 (invoiceNumber collision) retries.
  let invoice: Invoice | null = null;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < MAX_INVOICE_NUMBER_RETRIES; attempt++) {
    try {
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 999);

      // Wrap the inner $transaction in withTenant so RLS enforces tenant
      // isolation (defense-in-depth alongside our explicit where: userId).
      // We use RepeatableRead + pg_advisory_xact_lock as before, but the tx
      // client runs as app_user with the GUC set.
      //
      // Note: today's invoice count is read INSIDE the withTenant tx so
      // the count is also filtered by RLS.
      const created = await withTenant(
        profile.userId,
        async (tx) => {
          const todayCount = await tx.invoice.count({
            where: {
              createdAt: { gte: startOfDay, lte: endOfDay },
            },
          });
          const invoiceNumber = generateInvoiceNumber(todayCount + attempt, {
            prefix: userSettings.invoicePrefix,
            separator: userSettings.invoiceSeparator || "-",
            pad: Number(userSettings.invoicePad) || 4,
          });

          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1397772876, ${lockKey})`;

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
              discountAmount: totals.discountAmount,
              notes: profile.notes ?? null,
              lastSentAt: profile.autoSend ? now : null,
              recurringProfileId: profile.id,
              items: {
                create: lineItems.map((li) => ({
                  userId: profile.userId,
                  description: li.description,
                  quantity: li.quantity,
                  price: li.price,
                  total:
                    Math.round(
                      (li.quantity * li.price + Number.EPSILON) * 100
                    ) / 100,
                })),
              },
            },
          });

          // Ledger: an auto-sent (PENDING) recurring invoice is economically
          // issued — post INVOICE_ISSUED. DRAFTs (autoSend=false) are not yet
          // issued, so no ledger event until the user sends them.
          if (profile.autoSend) {
            await postLedgerEvent(
              {
                type: "INVOICE_ISSUED",
                invoice: {
                  id: inv.id,
                  userId: profile.userId,
                  items: lineItems.map((li) => ({
                    description: li.description,
                    quantity: li.quantity,
                    price: li.price,
                  })),
                  taxRate: Number(profile.taxRate),
                  discountType: null,
                  discountValue: null,
                },
              },
              tx
            );
          }

          await tx.recurringProfile.update({
            where: { id: profile.id },
            data: { lastRunAt: now, nextRunAt: nextRun },
          });

          await tx.invoiceActivity.create({
            data: {
              invoiceId: inv.id,
              userId: profile.userId,
              type: "RECURRING_GENERATED",
              message: profile.autoSend
                ? "Auto-generated by recurring profile (email queued)"
                : "Auto-generated by recurring profile (draft)",
              meta: { profileId: profile.id, autoSend: profile.autoSend },
            },
          });

          return inv;
        },
        { isolationLevel: "RepeatableRead" }
      );

      invoice = created;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const code = getPrismaErrorCode(err);
      const target = (err as { meta?: { target?: string[] } })?.meta?.target;
      if (code === "P2002" && target && target.includes("invoiceNumber")) {
        continue; // retry with bumped sequence
      }
      throw err;
    }
  }
  if (!invoice) throw lastErr ?? new Error("Failed to generate recurring invoice");

  // Post-commit email send (best-effort, never rolls back invoice).
  // Load full invoice with relations (the tx returned a plain object).
  let sent = false;
  if (profile.autoSend && process.env.RESEND_API_KEY) {
    try {
      const siteUrl = getSiteUrl();
      const fromEmail =
        process.env.FROM_EMAIL ||
        `${profile.user.settings?.companyName ?? "SmartBill"} <billing@smartbill.app>`;
      const viewLink = `${siteUrl}/view/${invoice.id}`;
      const pdfLink = `${siteUrl}/api/public/invoices/${invoice.id}/pdf`;
      const currency = profile.user.settings?.currency || "INR";

      const { getBrandingForUser } = await import("@/lib/branding");
      const branding = await getBrandingForUser(invoice.userId);
      const logoAbsUrl = branding.logoUrl
        ? branding.logoUrl.startsWith("http")
          ? branding.logoUrl
          : `${siteUrl}${branding.logoUrl}`
        : null;

      const fullInvoice = await prisma.invoice.findUnique({
        where: { id: invoice.id },
        include: {
          client: true,
          items: true,
          user: { include: { settings: true } },
        },
      });
      if (fullInvoice) {
        const result = await sendInvoiceEmail({
          invoice: fullInvoice,
          settings: {
            companyName: profile.user.settings?.companyName ?? "SmartBill",
            companyEmail:
              profile.user.settings?.companyEmail ?? profile.user.email,
            companyAddress: profile.user.settings?.companyAddress ?? null,
            companyPhone: profile.user.settings?.companyPhone ?? null,
            currency,
            logoUrl: logoAbsUrl,
            logoBase64: branding.logoData,
            logoContentType: branding.logoContentType,
            brandColor: branding.brandColor,
          },
          to: profile.client.email,
          from: fromEmail,
          variant: "new",
          viewLink,
          pdfLink,
          portalLink: profile.client.portalToken
            ? `${siteUrl}/portal/${profile.client.portalToken}`
            : null,
          personalMessage:
            "This invoice was generated automatically based on your recurring billing schedule.",
        });
        if (result.error) {
          console.error(
            `[recurring] Resend error for ${fullInvoice.invoiceNumber}:`,
            result.error
          );
        } else {
          sent = true;
        }
      }
    } catch (err) {
      console.error(
        `[recurring] Failed to send email for invoice ${invoice.invoiceNumber}:`,
        err
      );
    }
  }

  return {
    profileId: profile.id,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    sent,
  };
}

function hashProfileToLockKey(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}
