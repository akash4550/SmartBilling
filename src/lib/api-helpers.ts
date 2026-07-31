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
 * Per-process random key used by safeCompareSecrets() to fold the two
 * inputs into equal-length HMAC digests before invoking
 * crypto.timingSafeEqual(). This guarantees we never (a) throw a
 * RangeError because Buffer byte lengths differ, or (b) leak the
 * expected secret's length via an early-return timing branch.
 *
 * A fresh nonce is generated on module load; we only need it to be
 * stable for the lifetime of the process because no comparison result
 * is ever persisted or compared across restarts.
 */
const SAFE_COMPARE_KEY: Buffer = (() => {
  try {
    return crypto.randomBytes(32);
  } catch {
    // Extremely defensive: entropy-starved environments (testing
    // sandboxes without /dev/urandom). Falling back to a zero-filled
    // buffer still gives us equal-length digests for comparison; the
    // comparison result is never used for persistent MAC verification.
    return Buffer.alloc(32, 0);
  }
})();

/** Empty buffer reused for the "no expected secret" fast-path. */
const EMPTY = Buffer.alloc(0);

function toSecretBuffer(s: unknown): Buffer {
  // Accept only non-empty strings. Null / undefined / number / object
  // are treated as empty → comparison will fail. Empty strings also
  // fail: a bare "Authorization: Bearer " header must never match a
  // set secret, and vice versa.
  if (typeof s !== "string") return EMPTY;
  const trimmed = s; // do NOT trim — secrets can legitimately contain
  // leading/trailing whitespace; trimming would mask configuration bugs.
  if (trimmed.length === 0) return EMPTY;
  return Buffer.from(trimmed, "utf8");
}

/**
 * Timing-safe string comparison for shared secrets (CRON_SECRET,
 * webhook tokens, HMAC signatures).
 *
 * Why not `crypto.timingSafeEqual(a, b)` directly? Because it
 * (a) throws `RangeError` when the two buffers have different byte
 * lengths, turning a bad/short attacker probe into a 500 instead of a
 * clean 401, and (b) the obvious `if (a.length !== b.length) return false`
 * short-circuit leaks the secret's byte length via a timing
 * side-channel.
 *
 * This implementation:
 *   1. Returns `false` for null / undefined / empty / non-string input.
 *   2. Converts both inputs to UTF-8 Buffers.
 *   3. HMAC-SHA256s each with a per-process random key so both digests
 *      are always exactly 32 bytes — length mismatch cannot occur and
 *      the comparison does not branch on the input length.
 *   4. Compares the two digests with crypto.timingSafeEqual inside a
 *      try/catch as a final guard against unexpected throw modes.
 *
 * IMPORTANT: this is intended for bearer-token / shared-secret
 * equality only. It does NOT replace HMAC signature verification
 * against webhook payloads (those should use the provider-specific
 * HMAC computed over the raw body, compared per-provider).
 */
export function safeCompareSecrets(
  provided: unknown,
  expected: unknown
): boolean {
  const a = toSecretBuffer(provided);
  const b = toSecretBuffer(expected);
  // If either side was empty, comparison fails. Explicit branch is
  // safe here: it only tells the attacker "you sent nothing" vs
  // "something", which is not a secret.
  if (a === EMPTY || b === EMPTY) return false;
  try {
    const ha = crypto.createHmac("sha256", SAFE_COMPARE_KEY).update(a).digest();
    const hb = crypto.createHmac("sha256", SAFE_COMPARE_KEY).update(b).digest();
    // Both digests are exactly 32 bytes by construction;
    // timingSafeEqual cannot throw RangeError, but we keep the guard
    // belt-and-braces in case of unexpected runtime behavior.
    return crypto.timingSafeEqual(ha, hb);
  } catch {
    return false;
  }
}

/**
 * Backwards-compatible alias. New code should prefer `safeCompareSecrets`
 * which accepts unknown/null/undefined safely, but this export keeps
 * existing call sites working.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  return safeCompareSecrets(a, b);
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
