/**
 * GET/POST /api/cron/reconcile-ledger
 *
 * Alias for /api/cron/reconcile. Exposed under the canonical name used in
 * the reconciler mandate so external scheduler configs (and the original
 * vercel.json cron entry at this path) keep working.
 *
 * Route-segment config must be defined locally: Next.js cannot statically
 * analyze re-exported config values, and `dynamic` is required to prevent
 * static rendering of the handler.
 */
export { GET, POST } from "../reconcile/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
