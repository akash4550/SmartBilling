import { NextResponse } from "next/server";
import { stripeConfigured } from "@/lib/stripe";
import { razorpayConfigured, getRazorpayKeyId } from "@/lib/razorpay";

/**
 * GET /api/site/payments
 *
 * Public (unauthenticated) — returns which payment gateways are enabled
 * site-wide (env-based). Used by the admin invoice detail page and other
 * authenticated UIs to decide which Pay buttons to show.
 */
export async function GET() {
  return NextResponse.json({
    stripe: stripeConfigured(),
    razorpay: razorpayConfigured(),
    razorpayKeyId: getRazorpayKeyId(),
  });
}
