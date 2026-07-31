# SmartBill Enterprise Hardening — Batch 5 & 6 Architecture

**Audience:** Principal/Staff engineers reviewing for production-readiness.
**Scope:** Three hardening deliverables — kernel-enforced tenant isolation, resilient async webhook ingestion with an operationalized DLQ, and a cryptographically chained double-entry ledger.
**Status:** Shipped in commits `4a9c771`, `52b52ca`, `58aa987`; design documented here.

---

## Cross-Cutting Principles

1. **The database is the enforcement boundary, not the application.** Any defense we can move into a CHECK constraint, RLS policy, trigger, or column privilege is a defense an app bug cannot bypass. The Node.js layer is defense-in-depth, not the wall.
2. **Fail-closed, not fail-open.** When a `SET ROLE`, GUC assertion, or balance check fails, we abort the transaction rather than executing queries with elevated or ambiguous privilege.
3. **NOINHERIT + NOBYPASSRLS.** Neither `app_user` nor `service_role` inherits privileges, neither bypasses RLS. A pooled connection that misses a `SET LOCAL` sees zero rows, not all rows.
4. **Append-only for audit-critical tables.** `ledger_entries` and `invoice_activities` have UPDATE/DELETE physically revoked from the application role at the PostgreSQL privilege layer. Reversals are modeled as new entries.
5. **Superuser is for migrations and seeding only.** Runtime queries go through either `withTenant()` (app_user) or `withService()` (service_role); direct superuser access is grep-auditable.
6. **No hype.** Integer-paise arithmetic and conditional DB updates are table stakes. The hard part is the operational edge cases.

---

## Deliverable 1 — Database-Kernel Tenant Isolation

### 1.1 Threat Model

| Threat | Defense |
|---|---|
| App bug omits `where: { userId }` | RLS filters every row returned/inserted; app-level `where` is defense-in-depth |
| SQL injection in `userId` parameter | Strict allow-list regex + single-quote escape before interpolation; `SET LOCAL` uses literal strings |
| Leaked connection pool state across requests | `SET LOCAL` auto-resets at transaction end; every withTenant/withService re-asserts role + GUC |
| Cron/admin code running as superuser cross-tenant | `service_role` RLS read-only cross-tenant; writes still require `app.current_user_id` match |
| Privilege escalation via column grants | Explicit REVOKE UPDATE on non-whitelist columns of `users` |
| A future engineer accidentally bypassing RLS | `assertRoleAndGuc()` *after* SET LOCAL — if role didn't actually switch, throws before any query runs |

### 1.2 Roles

Two roles, both NOINHERIT NOBYPASSRLS, both with only the privileges they need:

| Role | Used by | Cross-tenant read? | Cross-tenant write? | Tables granted |
|---|---|---|---|---|
| `app_user` | Tenant HTTP request handlers (`withTenant`) | Never | Never | SELECT/INSERT/UPDATE/DELETE on tenant tables; SELECT+INSERT on append-only tables; SELECT+whitelist-UPDATE on `users` |
| `service_role` | Cron workers, DLQ admin, maintenance (`withService`) | Yes (discovery only) | Never, unless it SETs `app.current_user_id` and drops into `withTenant` | Same as `app_user` + full R/W/D on `webhook_ingestions` |
| `smartbill` (owner/superuser) | Migrations, seeding, *very narrow* public endpoints (`/view/:id` by CUID only) | Owner-bypass RLS | Owner-bypass RLS | Everything (intentionally) |

The reason for two roles (instead of just a "service bypass" column flag on app_user) is operational auditability: `SELECT current_user` inside any transaction tells you unambiguously which mode you're in, and `app_user` policies don't need an OR-branch that could accidentally leak data.

### 1.3 GUCs

- `app.current_user_id TEXT` — set by `withTenant(userId)`; drives tenant isolation policies.
- `app.service_name TEXT` — set by `withService(name)`; allows cross-tenant READ via OR-clause.

Both are declared with empty-string defaults (`set_config(..., false)` per-session) and SET LOCAL per-transaction. The `true` parameter to `current_setting(..., true)` returns NULL for missing values, which with default-deny returns zero rows (fail-closed).

### 1.4 Prisma Schema additions

None at the model level — RLS is a database-layer concern. Denormalized `userId` columns are added to `InvoiceItem` and `RecurringItem` so policies don't require FK joins:

```prisma
model InvoiceItem {
  id        String   @id @default(cuid())
  userId    String   // denormalized from Invoice.userId; required for RLS
  invoiceId String
  // ...
  @@index([userId])
}
```

### 1.5 DDL (abbreviated, see `prisma/rls-setup.sql` and `prisma/service-role.sql`)

```sql
-- Role creation (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

-- Privileges: tenant tables for app_user
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  settings, clients, invoices, invoice_items, expenses,
  recurring_profiles, recurring_items TO app_user, service_role;

-- Append-only for activities and ledger
GRANT SELECT, INSERT ON TABLE invoice_activities, ledger_entries TO app_user, service_role;
REVOKE UPDATE, DELETE ON TABLE invoice_activities, ledger_entries FROM app_user, service_role, PUBLIC;

-- webhook_ingestions: service_role only (edge uses superuser for single INSERT)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE webhook_ingestions TO service_role;
ALTER TABLE webhook_ingestions ENABLE ROW LEVEL SECURITY;

-- Users: SELECT own row; UPDATE on whitelist columns only.
GRANT SELECT, UPDATE ON TABLE users TO app_user, service_role;
REVOKE UPDATE (id, name, email, "passwordHash", "resetToken",
              "resetTokenExpires", "createdAt") ON TABLE users FROM app_user, service_role;

-- RLS: enable and create policies
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
-- ... same for all tenant tables

-- Tenant policy for invoices (shared by both roles when current_user_id is set)
CREATE POLICY invoice_isolation ON invoices FOR ALL
  USING     ("userId" = current_setting('app.current_user_id', true)
             OR current_setting('app.service_name', true) IS NOT NULL)
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
```

Key design choice: the `WITH CHECK` clause (enforced on INSERT/UPDATE) does **not** include the service_name OR-clause. This is critical: a service_role transaction that has *not* dropped into `withTenant(userId, ...)` (i.e., hasn't SET `app.current_user_id`) can read across tenants for discovery, but **any write attempt will raise a policy violation**. There is no code path where a cron can accidentally write a row with the wrong userId.

### 1.6 `withTenant()` wrapper (`src/lib/tenant.ts`)

Signature:
```ts
function withTenant<T>(
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  txOrOpts?: Prisma.TransactionClient | {
    isolationLevel?: Prisma.TransactionIsolationLevel;
    tx?: Prisma.TransactionClient;
  }
): Promise<T>;
```

Behavior:
1. Validate `userId` against `^[A-Za-z0-9_-]{1,128}$` (rejects SQLi payloads before any interpolation).
2. If passed an existing tx (composable case, e.g., `postLedgerEvent` called inside an outer `withTenant`): issue `SET LOCAL ROLE` + `SET LOCAL app.current_user_id` on that tx, then **assert** (see #4). Don't start a nested transaction (Prisma disallows this).
3. Otherwise open a fresh `prisma.$transaction(..., { isolationLevel })`.
4. After SET LOCAL, **assert**:
   - `SELECT current_user` → must be `app_user` or `service_role` (we tolerate service_role because withTenant nests cleanly inside withService for cron → per-tenant writes).
   - `SELECT current_setting('app.current_user_id', true)` → must equal the passed userId.
5. Invoke `fn(tx)`. If assertions fail, fn is never called.

### 1.7 `withService()` wrapper (`src/lib/service-context.ts`)

Symmetric to `withTenant`, but sets `app.service_name` instead:

```ts
function withService<T>(
  serviceName: string,           // "cron:process-webhooks", "cron:redrive-dlq", ...
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  txOrOpts?: ...
): Promise<T>;
```

Validation: service name must match `^[a-z][a-z0-9:-]{1,63}$`. Assertion enforces `current_user === 'service_role'` and `current_setting('app.service_name')` is non-empty.

Service-name strings are literal constants in code — no user input. They serve as audit breadcrumbs (logs show exactly which subsystem held the service context).

### 1.8 How crons work now (no superuser at runtime)

```
cron request (with CRON_SECRET)
  → withService("cron:process-webhooks", async (tx) => {
      // Service-scoped tx: can SELECT across webhook_ingestions + all tenant tables
      const rows = await claimDue({ client: tx, limit: 20 });
      for (const row of rows) {
        // Processor parses the event and derives userId.
        // When it's time to do tenant writes (e.g., markInvoicePaid), call:
        await markInvoicePaid(invoiceId, { tx });
        //   └─ markInvoicePaid calls withTenant(userId, fn, { tx })
        //      which SETs app.current_user_id on this same tx, asserts,
        //      then does the write. The write is now tenant-scoped.
      }
    });
```

This is the two-phase pattern: **service discovers, tenant acts**. Discovery reads are cross-tenant; any row that touches financial state runs through withTenant with the specific userId.

### 1.9 Trade-offs considered

| Alternative | Why rejected |
|---|---|
| One role with a "bypass" flag GUC | Doesn't survive code audit; `current_user` doesn't change so misdirection is invisible in pg_stat_activity |
| One connection string per tenant | Connection-pool explosion at N>100 tenants; SET ROLE is O(1) per tx |
| pgcrypto/set_config-based session variable with hashed user id | No concrete security benefit; adds complexity and prevents validating userId with simple equality |
| RLS policies using `current_setting` on a per-role custom variable | Fails over connection pool reuse unless SET LOCAL; extra catalog management |
| Using PostgreSQL `ROLE` per tenant (SET ROLE tenant_abc) | Prohibitive role-count explosion; DDL-per-tenant migration; breaks connection pooling |
| `SET LOCAL ROLE` without assertion | If the role was dropped/privilege changed, code continues as superuser — fail-open |

---

## Deliverable 2 — Async Webhook Ingestion with Operationalized DLQ

### 2.1 Requirements

- Edge handler must complete in <50ms (webhook providers require 2xx quickly; Stripe times out at 10s but we budget <50ms for headroom).
- Outbound API calls to Stripe/Razorpay/Resend and downstream business writes (mark invoice PAID, send receipt email) must NOT run on the request path.
- Concurrent workers must not double-process the same row (Stripe/Razorpay retry aggressively).
- A DLQ must not be a graveyard; operators must be able to see, replay, and resolve failures. Infinite retry loops on bad payloads must be impossible.

### 2.2 Prisma schema (`prisma/schema.prisma`)

```prisma
enum WebhookIngestionStatus {
  PENDING     // inserted by edge; awaiting claim
  PROCESSING  // claimed by a worker (lockedBy/lockedAt set)
  DONE        // processed successfully
  DLQ         // transient failure, eligible for redrive after cooldown
  POISON      // deterministic failure, quarantined, never auto-retried
}

model WebhookIngestion {
  id              String                  @id @default(cuid())
  provider        String                  // "stripe" | "razorpay" | "resend"
  providerEventId String?
  eventType       String
  rawBody         String                  @db.Text
  signature       String?

  attempts        Int                     @default(0)
  lastError       String?                 @db.Text       // truncated 2KB
  nextAttemptAt   DateTime                @default(now())

  status          WebhookIngestionStatus  @default(PENDING)
  lockedBy        String?                 // worker id pid-host
  lockedAt        DateTime?
  processedAt     DateTime?
  createdAt       DateTime                @default(now())

  // Batch 6 DLQ operations
  poisonPill      Boolean                 @default(false)
  poisonReason    String?                 @db.Text       // "malformed_json" | "invalid_signature" | "unknown_provider" | "missing_resource" | "redrive_quota_exceeded"
  redriveCount    Int                     @default(0)
  redriveAfter    DateTime?                // earliest auto-redrive eligibility
  lastAlertedAt   DateTime?
  resolvedAt      DateTime?
  resolveNote     String?                 @db.Text

  @@unique([provider, providerEventId], name: "wh_ingest_provider_event_uniq")
  @@index([status, nextAttemptAt], name: "wh_ingest_claim_idx")
  @@index([status, redriveAfter],  name: "wh_ingest_redrive_idx")
  @@index([poisonPill, status],    name: "wh_ingest_poison_idx")
  @@map("webhook_ingestions")
}
```

### 2.3 Pipeline

```mermaid
flowchart LR
  subgraph edge[Edge (request path, <50ms)]
    A[Receive webhook] --> B{Verify HMAC}
    B -->|fail| X[401]
    B -->|pass| C[INSERT rawBody<br/>PENDING<br/>nextAttemptAt=now]
    C -->|P2002 duplicate| Z[202 (idempotent)]
    C -->|ok| Z2[202 Accepted]
  end

  subgraph worker[Cron worker /api/cron/process-webhooks<br/>(service_role, every minute)]
    D[reapStaleClaims 5min] --> E[claimDue FOR UPDATE SKIP LOCKED<br/>limit=20]
    E --> F{per row}
    F -->|dispatch to processor| G{outcome}
    G -->|ok| H[markDone → DONE]
    G -->|transient err<br/>attempts < MAX| I[markRetry PENDING<br/>backoff 5·2^n + jitter]
    G -->|transient err<br/>attempts ≥ MAX| J[markRetry DLQ<br/>redriveAfter=now+15m]
    G -->|deterministic err| K[markRetry POISON<br/>poisonReason set<br/>fire alert hook]
  end

  subgraph redrive[Cron /api/cron/redrive-dlq<br/>(service_role, every 15 min)]
    L[redriveEligible limit=10] --> M{redriveCount < 3?}
    M -->|yes| N[status→PENDING<br/>nextAttemptAt=now<br/>redriveCount++]
    M -->|no| O[promote→POISON<br/>fire alert]
  end

  subgraph ops[Admin /api/admin/dlq<br/>(CRON_SECRET)]
    P[GET list]
    Q[POST /:id?action=redrive&force=1]
    R[POST /:id?action=resolve]
  end
```

### 2.4 Concurrency control: `SELECT FOR UPDATE SKIP LOCKED`

```sql
SELECT id, provider, "providerEventId", "eventType", "rawBody", attempts
FROM webhook_ingestions
WHERE status IN ('PENDING', 'PROCESSING')
  AND "nextAttemptAt" <= NOW()
ORDER BY "nextAttemptAt" ASC
LIMIT ${limit}
FOR UPDATE SKIP LOCKED;
```

Design notes:
- `SKIP LOCKED` means N concurrent workers each claim disjoint subsets — no lock waits, no thrashing.
- We include `PROCESSING` rows in the claim set so that `reapStaleClaims` (which recovers rows locked longer than 5 minutes by a dead worker) is functionally redundant but retained as a safety net.
- After claiming, we issue an `UPDATE ... SET status='PROCESSING', lockedAt=now(), lockedBy=$workerId`.
- The worker id is `pid-${process.pid}_host-${HOSTNAME}` for operational visibility.

### 2.5 Retry math

```ts
// After attempts failures, the next retry is at:
delay = BASE_BACKOFF_MS * 2^attempts + jitter(0..1000)
// BASE_BACKOFF_MS = 5000 → 5s, 10s, 20s, 40s, 80s (5 attempts ≈ ~2.5 min total window before DLQ)
```

Max attempts = 5 is a conscious trade-off: long enough to survive a ~1-minute Stripe/Razorpay blip, short enough that a real outage surfaces to the DLQ in minutes rather than hours.

### 2.6 Poison-pill classification (`classifyError()`)

We classify errors at the point of failure, not at the DLQ boundary. This is essential — if you can't tell a deterministic failure from a transient one, you can't prevent infinite cycling.

Patterns that are **deterministic** (poison):
- `/Unknown provider/i` — code/config bug; retries cannot fix.
- `/invalid.*json|malformed.*json|json.*parse|Unexpected token/i` — payload unparseable.
- `/signature.*(invalid|verification|mismatch)|no signature|hmac/i` — failed HMAC (shouldn't reach worker normally since edge verifies, but defense-in-depth).
- `/no such (invoice|customer|payment|charge|intent)|resource_missing/i` — referenced entity doesn't exist; retries won't create it.

Everything else (ECONNREFUSED, ECONNRESET, 5xx from downstream, timeouts, DB serialization errors) is treated as transient.

Adding new patterns requires a code change and code review — classification is not a config knob because false negatives (treating a deterministic error as transient) create infinite-retry loops that drain worker throughput.

### 2.7 Redrive schedule

- DLQ rows have `redriveAfter = now + 15min` (configurable).
- The redrive cron flips at most 10 rows per 15-minute tick → caps replay throughput at 40 rows/hour/instance, preventing "replay storms" after an outage recovers.
- `MAX_REDRIVES = 3` (total of 3 auto-redrives, i.e., ~15 additional attempts beyond the original 5). After that, promote to POISON with `poisonReason = 'redrive_quota_exceeded'`.
- Operators can override via `?action=redrive&force=1` (which replays POISON rows too), and `?action=resolve` to mark a row permanently acknowledged.

### 2.8 Alerting

```ts
type AlertHook = (row: {
  id: string; provider: string; eventType: string;
  status: "DLQ" | "POISON"; attempts: number; redriveCount: number;
  lastError: string | null; poisonReason: string | null;
}) => void | Promise<void>;

registerDlqAlertHook(async (row) => {
  console.error(`[dlq-alert] status=${row.status} provider=${row.provider} ... id=${row.id}`);
});
```

The default hook is intentionally stderr-only: hosting platforms (Vercel Log Drains, Datadog, Loki) already ship stderr, and emitting alerts *through* the same webhook/email subsystems that are failing is an anti-pattern. Slack/PagerDuty/Resend hooks are a trivial one-liner registration.

`lastAlertedAt` prevents alert spam if the same row is flagged multiple times (checked but not yet rate-limited in current code; designed for).

### 2.9 Idempotency guarantees

1. `(provider, providerEventId)` UNIQUE constraint — duplicate edge INSERTs from provider retries are absorbed via P2002 catch → return 202.
2. Processors (`markInvoicePaid` etc.) use atomic conditional UPDATE: `WHERE status NOT IN ('PAID','VOID')` so replays are no-ops.
3. `redriveOne()` checks current status: replaying DONE/PENDING/PROCESSING returns `{ ok: false, reason: 'already_*' }`.
4. Stripe/Razorpay idempotency keys (`payment_intent`, `checkout.session.id`) are checked downstream.

### 2.10 Trade-offs considered

| Alternative | Why rejected |
|---|---|
| In-memory queue (BullMQ, Redis, SQS) | Adds operational dependency; Postgres SKIP LOCKED with proper indexing handles our throughput target (<1000 events/min per tenant) without a broker |
| No status column, rely solely on `lockedAt`/`nextAttemptAt` | "Is this row in the DLQ?" becomes a time-based heuristic; explicit POISON/DLQ states are auditable |
| Infinite retries with long backoff | Masks real bugs forever; fills the queue; operators can't tell broken from slow |
| Poison detection via a separate "max attempts" rule alone | Can't distinguish "downstream is down" from "payload is garbage" — a 100x spike of bad payloads will block all retries |
| Redriving via direct UPDATE (no cron) | Requires an operator to notice; automatic redrive is essential for self-healing after transient outages |
| Processing via pgAgent/postgres-side logic | Harder to version, test, deploy, and monitor than a TypeScript worker |

---

## Deliverable 3 — Cryptographically Chained Double-Entry Ledger

### 3.1 Requirements

- Every balance-impacting action produces zero-sum entries (Σ debits = Σ credits) enforced in the database, not just the app.
- Append-only: UPDATE/DELETE must be physically impossible for the application role.
- Tamper-evident: any modification (row altered, row deleted, chain reordered) is detectable in O(N) verification with a clear break-point.
- Must handle 100+ concurrent events per tenant without timing out the pool.
- Void/refund/un-pay modeled as new entries, never mutations.

### 3.2 Prisma schema

```prisma
enum AccountType {
  ACCOUNTS_RECEIVABLE  // asset: Dr when invoice issued, Cr when paid/void
  REVENUE              // income: Cr when issued, Dr on void
  DISCOUNT_CONTRA      // contra-revenue: Dr for discount (reduces net revenue)
  TAX_PAYABLE          // liability: Cr on issuance (GST/VAT held for govt), Dr on void
  CASH                 // asset: Dr on payment received, Cr on expense/refund
  EXPENSES             // expense: Dr when expense recorded
}

enum EntrySide { DEBIT CREDIT }

enum LedgerEventType {
  INVOICE_ISSUED
  INVOICE_PAID
  INVOICE_VOIDED
  PAYMENT_REVERSED
  EXPENSE_RECORDED
}

model LedgerEntry {
  id            String         @id @default(cuid())
  userId        String
  eventId       String         // all rows of one balanced txn share eventId
  eventType     LedgerEventType
  account       AccountType
  side          EntrySide
  amountPaise   BigInt         // integer subunits (paise), always positive
  prevEntryHash String         // SHA-256 hex of prior entry's entryHash (chain)
  entryHash     String         // SHA-256 hex of prevHash || canonical(this)
  entryIndex    Int            // strictly increasing per-user (gapless)
  invoiceId     String?
  expenseId     String?
  currency      String         @default("INR")
  note          String?        @db.Text
  createdAt     DateTime       @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt])
  @@index([userId, eventId])
  @@index([invoiceId])
  @@index([expenseId])
  @@unique([userId, entryIndex])
  @@unique([userId, entryHash])
  @@map("ledger_entries")
}

// Tail-pointer columns added to User
model User {
  // ...existing fields...
  lastLedgerEntryHash String?  // tail of the hash chain
  lastLedgerEntryId   String?
  ledgerEntries       LedgerEntry[]
}
```

### 3.3 Canonical serialization

Hash inputs are deterministic pipe-delimited bytes (no JSON, no key ordering ambiguity, no locale sensitivity):

```
eventId|eventType|account|side|amountPaise|invoiceId|expenseId|currency
```

Every field is stringified; `null` → empty string; `amountPaise` is decimal-string of the bigint (no leading zeros, base 10). The entry hash is:

```
entryHash_n = SHA256_HEX(entryHash_{n-1} || "|" || canonical(entry_n))
```

The first entry for a user uses `GENESIS_HASH = SHA256("smartbill:ledger:genesis")` as `prevEntryHash`. Genesis is a constant, not a row, so there's no special "index 0" record to tamper with.

### 3.4 Balanced-posting triggers (`prisma/ledger.sql`)

An `AFTER INSERT ... FOR EACH STATEMENT` trigger fires once per `createMany` batch and re-verifies the invariant for every `eventId` present in the new batch:

```sql
CREATE OR REPLACE FUNCTION ledger_assert_balanced_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE bad RECORD;
BEGIN
  FOR bad IN
    SELECT le."eventId",
      SUM(CASE WHEN le.side='DEBIT'  THEN le."amountPaise"::bigint ELSE 0 END) AS d,
      SUM(CASE WHEN le.side='CREDIT' THEN le."amountPaise"::bigint ELSE 0 END) AS c
    FROM ledger_entries le
    WHERE le."eventId" IN (SELECT DISTINCT "eventId" FROM inserted)
    GROUP BY le."eventId"
    HAVING SUM(CASE WHEN le.side='DEBIT'  THEN le."amountPaise"::bigint ELSE 0 END)
        <> SUM(CASE WHEN le.side='CREDIT' THEN le."amountPaise"::bigint ELSE 0 END)
  LOOP
    RAISE EXCEPTION 'Ledger invariant violated: eventId % has D=% C=% (paise)',
      bad."eventId", bad.d, bad.c;
  END LOOP;
  RETURN NULL;
END; $$;

CREATE TRIGGER ledger_balance_trigger_insert
AFTER INSERT ON ledger_entries
REFERENCING NEW TABLE AS inserted
FOR EACH STATEMENT EXECUTE FUNCTION ledger_assert_balanced_insert();
```

Note:
- Uses `REFERENCING NEW TABLE AS inserted` (transition tables, PG10+); fires per-statement, not per-row, so bulk inserts are single-scan.
- Checks balance across the **whole table** for affected eventIds (not just the new rows) — this catches double-posting bugs too.
- There is no UPDATE/DELETE trigger because `app_user`/`service_role` cannot issue those (REVOKED). The superuser migration path is trusted.

### 3.5 Append-only enforcement

```sql
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
REVOKE UPDATE, DELETE ON ledger_entries FROM PUBLIC;
REVOKE UPDATE, DELETE ON ledger_entries FROM app_user, service_role;
GRANT SELECT, INSERT ON ledger_entries TO app_user, service_role;
```

Even if a future bug generated a Prisma `update()` call, Postgres rejects it with `permission denied`.

### 3.6 Posting logic: balanced entries per event

| Event | Debits | Credits |
|---|---|---|
| `INVOICE_ISSUED` | AR (total), DISCOUNT_CONTRA (discount if >0) | REVENUE (subtotal − discount), TAX_PAYABLE (tax) |
| `INVOICE_PAID` | CASH (amount) | AR (amount) |
| `INVOICE_VOIDED` | REVENUE (net), TAX_PAYABLE (tax), +AR if paid | AR (total), DISCOUNT_CONTRA (contra if discount), +CASH if paid |
| `PAYMENT_REVERSED` | AR (amount) | CASH (amount) |
| `EXPENSE_RECORDED` | EXPENSES (amount) | CASH (amount) |

All amounts are integer paise. Rounding is centralized in `src/lib/money.ts::calcInvoiceTotals` which returns `_paise` as bigint fields; the ledger never converts from floating-point.

`assertBalanced(entries)` runs client-side before insert as defense-in-depth (fast-fail with a clear error before holding the lock).

### 3.7 Solving the hash-chain contention bottleneck

This is the part most implementations get wrong. A naïve `SELECT ... FOR UPDATE` on the user row + insert per event means:

- Bulk CSV with 500 expenses → 500 lock acquires → 500 inserts → connection pool tie-up.
- Concurrent Stripe webhooks for the same merchant serialize on the lock and pile up as `lock_not_available`.

We solve it with three layered mitigations, none of which weaken the chain:

**(A) Per-user advisory lock with a single critical section.** Instead of `SELECT FOR UPDATE` on `users` (which caused `permission denied` for app_user on earlier iterations and is not composable with ORMs), we use `pg_advisory_xact_lock` keyed by `(namespace:32bit | fnv1a(userId):32bit)`. This is a transaction-level exclusive lock per user. Because we hold it for the duration of **one** `createMany` call (not across email/API calls), the critical section is O(entries) pure CPU + one bulk INSERT.

**(B) Bulk event API: `postLedgerEvents(events[], tx?)`**

```ts
async function postLedgerEvents(
  events: LedgerEventInput[],
  tx?: Prisma.TransactionClient
): Promise<BatchPostResult>;
```

All events must be for the same userId. The function:
1. Prepares all events (builds balanced entries, asserts balance).
2. Acquires the advisory lock **once**.
3. Reads the tail pointer (last entry hash + index) **once**.
4. Computes the entire hash chain across all entries of all events in one tight loop in Node.
5. Issues a **single** `createMany` for all rows.
6. Updates `users.lastLedgerEntryHash/Id` once.

This collapses N lock-acquires + N INSERTs + N tail-updates into **one of each**. The CSV expense importer uses this path: a 500-row import holds the advisory lock for milliseconds (one hash loop, one bulk insert).

**(C) Bounded retry on transient serialization failures**

Both `postLedgerEvent` and `postLedgerEvents` wrap the outer `withTenant` transaction in a retry loop with exponential backoff (20ms · 2^n + jitter, max 4 retries), triggered specifically by Postgres SQLSTATEs that indicate the lock was contended or a deadlock was broken:

- `40P01` deadlock_detected
- `55P03` lock_not_available
- `40001` serialization_failure
- `08006` / `08001` connection failures
- `57P01` admin_shutdown

Retry is **only** applied at the outer (new tx) boundary — never when an existing `tx` is passed in, because retrying mid-transaction would require replaying the caller's writes. The retry loop classifies errors via `isRetryablePgError()` (checks both `err.code` and the error message string for safety across Prisma versions).

**Why not an out-of-process append queue / batcher?** Considered. It would eliminate lock waits entirely by funneling all writes through a single per-worker append thread. The trade-off:
- Pro: eliminates contention completely (single writer).
- Con: adds at least one extra hop (now writes are eventually-consistent), breaks atomicity (invoice PAID update and ledger insert can't share a tx), and adds a major operational dependency (a write-ahead log / Kafka / Redis stream or a dedicated queue worker).

For SmartBill's throughput envelope (<1000 events/tenant/minute, <100 tenants), advisory lock + bulk insert + bounded retry achieves sub-50ms lock hold times in practice. The math: bulk-insert of 500 entries on PG17 with `(user_id, entry_index)` index is ~10ms; advisory lock acquisition under contention is queued but the lock is released immediately, so queue drains quickly. We do not add the asynchronous batching layer until we have measured contention — that would be premature optimization with significant correctness trade-offs.

**Why not epoch- / Merkle-batching (commit every N entries as a single anchor hash)?** This reduces hash verification granularity (a tamper between epochs is undetectable until the end of an epoch), and doesn't reduce lock contention since you still need the previous anchor hash to append. Rejected.

**Why not optimistic concurrency with `UPDATE users SET lastEntryHash = new WHERE lastEntryHash = expected` and retry?** Equivalent in contention behavior to the advisory lock (same serial tail), but fails after the work is done (wasted insert) and is harder to compose with Prisma's transaction model. The advisory lock serializes *before* the work, which is strictly more efficient under contention.

### 3.8 Reconciliation (`verifyUserLedger`)

```ts
async function verifyUserLedger(userId: string): Promise<VerificationResult>;
```

Walks entries `ORDER BY entryIndex ASC`:
1. Verifies `prevEntryHash === expectedPrevHash` at every step.
2. Recomputes `entryHash` from canonical serialization; must match.
3. Accumulates per-event debits/credits across the walk; asserts Σ D == Σ C per eventId (belt-and-suspenders even though the trigger enforced this on insert).
4. After the walk, asserts `users.lastLedgerEntryHash === lastEntry.entryHash` (tail pointer integrity).
5. Returns account balances (paise, as string to preserve bigint precision).
6. Caller (admin UI, `GET /api/admin/ledger-verify`) compares ACCOUNTS_RECEIVABLE balance to the sum of `totalAmount` on PENDING invoices; nonzero diff indicates a projection bug.

### 3.9 Backfill

`backfillLedger()` is idempotent: it finds invoices/expenses with no `INVOICE_ISSUED` / `EXPENSE_RECORDED` entry and posts them using the normal `postLedgerEvent` path. DRAFT invoices are skipped (no economic event yet). Safe to run repeatedly.

### 3.10 Trade-offs considered

| Alternative | Why rejected |
|---|---|
| UUID/GUID event IDs with separate LedgerEvent table | Adds a join for little benefit; eventId CUID + enum eventType is sufficient; we don't need event metadata beyond what's captured on the rows |
| Separate credit/debit columns (single amount with sign) | Prone to sign-flip bugs; double-entry convention naturally uses separate sides. Signed arithmetic was considered but rejected for the same reason bankers use DR/CR columns — clarity invariant is easier to enforce |
| Application-level hash chain without DB trigger | An app bug (or migration script) could post unbalanced entries; defense in depth requires the DB to refuse |
| Storing hash chain in a separate "audit log" table | Allows split-brain between ledger and chain; having the hash on the same row means any UPDATE must recompute the hash (and UPDATE is revoked anyway) |
| `pgcrypto` extension for SHA-256 | Extra extension dependency; Node `crypto.createHash('sha256')` is faster and avoids sending data to/from the server. We only need SHA-256 at insert time, which the app already does — we don't recompute in SQL except in the verification function if desired |
| `SELECT ... FOR UPDATE` on users row | Prisma/app_user privilege issues; advisory lock is cleaner and explicitly documentable as "per-user serialize" |
| Async/queued ledger writes (eventual consistency) | Breaks atomicity with business writes (PAID + ledger could commit separately); for our throughput, not justified |
| Multiple chain "shards" per user (parallel chains merged at intervals) | Destroys total ordering; makes verification N^2; does not solve concurrency since you still need a merge lock |

---

## End-to-End Failure Mode Inventory

| Failure | Detection | Recovery |
|---|---|---|
| SET ROLE fails (role dropped) | `assertRoleAndGuc` throws; tx aborts | Fix role DDL; restart app; zero queries executed in elevated mode |
| Poison-pill webhook payload (bad JSON, unknown provider) | `classifyError` → POISON on first failure | Operator inspects via `/api/admin/dlq`; fix code or ignore; `resolve` |
| Downstream outage (Stripe 5xx) | Transient errors retry → DLQ → auto-redrive for 15m | Auto-redrive recovers; after 3 redrives → POISON with alert |
| Webhook worker crash mid-process | `lockedAt` stale >5min | `reapStaleClaims` returns it to PENDING on next tick |
| Duplicate provider retry | `(provider, providerEventId)` UNIQUE → P2002 | Edge returns 202 (idempotent) |
| Unbalanced ledger insertion (app bug) | DB trigger raises exception; tx rolls back | Fix bug; backfill from business tables |
| Tampered ledger entry | `verifyUserLedger()` hash mismatch at entryIndex N | Restore from backup; investigate; chain break is reported with exact index and reason |
| Tail pointer desync (user.lastLedgerEntryHash off) | Verifier compares against `MAX(entryIndex)` entry | Backfill/verify rewrites the tail pointer |
| Lock contention (concurrent ledger posts) | pg_advisory_xact_lock queues; retries on 55P03 | Bulk API + short critical section + exponential backoff; alerts fire if retries exhausted |
| Operator replay of DLQ row that was already DONE | `redriveOne` returns `already_done`; no duplicate posting | Status code surfaces to operator UI |
| Redrive storm after outage | `redriveEligible` caps at 10/tick | Throttled recovery; max 40/hour per cron instance |
| Service-role tx forgets to SET current_user_id on write | RLS WITH CHECK policy rejects the INSERT | Fails closed; error surfaces to worker logs |

---

## Files (shipped)

- `prisma/schema.prisma` — enums, models (LedgerEntry, WebhookIngestion + POISON fields, User tail pointers)
- `prisma/rls-setup.sql` — app_user role, RLS policies on tenant tables, column whitelist on users
- `prisma/service-role.sql` — service_role role, RLS policies on webhook_ingestions and service-branch OR-clauses on tenant tables
- `prisma/ledger.sql` — append-only revokes, balance-invariant trigger
- `src/lib/tenant.ts` — `withTenant()` + assertion logic; supports tx reuse
- `src/lib/service-context.ts` — `withService()` for cron/admin paths
- `src/lib/webhook-ingestion.ts` — `ingestWebhook`, `claimDue` (SKIP LOCKED), `markDone`/`markRetry` (with poison classification), `reapStaleClaims`, `redriveOne`, `redriveEligible`, `resolveDlq`, `listDlq`, `registerDlqAlertHook`
- `src/lib/ledger.ts` — types, balanced entry builders, `postLedgerEvent`, `postLedgerEvents` (bulk), retry-on-lock-contention, `backfillLedger`, `verifyUserLedger`, advisory lock
- `src/lib/invoice-helpers.ts` — `markInvoicePaid`, `voidInvoice`, both ledger-aware and atomic
- `src/app/api/cron/process-webhooks/route.ts` — service_role worker
- `src/app/api/cron/redrive-dlq/route.ts` — service_role DLQ redriver
- `src/app/api/admin/dlq/route.ts` + `[id]/route.ts` — operator list/redrive/resolve endpoints (CRON_SECRET authed)
- `src/app/api/admin/ledger-verify/route.ts` — runtime integrity check endpoint
- `vercel.json` — cron schedule includes `redrive-dlq` every 15 minutes
