/**
 * Shared helper for writing invoice activity (timeline events).
 *
 * All writes are fire-and-forget (we don't await them in request paths)
 * and swallow errors so a logging failure never blocks business logic.
 *
 * Tenant isolation: writes go through withTenant() so RLS enforces that
 * the activity row is attached to the correct user. Since the activity
 * table is INSERT-only for app_user (no UPDATE/DELETE), this is safe.
 */
import { prisma } from "@/lib/prisma";
import { withTenant } from "@/lib/tenant";
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
  // Defer with setTimeout(0) so the call escapes the current promise chain.
  // If the caller is inside a withTenant transaction, we must wait for that
  // tx to resolve and release the connection before opening our own
  // withTenant tx — Prisma interactive transactions hold a dedicated
  // connection for their duration, and nested interactive tx is unsupported
  // (P2028). setImmediate runs before I/O but Prisma keeps the connection
  // pinned until promise resolution fully unwinds; setTimeout ensures we
  // yield to the event loop after the outer caller returns.
  setTimeout(() => {
    withTenant(opts.userId, (tx) =>
      tx.invoiceActivity.create({
        data: {
          invoiceId: opts.invoiceId,
          userId: opts.userId,
          type: opts.type,
          message: opts.message ?? null,
          ip: opts.ip ?? null,
          meta: opts.meta ? (opts.meta as unknown as object) : undefined,
        },
      })
    ).catch((err) => {
      console.error("[activity] Failed to log activity:", err);
    });
  }, 0);
}

/** Extract the client IP from a Request (respects X-Forwarded-For). */
export function clientIp(req: Request): string | null {
  const xfwd = req.headers.get("x-forwarded-for");
  if (xfwd) return xfwd.split(",")[0]?.trim() ?? null;
  return req.headers.get("x-real-ip") ?? null;
}
