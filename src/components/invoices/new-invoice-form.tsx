"use client";

import type { Client } from "@prisma/client";
import { InvoiceForm } from "@/components/invoices/invoice-form";

interface NewInvoiceFormProps {
  clients: Client[];
  /** Optionally pre-select a client (from /invoices/new?clientId=...). */
  initialClientId?: string;
  /** User's default tax rate (from settings) used as the initial value. */
  defaultTaxRate?: number;
  /** User's default due-in-days (from settings) used to compute due date. */
  defaultDueDays?: number;
  /** User's default notes/terms pre-filled on new invoices. */
  defaultNotes?: string;
}

/**
 * Thin wrapper kept for backwards compatibility with existing imports.
 * All logic lives in the shared <InvoiceForm mode="create" /> component,
 * which also powers the Edit Invoice page.
 */
export function NewInvoiceForm(props: NewInvoiceFormProps) {
  return <InvoiceForm mode="create" {...props} />;
}
