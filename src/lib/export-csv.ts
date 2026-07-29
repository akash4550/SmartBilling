import type { Invoice, Client } from "@prisma/client";
import { formatDate } from "@/lib/utils";

/** Invoice shape including client name — matches what our API returns. */
export interface InvoiceForExport extends Pick<Invoice,
  "invoiceNumber" | "status" | "issueDate" | "dueDate" | "totalAmount" | "taxRate" | "createdAt" | "paidAt"
> {
  client: Pick<Client, "name" | "email"> | null;
  /** 3-letter currency code (INR, USD, ...). Defaults to INR for backwards compat. */
  currency?: string;
}

/**
 * Escape a single CSV cell value.
 * - Wraps the value in double quotes if it contains commas, quotes, or newlines
 * - Doubles up internal quotes per RFC 4180
 */
function csvCell(value: string | number): string {
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Convert an array of invoices into a CSV string with columns:
 * Client Name, Client Email, Invoice Number, Issue Date, Due Date, Status,
 * Tax Rate, Total Amount, Paid At, Currency, Created At.
 */
export function invoicesToCSV(invoices: readonly InvoiceForExport[]): string {
  const headers = [
    "Client Name",
    "Client Email",
    "Invoice Number",
    "Issue Date",
    "Due Date",
    "Status",
    "Tax Rate (%)",
    "Total Amount",
    "Paid At",
    "Currency",
    "Created At",
  ];

  const rows = invoices.map((inv) => [
    inv.client?.name ?? "",
    inv.client?.email ?? "",
    inv.invoiceNumber,
    formatDate(inv.issueDate),
    inv.dueDate ? formatDate(inv.dueDate) : "",
    inv.status,
    inv.taxRate != null ? Number(inv.taxRate).toFixed(2) : "",
    Number(inv.totalAmount).toFixed(2),
    inv.paidAt ? formatDate(inv.paidAt) : "",
    inv.currency ?? "INR",
    formatDate(inv.createdAt),
  ]);

  // Prepend UTF-8 BOM so Excel correctly opens rupee symbols & special chars
  const bom = "\uFEFF";
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(","));
  return bom + lines.join("\r\n");
}

/**
 * Generate a browser download for a CSV of invoices.
 *
 * Creates a Blob, attaches it to a temporary anchor, and triggers a click.
 * The filename includes the current date for clarity, e.g.: `invoices-2026-07-27.csv`.
 *
 * Safe to call from client components only (uses window/document).
 */
export function downloadInvoicesCSV(invoices: readonly InvoiceForExport[]): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const csv = invoicesToCSV(invoices);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  // Filename: invoices-YYYY-MM-DD.csv (IST date)
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const filename = `invoices-${dateStr}.csv`;

  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Release the object URL after the click has been processed
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
