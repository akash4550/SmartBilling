import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { prisma } from "@/lib/prisma";
import { settingsSchema } from "@/lib/validations";
import {
  validationErrorResponse,
  jsonError,
  requireUser,
  unauthorized,
} from "@/lib/api-helpers";
import { getBrandingForUser } from "@/lib/branding";
import { getPrismaErrorCode } from "@/lib/api-helpers";

/**
 * Helper that returns the current user's settings row, creating it with
 * defaults if it doesn't yet exist.
 *
 * Any FK violation (P2003) is treated as "user no longer exists" and returns
 * null so callers can bail out with a 401 instead of throwing.
 */
export async function getSettingsForUser(userId: string) {
  try {
    return await prisma.settings.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
  } catch (err) {
    if (getPrismaErrorCode(err) === "P2003") {
      console.error("[getSettingsForUser] FK violation — user does not exist:", userId);
      return null;
    }
    throw err;
  }
}

/** GET /api/settings — fetch current user's settings (creating defaults if needed). */
export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const settings = await getSettingsForUser(user.id);
    if (!settings) return unauthorized();
    const { logoUrl, brandColor } = await getBrandingForUser(user.id);
    // Don't leak raw base64 to the list view — the logo URL is enough for
    // rendering previews; uploads go through the dedicated /logo endpoint.
    const { logoData: _omit, logoContentType: _omit2, ...rest } = settings;
    void _omit; void _omit2;
    return NextResponse.json(
      { ...rest, hasLogo: !!settings.logoData, logoUrl, brandColor: settings.brandColor || brandColor },
      { status: 200 },
    );
  } catch (error) {
    console.error("[GET /api/settings]", error);
    return jsonError("Failed to load settings", 500);
  }
}

/** PATCH /api/settings — update current user's settings. */
export async function PATCH(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const body = await request.json();
    // logoData/logoContentType are NOT writable through this route — use
    // POST /api/settings/logo for uploads. Strip them just in case.
    const { logoData, logoContentType, ...allowed } = body ?? {};
    void logoData; void logoContentType;

    const validated = settingsSchema.partial().parse(allowed);

    if (Object.keys(validated).length === 0) {
      return jsonError("No fields to update", 400);
    }

    let updated;
    try {
      updated = await prisma.settings.upsert({
        where: { userId: user.id },
        update: validated,
        create: { userId: user.id, ...validated },
      });
    } catch (err) {
      if (getPrismaErrorCode(err) === "P2003") return unauthorized();
      throw err;
    }

    const { logoUrl, brandColor } = await getBrandingForUser(user.id);
    const { logoData: _o, logoContentType: _o2, ...rest } = updated;
    void _o; void _o2;
    return NextResponse.json(
      { ...rest, hasLogo: !!updated.logoData, logoUrl, brandColor: updated.brandColor || brandColor },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    if (error instanceof SyntaxError) return jsonError("Invalid JSON payload", 400);
    console.error("[PATCH /api/settings]", error);
    return jsonError("Failed to update settings", 500);
  }
}
