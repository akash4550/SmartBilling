import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized, jsonError } from "@/lib/api-helpers";
import { getBrandingForUser } from "@/lib/branding";
import { renderClientStatementPdf, buildStatementFilename } from "@/lib/pdf-statement";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/clients/:id/statement
 *
 * Generates a PDF account statement for the client (all invoices sorted by
 * date, with a running balance, total billed, total paid, and amount due).
 * Owner-only; returns a downloadable PDF.
 */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const { id } = await params;

    const client = await prisma.client.findFirst({
      where: { id, userId: user.id },
      include: {
        invoices: {
          orderBy: { issueDate: "asc" },
          include: { items: true },
        },
      },
    });
    if (!client) return jsonError("Client not found", 404);

    const settings = await prisma.settings.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id },
    });

    const url = new URL(request.url);
    const asOf = url.searchParams.get("asOf");
    const asOfDate = asOf ? new Date(asOf) : new Date();

    const branding = await getBrandingForUser(user.id);

    const buffer = await renderClientStatementPdf({
      client,
      settings,
      invoices: client.invoices,
      asOfDate,
      branding: {
        logoBase64: branding.logoData,
        logoContentType: branding.logoContentType,
        brandColor: branding.brandColor,
      },
    });

    const body = new Uint8Array(new Uint8Array(buffer).buffer.slice(0));

    return new NextResponse(body as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${buildStatementFilename(client.name, asOfDate)}"`,
        "Content-Length": String(body.byteLength),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("[GET /api/clients/:id/statement] Failed:", error);
    return jsonError("Failed to generate statement", 500);
  }
}
