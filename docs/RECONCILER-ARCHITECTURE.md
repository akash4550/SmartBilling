# SmartBill — Automated Ledger Drift & Integrity Reconciler

**Status:** Architectural blueprint (pre-implementation).
**Builds on:** Batch 5 (RLS, async webhooks, hash-chained ledger) and Batch 6 (service_role, DLQ redrive, bulk ledger posting).
**Scope:** Continuous verification that (a) the ledger hash chain is intact (tamper-evident), (b) ledger account balances reconcile against application read models, (c) drift is detected, quarantined, alerted, and audited — all at production scale.

---

## Core Design Principles

1. **Verify the thing that matters, not a proxy.** The hash chain is not the product; correct balances are. The reconciler runs two orthogonal sweeps and must pass both to declare a tenant healthy.
2. **Streaming, not loading.** 50k+ entries per tenant must not blow Node memory or hold long read transactions. Hash verification streams; balance aggregation pushes down to SQL.
3. **Quarantine is a database-state change, not an in-memory flag.** If drift is detected, the tenant is quarantined by flipping a `users.ledgerQuarantinedAt` column. RLS-style guards inside `withTenant` and the posting helpers refuse financial writes for quarantined tenants — even if the reconciler process crashes mid-handle.
4. **Every run is recorded forever.** Audit rows are append-only; they are the compliance artifact.
5. **Idempotent and resumable.** A reconciliation killed mid-stream leaves no half-state; the next run starts fresh from GENESIS. Drift that persists across runs does not spam PagerDuty (alert cooldown per tenant+severity).
6. **Runs as service_role, never as superuser.** The reconciler is a cron/worker using `withService("maint:reconcile")`. It can read cross-tenant and writes to the audit table + quarantine column via service-scoped policies.

---

## Sweep A — Hash-Chain Integrity (Cryptographic Audit)

### What it checks

- `entryHash_n == SHA256(prevEntryHash_n | "|" | canonical_n)` for every row from `entryIndex=1` → tail.
- `prevEntryHash` of entry 1 equals `GENESIS_HASH`.
- `users.lastLedgerEntryHash == final entry.entryHash` (tail pointer integrity).
- `(userId, entryIndex)` is gapless (no deleted or skipped entries — detects partial TRUNCATE/DELETE).
- Per-`eventId` balance: Σ DEBIT == Σ CREDIT in paise (double-checks the INSERT trigger, which could have been disabled by a superuser migration).

### Streaming strategy (50k+ entries, constant memory)

Hash verification is inherently sequential — you cannot verify `entryHash_n` without knowing `entryHash_{n-1}`. But sequential does not mean "load everything." We use **keyset-cursor batching** with a stable order:

```sql
-- First batch (or resume cursor)
SELECT id, "entryIndex", "eventId", "eventType", account, side, "amountPaise",
       "prevEntryHash", "entryHash", "invoiceId", "expenseId", currency
FROM ledger_entries
WHERE "userId" = $1 AND "entryIndex" > $cursor
ORDER BY "entryIndex" ASC
LIMIT 500;
```

- `cursor` starts at 0; after each batch it advances to `MAX(entryIndex)` of the batch.
- We keep **only one running hash** in memory (the current expected `prevHash`) plus a per-`eventId` debit/credit accumulator (a `Map<eventId, {d: bigint, c: bigint}>`). Events fit within a batch almost always; if an event straddles a batch boundary, its partial accumulator carries over.
- Memory is O(batch size + in-flight events), not O(N total). With batch size 500 that is ~200 KB of heap regardless of tenant size.
- The query uses the `(userId, entryIndex)` UNIQUE index — pure index scan, no heap fetches except the selected columns.

### Transaction isolation

- Each batch runs in auto-commit (no long tx). Because ledger_entries is append-only (no UPDATE/DELETE allowed for app_user/service_role), a non-locking read sees a consistent prefix up to some tail. We verify the tail pointer AFTER the loop: if new entries were appended during the run, we verify the chain up to the tail we observed and then loop forward to the new tail (incremental catch-up) until we converge — or fail if we detect a tail regression (which would indicate superuser tampering mid-run).
- This is important: do NOT use `REPEATABLE READ` for a 50k-row sweep; that holds a snapshot for seconds-to-minutes and blocks vacuum.

### Canonical form (must match posting helper byte-for-byte)

```
eventId|eventType|account|side|amountPaise|invoiceId|expenseId|currency
```

This is the exact pipe-delimited serialization used in `src/lib/ledger.ts::serializeForHash`. The reconciler imports that function — no second copy (prevents drift in the verifier itself).

### Fast-fail vs. full-collection

- **Fast-fail on hash break:** on the first mismatch, we do not stop immediately; we continue to the end collecting *all* discrepancies in that run (so one audit row contains every gap/broken link in one ticket instead of one-per-email). The first broken index is reported as `firstBrokenIndex`.
- Balance mismatches (Sweep B) are always collected exhaustively.

---

## Sweep B — Read-Model Balance Cross-Check

### What it checks

For every account that has an independent read model in SmartBill today, we compute the balance from two sources and compare:

| Account | Ledger balance (Σ D − Σ C) | Read model | Expected match? |
|---|---|---|---|
| ACCOUNTS_RECEIVABLE | derived in SQL (see below) | Σ `totalAmount` on invoices where `status='PENDING'` (i.e., issued but not yet paid/voided) | Exact paise match |
| CASH (cash received) | derived in SQL | Σ `totalAmount` on invoices where `status='PAID'` minus Σ payments reversed | Exact paise match |
| REVENUE (net) | derived | Sum of AR issued across invoices less discounts (derived from subtotal − discount) | Exact match, but we tolerate a **known-drift** window if the tenant has edited PENDING/PAID invoices (see Drift Taxonomy) |
| TAX_PAYABLE | derived | Σ taxAmount per issued invoice less voided | Exact |
| EXPENSES | derived | Σ `amount` on `expenses` table | Exact |

### Strategy: push aggregation to SQL (not Node)

Balance cross-checks are aggregates, not sequential checks. We compute ledger-side balances in a single SQL query per tenant:

```sql
SELECT account,
       SUM(CASE WHEN side='DEBIT'  THEN "amountPaise"::bigint ELSE 0 END) AS total_debits,
       SUM(CASE WHEN side='CREDIT' THEN "amountPaise"::bigint ELSE 0 END) AS total_credits,
       SUM(CASE WHEN side='DEBIT'  THEN "amountPaise"::bigint ELSE -"amountPaise"::bigint END) AS signed_balance
FROM ledger_entries
WHERE "userId" = $1
GROUP BY account;
```

Ledger-side is one index range scan on `(userId, ...)`.

Read-model balances come from targeted aggregates:

```sql
-- Open AR (PENDING invoices) in paise
SELECT COALESCE(SUM(
  ROUND(("totalAmount"::numeric * 100)::bigint)  -- integer paise, same scale as toSubunit
), 0) AS open_receivable_paise
FROM invoices
WHERE "userId" = $1 AND status = 'PENDING';

-- Paid total (cash in)
SELECT COALESCE(SUM(
  ROUND(("totalAmount"::numeric * 100)::bigint)
), 0) AS paid_total_paise
FROM invoices
WHERE "userId" = $1 AND status = 'PAID';

-- Expense outflows
SELECT COALESCE(SUM(
  ROUND((amount::numeric * 100)::bigint)
), 0) AS expense_total_paise
FROM expenses WHERE "userId" = $1;
```

We do **not** attempt to recompute per-line-item revenue/tax from invoice line items on every sweep. That is what the ledger IS — if AR, cash, and expenses reconcile, revenue+tax differences fall into a known category: "edited after issuance" (see Drift Taxonomy below). Recomputing tax from line items is a quarterly audit job, not a frequent reconciler.

### Currency handling

SmartBill is single-currency per tenant (set in `settings.currency`). The reconciler resolves the tenant's subunit divisor via `toSubunit()` in `src/lib/money.ts` (which is already wired for arbitrary currencies, default INR). Multi-currency ledgers would add a `currency` GROUP BY, but that's a future problem.

### Tolerance

Zero tolerance (exact paise match) for AR, CASH, EXPENSES. These are asset/cash accounts where a one-paise mismatch is a bug. For REVENUE/TAX we allow zero tolerance but tag the source of any delta with a `DriftKind` enum (see below).

---

## Drift Taxonomy

Not all mismatches are equal. Classifying them drives remediation and alert routing:

```ts
type DriftKind =
  // Severe: cryptographic chain broken. Possible silent tampering, disk corruption,
  // or a superuser migration that bypassed the append-only trigger.
  | "HASH_CHAIN_BROKEN"
  // Severe: tail pointer desync. lastLedgerEntryHash doesn't match the actual tail.
  // Usually a bug in posting logic or a partial commit.
  | "TAIL_POINTER_DESYNC"
  // Severe: an eventId doesn't balance (ΣD ≠ ΣC). The trigger was bypassed or disabled.
  | "UNBALANCED_EVENT"
  // High: AR ledger balance doesn't match open PENDING total. Could be a missing
  // PAYMENT_REVERSED, a missed INVOICE_PAID, or a superuser status update bypassing
  // the ledger helper.
  | "AR_MISMATCH"
  // High: cash ledger doesn't match Σ PAID total.
  | "CASH_MISMATCH"
  // High: expense ledger doesn't match Σ expenses.
  | "EXPENSE_MISMATCH"
  // Medium: gaps in entryIndex (rows deleted).
  | "ENTRY_INDEX_GAP"
  // Medium: REVENUE/TAX mismatch — most often caused by editing totals/discounts/tax
  // on an already-issued invoice (which we permit in the UI but don't propagate to
  // the ledger because the ledger is append-only). Actionable: warn operator to
  // void+reissue.
  | "REVENUE_TAX_MISMATCH"
  // Informational: last run failed with transient error (DB connection, timeout);
  // does not trigger quarantine.
  | "TRANSIENT_ERROR";

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
```

Severity map:
- CRITICAL → HASH_CHAIN_BROKEN, UNBALANCED_EVENT, TAIL_POINTER_DESYNC
- HIGH → AR_MISMATCH, CASH_MISMATCH, EXPENSE_MISMATCH, ENTRY_INDEX_GAP
- MEDIUM → REVENUE_TAX_MISMATCH (known edit-after-issue drift)
- INFO → TRANSIENT_ERROR

---

## Schema Additions

### `ReconciliationAudit`

```prisma
enum ReconciliationStatus {
  PASSED             // Both sweeps clean
  DRIFT_DETECTED     // One or more mismatches (see DriftKind)
  HASH_BROKEN        // Cryptographic failure (subset of DRIFT, but separated for fast filtering)
  TRANSIENT_FAILURE  // DB timeout / connection / bug in verifier; not drift
}

model ReconciliationAudit {
  id               String                @id @default(cuid())
  tenantId         String                // userId
  startedAt        DateTime              @default(now())
  finishedAt       DateTime?
  durationMs       Int?
  status           ReconciliationStatus
  // Sweep A: chain integrity
  entriesScanned   Int                   @default(0)
  firstBrokenIndex Int?
  // Sweep B: balance cross-check results. Paired arrays of account name with expected/actual/diff in paise.
  // Stored as JSONB (PG) / Json (Prisma) — variable shape per account, queried by operator UI only.
  discrepancies    Json?                 // Array<{ kind: DriftKind; account?: string; expectedPaise: string; actualPaise: string; diffPaise: string; detail?: string }>
  // Number of discrepancies of each severity.
  criticalCount    Int                   @default(0)
  highCount        Int                   @default(0)
  mediumCount      Int                   @default(0)
  // For idempotency/alert dedupe: see §Alerting.
  triggeredAlert   Boolean               @default(false)
  // Worker identity (like webhook-ingestion lockedBy)
  workerId         String?
  // Version of the reconciler that produced this row (for rolling-upgrade debuggability).
  version          String                @default("1")

  tenant           User                  @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId, startedAt])
  @@index([status, startedAt])
  @@index([criticalCount, highCount])    // fast lookup for "any open critical drift"
  @@map("reconciliation_audits")
}
```

### User quarantine column

```prisma
model User {
  // ...existing fields...
  // Set when reconciler detects CRITICAL/HIGH drift. When non-null:
  //  - All financial writes (invoice create/pay/void, expense create, ledger posts)
  //    are refused at the withTenant/postLedgerEvent layer.
  //  - Reads continue to work; login/UI continue to work.
  //  - Only an operator via admin/quarantine-release endpoint can clear this.
  ledgerQuarantinedAt DateTime?
  ledgerQuarantineReason String?        // DriftKind that caused quarantine
  // Last reconciler-run timestamp regardless of status (for "never reconciled" UI badge).
  lastReconciledAt   DateTime?

  reconciliationAudits ReconciliationAudit[]
}
```

Why timestamp+reason rather than a boolean: auditability. A quarantine event has a time and cause; you can see stale quarantines; you can distinguish "auto-quarantined by reconciler" from "manually quarantined by support."

### Quarantine guard DDL/SQL

We enforce quarantine at **three** layers:

1. **Application layer:** `withTenant` refuses to start if `users.ledgerQuarantinedAt IS NOT NULL`, with a specific error code `LEDGER_QUARANTINED` (so the UI can render a "Your account is under financial review" page).
2. **RLS policy layer** (defense against any code path that forgets #1): add a `block_quarantined_writes` policy or, more simply, a `BEFORE INSERT OR UPDATE OR DELETE` trigger on all financial tables (invoices, expenses, ledger_entries, invoice_items) that raises if `current_setting('app.current_user_id', true)` resolves to a quarantined tenant. This is belt-and-suspenders against application bugs.
3. **Ledger posting helper:** `postLedgerEvent` and `postLedgerEvents` check quarantine before acquiring the advisory lock, short-circuiting with the same error.

```sql
-- Trigger function for financial tables.
CREATE OR REPLACE FUNCTION ledger_quarantine_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  uid text;
  quarantined timestamptz;
BEGIN
  uid := current_setting('app.current_user_id', true);
  IF uid IS NULL OR uid = '' THEN
    RETURN COALESCE(NEW, OLD);  -- service/superuser path (migrations, backfill) unaffected
  END IF;
  SELECT "ledgerQuarantinedAt" INTO quarantined FROM users WHERE id = uid;
  IF quarantined IS NOT NULL THEN
    RAISE EXCEPTION 'Ledger is quarantined for tenant % (since %). Financial writes blocked.',
      uid, quarantined
      USING ERRCODE = 'L0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$;

-- Applied to: invoices, invoice_items, expenses, ledger_entries, recurring_profiles.
-- Not applied to: invoice_activities (append-only audit trail), clients, settings,
--                 users (must be updatable to clear quarantine), webhook_ingestions.
CREATE TRIGGER ledger_quarantine_trigger_invoices
BEFORE INSERT OR UPDATE OR DELETE ON invoices
FOR EACH ROW EXECUTE FUNCTION ledger_quarantine_guard();
-- (Repeat for other financial tables.)
```

Note: the quarantine trigger does NOT fire when `app.current_user_id` is not set — service_role discovery paths and superuser migrations can still operate (e.g., to run the reconciler itself, or to clear quarantine after remediation). The reconciler runs as service_role without SET `app.current_user_id` for reads, and it explicitly whitelists its write to `users.ledgerQuarantinedAt`/`ReconciliationAudit` as part of the service path.

---

## Reconciliation Worker

### Entry point

`src/lib/reconciler.ts` exposes:

```ts
interface ReconcileOptions {
  tenantId?: string;      // reconcile one tenant; undefined = all
  force?: boolean;        // ignore min interval between runs
  batchSize?: number;    // cursor batch; default 500
}

interface ReconcileResult {
  tenantId: string;
  status: ReconciliationStatus;
  durationMs: number;
  entriesScanned: number;
  discrepancies: Discrepancy[];
  quarantined: boolean;  // true if this run flipped the tenant into quarantine
}

export async function reconcileTenant(
  tenantId: string,
  opts?: Omit<ReconcileOptions, 'tenantId'>
): Promise<ReconcileResult>;

export async function reconcileAllTenants(
  opts?: Omit<ReconcileOptions, 'tenantId'>
): Promise<ReconcileResult[]>;
```

### Cron schedule

- **Lightweight frequent pass:** every 15 minutes, reconcile tenants with activity since last run (`lastLedgerEntryHash` changed or `lastReconciledAt` is null / > 24h old). Caps at 20 tenants per tick.
- **Full sweep:** nightly at 03:00 IST (off-peak), reconcile every tenant.

`vercel.json` additions:

```json
{ "path": "/api/cron/reconcile?mode=incremental&limit=20", "schedule": "*/15 * * * *" },
{ "path": "/api/cron/reconcile?mode=full", "schedule": "0 3 * * *" }
```

### Execution flow per tenant (pseudocode)

```
start audit row (PENDING/startedAt)
read user: { lastLedgerEntryHash, ledgerQuarantinedAt }

run Sweep A streaming (cursor batches, compute hashes, accumulate per-event balances)
run Sweep B SQL aggregates
compare ledger balances vs read-model balances → Discrepancy[]
classify each discrepancy → DriftKind + Severity

commit audit row (status, discrepancies, counts, durationMs)
update user.lastReconciledAt

if (criticalCount + highCount > 0) and not already quarantined:
    SET user.ledgerQuarantinedAt = now(), ledgerQuarantineReason = worst DriftKind
    fire drift alerts (severity = CRITICAL/HIGH)
elif previously quarantined and now passes:
    // Don't auto-release. Quarantine requires operator action (see §Remediation).
    fire recovery-observability alert (INFO)
elif mediumCount > 0:
    fire daily-rollup alert (not paging)
```

### Running as service_role

```ts
await withService("maint:reconcile", async (tx) => {
  // All reads of ledger_entries, invoices, expenses go through tx with
  // app.service_name set (RLS allows cross-tenant SELECT).
  // Writes to reconciliation_audits + users.ledgerQuarantinedAt are allowed
  // via a specific policy (see below).
});
```

Additional RLS policy for audit writes:

```sql
-- Reconciliation audits are INSERT-only for service_role; SELECT for the tenant's own user.
ALTER TABLE reconciliation_audits ENABLE ROW LEVEL SECURITY;
CREATE POLICY recon_audit_insert_service ON reconciliation_audits
  FOR INSERT WITH CHECK (current_setting('app.service_name', true) = 'maint:reconcile');
CREATE POLICY recon_audit_select_tenant ON reconciliation_audits
  FOR SELECT USING ("tenantId" = current_setting('app.current_user_id', true));
-- UPDATE/DELETE revoked from app_user and service_role (append-only audit).
REVOKE UPDATE, DELETE ON reconciliation_audits FROM app_user, service_role, PUBLIC;
GRANT SELECT, INSERT ON reconciliation_audits TO app_user, service_role;
```

Users RLS must also allow `service_role` (in `maint:reconcile`) to SET `ledgerQuarantinedAt`/`ledgerQuarantineReason`/`lastReconciledAt` — we add these columns to the existing whitelist REVOKE/GRANT on users (currently sessionVersion/lastLedgerEntryHash/lastLedgerEntryId are the only writable columns).

---

## Memory & DB Timeout Mitigations (Sweep A Streaming in Depth)

This is the crux. Here's exactly how the streaming loop works:

```ts
const BATCH = 500;
let cursor = 0;                           // entryIndex high-water mark
let prevHash = GENESIS_HASH;
let scanned = 0;
const eventBalances = new Map<string, {d: bigint, c: bigint}>();
const discrepancies: Discrepancy[] = [];
let brokenHashAt: number | null = null;
let tailSeen: {hash: string, index: number} | null = null;

while (true) {
  const batch = await tx.ledgerEntry.findMany({
    where: { userId: tenantId, entryIndex: { gt: cursor } },
    orderBy: { entryIndex: "asc" },
    take: BATCH,
    select: { /* columns needed for hash + balances */ },
  });
  if (batch.length === 0) break;

  for (const row of batch) {
    // Hash chain check
    if (row.prevEntryHash !== prevHash) {
      discrepancies.push({ kind: "HASH_CHAIN_BROKEN", detail: `at index ${row.entryIndex}: expected prev=${prevHash.slice(0,12)}… got ${row.prevEntryHash.slice(0,12)}…` });
      if (!brokenHashAt) brokenHashAt = row.entryIndex;
      // Re-sync prevHash so we can continue collecting discrepancies further in the chain
      // (avoids cascading false-positives after the first break).
      prevHash = row.entryHash;
    } else {
      const canon = serializeForHash({ ...row, amountPaise: BigInt(row.amountPaise.toString()) });
      const expected = sha256Hex(prevHash + "|" + canon);
      if (expected !== row.entryHash) {
        discrepancies.push({ kind: "HASH_CHAIN_BROKEN", detail: `hash mismatch at index ${row.entryIndex}` });
        if (!brokenHashAt) brokenHashAt = row.entryIndex;
      }
      prevHash = row.entryHash;
    }
    // Per-event balance accumulator
    const bal = eventBalances.get(row.eventId) ?? { d: BigInt(0), c: BigInt(0) };
    if (row.side === "DEBIT") bal.d += BigInt(row.amountPaise.toString());
    else bal.c += BigInt(row.amountPaise.toString());
    eventBalances.set(row.eventId, bal);
    tailSeen = { hash: row.entryHash, index: row.entryIndex };
    scanned++;
  }
  cursor = batch[batch.length - 1].entryIndex;
  // Yield to event loop / avoid starving the conn pool; async iteration
  await new Promise(r => setImmediate(r));
}
```

- Memory per tenant: one running hash (32 bytes), one Map of in-flight event balances (bounded by the number of events straddling batch boundaries — typically zero for our posting helper, which puts all entries of one event contiguously, so eventBalances is almost always empty at batch boundaries because we finalize events once their entries don't extend into the next batch, which they never do when entries are contiguous).
- Worst-case memory: if an event had entries spread across batches, the worst case is one partial event of up to ~6 balances (our events have 2–5 entries each). Not a problem.
- Time: 50k rows at batch size 500 = 100 queries, each an index-only scan returning 500 rows (sub-ms on PG17). Total sweep A is well under 2 seconds per tenant.

**Why not a Postgres window function for hash chaining?**
`sha256` is available via `pgcrypto`, but:
1. Recursive window aggregation of a hash chain requires a recursive CTE or a custom aggregate. Plpgsql SHA256 over a window is doable but forces the entire scan into a single long-running query (harder to timeout, harder to cancel, no backpressure).
2. We'd duplicate the canonical serialization logic in PL/pgSQL — two implementations to keep in byte-level sync. Drift between verifier and poster is the exact class of bug the reconciler is meant to catch, so running the *same* `serializeForHash` and `sha256Hex` functions in Node (already imported from the posting code) eliminates that entire risk.
3. The application-level cursor loop adds ~50ms of overhead vs. a single SQL scan but buys us (a) early-but-exhaustive discrepancy collection, (b) streaming cancellation, (c) consistent reuse of the same canonical functions, (d) no pgcrypto dependency requirement.

**Why push balance aggregation to SQL?**
Balance sums are *grouped aggregates* (not sequential), they parallelize trivially, and they don't depend on row order. Doing them in a single SQL GROUP BY uses the database's highly optimized aggregation engine and avoids transferring all rows to Node. It also keeps the streaming loop (Sweep A) focused solely on the sequential problem only Node can do (hash chain verification).

This hybrid approach is the correct split of labor:
- Sequential/cryptographic/byte-exact work → streaming Node cursor.
- Parallel/aggregate/statistical work → single SQL aggregation.

---

## Quarantine & Remediation Protocol

### Automatic actions on CRITICAL/HIGH drift

1. **Immediately** set `users.ledgerQuarantinedAt = now()`, `ledgerQuarantineReason = <worst DriftKind>` in the same audit-tx.
2. **Block financial writes** at three layers:
   - The `postLedgerEvent` helper refuses posts for quarantined tenants (throws `LedgerQuarantinedError`).
   - `withTenant` checks quarantine on entry for any tx requesting write access (reads still allowed so the operator can diagnose).
   - The `ledger_quarantine_guard()` trigger refuses INSERT/UPDATE/DELETE on financial tables as last-resort.
3. **DLQ webhook processing pauses** for this tenant. The cron webhook worker checks `users.ledgerQuarantinedAt` before dispatching events to processStripeEvent etc.; events for a quarantined tenant remain in `webhook_ingestions` with status='PENDING' and a distinct `lastError` reason `tenant_quarantined`, ready to be reprocessed after release. (Do NOT mark them failed — they're valid events on hold.)
4. **Reads and login continue to work.** The merchant sees a banner "Your account is under financial review" instead of 500s. Outstanding invoices remain payable (we don't want customer-facing payments to disappear), but receipt recording (ledger posts) is queued in webhook_ingestions (which they already are).
5. **Alert fires once**, with a cooldown.

### Operator actions

- `POST /api/admin/ledger/:tenantId/quarantine` — manual quarantine (force).
- `POST /api/admin/ledger/:tenantId/release` — release quarantine, gated behind:
  - A fresh reconciliation run that passes (both sweeps).
  - An operator `reason` note (audit trail).
  - Optional "force_release" flag for emergency override (recorded in audit).
- `POST /api/admin/ledger/:tenantId/backfill` — run `backfillLedger()` for the tenant (idempotent; re-posts missing events) then a reconcile. This is the most common remediation for missed postings (AR_MISMATCH/CASH_MISMATCH from buggy transitions).
- `GET /api/admin/ledger/:tenantId/audit` — list audit history.
- Admin endpoints authenticated with `CRON_SECRET` (same pattern as DLQ admin).

### Auto-remediation: when to backfill automatically vs. page a human

| DriftKind | Auto-action |
|---|---|
| REVENUE_TAX_MISMATCH (edited after issuance) | None (page daily rollup; operator must void+reissue) |
| AR_MISMATCH / CASH_MISMATCH / EXPENSE_MISMATCH | Auto-run backfill once; if drift persists after backfill → quarantine + page human |
| ENTRY_INDEX_GAP | Quarantine + page (rows were physically deleted; requires data recovery) |
| HASH_CHAIN_BROKEN / UNBALANCED_EVENT / TAIL_POINTER_DESYNC | Quarantine immediately, page CRITICAL — cannot self-heal |
| TRANSIENT_ERROR | No quarantine; retry next run |

The one-shot auto-backfill is run in the same reconciler tick, guarded so it doesn't loop. If after backfill a second verify passes, quarantine is not engaged and the audit is marked as `PASSED` with `"autoRemediated": true`. If it still fails, we escalate.

---

## Alerting

Reuses the `registerDlqAlertHook` pattern from Batch 6 — a dedicated hook registry for ledger drift:

```ts
// src/lib/ledger-alerts.ts
type DriftAlertHook = (payload: {
  tenantId: string;
  tenantEmail?: string;
  severity: Severity;
  worstKind: DriftKind;
  auditId: string;
  criticalCount: number;
  highCount: number;
  discrepancies: Discrepancy[];
  quarantined: boolean;
}) => void | Promise<void>;
```

Default hook emits structured stderr `[ledger-drift-alert]` lines with severity prefix. Hooks run inline after the audit row is committed.

**Alert cooldown (anti-spam):**
- CRITICAL alerts fire at most once per tenant per 60 minutes.
- HIGH alerts fire at most once per tenant per 6 hours.
- MEDIUM (REVENUE_TAX_MISMATCH) rolls up into a daily summary, never pages.

Cooldown state is implicit in the audit table: "fired an alert for this tenant at severity ≥ X within the last Y minutes?" is a single SQL query, no Redis required. If the most recent CRITICAL audit with `triggeredAlert=true` is within cooldown, skip (still record the audit with `triggeredAlert=false`).

**Severity routing expectation (to be wired by ops):**
- CRITICAL → PagerDuty/SMS/on-call immediately.
- HIGH → PagerDuty during business hours, Slack channel always.
- MEDIUM → Daily Slack digest email.
- INFO → Log only.

---

## Idempotency, Concurrency, and Cron Safety

1. **No concurrent reconciles per tenant.** We take a per-tenant advisory lock (separate namespace from the ledger posting lock) at the start of each run, e.g., `pg_advisory_xact_lock(1397772901, fnv1a(tenantId))`. A concurrent trigger (e.g., full sweep + incremental overlapping) simply skips.
2. **Audit rows are append-only.** They are never UPDATEd except to set `finishedAt`/`durationMs` at the end of the same run. A crashed reconciler leaves an audit row with `finishedAt = NULL` (which a UI will flag as "last run interrupted").
3. **In-progress quarantine.** We only write quarantine after ALL discrepancies have been collected and the audit row is ready to commit. Quarantine + audit happen in the same tx; there is no state where a tenant is quarantined without an audit explaining why.
4. **Backfill during reconcile is a separate service-context tx.** If auto-backfill is triggered, it runs inside a nested transaction-context with app_user per-tenant; after backfill returns successfully, we re-run Sweep A+B inside the reconcile tx to confirm the fix.
5. **Reconciler runs do NOT block ledger writes** (unless quarantine is decided at the end). The `(userId, entryIndex)` range scan uses index-only reads without `FOR UPDATE`, so it does not contend with `postLedgerEvent`'s advisory lock.

---

## Trade-off Analysis

| Decision | Alternatives considered | Why chosen |
|---|---|---|
| Stream Sweep A in Node (cursor batches) | Single SQL window aggregate; load-all-into-memory; plpgsql function | Node streaming (a) reuses the *exact same* canonical/hash functions as the poster (no byte-drift between writer and verifier), (b) keeps memory bounded, (c) avoids pgcrypto dep, (d) each batch is short → no vacuum/lock issues. |
| SQL aggregates for Sweep B | Stream-balance in Node too; materialized view refreshed on trigger | Aggregates are GROUP BY not sequential; SQL is strictly faster and simpler; a materialized view adds write overhead to every ledger post. |
| Quarantine at three layers (helper + withTenant + PG trigger) | Just one layer; admin-only flag; RLS-only | Any single layer can be bypassed by a bug. Helper gives nice errors, withTenant gates early, trigger is un-bypassable even via raw SQL. |
| Append-only `ReconciliationAudit` table | Log-only (no persistence); metrics-only | Required for compliance/audit; gives us the dedupe/cool-down state for alerting; feeds operator UI. |
| Auto-backfill for AR/CASH mismatches; quarantine for hash breaks | Always auto-fix; always quarantine immediately | Hash breaks / unbalanced events cannot be auto-fixed (possible tampering). AR mismatches are usually just missed postings from a bug — safe to attempt a fix once before escalating. |
| Cron-triggered reconciliation (pull) | Event-driven (trigger on every ledger post) | Ledger writes happen many times per second; a verify-per-write multiplies CPU cost and introduces synchronous latency. Scheduled reconciliation provides SLO-bounded detection (≤15 min) with predictable cost. Event-driven verification is the `postLedgerEvent` hash chaining itself — the chain's self-verifying property already catches tamper *at write time*; the reconciler catches drift that accumulates after the fact. |
| Batch size 500 | Batch size 100 / 1000 / 10000 | 500 balances round-trip latency (<5ms) vs. memory per batch. 100 → too many round trips. 10000 → risk of larger I/O spikes during full sweep. 500 is the sweet spot on PG17 with our row width. Made configurable. |
| Quarantine blocks writes but not reads/ login | Block everything (logout); read-only mode with UI mask | Blocking reads would hide data from the merchant during an incident and make diagnosis harder. Blocking writes prevents further financial damage (more invoices / false payments posting to a drifted ledger) while letting the operator investigate. Customer-facing payments still land in webhook_ingestions (queued), so no customer payments are lost. |
| No auto-release from quarantine | Auto-release after a clean run | Quarantine must be an intentional human decision. If a transient DB glitch caused the quarantine, a clean run notifies the operator but doesn't silently resume financial writes (in case the drift was actually real but the verifier missed it on re-run due to a race). |
| `reconciliation_audits` not tenant-RLS-isolated for writes (uses service_role) | withTenant per audit write | The reconciler runs cross-tenant; withTenant would require SET ROLE churn per tenant. The service-role insert policy restricts writes to service_name='maint:reconcile'; tenants see only their own rows via SELECT policy. |

---

## Files to be Added / Modified

**New files:**
- `src/lib/reconciler.ts` — core engine (streaming Sweep A, SQL Sweep B, audit writes, quarantine flagging, auto-backfill).
- `src/lib/reconciler-alerts.ts` — hook registry, cooldown logic, default stderr logger.
- `src/app/api/cron/reconcile/route.ts` — Vercel cron entry (incremental + full modes).
- `src/app/api/admin/ledger/[tenantId]/quarantine/route.ts` — manual quarantine/release/backfill.
- `src/app/api/admin/ledger/[tenantId]/audit/route.ts` — audit history listing.
- `prisma/reconciler.sql` — CREATEs for `ledger_quarantine_guard` trigger, `reconciliation_audits` RLS policies, column whitelist expansion on `users`.
- `docs/RECONCILER-ARCHITECTURE.md` (this document).

**Modified files:**
- `prisma/schema.prisma` — add `ReconciliationAudit`, `ReconciliationStatus` enum, quarantine columns on `User`.
- `prisma/rls-setup.sql` / `prisma/service-role.sql` — expand user column whitelist to include quarantine columns; add RLS for `reconciliation_audits`; grant INSERT on audits to service_role.
- `src/lib/ledger.ts` — quarantine short-circuit in `postLedgerEvent`/`postLedgerEvents` before acquiring advisory lock; export `serializeForHash` for reuse.
- `src/lib/tenant.ts` — quarantine check that throws `LedgerQuarantinedError` for any mutating callback (we allow reads for quarantined tenants; we add an `opts: { allowQuarantinedRead?: boolean }` flag).
- `src/lib/webhook-processors.ts` or process-webhooks cron — check quarantine before dispatching events for a tenant; leave PENDING in queue with `lastError='tenant_quarantined'`.
- `vercel.json` — two new cron schedules.

---

## Verification Plan (post-implementation)

1. **Unit tests** for `serializeForHash` byte-exactness (canonical test vectors covering each account/side/null fields).
2. **Synthetic drift injection** (in dev only):
   - Flip one `entryHash` in DB directly → expect HASH_BROKEN, quarantine, alert.
   - Insert an unbalanced entry as superuser (bypass trigger by disabling trigger first) → expect UNBALANCED_EVENT.
   - Mark an invoice PAID directly via SQL (bypass ledger) → expect AR_MISMATCH, auto-backfill remediates.
   - Delete a ledger row as superuser → ENTRY_INDEX_GAP.
3. **Scale test:** generate 100k entries for a tenant, confirm Sweep A finishes in <5s with RSS <150 MB.
4. **Concurrency test:** run a reconcile while simultaneously posting 50 ledger events; confirm no deadlocks, reconcile finishes, no false positives.
5. **Trigger test:** as app_user, attempt an INSERT on invoices for a quarantined tenant → expect `L0001` error.
