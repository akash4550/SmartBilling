/**
 * Stripe event → SmartBill invoice resolver.
 *
 * Extracted to its own module so both the Temporal activity
 * (`resolveInvoiceForWebhook`) and any non-Temporal fallbacks can share
 * the same mapping logic.
 *
 * The resolver reads metadata.invoiceId (preferred, set by our Checkout
 * Session creation) and falls back to looking up by checkout session id
 * or payment intent id. It is a pure read against the database — never
 * writes — which makes it safe to retry.
 */
import "server-only";

import type { Stripe } from "stripe";
import { prisma } from "@/lib/prisma";

export interface ResolvedStripePayment {
  invoiceId: string;
  paymentIntentId: string | null;
  checkoutSessionId: string | null;
}

export function parseStripeEvent(rawBody: string): Stripe.Event {
  // Temporal runs in NODE_ENV !== "production" equivalent context; we
  // parse JSON (the edge route already verified HMAC where required).
  return JSON.parse(rawBody) as Stripe.Event;
}

export async function resolveInvoiceFromStripeEvent(
  event: Stripe.Event
): Promise<ResolvedStripePayment | null> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const invoiceId = (session.metadata as Record<string, string> | undefined)?.invoiceId;
      if (invoiceId) {
        return {
          invoiceId,
          checkoutSessionId: session.id,
          paymentIntentId:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : session.payment_intent?.id ?? null,
        };
      }
      // Fallback: find by previously-reserved checkout session id.
      const bySession = await prisma.invoice.findFirst({
        where: { stripeCheckoutSessionId: session.id },
        select: { id: true },
      });
      return bySession
        ? {
            invoiceId: bySession.id,
            checkoutSessionId: session.id,
            paymentIntentId:
              typeof session.payment_intent === "string"
                ? session.payment_intent
                : session.payment_intent?.id ?? null,
          }
        : null;
    }
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const invoiceId = (pi.metadata as Record<string, string> | undefined)?.invoiceId;
      if (invoiceId) {
        return {
          invoiceId,
          paymentIntentId: pi.id,
          checkoutSessionId: null,
        };
      }
      // No metadata link; refuse to guess. We'd rather no-op than misapply.
      return null;
    }
    case "payment_intent.payment_failed":
    case "charge.dispute.created":
    case "checkout.session.expired":
    case "invoice.paid":
    case "invoice.payment_failed":
      // Handled / ignored explicitly for future expansion; for now we
      // no-op these events in the Temporal pipeline.
      return null;
    default:
      return null;
  }
}
