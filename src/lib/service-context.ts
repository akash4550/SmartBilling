/**
 * Service-scoped Prisma client wrapper for background workers and system
 * maintenance paths. Mirrors withTenant() but uses `service_role` with a
 * service-name GUC, allowing cross-tenant READ for discovery while
 * requiring app.current_user_id for tenant writes (enforced by RLS WITH
 * CHECK policies in prisma/service-role.sql).
 *
 * Why this exists:
 *   Cron workers (recurring, webhooks, reminders, redrive, cleanup) and
 *   operational admin endpoints previously ran as the database
 *   superuser/owner, which bypasses RLS and violates least-privilege.
 *   service_role is NOINHERIT NOBYPASSRLS — identical security posture
 *   to app_user, except it adds a second policy path (service_name set)
 *   for cross-tenant discovery reads. Tenant-scoped writes from a
 *   service path MUST drop into withTenant(userId, fn, {tx}) which
 *   SETs app.current_user_id for that specific tenant.
 *
 * Service names are free-form strings but the convention is:
 *   "cron:process-webhooks" | "cron:generate-recurring" | "cron:send-reminders"
 *   "cron:redrive-dlq"      | "maint:backfill"          | "admin:dlq"
 *
 * SET LOCAL applies for the life of the transaction only; there is zero
 * risk of leaking the role to subsequent queries on a pooled connection.
 * If SET ROLE fails (role dropped/missing) we throw and the callback
 * does not run.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export class ServiceContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceContextError";
  }
}

const SAFE_SERVICE_NAME_RE = /^[a-z][a-z0-9:-]{1,63}$/;

function assertSafeServiceName(name: string) {
  if (!SAFE_SERVICE_NAME_RE.test(name)) {
    throw new ServiceContextError(
      `withService: invalid service name "${name}" (must match ${SAFE_SERVICE_NAME_RE})`
    );
  }
}

function escapeStringLiteral(s: string): string {
  return s.replace(/'/g, "''").replace(/\\/g, "\\\\");
}

export type PrismaLike = Prisma.TransactionClient | typeof prisma;

async function assertServiceRole(tx: {
  $queryRaw: <T = unknown>(q: TemplateStringsArray, ...p: unknown[]) => Promise<T>;
}) {
  const roleCheck = await tx.$queryRaw<{ current_role: string }[]>`
    SELECT current_user AS current_role
  `;
  if (roleCheck[0]?.current_role !== "service_role") {
    throw new ServiceContextError(
      `Service-context assertion failed: current_role is "${roleCheck[0]?.current_role}", expected "service_role". Aborting.`
    );
  }
  const nameCheck = await tx.$queryRaw<{ v: string | null }[]>`
    SELECT current_setting('app.service_name', true) AS v
  `;
  if (!nameCheck[0]?.v) {
    throw new ServiceContextError(
      `Service-context assertion failed: app.service_name is not set.`
    );
  }
}

async function enterService(
  tx: { $executeRawUnsafe: (q: string) => Promise<unknown> },
  serviceName: string
) {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE service_role`);
  await tx.$executeRawUnsafe(
    `SET LOCAL app.service_name = '${escapeStringLiteral(serviceName)}'`
  );
}

/**
 * Execute `fn` inside a service_role transaction scoped to `serviceName`.
 * Use this for cross-tenant discovery reads (e.g. scanning all due
 * recurring profiles, listing DLQ rows). For per-tenant writes inside
 * the service tx, use withTenant(userId, fn, {tx}) which SETs
 * app.current_user_id on top of the already-active service_role.
 */
export async function withService<T>(
  serviceName: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  txOrOpts?:
    | Prisma.TransactionClient
    | { isolationLevel?: Prisma.TransactionIsolationLevel; tx?: Prisma.TransactionClient }
): Promise<T> {
  assertSafeServiceName(serviceName);

  let existingTx: Prisma.TransactionClient | undefined;
  let isolationLevel: Prisma.TransactionIsolationLevel = "ReadCommitted";
  if (txOrOpts) {
    if (typeof txOrOpts === "object" && "$executeRawUnsafe" in txOrOpts) {
      existingTx = txOrOpts as Prisma.TransactionClient;
    } else if (typeof txOrOpts === "object") {
      const opts = txOrOpts as {
        isolationLevel?: Prisma.TransactionIsolationLevel;
        tx?: Prisma.TransactionClient;
      };
      if (opts.isolationLevel) isolationLevel = opts.isolationLevel;
      if (opts.tx) existingTx = opts.tx;
    }
  }

  if (existingTx) {
    await enterService(existingTx, serviceName);
    await assertServiceRole(existingTx);
    return fn(existingTx);
  }

  return prisma.$transaction(
    async (tx) => {
      await enterService(tx, serviceName);
      await assertServiceRole(tx);
      return fn(tx);
    },
    { isolationLevel }
  );
}
