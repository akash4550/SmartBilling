import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// ============================================================
// TAILWIND CLASS MERGER
// ============================================================
/**
 * Conditionally merge Tailwind CSS class names while resolving conflicts.
 * Wraps `clsx` (for conditional objects/arrays) with `tailwind-merge`
 * (so that later utility classes override earlier ones correctly).
 *
 * @example
 * cn("px-2 py-1", isActive && "bg-blue-500", "px-4") // → "py-1 bg-blue-500 px-4"
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// ============================================================
// CURRENCY FORMATTING
// ============================================================
/**
 * Format a numeric amount (number, string, or Prisma Decimal-like object)
 * as Indian Rupees (₹) using the en-IN locale.
 *
 * Accepts Prisma's Decimal type out of the box (which exposes `.toNumber()`),
 * plus plain numbers and numeric strings.
 */
export function formatCurrency(
  amount: number | string | { toNumber: () => number }
): string {
  const value =
    typeof amount === "object" && "toNumber" in amount
      ? amount.toNumber()
      : Number(amount);

  if (Number.isNaN(value)) return "—";

  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

// ============================================================
// DATE FORMATTING
// ============================================================
/**
 * Format a date to a human-readable string (e.g., "27 Jul 2026") using en-IN.
 * Accepts a Date object, an ISO string, or a DB date string.
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}

// ============================================================
// INVOICE NUMBER GENERATOR
// ============================================================
export interface GenerateInvoiceNumberOptions {
  /** How many invoices already exist today (used to compute the sequence). */
  count?: number;
  /** Optional separator between segments. Defaults to "-". */
  separator?: string;
  /** Optional padding width for the sequence number. Defaults to 4. */
  pad?: number;
  /** Optional prefix (e.g. "INV", "ACME"). Alphanumeric/underscore/dash; default "INV". */
  prefix?: string;
  /**
   * Optional format template. Variables: {P} prefix, {D} date (YYYYMMDD), {N} sequence.
   * When provided, separator/pad are ignored except for {N} which uses pad.
   * Example: "{P}/{D}/{N}" → "INV/20260728/0001"
   */
  format?: string;
}

/**
 * Generate a human-readable, sortable invoice number based on the current date.
 *
 * Format: `<PREFIX><sep>YYYYMMDD<sep>NNNN`
 * @example INV-20260727-0001 (default prefix)
 * @example ACME-20260728-0001 (custom prefix)
 *
 * Uses IST (Asia/Calcutta) for the date portion since the user's locale is India.
 */
export function generateInvoiceNumber(
  count: number = 0,
  options: GenerateInvoiceNumberOptions = {}
): string {
  const { separator = "-", pad = 4, prefix = "INV" } = options;
  // Sanitise prefix: letters, digits, underscore, dash only. Up to 12 chars.
  const safePrefix = (prefix || "INV")
    .replace(/[^\w-]+/g, "")
    .toUpperCase()
    .slice(0, 12) || "INV";

  // Format date in IST to match the user's timezone
  const now = new Date();
  const istFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Calcutta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = istFormatter.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const yyyyMmDd = `${get("year")}${get("month")}${get("day")}`;

  const sequence = String(count + 1).padStart(pad, "0");
  return `${safePrefix}${separator}${yyyyMmDd}${separator}${sequence}`;
}

// ============================================================
// INVOICE TOTAL CALCULATION
// ============================================================
export type DiscountType = "PERCENT" | "FIXED";

export interface DiscountInput {
  /** Discount value interpretation. null/undefined = no discount. */
  type?: DiscountType | null;
  /** Discount value — percent (0..100) when PERCENT, flat amount when FIXED. */
  value?: number | null;
}

export interface InvoiceTotals {
  /** Sum of (quantity * price) across all items, before discount/tax. */
  subtotal: number;
  /** Absolute discount amount applied (0 if no discount). */
  discountAmount: number;
  /** Net amount after discount but before tax. */
  netAmount: number;
  /** Computed tax amount: netAmount * (taxRate / 100). */
  taxAmount: number;
  /** Grand total: netAmount + taxAmount. */
  total: number;
}

export interface InvoiceLineItemInput {
  quantity: number;
  price: number;
}

/**
 * Round a number to 2 decimal places using banker-safe rounding
 * (scaled integer rounding to avoid IEEE-754 floating-point drift).
 */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Given line items, a tax rate, and an optional discount, compute
 * subtotal, discount, net (post-discount, pre-tax), tax, and grand total.
 * Discount is applied pre-tax (the standard for most jurisdictions).
 *
 * @example
 * calculateInvoiceTotals(
 *   [{ quantity: 2, price: 100 }, { quantity: 1, price: 50 }],
 *   18,
 *   { type: "PERCENT", value: 10 }
 * )
 * // → { subtotal: 250, discountAmount: 25, netAmount: 225, taxAmount: 40.50, total: 265.50 }
 */
export function calculateInvoiceTotals(
  items: readonly InvoiceLineItemInput[],
  taxRate: number = 0,
  discount: DiscountInput = {}
): InvoiceTotals {
  const safeTaxRate = Math.max(0, Math.min(100, Number(taxRate) || 0));

  const subtotal = round2(
    items.reduce((sum, item) => {
      const qty = Number(item.quantity) || 0;
      const price = Number(item.price) || 0;
      return sum + round2(qty * price);
    }, 0)
  );

  // Compute discount (capped so it can't exceed subtotal).
  let discountAmount = 0;
  if (discount.type && discount.value != null && Number(discount.value) > 0) {
    const raw = Number(discount.value);
    if (discount.type === "PERCENT") {
      const pct = Math.max(0, Math.min(100, raw));
      discountAmount = round2((subtotal * pct) / 100);
    } else {
      discountAmount = Math.max(0, round2(Math.min(raw, subtotal)));
    }
  }

  const netAmount = round2(subtotal - discountAmount);
  const taxAmount = round2((netAmount * safeTaxRate) / 100);
  const total = round2(netAmount + taxAmount);

  return { subtotal, discountAmount, netAmount, taxAmount, total };
}

// ============================================================
// OVERDUE DETECTION
// ============================================================

/**
 * Returns true if the invoice is pending (not paid/draft/void) AND its dueDate
 * is strictly before today (in Asia/Calcutta). Pure function; works on any
 * shape that exposes `status` and `dueDate`.
 */
export function isInvoiceOverdue(
  invoice: { status: string; dueDate: Date | string },
  now: Date = new Date()
): boolean {
  if (invoice.status !== "PENDING") return false;
  // Normalise "today" to IST midnight so an invoice due today is NOT yet overdue
  // (it becomes overdue the day after dueDate).
  const tz = "Asia/Calcutta";
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const due = typeof invoice.dueDate === "string" ? new Date(invoice.dueDate) : invoice.dueDate;
  const dueStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(due);
  return dueStr < todayStr;
}

/**
 * Returns number of days an invoice is overdue (negative = not yet due).
 * Returns 0 for non-pending invoices.
 */
export function daysOverdue(
  invoice: { status: string; dueDate: Date | string },
  now: Date = new Date()
): number {
  if (invoice.status !== "PENDING") return 0;
  const tz = "Asia/Calcutta";
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const todayParts = fmt.formatToParts(now);
  const due = typeof invoice.dueDate === "string" ? new Date(invoice.dueDate) : invoice.dueDate;
  const dueParts = fmt.formatToParts(due);
  const get = (parts: Intl.DateTimeFormatPart[], t: string) => Number(parts.find((p) => p.type === t)?.value);
  const a = Date.UTC(get(todayParts, "year"), get(todayParts, "month") - 1, get(todayParts, "day"));
  const b = Date.UTC(get(dueParts, "year"), get(dueParts, "month") - 1, get(dueParts, "day"));
  return Math.floor((a - b) / 86_400_000);
}

/**
 * Relative "days until due / days overdue" label, e.g. "Due today", "2 days overdue", "In 5 days".
 */
export function dueLabel(
  invoice: { status: string; dueDate: Date | string },
  now: Date = new Date()
): { label: string; tone: "overdue" | "today" | "soon" | "ok" | "paid" | "draft" | "void" } {
  if (invoice.status === "PAID") return { label: "Paid", tone: "paid" };
  if (invoice.status === "DRAFT") return { label: "Draft", tone: "draft" };
  if (invoice.status === "VOID") return { label: "Void", tone: "void" };
  const d = daysOverdue(invoice, now);
  if (d > 0) return { label: `${d} day${d === 1 ? "" : "s"} overdue`, tone: "overdue" };
  if (d === 0) return { label: "Due today", tone: "today" };
  if (d >= -3) return { label: `In ${-d} day${d === -1 ? "" : "s"}`, tone: "soon" };
  return { label: `In ${-d} days`, tone: "ok" };
}
