import { PrismaClient } from "@prisma/client";

/**
 * PrismaClient is attached to the `global` object in development to prevent
 * exhausting the database connection limit from hot-module reloads
 * (Next.js dev server recompiles files on every change, which would otherwise
 * create a new PrismaClient instance each time).
 *
 * In production, a single PrismaClient instance is created and reused for
 * the lifetime of the serverless function / Node process.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
