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

/**
 * Helper that returns the current user's settings row, creating it with
 * defaults if it doesn't yet exist.
 */
export async function getSettingsForUser(userId: string) {
  return prisma.settings.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
}

/** GET /api/settings — fetch current user's settings (creating defaults if needed). */
export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const settings = await getSettingsForUser(user.id);
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

    const updated = await prisma.settings.upsert({
      where: { userId: user.id },
      update: validated,
      create: { userId: user.id, ...validated },
    });

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
