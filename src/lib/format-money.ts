/**
 * Format a monetary amount for a given currency using the en-IN locale
 * (override by passing a different BCP 47 locale).
 *
 * Falls back to INR if no currency is passed.
 */
export function formatMoney(
  amount: number | string | { toNumber: () => number },
  currency: string = "INR",
  locale: string = "en-IN"
): string {
  const value =
    typeof amount === "object" && "toNumber" in amount
      ? amount.toNumber()
      : Number(amount);

  if (Number.isNaN(value)) return "—";

  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: String(currency).toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // If Intl doesn't recognize the currency code, fall back to plain number
    return `${currency.toUpperCase()} ${value.toFixed(2)}`;
  }
}

/**
 * Build a complete address block from a company profile.
 */
export function formatAddressBlock(settings: {
  companyName?: string;
  companyEmail?: string | null;
  companyPhone?: string | null;
  companyAddress?: string | null;
}): string[] {
  const lines: string[] = [];
  if (settings.companyAddress) lines.push(settings.companyAddress);
  if (settings.companyPhone) lines.push(settings.companyPhone);
  return lines;
}
