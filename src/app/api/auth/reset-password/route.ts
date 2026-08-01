import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, requestKey } from "@/lib/rate-limiter";
import { z } from "zod";

const resetSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain an uppercase letter")
    .regex(/[a-z]/, "Password must contain a lowercase letter")
    .regex(/[0-9]/, "Password must contain a number"),
});

/**
 * POST /api/auth/reset-password
 *
 * Consumes a one-use reset token (from /api/auth/forgot-password) and sets a
 * new password using argon2id. The token is single-use: it is cleared on
 * successful reset and rejected if expired.
 */
export async function POST(request: Request) {
  try {
    const rl = await checkRateLimit(requestKey(request), { namespace: "auth:reset", limit: 5, windowSec: 60 * 10 });
    if (!rl.allowed) {
      return rl.toResponse('Too many attempts — try again later.');
    }

    const body = (await request.json().catch(() => ({}))) as { token?: string; password?: string };
    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid request",
          details: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
        },
        { status: 400 }
      );
    }
    const { token, password } = parsed.data;

    // Look up by SHA-256 hash of token (DB stores hashed tokens; plaintext
    // only lives in the reset link emailed to the user).
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await prisma.user.findFirst({
      where: { resetToken: tokenHash, resetTokenExpires: { gt: new Date() } },
    });
    if (!user) {
      return NextResponse.json({ error: "This reset link is invalid or has expired." }, { status: 400 });
    }

    // Hash new password (dynamic import for argon2 native module).
    const argon2Mod = await import("argon2");
    const argon2 = argon2Mod.default ?? argon2Mod;
    const passwordHash = await argon2.hash(password, { type: 2 /* argon2id */ });

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, resetToken: null, resetTokenExpires: null },
    });

    return NextResponse.json({
      success: true,
      message: "Password updated — you can now sign in with your new password.",
    });
  } catch (error) {
    console.error("[reset-password] Failed:", error);
    return NextResponse.json({ error: "Failed to reset password." }, { status: 500 });
  }
}
