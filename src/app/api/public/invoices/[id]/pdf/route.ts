import { NextResponse } from "next/server";
import { jsonError, getPrismaErrorCode } from "@/lib/api-helpers";
import { loadInvoiceForPdf, renderInvoicePdfToBuffer } from "@/lib/pdf";
import { checkRateLimit, requestKey } from "@/lib/rate-limiter";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/public/invoices/:id/pdf
 *
 * Public PDF endpoint (CUID-protected) so clients who have the /view/:id
 * link can download a PDF without logging in. Same rate-limit policy as
 * the public HTML view (60/min/IP) to prevent CUID scanning and to
 * protect against PDF-render CPU abuse.
 */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;

    const rl = await checkRateLimit(requestKey(request), {
      namespace: "public:get-invoice-pdf",
      limit: 30,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return rl.toResponse('Too many requests — please try again later.');
    }

    let data;
    try {
      data = await loadInvoiceForPdf(id); // no userId → public
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return jsonError("Invoice not found", 404);
      throw err;
    }

    const buffer = await renderInvoicePdfToBuffer(data);
    const body = new Uint8Array(new Uint8Array(buffer).buffer.slice(0));

    return new NextResponse(body as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${data.filename}"; filename*=UTF-8''${encodeURIComponent(data.filename)}`,
        "Content-Length": String(body.byteLength),
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2025" || getPrismaErrorCode(error) === "P2016") {
      return jsonError("Invoice not found", 404);
    }
    console.error("[GET /api/public/invoices/:id/pdf] Failed:", error);
    return jsonError("Failed to generate PDF", 500);
  }
}
