import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import crypto from "node:crypto";

/**
 * Standard shape for API error responses.
 */
export interface ApiError {
  error: string;
  details?: Array<{ field: string; message: string }>;
}

// ============================================================
// AUTH HELPERS
// ============================================================

/**
 * Constant-time string comparison to mitigate timing attacks.
 * Use for shared-secret comparisons (CRON_SECRET, webhook tokens).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Require an authenticated NextAuth session AND:
 *   1. Verify the user still exists in the database (catches stale JWTs
 *      after DB resets / account deletion).
 *   2. Verify the JWT's sessionVersion matches the current row's value
 *      so password-changes / sign-out-everywhere can revoke outstanding
 *      JWTs (stateless JWT cannot otherwise be revoked).
 *
 * Returns the session user on success, or `null` on failure. Handlers
 * should early-return `unauthorized()` when this returns null.
 */
export async function requireUser() {
  try {
    const session = await auth();
    if (!session?.user?.id) return null;
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, sessionVersion: true },
    });
    if (!user) return null;
    // JWT sessionVersion mismatch → token was revoked; force sign-in.
    if (
      typeof (session.user as { sessionVersion?: number }).sessionVersion ===
        "number" &&
      (session.user as { sessionVersion: number }).sessionVersion !==
        user.sessionVersion
    ) {
      return null;
    }
    return session.user;
  } catch {
    return null;
  }
}

/**
 * Standard 401 response used when requireUser() fails.
 */
export function unauthorized() {
  return NextResponse.json<ApiError>(
    { error: "Unauthorized — please sign in." },
    { status: 401 }
  );
}

// ============================================================
// VALIDATION / ERROR HELPERS
// ============================================================

/**
 * Format a Zod validation error into a consistent JSON response shape.
 * Works with both Zod v3 (.errors) and Zod v4 (.issues) by normalizing.
 */
export function formatZodError(error: ZodError) {
  const issues = (error.issues ??
    (error as unknown as { errors: unknown[] }).errors) as Array<{
    path: Array<string | number | symbol>;
    message: string;
  }>;
  return issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
}

/**
 * Common error-response helper so all routes return consistent shapes.
 */
export function validationErrorResponse(error: ZodError, status = 400) {
  return NextResponse.json<ApiError>(
    {
      error: "Validation failed",
      details: formatZodError(error),
    },
    { status }
  );
}

export function jsonError(message: string, status: number) {
  return NextResponse.json<ApiError>({ error: message }, { status });
}

/**
 * Detect Prisma error codes in a type-safe way.
 */
export function getPrismaErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code: string }).code;
  }
  return null;
}
