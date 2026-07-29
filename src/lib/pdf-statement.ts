/**
 * Client Account Statement PDF — rendered with @react-pdf/renderer, same lazy-
 * load pattern used by invoice PDFs to avoid pulling React PDF into the client
 * bundles or breaking Turbopack native-module resolution.
 *
 * Statement shows: company header, client bill-to, as-of date, a line-by-line
 * table of invoices (date, number, status, charges, payments, balance), totals,
 * and a fixed footer.
 */
import { prisma } from "@/lib/prisma";
import type { Client, Invoice, InvoiceItem, Settings } from "@prisma/client";

type FullInvoice = Invoice & { items: InvoiceItem[] };

export interface StatementData {
  client: Client & { invoices: FullInvoice[] };
  settings: Settings;
  invoices: FullInvoice[];
  asOfDate: Date;
  branding?: {
    logoBase64?: string | null;
    logoContentType?: string | null;
    brandColor?: string | null;
  };
}

let _pdfLib: Awaited<ReturnType<typeof loadPdfDeps>> | null = null;

type PdfLib = {
  renderToBuffer: (el: React.ReactElement) => Promise<Buffer>;
  Document: React.ComponentType<Record<string, unknown>>;
  Page: React.ComponentType<Record<string, unknown>>;
  View: React.ComponentType<Record<string, unknown>>;
  Text: React.ComponentType<Record<string, unknown>>;
  Link: React.ComponentType<Record<string, unknown>>;
  Image: React.ComponentType<Record<string, unknown>>;
  StyleSheet: {
    create: <T extends Record<string, Record<string, unknown>>>(styles: T) => T;
  };
};

async function loadPdfDeps(): Promise<{ React: typeof import("react"); pdfLib: PdfLib }> {
  if (_pdfLib) {
    return _pdfLib;
  }
  const reactMod = await import("react");
  const R = (reactMod.default ?? reactMod) as unknown as typeof import("react");
  const pdfMod = await import("@react-pdf/renderer") as unknown as Record<string, unknown>;
  // Prefer named exports (renderToBuffer lives there); fall back to .default.
  const src = (typeof pdfMod.renderToBuffer === "function")
    ? pdfMod
    : ((pdfMod.default ?? pdfMod) as Record<string, unknown>);
  const mod = src as unknown as {
    renderToBuffer: (el: React.ReactElement) => Promise<Buffer>;
    Document: React.ComponentType<Record<string, unknown>>;
    Page: React.ComponentType<Record<string, unknown>>;
    View: React.ComponentType<Record<string, unknown>>;
    Text: React.ComponentType<Record<string, unknown>>;
    Link: React.ComponentType<Record<string, unknown>>;
    Image: React.ComponentType<Record<string, unknown>>;
    StyleSheet: PdfLib["StyleSheet"];
    Font?: { register: (opts: Record<string, unknown>) => void };
  };
  const lib: PdfLib = {
    renderToBuffer: mod.renderToBuffer,
    Document: mod.Document,
    Page: mod.Page,
    View: mod.View,
    Text: mod.Text,
    Link: mod.Link,
    Image: mod.Image,
    StyleSheet: mod.StyleSheet,
  };
  _pdfLib = { React: R, pdfLib: lib };
  // Register NotoSans font for better Unicode coverage (best-effort).
  if (mod.Font) {
    const { registerPdfFonts } = await import("@/lib/pdf-fonts");
    await registerPdfFonts(mod.Font as { register: (opts: unknown) => void });
  }
  return _pdfLib;
}

export function buildStatementFilename(clientName: string, asOfDate: Date): string {
  const safe = clientName.replace(/[^\w.-]+/g, "_").slice(0, 40);
  const ymd = asOfDate.toISOString().slice(0, 10);
  return `Statement_${safe}_${ymd}.pdf`;
}

function inr(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(n);
}

function fmtDate(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(dt);
}

export async function renderClientStatementPdf(data: StatementData): Promise<Buffer> {
  const { React, pdfLib } = await loadPdfDeps();
  const { Document, Page, View, Text, Image, StyleSheet, renderToBuffer } = pdfLib;
  const { client, settings, invoices, asOfDate, branding } = data;

  // Resolve brand color + logo.
  const rawBrand = branding?.brandColor;
  const brandColor = rawBrand && typeof rawBrand === "string" && /^#([0-9a-fA-F]{3}){1,2}$/.test(rawBrand)
    ? (rawBrand.length === 4
        ? `#${rawBrand[1]}${rawBrand[1]}${rawBrand[2]}${rawBrand[2]}${rawBrand[3]}${rawBrand[3]}`
        : rawBrand.toLowerCase())
    : "#2563eb";

  // Compute running balance (ascending by issue date)
  let running = 0;
  const rows = invoices
    .filter((inv) => inv.issueDate <= asOfDate)
    .map((inv) => {
      const total = Number(inv.totalAmount);
      const charge = inv.status === "PAID" || inv.status === "VOID" ? 0 : total;
      const payment = inv.status === "PAID" ? total : 0;
      running += charge - payment;
      return { inv, total, charge, payment, balance: running };
    });

  const totalBilled = rows.reduce((s, r) => s + r.total, 0);
  const totalPaid = rows.reduce((s, r) => s + r.payment, 0);
  const balanceDue = running;

  const palette = { primary: brandColor, muted: "#64748b", text: "#0f172a", border: "#e2e8f0", bgSoft: "#f8fafc" };
  const hasLogo = !!(branding?.logoBase64 && branding?.logoContentType);

  const styles = StyleSheet.create({
    page: { padding: 40, fontFamily: "Helvetica", fontSize: 10, color: palette.text },
    headerBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 },
    companyBlock: {},
    companyName: { fontSize: 18, fontWeight: "bold", color: palette.primary },
    muted: { fontSize: 9, color: palette.muted, marginTop: 2 },
    titleBlock: { alignItems: "flex-end" },
    title: { fontSize: 20, fontWeight: "bold", color: palette.text },
    subtitle: { fontSize: 9, color: palette.muted, marginTop: 4, textAlign: "right" },
    section: { marginTop: 20 },
    sectionTitle: { fontSize: 9, fontWeight: "bold", color: palette.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 },
    billTo: { padding: 12, backgroundColor: palette.bgSoft, borderRadius: 6 },
    billToName: { fontSize: 12, fontWeight: "bold", marginBottom: 2 },
    table: { width: "100%", borderWidth: 1, borderColor: palette.border, borderRadius: 4, overflow: "hidden" },
    tableRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: palette.border },
    tableHead: { backgroundColor: palette.bgSoft, fontWeight: "bold", fontSize: 8, color: palette.muted },
    cell: { padding: 8, fontSize: 9 },
    cellDate: { width: "18%" },
    cellNum: { width: "20%" },
    cellStatus: { width: "14%" },
    cellAmt: { width: "16%", textAlign: "right" },
    cellBal: { width: "16%", textAlign: "right", fontWeight: "bold" },
    summary: { marginTop: 16, alignSelf: "flex-end", width: "40%" },
    summaryRow: { flexDirection: "row", justifyContent: "space-between", padding: "4px 0", fontSize: 9 },
    summaryTotal: { flexDirection: "row", justifyContent: "space-between", padding: "6px 0", fontSize: 11, fontWeight: "bold", borderTopWidth: 1, borderTopColor: palette.text, marginTop: 4 },
    footer: { position: "absolute", bottom: 24, left: 40, right: 40, textAlign: "center", fontSize: 8, color: palette.muted, borderTopWidth: 1, borderTopColor: palette.border, paddingTop: 8 },
    badge: { padding: "2px 6px", borderRadius: 3, fontSize: 7, fontWeight: "bold", color: "white" },
    brandLogo: { maxHeight: 52, maxWidth: 160, objectFit: "contain" as const, marginBottom: 4 },
  } as Record<string, Record<string, unknown>>);

  const statusColor = (s: string) =>
    s === "PAID" ? "#10b981" : s === "PENDING" ? "#f59e0b" : s === "VOID" ? "#64748b" : "#94a3b8";

  const el = React.createElement(Document, null,
    React.createElement(Page, { size: "A4", style: styles.page },
      // Header
      React.createElement(View, { style: styles.headerBar },
        React.createElement(View, { style: styles.companyBlock },
          hasLogo
            ? React.createElement(Image, {
                key: "logo",
                style: styles.brandLogo,
                src: {
                  data: branding!.logoBase64!,
                  format: branding!.logoContentType === "image/png" ? "png" : branding!.logoContentType === "image/webp" ? "png" : "jpg",
                },
              })
            : null,
          React.createElement(Text, { style: styles.companyName }, settings.companyName),
          settings.companyEmail ? React.createElement(Text, { style: styles.muted }, settings.companyEmail) : null,
          settings.companyPhone ? React.createElement(Text, { style: styles.muted }, settings.companyPhone) : null,
          settings.companyAddress ? React.createElement(Text, { style: styles.muted }, settings.companyAddress) : null
        ),
        React.createElement(View, { style: styles.titleBlock },
          React.createElement(Text, { style: styles.title }, "Account Statement"),
          React.createElement(Text, { style: styles.subtitle }, `As of ${fmtDate(asOfDate)}`)
        )
      ),

      // Bill to
      React.createElement(View, { style: styles.section },
        React.createElement(Text, { style: styles.sectionTitle }, "Bill To"),
        React.createElement(View, { style: styles.billTo },
          React.createElement(Text, { style: styles.billToName }, client.name),
          React.createElement(Text, { style: styles.muted }, client.email),
          client.phone ? React.createElement(Text, { style: styles.muted }, client.phone) : null,
          client.address ? React.createElement(Text, { style: styles.muted }, client.address) : null
        )
      ),

      // Summary cards row
      React.createElement(View, { style: { ...styles.section, flexDirection: "row", gap: 8 } },
        statBox("Total Billed", inr(totalBilled), palette.primary),
        statBox("Total Paid", inr(totalPaid), "#10b981"),
        statBox("Balance Due", inr(balanceDue), balanceDue > 0 ? "#dc2626" : "#64748b"),
      ),

      // Ledger table
      React.createElement(View, { style: styles.section },
        React.createElement(Text, { style: styles.sectionTitle }, "Invoice History"),
        React.createElement(View, { style: styles.table },
          React.createElement(View, { style: { ...styles.tableRow, ...styles.tableHead } },
            React.createElement(Text, { style: { ...styles.cell, ...styles.cellDate } }, "Date"),
            React.createElement(Text, { style: { ...styles.cell, ...styles.cellNum } }, "Invoice #"),
            React.createElement(Text, { style: { ...styles.cell, ...styles.cellStatus } }, "Status"),
            React.createElement(Text, { style: { ...styles.cell, ...styles.cellAmt } }, "Amount"),
            React.createElement(Text, { style: { ...styles.cell, ...styles.cellAmt } }, "Payment"),
            React.createElement(Text, { style: { ...styles.cell, ...styles.cellBal } }, "Balance"),
          ),
          ...rows.map((r) =>
            React.createElement(View, { key: r.inv.id, style: styles.tableRow },
              React.createElement(Text, { style: { ...styles.cell, ...styles.cellDate } }, fmtDate(r.inv.issueDate)),
              React.createElement(Text, { style: { ...styles.cell, ...styles.cellNum } }, r.inv.invoiceNumber),
              React.createElement(View, { style: { ...styles.cell, ...styles.cellStatus } },
                React.createElement(View, { style: { ...styles.badge, backgroundColor: statusColor(r.inv.status) } },
                  React.createElement(Text, { style: { color: "white", fontSize: 7, fontWeight: "bold" } }, r.inv.status)
                )
              ),
              React.createElement(Text, { style: { ...styles.cell, ...styles.cellAmt } }, inr(r.total)),
              React.createElement(Text, { style: { ...styles.cell, ...styles.cellAmt } }, r.payment > 0 ? inr(r.payment) : "—"),
              React.createElement(Text, { style: { ...styles.cell, ...styles.cellBal } }, inr(r.balance)),
            )
          )
        )
      ),

      // Footer
      React.createElement(View, { style: styles.footer },
        React.createElement(Text, null, `${settings.companyName} · Statement generated on ${fmtDate(new Date())} · All amounts in ${settings.currency || "INR"}.`)
      )
    )
  );

  return renderToBuffer(el);

  function statBox(label: string, value: string, color: string) {
    return React.createElement(View, {
      style: {
        flex: 1,
        padding: 10,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: color + "33",
        backgroundColor: color + "0a",
      },
    },
      React.createElement(Text, { style: { fontSize: 8, color, fontWeight: "bold", textTransform: "uppercase", letterSpacing: 0.5 } }, label),
      React.createElement(Text, { style: { fontSize: 13, fontWeight: "bold", color, marginTop: 4 } }, value)
    );
  }
}

// Silence unused prisma import (kept for future server-side resolution helpers).
export const _prisma = prisma;
