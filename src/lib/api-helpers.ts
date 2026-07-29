import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { auth } from "@/lib/auth";

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
 * Require an authenticated NextAuth session. Returns the session user on
 * success, or `null` if the caller is unauthenticated. Handlers should
 * early-return `unauthorized()` when this returns null.
 *
 * Usage (at the very top of a protected handler):
 *   const user = await requireUser();
 *   if (!user) return unauthorized();
 */
export async function requireUser() {
  try {
    const session = await auth();
    if (!session?.user) return null;
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
  const issues = (error.issues ?? (error as unknown as { errors: unknown[] }).errors) as Array<{
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
