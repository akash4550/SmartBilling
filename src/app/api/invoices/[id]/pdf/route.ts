import { NextResponse } from "next/server";
import {
  jsonError,
  requireUser,
  unauthorized,
  getPrismaErrorCode,
} from "@/lib/api-helpers";
import { loadInvoiceForPdf, renderInvoicePdfToBuffer } from "@/lib/pdf";
import { logActivity, clientIp } from "@/lib/activity";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/invoices/:id/pdf
 *
 * Authenticated (must own the invoice) — returns an `application/pdf`
 * response with Content-Disposition: attachment so the browser downloads
 * a branded PDF of the invoice.
 */
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const { id } = await params;

    let data;
    try {
      data = await loadInvoiceForPdf(id, user.id);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return jsonError("Invoice not found", 404);
      throw err;
    }

    const buffer = await renderInvoicePdfToBuffer(data);
    // Copy into a fresh ArrayBuffer-backed Uint8Array to satisfy Next 16's
    // strict BodyInit typing (which doesn't accept Buffer or offset views
    // of shared ArrayBuffers).
    const body = new Uint8Array(new Uint8Array(buffer).buffer.slice(0));

    logActivity({
      invoiceId: id,
      userId: user.id,
      type: "PDF_DOWNLOADED",
      message: "PDF downloaded by admin",
      ip: clientIp(_request),
    });

    return new NextResponse(body as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${data.filename}"; filename*=UTF-8''${encodeURIComponent(data.filename)}`,
        "Content-Length": String(body.byteLength),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2025" || getPrismaErrorCode(error) === "P2016") {
      return jsonError("Invoice not found", 404);
    }
    console.error("[GET /api/invoices/:id/pdf] Failed:", error);
    return jsonError("Failed to generate PDF", 500);
  }
}
