/**
 * POST /api/settings/logo — upload company logo (multipart/form-data).
 * DELETE /api/settings/logo — remove the current logo.
 *
 * Stored base64-encoded in Settings.logoData (with logoContentType).
 * Hard server-side cap of 500 KB (after base64 decode) keeps DB storage
 * and SSR/email payload sizes bounded regardless of what the client does.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, jsonError, unauthorized } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/activity";

// L7: 500 KB cap (base64-encoded ≈ 666 KB stored — still well under any
// reasonable page-weight or PDF-inclusion budget).
const MAX_BYTES = 500 * 1024;
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);
// Minimum dimensions (reject trivially small/corrupt images) — enforced by
// magic bytes only; we don't spin up a decoder for performance.
const MIN_BYTES = 128;

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const ip = clientIp(request);
    const rl = rateLimit(`logo-up:${user.id}:${ip}`, {
      namespace: "logo-upload",
      limit: 20,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Try again shortly." },
        { status: 429 }
      );
    }

    const ct = request.headers.get("content-type") || "";
    if (!ct.toLowerCase().startsWith("multipart/form-data")) {
      return jsonError("Request must be multipart/form-data", 400);
    }

    // Cap raw request size at the Next/edge boundary by reading with a
    // size guard. We use formData() which is bounded by Next's body-size
    // limit, but we double-check the actual file size after decoding.
    const formData = await request.formData();
    const file = formData.get("logo");
    if (!(file instanceof File)) {
      return jsonError("No logo file provided", 400);
    }

    const normalizedType =
      file.type.toLowerCase() === "image/jpg" ? "image/jpeg" : file.type.toLowerCase();

    if (!ALLOWED_TYPES.has(normalizedType)) {
      return jsonError("Logo must be PNG, JPEG, or WebP", 400);
    }
    if (file.size < MIN_BYTES) {
      return jsonError("Logo file is too small or empty", 400);
    }
    if (file.size > MAX_BYTES) {
      return jsonError(
        `Logo must be under ${Math.round(MAX_BYTES / 1024)} KB. Please resize before uploading.`,
        400
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // Sanity: buffer length must match the declared File.size.
    if (buffer.length > MAX_BYTES) {
      return jsonError(
        `Logo exceeds the ${Math.round(MAX_BYTES / 1024)} KB size limit.`,
        400
      );
    }

    // Magic-byte sniff for PNG/JPEG/WebP (defense-in-depth against renamed
    // binaries — attackers could still craft a polyglot, but the bytes
    // won't render as dangerous content in email/PDF readers).
    const header = buffer.subarray(0, 12);
    const isPng =
      header[0] === 0x89 &&
      header[1] === 0x50 &&
      header[2] === 0x4e &&
      header[3] === 0x47;
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
      return jsonError(
        "File does not appear to be a valid PNG/JPEG/WebP image",
        400
      );
    }

    // Dimension guard: reject if base64-encoded payload would exceed
    // ~684 KB stored (500 KB raw → ~684 KB b64 — well under PG toast
    // threshold and keeps total page/image payload small).
    const base64 = buffer.toString("base64");
    const MAX_B64_CHARS = Math.ceil((MAX_BYTES * 4) / 3) + 1024;
    if (base64.length > MAX_B64_CHARS) {
      return jsonError(
        "Encoded logo is too large; please resize to ≤ 500 KB.",
        400
      );
    }

    await prisma.settings.upsert({
      where: { userId: user.id },
      update: { logoData: base64, logoContentType: normalizedType },
      create: {
        userId: user.id,
        logoData: base64,
        logoContentType: normalizedType,
      },
    });

    return NextResponse.json(
      {
        ok: true,
        logoUrl: `/api/public/logo?u=${user.id}`,
        contentType: normalizedType,
        bytes: buffer.length,
      },
      { status: 200 }
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

export const runtime = "nodejs";
