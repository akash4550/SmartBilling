/**
 * Tenant-isolated Prisma client wrapper using PostgreSQL Row-Level Security.
 *
 * Design:
 *   - The `app_user` Postgres role has NOINHERIT + NOBYPASSRLS and can only
 *     read/write rows where `userId = current_setting('app.current_user_id')`.
 *   - We connect as the superuser (migrations/seeding/public views run as
 *     superuser — the small trusted surface), but every user-facing route
 *     funnels its DB work through `withTenant(userId, fn)`.
 *   - withTenant opens an interactive transaction and runs:
 *         SET LOCAL ROLE app_user;
 *         SET LOCAL app.current_user_id = '<userId>';
 *     then asserts that the role actually changed (fail-closed if SET ROLE
 *     fails, e.g. if the role was dropped) before invoking the callback.
 *   - SET LOCAL rolls back automatically at transaction end, so there is
 *     zero risk of leaking the role/session into subsequent queries.
 *
 * Composability: when already inside a withTenant cb, helpers like
 * markInvoicePaid / logActivity may be called with the outer `tx`
 * (TransactionClient) instead of the global prisma. If the caller passes
 * the tx, we skip opening a nested transaction and just re-SET LOCAL on
 * the existing tx (asserting the same userId). This avoids the P2028
 * "transaction not found" error from nested $transaction calls.
 *
 * Defense-in-depth: even if a future route accidentally omits a
 * `where: { userId }` predicate, RLS filters at the DB level.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantIsolationError";
  }
}

/**
 * Allow-list of characters for the userId before interpolation into SET LOCAL.
 * CUIDs/UUIDs/ULIDs and similar are covered; single quotes and backslashes
 * are rejected so SQL injection is impossible even if the caller is buggy.
 */
const SAFE_USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeUserId(userId: string) {
  if (!SAFE_USER_ID_RE.test(userId)) {
    throw new TenantIsolationError(
      `withTenant: userId failed safety check (suspicious characters)`
    );
  }
}

function escapeStringLiteral(s: string): string {
  return s.replace(/'/g, "''").replace(/\\/g, "\\\\");
}

/** A Prisma client or transaction client. */
export type PrismaLike = Prisma.TransactionClient | PrismaClientTop;
// PrismaClient isn't exported as a type alias cleanly; accept anything with
// $executeRawUnsafe + $queryRaw + the model delegates.
type PrismaClientTop = typeof prisma;

async function assertRoleAndGuc(
  tx: {
    $executeRawUnsafe: (q: string) => Promise<unknown>;
    $queryRaw: <T = unknown>(q: TemplateStringsArray, ...p: unknown[]) => Promise<T>;
  },
  userId: string
) {
  const roleCheck = await tx.$queryRaw<{ current_role: string }[]>`
    SELECT current_user AS current_role
  `;
  const currentRole = roleCheck[0]?.current_role;
  if (currentRole !== "app_user") {
    throw new TenantIsolationError(
      `RLS assertion failed: current_role is "${currentRole}", expected "app_user". Aborting.`
    );
  }
  const gucCheck = await tx.$queryRaw<{ v: string | null }[]>`
    SELECT current_setting('app.current_user_id', true) AS v
  `;
  if (gucCheck[0]?.v !== userId) {
    throw new TenantIsolationError(
      `RLS assertion failed: app.current_user_id is "${gucCheck[0]?.v}", expected "${userId}".`
    );
  }
}

async function enterRls(
  tx: {
    $executeRawUnsafe: (q: string) => Promise<unknown>;
  },
  userId: string
) {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
  await tx.$executeRawUnsafe(
    `SET LOCAL app.current_user_id = '${escapeStringLiteral(userId)}'`
  );
}

/**
 * Execute `fn` inside an RLS-protected context scoped to `userId`.
 *
 * Accepts either:
 *   - withTenant(userId, fn): opens a new interactive transaction, SETs ROLE
 *     app_user and the current_user_id GUC, invokes fn(tx), commits.
 *   - withTenant(userId, fn, tx): reuses an existing transaction client.
 *     Issues SET LOCAL (which applies to the remaining life of that tx)
 *     and asserts role. The caller manages commit/rollback. This is used
 *     by helpers that are *called from within* another withTenant block
 *     so we don't nest transactions (Prisma disallows that).
 */
export async function withTenant<T>(
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  txOrOpts?:
    | Prisma.TransactionClient
    | { isolationLevel?: Prisma.TransactionIsolationLevel; tx?: Prisma.TransactionClient }
): Promise<T> {
  if (!userId || typeof userId !== "string") {
    throw new TenantIsolationError("withTenant: userId is required");
  }
  assertSafeUserId(userId);

  // Normalize the third arg.
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
    // Reuse an existing tx: SET LOCAL applies to the rest of this transaction.
    await enterRls(existingTx, userId);
    await assertRoleAndGuc(existingTx, userId);
    return fn(existingTx);
  }

  // Open a new interactive transaction.
  return prisma.$transaction(
    async (tx) => {
      await enterRls(tx, userId);
      await assertRoleAndGuc(tx, userId);
      return fn(tx);
    },
    { isolationLevel }
  );
}

/**
 * Escape hatch for code paths that must run as superuser (webhook
 * ingestion table, auth flows, public /view and /portal endpoints).
 *
 * Named explicitly so call sites are grep-able.
 */
export function asSuperuser() {
  return prisma;
}
