/**
 * Shared Razorpay helpers.
 *
 * Razorpay is the dominant payment gateway in India (UPI, cards, netbanking,
 * wallets) — critical for an INR-first SaaS. Lazy-loaded like Stripe so the
 * SDK isn't pulled into unrelated bundles. Returns null when not configured
 * so callers can hide/Disable Pay buttons gracefully.
 *
 * Docs: https://razorpay.com/docs/api/orders/
 */

// Razorpay SDK ships as a CommonJS module with `instance` as default; we
// dynamically import it so Turbopack/Next 16 don't try to pre-bundle it for
// edge/server-component contexts where it won't load.
type RazorpayInstance = {
  orders: {
    create(params: Record<string, unknown>): Promise<{ id: string; amount: number; currency: string; status: string }>;
    fetch(id: string): Promise<unknown>;
  };
  payments: {
    fetch(id: string): Promise<{ status: string; order_id: string; [k: string]: unknown }>;
  };
  utility: {
    verifyPaymentSignature(params: { order_id: string; payment_id: string; signature: string }): boolean;
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
    // Razorpay Node SDK is CJS; dynamic import returns module with .default.
    const mod = (await import("razorpay")) as unknown as { default?: RazorpayCtor; Razorpay?: RazorpayCtor };
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

/** Public key id shipped to the browser for Checkout. */
export function getRazorpayKeyId(): string | null {
  return process.env.RAZORPAY_KEY_ID ?? process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? null;
}

export function getRazorpayWebhookSecret(): string | null {
  return process.env.RAZORPAY_WEBHOOK_SECRET ?? null;
}

/**
 * Convert a decimal amount to Razorpay's paise subunit. Like Stripe, Razorpay
 * expects smallest-unit integer amounts for INR ("50000" = ₹500.00).
 */
export function toRazorpayAmount(amount: number, currency = "INR"): number {
  const zeroDecimal = new Set([
    "bif","clp","djf","gnf","jpy","kmf","krw","mga","pyg","rwf",
    "ugx","vnd","vuv","xaf","xof","xpf",
  ]);
  if (zeroDecimal.has(currency.toLowerCase())) return Math.round(amount);
  return Math.round((amount + Number.EPSILON) * 100);
}

/**
 * Verify signature using crypto.subtle (Web Crypto, available in Node 20+).
 * Razorpay HMAC-SHA256 hex-encodes sha256(orderId + "|" + paymentId) using the
 * webhook secret OR key_secret for client-side-initiated payment verification.
 *
 * Falls back to the SDK's utility.verifyPaymentSignature when available.
 */
export async function verifyRazorpaySignature(params: {
  orderId: string;
  paymentId: string;
  signature: string;
  secret: string;
}): Promise<boolean> {
  const { orderId, paymentId, signature, secret } = params;
  const rp = await getRazorpay();
  if (rp?.utility) {
    try {
      return rp.utility.verifyPaymentSignature({
        order_id: orderId,
        payment_id: paymentId,
        signature,
      });
    } catch {
      // fall through to manual verify
    }
  }
  // Manual HMAC verification (crypto.subtle works on Node 20+).
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      enc.encode(`${orderId}|${paymentId}`)
    );
    const hex = Buffer.from(sig).toString("hex");
    // timing-safe compare
    if (hex.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
  } catch (err) {
    console.error("[razorpay] Manual signature verification failed:", err);
    return false;
  }
}

export async function verifyWebhookSignature(rawBody: string, signature: string, secret: string): Promise<boolean> {
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
    const hex = Buffer.from(sig).toString("hex");
    if (hex.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}
