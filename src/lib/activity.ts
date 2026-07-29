/**
 * Shared helper for writing invoice activity (timeline events).
 *
 * All writes are fire-and-forget (we don't await them in request paths)
 * and swallow errors so a logging failure never blocks business logic.
 */
import { prisma } from "@/lib/prisma";
import type { InvoiceActivityType } from "@prisma/client";

export interface LogActivityOptions {
  invoiceId: string;
  userId: string;
  type: InvoiceActivityType;
  message?: string;
  ip?: string | null;
  meta?: Record<string, unknown>;
}

export function logActivity(opts: LogActivityOptions): void {
  // Fire-and-forget: swallow errors so activity logging never breaks the main flow.
  prisma.invoiceActivity
    .create({
      data: {
        invoiceId: opts.invoiceId,
        userId: opts.userId,
        type: opts.type,
        message: opts.message ?? null,
        ip: opts.ip ?? null,
        meta: opts.meta ? (opts.meta as unknown as object) : undefined,
      },
    })
    .catch((err) => {
      console.error("[activity] Failed to log activity:", err);
    });
}

/** Extract the client IP from a Request (respects X-Forwarded-For). */
export function clientIp(req: Request): string | null {
  const xfwd = req.headers.get("x-forwarded-for");
  if (xfwd) return xfwd.split(",")[0]?.trim() ?? null;
  return req.headers.get("x-real-ip") ?? null;
}
