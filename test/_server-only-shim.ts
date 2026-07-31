/**
 * No-op shim for Next.js's `server-only` package in vitest.
 *
 * In Next.js runtime, `import "server-only"` throws when a module
 * marked server-only accidentally ends up in a client bundle. Under
 * vitest we run in a pure Node (server) context so the guard is
 * irrelevant — re-exporting an empty module keeps imports intact and
 * avoids the runtime-throw while still letting Next's own build
 * enforce the boundary in production.
 */
export {};
