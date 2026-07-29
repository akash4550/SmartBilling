import type { Prisma } from "@prisma/client";

// Re-export Prisma-generated types for convenience
export type { Client, Invoice, InvoiceItem, InvoiceStatus, RecurringProfile, RecurringItem, RecurrenceFrequency, InvoiceActivity, InvoiceActivityType } from "@prisma/client";

// Typed payload for an invoice with items + client included
export type InvoiceWithRelations = Prisma.InvoiceGetPayload<{
  include: {
    client: true;
    items: true;
  };
}>;

export type ClientWithInvoices = Prisma.ClientGetPayload<{
  include: {
    invoices: true;
  };
}>;

export type RecurringProfileWithRelations = Prisma.RecurringProfileGetPayload<{
  include: {
    client: true;
    items: true;
    _count: { select: { invoices: true } };
  };
}>;

export type RecurringProfileDetail = Prisma.RecurringProfileGetPayload<{
  include: {
    client: true;
    items: true;
    invoices: {
      orderBy: { createdAt: "desc" };
      take: 10;
    };
    _count: { select: { invoices: true } };
  };
}>;

// Shape of the data returned by the dashboard summary endpoint
export interface DashboardSummary {
  totalRevenue: number;
  pendingAmount: number;
  overdueCount: number;
  overdueAmount: number;
  draftCount: number;
  paidCount: number;
  pendingCount: number;
  totalClients: number;
  totalInvoices: number;
  recentInvoices: InvoiceWithRelations[];
}
