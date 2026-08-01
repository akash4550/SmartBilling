import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { prisma } from "@/lib/prisma";
import { jsonError, validationErrorResponse, getPrismaErrorCode } from "@/lib/api-helpers";
import { checkRateLimit, requestKey } from "@/lib/rate-limiter";

const registerSchema = z.object({
  name: z
    .string({ message: "Name is required" })
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name must be at most 100 characters"),
  email: z
    .string({ message: "Email is required" })
    .trim()
    .email("Please enter a valid email address")
    .max(255, "Email must be at most 255 characters")
    .transform((s) => s.toLowerCase()),
  password: z
    .string({ message: "Password is required" })
    .min(8, "Password must be at least 8 characters")
    .max(100, "Password must be at most 100 characters"),
});

/**
 * POST /api/register
 *
 * Public endpoint for creating a new account. Does NOT auto-sign-in — the
 * client should redirect to /login with the new credentials after success,
 * or call signIn() directly.
 */
export async function POST(request: Request) {
  try {
    // 5 sign-ups per IP per minute is generous for humans but blocks
    // automated account spam.
    const rl = await checkRateLimit(requestKey(request), {
      namespace: "register",
      limit: 5,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return rl.toResponse('Too many sign-up attempts — please try again later.');
    }

    const body = await request.json();
    const validated = registerSchema.parse(body);

    // Lazy-load argon2 for the same reason as in auth.ts.
    const argon2 = (await import("argon2")).default;
    const passwordHash = await argon2.hash(validated.password, { type: 2 }); // argon2id

    const user = await prisma.user.create({
      data: {
        name: validated.name,
        email: validated.email,
        passwordHash,
        // Auto-provision default settings for this user
        settings: { create: {} },
      },
      select: { id: true, email: true, name: true },
    });

    return NextResponse.json(
      { success: true, user },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return validationErrorResponse(error);
    }
    if (error instanceof SyntaxError) {
      return jsonError("Invalid JSON payload", 400);
    }
    if (getPrismaErrorCode(error) === "P2002") {
      return jsonError("An account with this email already exists", 409);
    }
    console.error("[POST /api/register] Failed:", error);
    return jsonError("Failed to create account", 500);
  }
}
