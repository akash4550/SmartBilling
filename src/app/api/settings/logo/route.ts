/**
 * POST /api/settings/logo — upload company logo (multipart/form-data).
 * DELETE /api/settings/logo — remove the current logo.
 *
 * Stored base64-encoded in Settings.logoData (with logoContentType). This
 * keeps the app stateless (works on Vercel serverless, no S3/Blob required)
 * while still letting email clients and PDFs render the image. A hard cap
 * of 2 MB is enforced on the request body; we expect the client to resize
 * before uploading for best results.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, jsonError, unauthorized } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/activity";

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    // Rate limit logo uploads per user (not a public endpoint, but abuse-
    // prevention against runaway client retries).
    const ip = clientIp(request);
    const rl = rateLimit(`logo-up:${user.id}:${ip}`, {
      namespace: "logo-upload",
      limit: 20,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }

    const ct = request.headers.get("content-type") || "";
    if (!ct.toLowerCase().startsWith("multipart/form-data")) {
      return jsonError("Request must be multipart/form-data", 400);
    }

    const formData = await request.formData();
    const file = formData.get("logo");
    if (!(file instanceof File)) {
      return jsonError("No logo file provided", 400);
    }

    if (!ALLOWED_TYPES.has(file.type.toLowerCase())) {
      return jsonError("Logo must be PNG, JPEG, or WebP", 400);
    }
    if (file.size === 0) {
      return jsonError("Logo file is empty", 400);
    }
    if (file.size > MAX_BYTES) {
      return jsonError(`Logo must be under ${Math.round(MAX_BYTES / 1024 / 1024)} MB. Please resize before uploading.`, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const base64 = buffer.toString("base64");

    // Validate it actually looks like an image (magic-byte sniff on the
    // first few bytes). Quick safety net — not a full decoder.
    const header = buffer.subarray(0, 12);
    const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47;
    const isJpeg = header[0] === 0xff && header[1] === 0xd8;
    const isWebp =
      header[0] === 0x52 &&
      header[1] === 0x49 &&
      header[2] === 0x46 &&
      header[3] === 0x46 &&
      header[8] === 0x57 &&
      header[9] === 0x45 &&
      header[10] === 0x42 &&
      header[11] === 0x50;
    if (!isPng && !isJpeg && !isWebp) {
      return jsonError("File does not appear to be a valid PNG/JPEG/WebP image", 400);
    }

    // Sanity: cap stored payload at ~1 MB base64. Client-side canvas
    // resize should already have brought this well under.
    if (base64.length > (1024 * 1024 * 4) / 3 + 1024) {
      return jsonError("Encoded logo is too large after upload; please resize and try again.", 400);
    }

    const normalizedType =
      file.type.toLowerCase() === "image/jpg" ? "image/jpeg" : file.type.toLowerCase();

    await prisma.settings.upsert({
      where: { userId: user.id },
      update: { logoData: base64, logoContentType: normalizedType },
      create: { userId: user.id, logoData: base64, logoContentType: normalizedType },
    });

    return NextResponse.json(
      { ok: true, logoUrl: `/api/public/logo?u=${user.id}`, contentType: normalizedType, bytes: buffer.length },
      { status: 200 },
    );
  } catch (error) {
    console.error("[POST /api/settings/logo]", error);
    return jsonError("Failed to upload logo", 500);
  }
}

export async function DELETE() {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    await prisma.settings.upsert({
      where: { userId: user.id },
      update: { logoData: null, logoContentType: null },
      create: { userId: user.id },
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("[DELETE /api/settings/logo]", error);
    return jsonError("Failed to remove logo", 500);
  }
}

// Prevent Next from trying to parse the body as JSON on this route.
export const runtime = "nodejs";
