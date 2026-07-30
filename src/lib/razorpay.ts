/**
 * Shared Razorpay helpers.
 *
 * Razorpay is the dominant payment gateway in India (UPI, cards, netbanking,
 * wallets). Lazy-loaded like Stripe so the SDK isn't pulled into unrelated
 * bundles. Returns null when not configured so callers can hide Pay buttons
 * gracefully.
 *
 * Signature verification is delegated ENTIRELY to the official Razorpay SDK
 * (`utility.verifyPaymentSignature`). The SDK performs constant-time HMAC
 * comparison internally; we do NOT maintain a parallel fallback — N4 fix to
 * eliminate the duplicate/parallel verification path.
 */

type RazorpayInstance = {
  orders: {
    create(params: Record<string, unknown>): Promise<{
      id: string;
      amount: number;
      currency: string;
      status: string;
    }>;
    fetch(id: string): Promise<unknown>;
  };
  payments: {
    fetch(id: string): Promise<{ status: string; order_id: string; [k: string]: unknown }>;
  };
  utility: {
    verifyPaymentSignature(params: {
      order_id: string;
      payment_id: string;
      signature: string;
    }): boolean;
  };
};

type RazorpayCtor = new (opts: { key_id: string; key_secret: string }) => RazorpayInstance;

let _razorpay: RazorpayInstance | null | undefined;

export async function getRazorpay(): Promise<RazorpayInstance | null> {
  if (_razorpay !== undefined) return _razorpay;
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    _razorpay = null;
    return null;
  }
  try {
    const mod = (await import("razorpay")) as unknown as {
      default?: RazorpayCtor;
      Razorpay?: RazorpayCtor;
    };
    const Ctor = mod.default ?? mod.Razorpay;
    if (!Ctor) throw new Error("Razorpay SDK missing default export");
    _razorpay = new Ctor({ key_id: keyId, key_secret: keySecret });
    return _razorpay;
  } catch (err) {
    console.error("[razorpay] Failed to initialize Razorpay:", err);
    _razorpay = null;
    return null;
  }
}

export function razorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export function getRazorpayKeyId(): string | null {
  return process.env.RAZORPAY_KEY_ID ?? process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? null;
}

export function getRazorpayWebhookSecret(): string | null {
  return process.env.RAZORPAY_WEBHOOK_SECRET ?? null;
}

/** Public key id shipped to the browser for Checkout. */
export { getRazorpayKeyId as getRazorpayKey };

/**
 * Convert a decimal amount to Razorpay's paise subunit. Returns subunit
 * integer for a given major-unit amount.
 *
 * Deprecated: use `toSubunit(amount, currency)` from `@/lib/money` — kept
 * here as a thin wrapper for backwards compatibility with any external
 * imports.
 */
export function toRazorpayAmount(amount: number, currency = "INR"): number {
  const { toSubunit } = require("@/lib/money");
  return toSubunit(amount, currency);
}

/**
 * Verify a client-side Razorpay payment signature using the OFFICIAL SDK.
 *
 * The SDK performs HMAC-SHA256(secret, order_id + "|" + payment_id) and
 * compares to the provided signature using a constant-time algorithm.
 * Returns false on any failure (missing config, SDK unavailable, or bad
 * signature) — never throws.
 */
export async function verifyRazorpaySignature(params: {
  orderId: string;
  paymentId: string;
  signature: string;
  secret?: string;
}): Promise<boolean> {
  const { orderId, paymentId, signature } = params;
  if (!orderId || !paymentId || !signature) return false;
  // If the caller provides an explicit secret (e.g. the key_secret for
  // client-side verify) we construct a one-off Razorpay instance with it;
  // otherwise we use the shared client initialized from env.
  let rp: RazorpayInstance | null = null;
  let oneOffInstance: RazorpayInstance | null = null;
  try {
    if (params.secret && params.secret !== process.env.RAZORPAY_KEY_SECRET) {
      const mod = (await import("razorpay")) as unknown as {
        default?: RazorpayCtor;
        Razorpay?: RazorpayCtor;
      };
      const Ctor = mod.default ?? mod.Razorpay;
      if (Ctor) {
        oneOffInstance = new Ctor({
          key_id: process.env.RAZORPAY_KEY_ID ?? "",
          key_secret: params.secret,
        });
      }
    }
    if (!oneOffInstance) {
      rp = await getRazorpay();
    }
    const client = oneOffInstance ?? rp;
    if (!client?.utility) return false;
    return client.utility.verifyPaymentSignature({
      order_id: orderId,
      payment_id: paymentId,
      signature,
    });
  } catch {
    return false;
  }
}

/**
 * Verify a Razorpay webhook signature.
 *
 * Delegates to a simple HMAC-SHA256 over the raw webhook body using the
 * webhook secret. This is NOT the same as client-side verify (different
 * signed content — webhooks sign the raw body, not order|payment).
 * Uses crypto.subtle constant-time verification.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string
): Promise<boolean> {
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
    const expected = Buffer.from(sig).toString("hex");
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}
