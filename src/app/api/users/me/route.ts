import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { prisma } from "@/lib/prisma";
import { accountSchema } from "@/lib/validations";
import {
  validationErrorResponse,
  jsonError,
  requireUser,
  unauthorized,
  getPrismaErrorCode,
} from "@/lib/api-helpers";

/**
 * GET /api/users/me
 *
 * Returns the current user's profile (id, name, email, createdAt/updatedAt).
 * Does NOT return the password hash. Used by the Account Settings page to
 * hydrate the form.
 */
export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const record = await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, name: true, email: true, createdAt: true, updatedAt: true },
    });
    if (!record) return unauthorized();
    return NextResponse.json(record, { status: 200 });
  } catch (error) {
    console.error("[GET /api/users/me] Failed:", error);
    return jsonError("Failed to load account", 500);
  }
}

/**
 * PATCH /api/users/me
 *
 * Update profile (name/email) and/or change password. Rules:
 *  - To change password, currentPassword must match the stored argon2id hash.
 *  - Email changes are rejected if another (non-deleted) user already uses
 *    that email (case-insensitive).
 *  - Name/email changes update the JWT token via NextAuth's built-in
 *    session mechanics; callers should trigger a client-side session
 *    refresh (or sign-in-again) after a successful PATCH.
 */
export async function PATCH(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const body = await request.json();
    const validated = accountSchema.parse(body);

    const existing = await prisma.user.findUnique({ where: { id: user.id } });
    if (!existing) return unauthorized();

    const data: {
      name?: string;
      email?: string;
      passwordHash?: string;
    } = {};

    let changingPassword = false;
    if (validated.newPassword) {
      changingPassword = true;
      if (!validated.currentPassword) {
        return jsonError("Current password is required", 400);
      }
      // Verify current password
      const argon2 = (await import("argon2")).default;
      const ok = await argon2.verify(existing.passwordHash, validated.currentPassword);
      if (!ok) {
        return NextResponse.json(
          {
            error: "Current password is incorrect",
            details: [{ field: "currentPassword", message: "Current password is incorrect" }],
          },
          { status: 400 }
        );
      }
      data.passwordHash = await argon2.hash(validated.newPassword);
    }

    if (validated.name && validated.name !== existing.name) {
      data.name = validated.name;
    }

    if (validated.email) {
      const nextEmail = validated.email.toLowerCase().trim();
      if (nextEmail !== existing.email.toLowerCase()) {
        const collision = await prisma.user.findUnique({
          where: { email: nextEmail },
          select: { id: true },
        });
        if (collision) {
          return NextResponse.json(
            {
              error: "An account with that email already exists",
              details: [{ field: "email", message: "An account with that email already exists" }],
            },
            { status: 409 }
          );
        }
        data.email = nextEmail;
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { message: "No changes to save" },
        { status: 200 }
      );
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data,
      select: { id: true, name: true, email: true, createdAt: true, updatedAt: true },
    });

    return NextResponse.json(
      {
        success: true,
        user: updated,
        message: changingPassword
          ? "Profile updated and password changed. Please sign in again."
          : "Profile updated",
        passwordChanged: changingPassword,
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    if (error instanceof SyntaxError) return jsonError("Invalid JSON payload", 400);
    const code = getPrismaErrorCode(error);
    if (code === "P2002") {
      return NextResponse.json(
        {
          error: "An account with that email already exists",
          details: [{ field: "email", message: "An account with that email already exists" }],
        },
        { status: 409 }
      );
    }
    console.error("[PATCH /api/users/me] Failed:", error);
    return jsonError("Failed to update account", 500);
  }
}

/**
 * DELETE /api/users/me
 *
 * Account deletion — requires current password (to prevent accidental /
 * CSRF deletions). Deletes the user and cascades to all their clients,
 * invoices, settings per Prisma relation onDelete: Cascade rules.
 */
export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const body = await request.json().catch(() => ({}));
    const password =
      body && typeof (body as { password?: unknown }).password === "string"
        ? (body as { password: string }).password
        : "";
    if (!password) {
      return jsonError("Please confirm your password to delete your account", 400);
    }

    const existing = await prisma.user.findUnique({ where: { id: user.id } });
    if (!existing) return unauthorized();

    const argon2 = (await import("argon2")).default;
    const ok = await argon2.verify(existing.passwordHash, password);
    if (!ok) {
      return NextResponse.json(
        { error: "Password is incorrect" },
        { status: 400 }
      );
    }

    await prisma.user.delete({ where: { id: user.id } });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2025") {
      return jsonError("Account not found", 404);
    }
    console.error("[DELETE /api/users/me] Failed:", error);
    return jsonError("Failed to delete account", 500);
  }
}
