"use client";

/**
 * Client-side display helpers for the Ledger Audit Console.
 *
 * Money handling rule: every monetary value enters the client as a
 * STRINGIFIED integer SUBUNIT (paise for INR). All display formatting
 * parses with BigInt and only divides by the subunit divisor (1, 100,
 * or 1000) at the PRESENTATION BOUNDARY when Intl.NumberFormat needs a
 * Number. There is ZERO JavaScript floating-point math in calculation
 * paths; the division is a display artifact only, and paise values
 * stay well under Number.MAX_SAFE_INTEGER (~10^12 paise = ₹10,000 Cr).
 *
 * Timezone is fixed to Asia/Kolkata (en-IN locale) to match app-wide
 * defaults.
 */

// ============================================================
// CURRENCY SUPPORT
// ============================================================

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  AUD: "A$",
  CAD: "C$",
  SGD: "S$",
  AED: "د.إ",
};

/** Currencies with no minor unit (divisor = 1). */
const ZERO_DECIMAL = new Set<string>([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

/** Currencies with 3 decimal places (divisor = 1000). */
const THREE_DECIMAL = new Set<string>([
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
]);

function subunitDivisor(currency: string): 1 | 100 | 1000 {
  const cur = currency.toUpperCase();
  if (ZERO_DECIMAL.has(cur)) return 1;
  if (THREE_DECIMAL.has(cur)) return 1000;
  return 100;
}

// ============================================================
// FORMATTERS
// ============================================================

export interface FormatPaiseOptions {
  /** Locale override (defaults to en-IN for INR, en-US otherwise). */
  locale?: string;
  /** If true, prefix non-negative values with '+' for deltas. */
  showSign?: boolean;
}

/**
 * Format a stringified integer-subunit (paise) value as currency.
 *
 *   formatPaise("12345")          // "₹123.45"
 *   formatPaise("-12345")         // "-₹123.45"
 *   formatPaise("12345", "INR", { showSign: true })  // "+₹123.45"
 *
 * All arithmetic (sign, absolute value, division, remainder) is done
 * with BigInt. The Number conversion to satisfy Intl.NumberFormat
 * happens once, at the presentation boundary.
 */
export function formatPaise(
  paise: string | bigint | number | null | undefined,
  currency: string = "INR",
  opts: FormatPaiseOptions = {}
): string {
  if (paise == null || paise === "") return "—";
  let p: bigint;
  try {
    p = BigInt(paise.toString());
  } catch {
    return "—";
  }

  const negative = p < BigInt(0);
  const abs = negative ? -p : p;
  const div = subunitDivisor(currency);
  const major = abs / BigInt(div);
  const minor = abs % BigInt(div);
  // One carefully-scoped numeric division for display only.
  const value = Number(major) + Number(minor) / div;

  const cur = currency.toUpperCase();
  const locale = opts.locale ?? (cur === "INR" ? "en-IN" : "en-US");

  const fractionDigits =
    div === 1 ? 0 : div === 1000 ? 3 : 2;

  try {
    const formatted = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: cur,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value);
    if (negative) return `-${formatted}`;
    if (opts.showSign && p > BigInt(0)) return `+${formatted}`;
    return formatted;
  } catch {
    // Fallback for unknown currency codes.
    const symbol = CURRENCY_SYMBOLS[cur] ?? cur + " ";
    const sign = negative
      ? "-"
      : opts.showSign && p > BigInt(0)
      ? "+"
      : "";
    const fixed = value.toFixed(fractionDigits);
    return `${sign}${symbol}${fixed}`;
  }
}

/**
 * Truncate a SHA-256 (or any long) hash for table display. Defaults to
 * first 8 hex chars + ellipsis (e.g. "a3f19b2c…"). The full hash is
 * always one click away via copy-to-clipboard.
 */
export function shortHash(h: string | null | undefined, len: number = 8): string {
  if (!h) return "—";
  if (h.length <= len + 1) return h;
  return `${h.slice(0, len)}…`;
}

/**
 * Format an ISO-8601 timestamp as human-readable IST (Asia/Kolkata, en-IN).
 * Returns "—" for null/undefined/parse failure.
 */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return "—";
  }
}

/**
 * Format a duration in milliseconds for human display (320ms, 1.2s, 3m 12s).
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${min}m ${s}s` : `${min}m`;
}

// ============================================================
// LABEL MAPS
// ============================================================

/** AccountType enum → human-readable label. */
export const ACCOUNT_LABELS: Record<string, string> = {
  ACCOUNTS_RECEIVABLE: "Accounts Receivable",
  REVENUE: "Revenue",
  DISCOUNT_CONTRA: "Discounts (Contra)",
  TAX_PAYABLE: "Tax Payable",
  CASH: "Cash",
  EXPENSES: "Expenses",
};

/** LedgerEventType enum → human-readable label. */
export const EVENT_LABELS: Record<string, string> = {
  INVOICE_ISSUED: "Invoice Issued",
  INVOICE_PAID: "Payment Received",
  INVOICE_VOIDED: "Invoice Voided",
  PAYMENT_REVERSED: "Payment Reversed",
  EXPENSE_RECORDED: "Expense Recorded",
};

/** DriftKind → human label + operator-oriented hint for the audit UI. */
export const DRIFT_LABELS: Record<
  string,
  { label: string; hint: string }
> = {
  HASH_CHAIN_BROKEN: {
    label: "Hash Chain Broken",
    hint: "Cryptographic integrity failure — possible tampering. Tenant has been quarantined.",
  },
  TAIL_POINTER_DESYNC: {
    label: "Tail Pointer Desync",
    hint: "users.lastLedgerEntryHash does not match the actual chain tail.",
  },
  UNBALANCED_EVENT: {
    label: "Unbalanced Event",
    hint: "A transaction has Σ Debits ≠ Σ Credits; the balance trigger may have been bypassed.",
  },
  AR_MISMATCH: {
    label: "AR Mismatch",
    hint: "Ledger AR balance does not match Σ PENDING invoice totals.",
  },
  CASH_MISMATCH: {
    label: "Cash Mismatch",
    hint: "Ledger CASH does not match the signed sum of recognized cash event types.",
  },
  EXPENSE_MISMATCH: {
    label: "Expense Mismatch",
    hint: "Ledger EXPENSES does not match Σ expenses.amount.",
  },
  ENTRY_INDEX_GAP: {
    label: "Entry Index Gap",
    hint: "Ledger rows have been physically deleted or skipped.",
  },
  REVENUE_TAX_MISMATCH: {
    label: "Revenue/Tax Drift",
    hint: "Usually caused by editing totals after issuance; fix by void + reissue.",
  },
  TRANSIENT_ERROR: {
    label: "Transient Error",
    hint: "DB timeout/connection issue; next scheduled run will retry.",
  },
};
