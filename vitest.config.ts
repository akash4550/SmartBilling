import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest config for SmartBill server-side integration tests.
 *
 * Mirrors tsconfig's "@/*" path alias so tests can import source modules
 * via the same absolute imports the runtime uses. tests run in a Node
 * environment (no jsdom) because we execute real Prisma / Postgres code.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Tests run in a pure Node server context — Next.js's `server-only`
      // package throws on import as a client-boundary guard, which is
      // meaningless (and actively breaks) under vitest. Alias it to a
      // no-op shim.
      "server-only": path.resolve(__dirname, "./test/_server-only-shim.ts"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Single worker: each test mutates the same DB and the reconciler
    // uses per-tenant advisory locks — parallel workers would contend.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
