/**
 * Money helpers — arbitrary-precision arithmetic for billing math.
 *
 * Two layers:
 *
 *  1. SUBUNIT-INTEGER ARITHMETIC — `calcInvoiceTotals()` runs ALL arithmetic
 *     in integer paise/cents (BigInt) to guarantee zero binary-float drift.
 *     This is the canonical source of truth for invoice totals and replaces
 *     the previous float-based `calculateInvoiceTotals` in utils.ts.
 *
 *  2. DECIMAL CONVERSION BOUNDARY — `toSubunit` / `toDecimal` / `toNumber`
 *     bridge Prisma Decimal (NUMERIC) values to/from gateway subunit ints
 *     and display numbers. ROUND_HALF_UP is used everywhere to match Stripe
 *     and Razorpay's published rounding rule.
 *
 * Design guarantee: after `calcInvoiceTotals`, the identity
 *   subtotal - discountAmount + taxAmount === total
 * holds to the exact paisa (line-item totals sum to subtotal).
 */
import { Prisma } from "@prisma/client";

// ============================================================
// TYPES
// ============================================================

export type DecimalLike = Prisma.Decimal | number | string | null | undefined;

export interface SubunitLineItem {
  /** Unit price in MAJOR units (e.g. ₹19.99). */
  price: number;
  quantity: number;
  /** Optional per-line description (passthrough). */
  description?: string;
}

export type SubunitDiscountType = "PERCENT" | "FIXED";

export interface SubunitDiscount {
  type?: SubunitDiscountType | null;
  /** PERCENT: 0..100 (major percent). FIXED: major currency units (e.g. 50.00). */
  value?: number | null;
}

export interface SubunitTotals {
  subtotal: number;        // major units, 2dp
  discountAmount: number;  // major units, 2dp
  netAmount: number;       // major units, 2dp (post-discount, pre-tax)
  taxAmount: number;       // major units, 2dp
  total: number;           // major units, 2dp (net + tax)
  /** Integer-paise intermediates exposed for tests/auditing. */
  _paise: {
    subtotal: bigint;
    discountAmount: bigint;
    netAmount: bigint;
    taxAmount: bigint;
    total: bigint;
    /** Per-line paise totals, in input order. */
    lineTotals: bigint[];
  };
}

// ============================================================
// DECIMAL LIFT / CONVERT
// ============================================================

const ZERO = new Prisma.Decimal(0);

export function toDecimal(value: DecimalLike): Prisma.Decimal {
  if (value === null || value === undefined || value === "") return ZERO;
  if (value instanceof Prisma.Decimal) return value;
  try {
    const d = new Prisma.Decimal(value as number | string);
    return d.isFinite() ? d : ZERO;
  } catch {
    return ZERO;
  }
}

export function toNumber(value: DecimalLike): number {
  const d = toDecimal(value);
  const n = d.toNumber();
  return Number.isFinite(n) ? n : 0;
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);
const THREE_DECIMAL_CURRENCIES = new Set([
  "bhd", "iqd", "jod", "kwd", "lyd", "omr", "tnd",
]);

export function toSubunit(amount: DecimalLike, currency: string = "INR"): number {
  const d = toDecimal(amount);
  if (d.isNeg()) return 0;

  const cur = (currency || "INR").toLowerCase();
  let subunits: Prisma.Decimal;
  if (ZERO_DECIMAL_CURRENCIES.has(cur)) {
    subunits = d.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  } else if (THREE_DECIMAL_CURRENCIES.has(cur)) {
    subunits = d.mul(1000).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  } else {
    subunits = d.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  }

  const num = subunits.toNumber();
  if (!Number.isFinite(num) || !Number.isSafeInteger(num)) return 0;
  return Math.max(0, num);
}

export function subunitDivisor(currency: string = "INR"): number {
  const cur = (currency || "INR").toLowerCase();
  if (ZERO_DECIMAL_CURRENCIES.has(cur)) return 1;
  if (THREE_DECIMAL_CURRENCIES.has(cur)) return 1000;
  return 100;
}

// ============================================================
// SUBUNIT-INTEGER TOTAL CALCULATION (M1)
// ============================================================

const PAISA_PER_RUPEE = BigInt(100);
const HUNDRED_PERCENT = BigInt(100);

/**
 * Multiply a JS major-unit number into paise as a BigInt, safely.
 * Uses integer scaling to avoid float binary drift:
 *   toPaise(19.99) → 1999n
 *   toPaise(0.07) → 7n
 *   toPaise(0.1)  → 10 (paise)
 *
 * Strategy: round to 3 decimals (to absorb IEEE-754 junk like 0.0000001)
 * then scale, then round half-up.
 */
function toPaise(major: number): bigint {
  if (!Number.isFinite(major)) return BigInt(0);
  if (major < 0) return BigInt(0);
  // Quantize to 3dp to kill binary-float noise, then scale to paise with
  // ROUND_HALF_UP. Using Decimal here is safe because the input is bounded
  // (price ≤ 99,99,99,999.99 per Decimal(12,2); quantity positive int).
  const d = new Prisma.Decimal(major);
  const paise = d
    .toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP)
    .mul(PAISA_PER_RUPEE.toString())
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  return BigInt(paise.toFixed(0));
}

function paiseToMajor(paise: bigint): number {
  const major = new Prisma.Decimal(paise.toString()).div(PAISA_PER_RUPEE.toString());
  const n = major.toNumber();
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Calculate invoice totals (subtotal/discount/tax/total) entirely in
 * integer paise (BigInt) using ROUND_HALF_UP for any fractional-paise
 * intermediate. Guarantees:
 *
 *   - Every line total is round(quantity * price_paise) with HALF_UP.
 *   - Subtotal = sum(line totals).
 *   - Discount is subtracted BEFORE tax (pre-tax discount, standard for
 *     GST/VAT regimes).
 *   - Percent discount rounds to whole paisa HALF_UP. Fixed discount values
 *     are converted to paise HALF_UP (already paisa-accurate from form).
 *   - Tax = round(netPaise * taxRatePercent / 100) HALF_UP.
 *   - Final invariant: subtotal - discount + tax === total (exact paise).
 */
export function calcInvoiceTotals(
  items: readonly SubunitLineItem[],
  taxRatePercent: number = 0,
  discount: SubunitDiscount = {}
): SubunitTotals {
  // 1. Compute per-line paise totals and sum to subtotal.
  const lineTotals: bigint[] = [];
  let subtotalPaise = BigInt(0);
  for (const it of items) {
    const qty = BigInt(Math.max(0, Math.trunc(Number(it.quantity) || 0)));
    const pricePaise = toPaise(Number(it.price) || 0);
    const line = qty * pricePaise; // exact: qty is int, pricePaise is int
    lineTotals.push(line);
    subtotalPaise += line;
  }

  // 2. Clamp tax rate to [0, 100] and scale to an integer "basis" value we
  //    can multiply without float. For two-digit tax rates (e.g. 18, 18.5,
  //    0.01), multiply by 100 to preserve 2-decimal precision in the rate.
  const safeTax = Math.max(0, Math.min(100, Number(taxRatePercent) || 0));
  // Use Decimal for the tax rate to avoid binary-float drift (e.g. 0.07%
  // cannot be represented exactly in binary).
  const taxRateDec = new Prisma.Decimal(safeTax).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);

  // 3. Discount (pre-tax).
  let discountPaise = BigInt(0);
  if (discount.type && discount.value != null && Number(discount.value) > 0) {
    const raw = Number(discount.value);
    if (discount.type === "PERCENT") {
      const pct = Math.max(0, Math.min(100, raw));
      // discountPaise = round(subtotalPaise * pct / 100) HALF_UP
      const pctDec = new Prisma.Decimal(pct).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
      discountPaise = BigInt(
        new Prisma.Decimal(subtotalPaise.toString())
          .mul(pctDec)
          .div(HUNDRED_PERCENT.toString())
          .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
          .toFixed(0)
      );
    } else {
      // FIXED — convert major-value to paise.
      discountPaise = toPaise(raw);
    }
    // Cap discount at subtotal.
    if (discountPaise > subtotalPaise) discountPaise = subtotalPaise;
  }

  const netPaise = subtotalPaise - discountPaise;

  // 4. Tax on net amount: round(net * rate / 100) HALF_UP.
  let taxPaise = BigInt(0);
  if (netPaise > BigInt(0) && safeTax > 0) {
    taxPaise = BigInt(
      new Prisma.Decimal(netPaise.toString())
        .mul(taxRateDec)
        .div(HUNDRED_PERCENT.toString())
        .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
        .toFixed(0)
    );
  }

  const totalPaise = netPaise + taxPaise;

  return {
    subtotal: paiseToMajor(subtotalPaise),
    discountAmount: paiseToMajor(discountPaise),
    netAmount: paiseToMajor(netPaise),
    taxAmount: paiseToMajor(taxPaise),
    total: paiseToMajor(totalPaise),
    _paise: {
      subtotal: subtotalPaise,
      discountAmount: discountPaise,
      netAmount: netPaise,
      taxAmount: taxPaise,
      total: totalPaise,
      lineTotals,
    },
  };
}
