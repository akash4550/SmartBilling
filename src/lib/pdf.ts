/**
 * Server-side PDF rendering helpers.
 *
 * We lazy-import @react-pdf/renderer + React here (and only from API
 * routes) so the heavy PDF stack isn't pulled into the client bundle or
 * into unrelated SSR pages. On Next 16 Turbopack this avoids native-module
 * resolution hiccups similar to what we hit with argon2.
 */
import { prisma } from "@/lib/prisma";
import { getBrandingForUser, darken } from "@/lib/branding";
import type { InvoiceWithRelations } from "@/types";

export interface PdfSettings {
  companyName: string;
  companyEmail: string;
  companyAddress?: string | null;
  companyPhone?: string | null;
  currency: string;
  // Optional company logo: base64 (without data: prefix) + MIME type. When
  // present we render an <Image> in the header; when absent we fall back
  // to the initial-letter badge.
  logoBase64?: string | null;
  logoContentType?: string | null;
  brandColor?: string; // hex accent (default #2563eb)
}

export interface InvoicePdfData {
  invoice: InvoiceWithRelations;
  settings: PdfSettings;
  filename: string;
}

/**
 * Resolve an invoice + the settings to render on its PDF.
 *
 * When `userId` is supplied (authenticated, admin download) we require
 * ownership. When it's omitted (public download link) we simply look up by
 * id — the invoice id itself is a non-guessable CUID and access is rate
 * limited at the route level.
 */
export async function loadInvoiceForPdf(
  invoiceId: string,
  userId?: string
): Promise<InvoicePdfData> {
  const invoice = userId
    ? await prisma.invoice.findFirst({
        where: { id: invoiceId, userId },
        include: { client: true, items: { orderBy: { id: "asc" } } },
      })
    : await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { client: true, items: { orderBy: { id: "asc" } } },
      });

  if (!invoice) {
    const err = new Error("Invoice not found");
    (err as { status?: number }).status = 404;
    throw err;
  }

  const settings = await prisma.settings.findUnique({
    where: { userId: invoice.userId },
  });

  const currency = settings?.currency || "INR";
  const companyName = settings?.companyName || "Your Business Name";
  const companyEmail = settings?.companyEmail || "billing@example.com";

  // Pull branding (logo + accent color).
  const branding = await getBrandingForUser(invoice.userId);

  return {
    invoice,
    settings: {
      companyName,
      companyEmail,
      companyAddress: settings?.companyAddress ?? null,
      companyPhone: settings?.companyPhone ?? null,
      currency,
      logoBase64: branding.logoData,
      logoContentType: branding.logoContentType,
      brandColor: branding.brandColor,
    },
    filename: buildPdfFilename(invoice.invoiceNumber),
  };
}

export function buildPdfFilename(invoiceNumber: string): string {
  // Filesystem-safe: INV-20250728-0001 -> Invoice_INV-20250728-0001.pdf
  const safe = invoiceNumber.replace(/[^\w.-]+/g, "_");
  return `Invoice_${safe}.pdf`;
}

// Lazily loaded caches — populated on first render.
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

let _pdfLib: PdfLib | null = null;
let _React: typeof import("react") | null = null;

async function loadPdfDeps(): Promise<{ React: typeof import("react"); pdfLib: PdfLib }> {
  if (_pdfLib && _React) return { React: _React, pdfLib: _pdfLib };
  const reactMod = await import("react");
  const R = (reactMod.default ?? reactMod) as unknown as typeof import("react");
  const pdfMod = (await import("@react-pdf/renderer")) as unknown as Record<string, unknown>;
  // @react-pdf/renderer has both a `default` export (browser primitives only)
  // AND named exports (renderToBuffer, pdf, etc.). We want the named exports
  // since they include renderToBuffer. Fall back to default only if the named
  // export set is missing renderToBuffer.
  const hasNamed = typeof pdfMod.renderToBuffer === "function";
  const candidate = (hasNamed ? pdfMod : (pdfMod.default ?? pdfMod)) as Record<string, unknown>;
  _React = R;
  _pdfLib = candidate as unknown as PdfLib;
  // NOTE: Noto Sans font registration is attempted but best-effort; failures
  // are caught and logged so the PDF still renders with Helvetica fallback.
  try {
    const { registerPdfFonts } = await import("@/lib/pdf-fonts");
    const Font = (candidate as unknown as { Font?: { register: (opts: unknown) => void } }).Font;
    if (Font) await registerPdfFonts(Font);
  } catch (fontErr) {
    console.warn("[pdf] Font registration failed, using default fonts:", (fontErr as Error).message);
  }
  return { React: R, pdfLib: _pdfLib };
}

/**
 * Render the invoice React tree to a PDF Buffer.
 *
 * Uses a dynamic ESM import of @react-pdf/renderer so the heavy PDF stack
 * (pdfkit, fontkit, etc.) is never pulled into the client bundle or into
 * unrelated SSR pages. The imports are cached in-memory across requests.
 */
export async function renderInvoicePdfToBuffer(
  data: InvoicePdfData
): Promise<Buffer> {
  const { React, pdfLib } = await loadPdfDeps();
  const { Document, Page, View, Text, Link, Image, StyleSheet, renderToBuffer } = pdfLib;
  const { invoice, settings } = data;

  // Resolve brand color (with safe default) and derived shades.
  const rawBrand = settings.brandColor;
  const brand = rawBrand && typeof rawBrand === "string" && /^#([0-9a-fA-F]{3}){1,2}$/.test(rawBrand)
    ? (rawBrand.length === 4
        ? `#${rawBrand[1]}${rawBrand[1]}${rawBrand[2]}${rawBrand[2]}${rawBrand[3]}${rawBrand[3]}`
        : rawBrand.toLowerCase())
    : "#2563eb";
  const brandDark = darken(brand, 0.22);
  // Build a soft tint of the brand for the "Bill To" card (light bg).
  const brandTint = (() => {
    const h = brand.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const mix = (c: number) => Math.round(c + (255 - c) * 0.92);
    return `#${[mix(r), mix(g), mix(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  })();

  const palette = {
    primary: brand,
    primaryDark: brandDark,
    primarySoft: brandTint,
    text: "#0f172a",
    muted: "#64748b",
    border: "#e2e8f0",
    bgSoft: "#f8fafc",
    paid: "#dcfce7",
    paidText: "#15803d",
    warning: "#d97706",
    warningBg: "#fef3c7",
    warningBorder: "#fcd34d",
    overdueBg: "#fee2e2",
    overdueBorder: "#fca5a5",
    overdueText: "#b91c1c",
    draftBg: "#f1f5f9",
  };

  const styles = StyleSheet.create({
    page: {
      padding: "40 48 56 48",
      fontFamily: "Helvetica",
      color: palette.text,
      fontSize: 10,
      lineHeight: 1.45,
    },
    accentBar: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: 6,
      backgroundColor: palette.primary,
    },
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28 },
    brand: { flexDirection: "row", alignItems: "center", gap: 10 },
    brandMark: { width: 38, height: 38, borderRadius: 8, backgroundColor: palette.primary, alignItems: "center", justifyContent: "center" },
    brandMarkText: { color: "white", fontSize: 16, fontWeight: "bold" },
    brandTitle: { fontSize: 20, fontWeight: "bold", color: palette.text },
    brandSub: { fontSize: 9, color: palette.muted, fontFamily: "Courier", marginTop: 2 },
    rightBlock: { alignItems: "flex-end" },
    statusRow: { flexDirection: "row", justifyContent: "flex-end", marginBottom: 4 },
    statusPill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, fontSize: 8, fontWeight: "bold", textTransform: "uppercase", letterSpacing: 0.6 },
    invoiceTitle: { fontSize: 26, fontWeight: "bold", color: palette.primaryDark, letterSpacing: 1 },
    invoiceNumber: { fontSize: 10, color: palette.muted, fontFamily: "Courier", marginTop: 2 },
    amountDueLabel: { fontSize: 8, color: palette.muted, textTransform: "uppercase", letterSpacing: 0.8, marginTop: 10, textAlign: "right" },
    amountDue: { fontSize: 18, fontWeight: "bold", color: palette.primary, marginTop: 2 },

    parties: { flexDirection: "row", gap: 12, marginBottom: 20 },
    partyCard: { flex: 1, padding: 12, borderRadius: 6, backgroundColor: palette.bgSoft, borderWidth: 1, borderColor: palette.border },
    partyCardBillTo: { backgroundColor: brandTint, borderColor: brand },
    partyLabel: { fontSize: 8, color: palette.muted, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: "bold", marginBottom: 6 },
    partyLabelBillTo: { color: brandDark },
    partyName: { fontSize: 12, fontWeight: "bold", marginBottom: 3 },
    partyLine: { fontSize: 9, color: "#475569", marginBottom: 1.5 },
    partyLink: { fontSize: 9, color: palette.primary, textDecoration: "none", marginBottom: 1.5 },

    meta: { flexDirection: "row", backgroundColor: palette.bgSoft, borderRadius: 6, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: palette.border },
    metaCell: { flex: 1, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: palette.border },
    metaCellLast: { flex: 1, paddingHorizontal: 6 },
    metaLabel: { fontSize: 8, color: palette.muted, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: "bold", marginBottom: 3 },
    metaValue: { fontSize: 10, fontWeight: "bold" },

    table: { borderWidth: 1, borderColor: palette.border, borderRadius: 6, overflow: "hidden", marginBottom: 14 },
    tableHeader: { flexDirection: "row", backgroundColor: palette.bgSoft, borderBottomWidth: 1, borderBottomColor: palette.border, paddingVertical: 7, paddingHorizontal: 10 },
    tableHeaderCell: { fontSize: 8, color: palette.muted, textTransform: "uppercase", letterSpacing: 0.7, fontWeight: "bold" },
    tableRow: { flexDirection: "row", paddingVertical: 8, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: palette.border },
    tableRowLast: { flexDirection: "row", paddingVertical: 8, paddingHorizontal: 10 },
    colIdx: { width: "6%" },
    colDesc: { width: "52%" },
    colQty: { width: "12%", textAlign: "right" },
    colPrice: { width: "15%", textAlign: "right" },
    colAmount: { width: "15%", textAlign: "right" },
    idxCell: { fontSize: 9, color: palette.muted, fontFamily: "Courier" },
    descCell: { fontSize: 10 },
    numCell: { fontSize: 10, fontFamily: "Courier" },
    numCellBold: { fontSize: 10, fontFamily: "Courier", fontWeight: "bold" },

    totalsWrap: { flexDirection: "row", justifyContent: "flex-end", marginBottom: 16 },
    totalsBox: { width: "52%", padding: 14, backgroundColor: palette.bgSoft, borderRadius: 6, borderWidth: 1, borderColor: palette.border },
    totalRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
    totalRowLast: { flexDirection: "row", justifyContent: "space-between", paddingTop: 8, marginTop: 4, borderTopWidth: 1, borderTopColor: palette.border },
    totalLabel: { fontSize: 10, color: palette.muted },
    totalLabelBig: { fontSize: 12, fontWeight: "bold", color: palette.text },
    totalValue: { fontSize: 10, fontFamily: "Courier", fontWeight: "bold" },
    totalValueBig: { fontSize: 16, fontFamily: "Courier", fontWeight: "bold", color: palette.primary },

    banner: { padding: 10, borderRadius: 6, marginBottom: 14, borderWidth: 1 },
    bannerText: { fontSize: 9, fontWeight: "bold" },
    bannerSub: { fontSize: 8.5, marginTop: 2, color: "#475569" },

    notesCard: { padding: 12, backgroundColor: palette.bgSoft, borderRadius: 6, borderWidth: 1, borderColor: palette.border, marginBottom: 14 },
    notesLabel: { fontSize: 8, color: palette.muted, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: "bold", marginBottom: 5 },
    notesText: { fontSize: 9.5, color: "#334155" },

    footer: { position: "absolute", bottom: 30, left: 48, right: 48, textAlign: "center", borderTopWidth: 1, borderTopColor: palette.border, paddingTop: 10 },
    footerCompany: { fontSize: 9, fontWeight: "bold", color: palette.muted },
    footerEmail: { fontSize: 8, color: palette.muted, marginTop: 1 },
    footerThanks: { fontSize: 8.5, color: "#94a3b8", marginTop: 4 },
    footerMeta: { flexDirection: "row", justifyContent: "space-between", marginTop: 4, fontSize: 7, color: "#cbd5e1", fontFamily: "Courier" },
    brandLogo: { maxHeight: 56, maxWidth: 170, objectFit: "contain" as const },
  });

  const currency = settings.currency;
  const subtotal = Number(invoice.subtotal);
  // The invoice may carry a discount column (added after initial launch).
  // Tolerate Decimal/number/null safely.
  const discVal = (invoice as unknown as { discountAmount?: unknown }).discountAmount;
  const discountAmount =
    discVal == null
      ? 0
      : typeof discVal === "number"
        ? discVal
        : typeof (discVal as { toNumber?: () => number }).toNumber === "function"
          ? (discVal as { toNumber: () => number }).toNumber()
          : Number(discVal);
  const taxRate = Number(invoice.taxRate);
  const taxLabelInv = (invoice as unknown as { taxLabel?: string | null }).taxLabel;
  const taxLabel = (taxLabelInv && taxLabelInv.trim() ? taxLabelInv : "GST").toUpperCase();
  const net = Math.max(0, subtotal - (Number.isFinite(discountAmount) ? discountAmount : 0));
  const taxAmount = (net * taxRate) / 100;
  const total = Number(invoice.totalAmount);
  const issueDate = new Date(invoice.issueDate);
  const dueDate = new Date(invoice.dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysOverdue = invoice.status === "PENDING"
    ? Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
    : 0;
  const isOverdue = daysOverdue > 0;
  const companyInitial = (settings.companyName || "S").charAt(0).toUpperCase();

  const fmtMoney = (n: number) => {
    try {
      return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n);
    } catch {
      return `${currency} ${n.toFixed(2)}`;
    }
  };
  const fmtDate = (d: Date) => {
    try {
      return new Intl.DateTimeFormat("en-IN", {
        day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Calcutta",
      }).format(d);
    } catch {
      return d.toDateString();
    }
  };

  // The base statusPill style comes from StyleSheet.create which returns
  // typed keys only, so we build a plain style object for the status color.
  const basePill: Record<string, unknown> = {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
    fontSize: 8,
    fontWeight: "bold",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  };
  let statusPillStyle: Record<string, unknown> = { ...basePill, backgroundColor: "#e2e8f0", color: "#64748b" };
  let statusLabel = "Draft";
  if (invoice.status === "VOID") { statusPillStyle = { ...basePill, backgroundColor: "#e2e8f0", color: "#475569" }; statusLabel = "Void"; }
  else if (isOverdue) { statusPillStyle = { ...basePill, backgroundColor: palette.overdueBg, color: palette.overdueText }; statusLabel = "Overdue"; }
  else if (invoice.status === "PAID") { statusPillStyle = { ...basePill, backgroundColor: palette.paid, color: palette.paidText }; statusLabel = "Paid"; }
  else if (invoice.status === "PENDING") { statusPillStyle = { ...basePill, backgroundColor: palette.warningBg, color: palette.warning }; statusLabel = "Pending"; }

  const banner = (() => {
    if (invoice.status === "PAID") {
      return (
        React.createElement(View, { style: [styles.banner, { backgroundColor: palette.paid, borderColor: "#86efac" }], key: "banner" },
          React.createElement(Text, { style: [styles.bannerText, { color: palette.paidText }] }, "Payment Received — Thank you for your business!")
        )
      );
    }
    if (isOverdue) {
      return (
        React.createElement(View, { style: [styles.banner, { backgroundColor: palette.overdueBg, borderColor: palette.overdueBorder }], key: "banner" },
          React.createElement(Text, { style: [styles.bannerText, { color: palette.overdueText }] },
            `Payment Overdue — ${daysOverdue} day${daysOverdue !== 1 ? "s" : ""} past due`
          )
        )
      );
    }
    if (invoice.status === "VOID") {
      return (
        React.createElement(View, { style: [styles.banner, { backgroundColor: "#f1f5f9", borderColor: "#94a3b8" }], key: "banner" },
          React.createElement(Text, { style: [styles.bannerText, { color: "#475569" }] }, "Void — This invoice has been cancelled and is not payable")
        )
      );
    }
    if (invoice.status === "PENDING") {
      return (
        React.createElement(View, { style: [styles.banner, { backgroundColor: palette.warningBg, borderColor: palette.warningBorder }], key: "banner" },
          React.createElement(Text, { style: [styles.bannerText, { color: palette.warning }] }, "Payment Pending"),
          React.createElement(Text, { style: styles.bannerSub }, `Due by ${fmtDate(dueDate)}`)
        )
      );
    }
    return (
      React.createElement(View, { style: [styles.banner, { backgroundColor: palette.draftBg, borderColor: palette.border }], key: "banner" },
        React.createElement(Text, { style: [styles.bannerText, { color: "#64748b" }] }, "Draft — This invoice has not been sent to the client.")
      )
    );
  })();

  const clientPhone = "phone" in invoice.client && typeof (invoice.client as { phone?: unknown }).phone === "string"
    ? (invoice.client as { phone: string }).phone
    : null;

  const el = React.createElement(Document, {
    title: `${invoice.invoiceNumber} - ${settings.companyName}`,
    author: settings.companyName,
    subject: `Invoice ${invoice.invoiceNumber} for ${invoice.client.name}`,
  },
    React.createElement(Page, { size: "A4", style: styles.page },
      React.createElement(View, { style: styles.accentBar, fixed: true }),

      // Header — logo or initial badge + brand name, then invoice title block.
      React.createElement(View, { style: styles.header },
        React.createElement(View, { style: styles.brand },
          settings.logoBase64 && settings.logoContentType
            ? React.createElement(Image, {
                key: "logo",
                style: styles.brandLogo,
                src: { data: settings.logoBase64, format: settings.logoContentType === "image/png" ? "png" : settings.logoContentType === "image/webp" ? "png" : "jpg" },
              })
            : React.createElement(View, { key: "mark", style: styles.brandMark },
                React.createElement(Text, { style: styles.brandMarkText }, companyInitial)
              ),
          // When a logo is present we don't repeat "INVOICE" in the brand
          // block; the right-side AMOUNT DUE title already labels the doc.
          settings.logoBase64
            ? null
            : React.createElement(View, { key: "title" },
                React.createElement(Text, { style: styles.brandTitle }, "INVOICE"),
                React.createElement(Text, { style: styles.brandSub }, invoice.invoiceNumber)
              )
        ),
        React.createElement(View, { style: styles.rightBlock },
          React.createElement(View, { style: styles.statusRow },
            React.createElement(View, { style: statusPillStyle },
              React.createElement(Text, null, statusLabel)
            )
          ),
          React.createElement(Text, { style: styles.invoiceTitle }, invoice.status === "PAID" ? "PAID" : invoice.status === "VOID" ? "VOID" : "AMOUNT DUE"),
          React.createElement(Text, { style: styles.invoiceNumber }, invoice.invoiceNumber),
          React.createElement(Text, { style: styles.amountDueLabel }, "Total"),
          React.createElement(Text, { style: styles.amountDue }, fmtMoney(total))
        )
      ),

      // Parties
      React.createElement(View, { style: styles.parties },
        React.createElement(View, { style: styles.partyCard },
          React.createElement(Text, { style: styles.partyLabel }, "From"),
          React.createElement(Text, { style: styles.partyName }, settings.companyName),
          settings.companyEmail
            ? React.createElement(Link, { src: `mailto:${settings.companyEmail}`, style: styles.partyLink }, settings.companyEmail)
            : null,
          settings.companyPhone
            ? React.createElement(Text, { style: styles.partyLine }, settings.companyPhone)
            : null,
          settings.companyAddress
            ? React.createElement(Text, { style: styles.partyLine }, settings.companyAddress)
            : null
        ),
        React.createElement(View, { style: [styles.partyCard, styles.partyCardBillTo] },
          React.createElement(Text, { style: [styles.partyLabel, styles.partyLabelBillTo] }, "Bill To"),
          React.createElement(Text, { style: styles.partyName }, invoice.client.name),
          invoice.client.email
            ? React.createElement(Link, { src: `mailto:${invoice.client.email}`, style: styles.partyLink }, invoice.client.email)
            : null,
          clientPhone
            ? React.createElement(Text, { style: styles.partyLine }, clientPhone)
            : null,
          invoice.client.address
            ? React.createElement(Text, { style: styles.partyLine }, invoice.client.address)
            : null
        )
      ),

      // Meta
      React.createElement(View, { style: styles.meta },
        React.createElement(View, { style: styles.metaCell },
          React.createElement(Text, { style: styles.metaLabel }, "Issue Date"),
          React.createElement(Text, { style: styles.metaValue }, fmtDate(issueDate))
        ),
        React.createElement(View, { style: styles.metaCell },
          React.createElement(Text, { style: styles.metaLabel }, "Due Date"),
          React.createElement(Text, { style: styles.metaValue }, fmtDate(dueDate))
        ),
        React.createElement(View, { style: styles.metaCellLast },
          React.createElement(Text, { style: styles.metaLabel }, taxLabel),
          React.createElement(Text, { style: styles.metaValue }, `${taxRate}%`)
        )
      ),

      // Table
      React.createElement(View, { style: styles.table },
        React.createElement(View, { style: styles.tableHeader },
          React.createElement(View, { style: styles.colIdx }, React.createElement(Text, { style: styles.tableHeaderCell }, "#")),
          React.createElement(View, { style: styles.colDesc }, React.createElement(Text, { style: styles.tableHeaderCell }, "Description")),
          React.createElement(View, { style: styles.colQty }, React.createElement(Text, { style: styles.tableHeaderCell }, "Qty")),
          React.createElement(View, { style: styles.colPrice }, React.createElement(Text, { style: styles.tableHeaderCell }, "Unit Price")),
          React.createElement(View, { style: styles.colAmount }, React.createElement(Text, { style: styles.tableHeaderCell }, "Amount"))
        ),
        ...invoice.items.map((it, i) =>
          React.createElement(View, { key: it.id, style: i === invoice.items.length - 1 ? styles.tableRowLast : styles.tableRow },
            React.createElement(View, { style: styles.colIdx }, React.createElement(Text, { style: styles.idxCell }, String(i + 1))),
            React.createElement(View, { style: styles.colDesc }, React.createElement(Text, { style: styles.descCell }, it.description)),
            React.createElement(View, { style: styles.colQty }, React.createElement(Text, { style: styles.numCell }, String(it.quantity))),
            React.createElement(View, { style: styles.colPrice }, React.createElement(Text, { style: styles.numCell }, fmtMoney(Number(it.price)))),
            React.createElement(View, { style: styles.colAmount }, React.createElement(Text, { style: styles.numCellBold }, fmtMoney(Number(it.total))))
          )
        )
      ),

      // Totals
      React.createElement(View, { style: styles.totalsWrap },
        React.createElement(View, { style: styles.totalsBox },
          React.createElement(View, { style: styles.totalRow },
            React.createElement(Text, { style: styles.totalLabel }, "Subtotal"),
            React.createElement(Text, { style: styles.totalValue }, fmtMoney(subtotal))
          ),
          discountAmount > 0
            ? React.createElement(View, { key: "disc", style: styles.totalRow },
                React.createElement(Text, { style: [styles.totalLabel, { color: "#059669" }] }, "Discount"),
                React.createElement(Text, { style: [styles.totalValue, { color: "#059669" }] }, `−${fmtMoney(discountAmount)}`)
              )
            : null,
          React.createElement(View, { style: styles.totalRow },
            React.createElement(Text, { style: styles.totalLabel }, `${taxLabel} (${taxRate}%)`),
            React.createElement(Text, { style: styles.totalValue }, fmtMoney(taxAmount))
          ),
          React.createElement(View, { style: styles.totalRowLast },
            React.createElement(Text, { style: styles.totalLabelBig }, "Total Due"),
            React.createElement(Text, { style: styles.totalValueBig }, fmtMoney(total))
          )
        )
      ),

      banner,

      invoice.notes
        ? React.createElement(View, { style: styles.notesCard, key: "notes" },
            React.createElement(Text, { style: styles.notesLabel }, "Notes / Terms"),
            React.createElement(Text, { style: styles.notesText }, invoice.notes)
          )
        : null,

      // Footer
      React.createElement(View, { style: styles.footer, fixed: true },
        React.createElement(Text, { style: styles.footerCompany }, settings.companyName),
        settings.companyEmail ? React.createElement(Text, { style: styles.footerEmail }, settings.companyEmail) : null,
        React.createElement(Text, { style: styles.footerThanks }, "Thank you for your business!"),
        React.createElement(View, { style: styles.footerMeta },
          React.createElement(Text, null, invoice.invoiceNumber),
          React.createElement(Text, null, new Date().toISOString().slice(0, 10))
        )
      )
    )
  );

  return renderToBuffer(el);
}
