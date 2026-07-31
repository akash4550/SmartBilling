/**
 * Client-side paise → display helpers. BigInts don't cross the RSC/action
 * boundary, so these functions operate on stringified paise (as returned
 * from the server actions / getters) and on plain JS numbers.
 *
 * Formatting rules mirror format-money.ts but operate on SUBUNIT integers
 * (never float major units) to preserve the integer-paise guarantee end-
 * to-end.
 */

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

const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

function subunitDivisor(currency: string): number {
  const cur = currency.toUpperCase();
  if (ZERO_DECIMAL.has(cur)) return 1;
  if (THREE_DECIMAL.has(cur)) return 1000;
  return 100;
}

/**
 * Format a stringified integer-paise (or subunit) value using Intl.NumberFormat.
 * Never uses JS float math — divides numerically only at the display boundary
 * where Intl accepts a Number (paise amounts up to 12 digits fit in
 * MAX_SAFE_INTEGER easily — 10^12 paise = ₹10,000 Cr).
 */
export function formatPaise(
  paise: string | bigint | number | null | undefined,
  currency: string = "INR",
  opts: { locale?: string; showSign?: boolean } = {}
): string {
  if (paise == null) return "—";
  let p: bigint;
  try {
    p = BigInt(paise.toString());
  } catch {
    return "—";
  }
  const negative = p < BigInt(0);
  const abs = p < BigInt(0) ? -p : p;
  const div = subunitDivisor(currency);
  const major = Number(abs / BigInt(div));
  const minor = Number(abs % BigInt(div));
  const value = major + minor / div;

  const cur = currency.toUpperCase();
  const locale = opts.locale ?? (cur === "INR" ? "en-IN" : "en-US");

  try {
    const formatted = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: cur,
      minimumFractionDigits: div === 1 ? 0 : 2,
      maximumFractionDigits: div === 1 ? 0 : div === 1000 ? 3 : 2,
    }).format(value);
    if (negative) return `-${formatted}`;
    if (opts.showSign && p > BigInt(0)) return `+${formatted}`;
    return formatted;
  } catch {
    const symbol = CURRENCY_SYMBOLS[cur] ?? cur + " ";
    const sign = negative ? "-" : opts.showSign && p > 0 ? "+" : "";
    return `${sign}${symbol}${value.toFixed(div === 1 ? 0 : 2)}`;
  }
}

/** Truncate a SHA-256 hash to a shortened display form. */
export function shortHash(h: string | null | undefined, len = 10): string {
  if (!h) return "—";
  if (h.length <= len * 2 + 2) return h;
  return `${h.slice(0, len)}…${h.slice(-6)}`;
}

/** Format an ISO date string to human-readable IST time. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

/** Format a duration in ms (1.2s, 240ms, 3.4min). */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${min}m${s > 0 ? " " + s + "s" : ""}`;
}

/** Account → human label. */
export const ACCOUNT_LABELS: Record<string, string> = {
  ACCOUNTS_RECEIVABLE: "Accounts Receivable",
  REVENUE: "Revenue",
  DISCOUNT_CONTRA: "Discounts (Contra)",
  TAX_PAYABLE: "Tax Payable",
  CASH: "Cash",
  EXPENSES: "Expenses",
};

export const EVENT_LABELS: Record<string, string> = {
  INVOICE_ISSUED: "Invoice Issued",
  INVOICE_PAID: "Payment Received",
  INVOICE_VOIDED: "Invoice Voided",
  PAYMENT_REVERSED: "Payment Reversed",
  EXPENSE_RECORDED: "Expense",
};

export const DRIFT_LABELS: Record<string, { label: string; hint: string }> = {
  HASH_CHAIN_BROKEN: { label: "Hash Chain Broken", hint: "Cryptographic integrity failure — possible tampering." },
  TAIL_POINTER_DESYNC: { label: "Tail Pointer Desync", hint: "User.lastLedgerEntryHash does not match actual tail." },
  UNBALANCED_EVENT: { label: "Unbalanced Event", hint: "A transaction has ΣD ≠ ΣC; balance trigger may have been bypassed." },
  AR_MISMATCH: { label: "AR Mismatch", hint: "Ledger AR balance does not match Σ PENDING invoices." },
  CASH_MISMATCH: { label: "Cash Mismatch", hint: "Ledger CASH does not match Σ PAID − Σ expenses." },
  EXPENSE_MISMATCH: { label: "Expense Mismatch", hint: "Ledger EXPENSES does not match Σ expenses table." },
  ENTRY_INDEX_GAP: { label: "Entry Index Gap", hint: "Ledger rows were physically deleted." },
  REVENUE_TAX_MISMATCH: { label: "Revenue/Tax Drift", hint: "Usually caused by editing totals after issuance; may need void+reissue." },
  TRANSIENT_ERROR: { label: "Transient Error", hint: "DB timeout / connection issue; next run will retry." },
};
