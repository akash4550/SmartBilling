/**
 * Runtime environment validation (T3-Env pattern, zod-only — no extra deps).
 *
 * Why this exists:
 *   `process.env` in Node is `Record<string, string | undefined>` — every
 *   access is a stringly-typed maybe. In a billing codebase where a missing
 *   or malformed var can mean "sign webhooks with an empty secret" or
 *   "talk to the wrong Redis database", we cannot rely on callers checking
 *   for undefined. This module is imported ONCE at the top of the server
 *   entry graph; it validates the full env at boot and FAILS FAST with a
 *   structured error rather than letting the process half-run against a
 *   misconfigured environment.
 *
 * Design constraints:
 *   1. `server` schema is NEVER shipped to the client bundle. We enforce
 *      this with `server-only` and by separating the `client` schema so
 *      any code that wants a NEXT_PUBLIC_* var gets only the client
 *      subset.
 *   2. Optional vars (Redis, Stripe secret, cron secret, Temporal) are
 *      modeled as `optional()` and validated when present — missing values
 *      degrade gracefully at runtime (Redis falls back to in-process,
 *      Stripe returns 503, cron routes skip auth only in dev).
 *   3. Required vars (DATABASE_URL, NODE_ENV) are non-optional and fail
 *      the build/boot immediately if missing — there is no coherent
 *      fallback for a missing database connection string.
 *   4. All values are coerced/trimmed and URL vars are validated with
 *      `.url()` to catch the classic postgres:// typo or an Upstash URL
 *      with a trailing space.
 *
 * Usage:
 *   import { env } from "@/env";
 *   const conn = env.DATABASE_URL;           // typed: string
 *   const redisUrl = env.UPSTASH_REDIS_REST_URL; // typed: string | undefined
 */
import "server-only";

import { z } from "zod";

/**
 * URL validator. Uses the WHATWG `URL` constructor (which accepts both
 * `https://` and `postgresql://` schemes) rather than Zod's built-in
 * `.url()` — Zod 4's `.url()` is HTTP-scheme-only and would reject
 * Postgres connection strings.
 */
const isValidUrl = (v: string) => {
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Server-only schema
// ---------------------------------------------------------------------------
//
// Add every secret/connection-string env var used by the server here.
// Variables that are genuinely optional (feature flags, third-party keys
// with graceful degradation) are `.optional()`; everything else is
// required and fails boot.

const serverSchema = z.object({
  // ---- Core runtime ----
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // ---- Database ----
  DATABASE_URL: z
    .string()
    .trim()
    .min(1, "DATABASE_URL must not be empty")
    // Postgres URLs can be `postgresql://` or `postgres://`; the URL
    // constructor accepts both, so a manual refine is sufficient.
    .refine(isValidUrl, "DATABASE_URL must be a valid postgres:// URL"),

  // ---- Auth ----
  AUTH_SECRET: z
    .string()
    .trim()
    .min(32, "AUTH_SECRET must be at least 32 characters (generate with `node -e \"console.log(crypto.randomBytes(32).toString('hex'))\"`)")
    .optional(),
  NEXTAUTH_SECRET: z.string().trim().min(1).optional(),

  // ---- Upstash Redis (optional — graceful in-memory fallback) ----
  // If either is present, BOTH must be present and the URL must parse.
  UPSTASH_REDIS_REST_URL: z
    .string()
    .trim()
    .refine(isValidUrl, "UPSTASH_REDIS_REST_URL must be a valid HTTPS URL")
    .optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().trim().min(1).optional(),

  // ---- Stripe (optional — app boots in "no payments" mode without it) ----
  STRIPE_SECRET_KEY: z
    .string()
    .trim()
    .regex(/^sk_/, "STRIPE_SECRET_KEY must start with sk_")
    .optional(),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .trim()
    .regex(/^whsec_/, "STRIPE_WEBHOOK_SECRET must start with whsec_")
    .optional(),

  // ---- Razorpay (optional) ----
  RAZORPAY_KEY_ID: z.string().trim().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().trim().min(1).optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().trim().min(1).optional(),

  // ---- Email / Resend (optional) ----
  RESEND_API_KEY: z
    .string()
    .trim()
    .regex(/^re_/, "RESEND_API_KEY must start with re_")
    .optional(),
  FROM_EMAIL: z.string().trim().email().optional(),

  // ---- OpenAI (optional, receipt scanning) ----
  OPENAI_API_KEY: z.string().trim().min(1).optional(),

  // ---- Cron auth (optional — enforced only when set in prod) ----
  CRON_SECRET: z.string().trim().min(16).optional(),

  // ---- Temporal (optional — defaults point at local dev server) ----
  TEMPORAL_ADDRESS: z
    .string()
    .trim()
    .regex(/^[a-z0-9.-]+:\d{1,5}$/i, "TEMPORAL_ADDRESS must be host:port")
    .default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().trim().min(1).default("default"),
  TEMPORAL_TASK_QUEUE: z.string().trim().min(1).default("smartbill-webhooks"),

  // ---- Read-only / quarantine overrides (for emergency maintenance) ----
  SMARTBILL_READ_ONLY: z.enum(["1", "0", "true", "false"]).optional(),

  // ---- Resend inbound webhook secret (optional) ----
  RESEND_WEBHOOK_SECRET: z.string().trim().min(1).optional(),

  // ---- Host identifier (used by reconciler for worker id) ----
  HOSTNAME: z.string().optional(),
  COMPUTERNAME: z.string().optional(),

  // ---- Vercel platform-provided (optional; used for canonical URL derivation) ----
  VERCEL_URL: z.string().trim().min(1).optional(),
  VERCEL_PROJECT_PRODUCTION_URL: z.string().trim().min(1).optional(),
  APP_URL: z.string().trim().min(1).optional(),
});

// Cross-field refinements: if one Redis half is set, the other must be too.
const serverSchemaRefined = serverSchema.superRefine((val, ctx) => {
  const hasRedisUrl = Boolean(val.UPSTASH_REDIS_REST_URL);
  const hasRedisToken = Boolean(val.UPSTASH_REDIS_REST_TOKEN);
  if (hasRedisUrl !== hasRedisToken) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set together",
      path: [hasRedisUrl ? "UPSTASH_REDIS_REST_TOKEN" : "UPSTASH_REDIS_REST_URL"],
    });
  }
});

// ---------------------------------------------------------------------------
// Client schema — only NEXT_PUBLIC_* variables allowed here
// ---------------------------------------------------------------------------
//
// The build replaces NEXT_PUBLIC_* at compile time, so these are the only
// env vars that may legally appear in client bundles. Keep this list small;
// client bundles are public.
const clientSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z
    .string()
    .trim()
    .refine(isValidUrl, "NEXT_PUBLIC_SITE_URL must be a valid URL")
    .default("http://localhost:3000"),
  NEXT_PUBLIC_RAZORPAY_KEY_ID: z.string().trim().min(1).optional(),
});

/**
 * Merged shape. The client subset is destructured separately so the
 * exported `env` object carries both server and client keys, but code
 * that is meant to run on the client should only import `clientEnv`
 * below. The `server-only` import at the top of this module prevents
 * any client bundle from importing `env` at build time.
 */
const processEnv = {
  // Spread all of process.env so our schemas can read arbitrary keys;
  // zod filters to the declared shapes.
  ...process.env,

  // Coerce booleans / known defaults here if needed.
};

// ---------------------------------------------------------------------------
// Validate — fail fast on boot
// ---------------------------------------------------------------------------

const _serverParsed = serverSchemaRefined.safeParse(processEnv);
if (!_serverParsed.success) {
  // Format errors into a human-readable block and throw so the process
  // dies immediately (Next.js dev will show the overlay; production will
  // crash the container and alert).
  const errors = _serverParsed.error.flatten().fieldErrors;
  const lines = Object.entries(errors)
    .map(([key, msgs]) => `  - ${key}: ${(msgs ?? []).join("; ")}`)
    .join("\n");
  throw new Error(
    `[env] Invalid/missing server environment variables:\n${lines}\n\n` +
      `Fix the variables above (see .env.example) and restart the server.`
  );
}

const _clientParsed = clientSchema.safeParse(processEnv);
if (!_clientParsed.success) {
  const errors = _clientParsed.error.flatten().fieldErrors;
  const lines = Object.entries(errors)
    .map(([key, msgs]) => `  - ${key}: ${(msgs ?? []).join("; ")}`)
    .join("\n");
  throw new Error(
    `[env] Invalid/missing client (NEXT_PUBLIC_*) environment variables:\n${lines}\n\n` +
      `Client env vars are compiled into the browser bundle; fix .env and rebuild.`
  );
}

/**
 * Validated server environment. Strongly-typed, ready to consume.
 *
 * This MUST NOT be re-exported from a client component or a file that
 * leaks into the client graph. The `server-only` import at the top of
 * this module enforces that at build time.
 */
export const env = {
  ..._serverParsed.data,
  ..._clientParsed.data,
};

/**
 * Client-safe subset. Components may import `clientEnv` explicitly to
 * make the boundary obvious; `env.NEXT_PUBLIC_*` also works from server
 * code and is identical.
 *
 * NOTE: We deliberately do NOT export the full server `env` under a name
 * that looks client-safe; client code should only import `clientEnv` (or
 * destructure the NEXT_PUBLIC_* fields it needs).
 */
export const clientEnv: z.infer<typeof clientSchema> = {
  NEXT_PUBLIC_SITE_URL: _clientParsed.data.NEXT_PUBLIC_SITE_URL,
  NEXT_PUBLIC_RAZORPAY_KEY_ID: _clientParsed.data.NEXT_PUBLIC_RAZORPAY_KEY_ID,
};

/** Convenience type for consumers that want the full shape. */
export type Env = typeof env;
