/**
 * Shared Stripe helpers.
 *
 * Lazy-loaded so the heavy Stripe SDK isn't pulled into unrelated server
 * bundles or the client. Returns `null` when Stripe isn't configured so
 * callers can fall back gracefully (hiding Pay buttons rather than
 * erroring).
 */

let _stripe: import("stripe").default | null | undefined;

export async function getStripe(): Promise<import("stripe").default | null> {
  if (_stripe !== undefined) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    _stripe = null;
    return null;
  }
  try {
    const mod = await import("stripe");
    const Stripe = mod.default;
    // Use Stripe's default (latest) API version for this install. Pinning
    // a specific date can cause TS type mismatches between major versions.
    _stripe = new Stripe(key, {
      typescript: true,
    });
    return _stripe;
  } catch (err) {
    console.error("[stripe] Failed to initialize Stripe:", err);
    _stripe = null;
    return null;
  }
}

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** Return the webhook secret (if configured) for signature verification. */
export function getStripeWebhookSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET ?? null;
}

/** Build absolute URLs based on env (works on Vercel out of the box). */
export function getSiteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
    "http://localhost:3000"
  );
}
