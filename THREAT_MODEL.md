# SmartBill — Automated Ledger Drift & Integrity Reconciler
# Executive Security Architecture & STRIDE Threat Model

> **Document status:** Production (v1.0)
> **Component:** `/admin/ledger` console, `src/lib/reconciler.ts`, Postgres 17 kernel (RLS + trigger + advisory locks), Next.js 16 Server Actions, Stripe/Razorpay webhook workers.
> **Currency:** INR ₹, integer paise (BigInt), en-IN / Asia/Calcutta.
> **Principal proof artifact:** `src/lib/reconciler.test.ts` (Tests A–E) running in CI via `.github/workflows/production-readiness.yml` against a real `postgres:17-alpine` container.

---

## 1. Executive Security Summary

SmartBill processes double-entry bookkeeping events (invoice issuance, payments, voids, refunds, expenses) across thousands of multi-tenant Indian SMB tenants. A silent mutation of a ledger row or a cross-tenant data leak would cause regulatory, financial, and trust failure. The security architecture is therefore **fail-closed at every layer**, and the reconciler itself is modeled as a *third independent auditor* — not as a code path that trusts application-layer invariants.

### 1.1 Defense-in-Depth — Three Concertina Rings

```
┌──────────────────────────────────────────────────────────────────────────┐
│  EDGE LAYER (process boundary / Internet)                               │
│  • isSameOrigin() CSRF guard on cookie-auth state changes               │
│  • safeCompareSecrets() HMAC-SHA256 timing-safe secret compares         │
│    (double-HMAC, random per-process key, avoids length-Δ timing leak)   │
│  • assertMutationRateLimit() — Upstash Redis distributed sliding window │
│    (EVALSHA Lua, NOSCRIPT recovery, 1500ms abort); in-memory fallback  │
│  • Webhook HMAC verification (Stripe constructEvent, Razorpay S256)     │
│  • CI-hardened: tsc --noEmit + next build + Vitest A-E gates every PR   │
├──────────────────────────────────────────────────────────────────────────┤
│  APPLICATION ENGINE LAYER (Next.js Server Actions, Cron routes)         │
│  • withTenant() / withService() wrapped tx — app.current_user_id GUC   │
│    validated after SET LOCAL, no superuser access from handlers        │
│  • withRetry() Full-Jitter exponential backoff (P1001/P1002/P1008/P1017 │
│    /40001/ETIMEDOUT/ECONNRESET/EPIPE/AbortError only)                  │
│  • CircuitBreaker (5-failure trip / 30s cooldown; OPEN → 503 fast-fail) │
│  • assertReadWriteMode() — ReadOnlyModeError short-circuits writes      │
│    before DB/rate-limit; webhook cron returns 503+Retry-After:60       │
│  • BigInt integer-paise arithmetic — zero JS float math on money       │
│  • withSpan() AsyncLocalStorage W3C TraceContext envelope (stdout/err)  │
├──────────────────────────────────────────────────────────────────────────┤
│  DATABASE-KERNEL LAYER (Postgres 17)                                    │
│  • Asymmetric RLS: app_user NOINHERIT NOBYPASSRLS (tenant-scoped R/W),  │
│    service_role NOINHERIT NOBYPASSRLS (cross-tenant discovery, writes   │
│    only under WITH CHECK requiring app.current_user_id)                │
│  • SET LOCAL ROLE + SET LOCAL app.current_user_id auto-reset per tx   │
│    — impossible to leak a privileged role into a pooled connection     │
│  • Per-user pg_advisory_xact_lock namespaces: posting=1397772900,      │
│    reconcile=1397772901 — FNV-1a folded, lock-per-tenant, never queue   │
│  • AFTER INSERT per-statement ledger_assert_balanced_insert() enforces  │
│    ΣD ≡ ΣC in integer paise — impossible to post an unbalanced entry   │
│  • ledger_quarantine_guard() BEFORE trigger raises SQLSTATE L0001 on    │
│    ANY INSERT/UPDATE/DELETE against 6 financial tables for quarantined │
│    tenants — even a raw SQL escape is blocked at the kernel            │
│  • ledger_entries: INSERT/SELECT only (UPDATE/DELETE REVOKED);          │
│    reconciliation_audits: INSERT/SELECT only (no UPDATE/DELETE)        │
│  • SHA-256 hash chain: entryHash = SHA256(prevEntryHash|canonical);    │
│    users.lastLedgerEntryHash/Id updated atomically in the same tx     │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Trust Boundaries & Data Classification

| Boundary | Crossing mechanism | Auth primitive |
|---|---|---|
| Browser → Next.js Server Action | `use server` invocation over POST (RSC) | Session cookie + `isSameOrigin()` + `requireUser()` |
| Browser → Admin API (DLQ, quarantine, audit) | JSON fetch | Session + CSRF origin match + tenant regex |
| Cron scheduler → `/api/cron/*` | Fetch with `Authorization: Bearer …` or `?secret=` | `safeCompareSecrets(CRON_SECRET)` |
| Stripe/Razorpay/Resend → `/api/webhooks/*` | Signed HTTP POST | Provider HMAC (constructEvent / x-razorpay-signature) fail-closed |
| Server → Postgres | TCP 5432 | `smartbill` owner login; RLS downgrades every transaction via SET LOCAL ROLE |
| App → Upstash Redis | HTTPS REST | Bearer token, 1500ms AbortController, circuit breaker |

**Data classification (in-scope):**
- PII: tenant email, name, client names, invoice line items.
- Financial: ledger_entries (immutable), invoices/expenses (mutable, audited), paise amounts (BigInt).
- Secrets: argon2id password hashes (col `passwordHash`), resetToken (SHA-256 hashed before storage), webhook shared secrets, CRON_SECRET, AUTH_SECRET. No plaintext secrets are logged (telemetry `sanitizeAttributes` recurses Error/Dates/BigInts/Decimals, drops functions/symbols, breaks circular references).

---

## 2. STRIDE Threat Matrix

| # | STRIDE Threat | In-Scope Asset | Primary Mitigation | Verdict |
|---|---|---|---|---|
| S-1 | Webhook forgery (spoof provider) | `webhook_ingestions` queue & ledger | HMAC signature verification (Stripe `constructEvent`, Razorpay `verifyWebhookSignature`), fail-closed 401 when secret missing in prod | Mitigated |
| S-2 | Cron-job spoofing | `/api/cron/*` (process-webhooks, reconcile, generate-recurring, send-reminders, redrive-dlq) | `safeCompareSecrets` double-HMAC timing-safe compare; production 503 if `CRON_SECRET` unset | Mitigated |
| S-3 | Session/user spoofing via auth bypass | All `/admin` routes | NextAuth with argon2id hashed passwords; reset tokens SHA-256 hashed at rest; session-secret required | Mitigated (out of scope for reconciler; inherited from NextAuth) |
| T-1 | Silent ledger mutation (row tampering) | `ledger_entries` | SHA-256 hash chain + per-entry index gap detection + tail-pointer cross-check (Sweep A); CRITICAL drift auto-quarantines | Mitigated (Test C) |
| T-2 | Direct DB UPDATE/DELETE of ledger | `ledger_entries` table | `REVOKE UPDATE, DELETE` from PUBLIC/app_user/service_role; append-only; SQL trigger double-checks ΣD≡ΣC | Mitigated |
| T-3 | Tampering with audit history | `reconciliation_audits` | `REVOKE UPDATE, DELETE`; INSERT-only; reconciler writes once and never reads-back for state decisions | Mitigated |
| T-4 | Quarantine-flag bypass | `users.ledgerQuarantinedAt` | Three-layer quarantine: (1) in-app `assertNotQuarantined`, (2) RLS policies, (3) kernel `ledger_quarantine_guard()` trigger raising **L0001** BEFORE any INSERT/UPDATE/DELETE on 6 tables | Mitigated (Test C asserts L0001) |
| R-1 | Operator cover-up (silent quarantine release) | Audit log | Mandatory typed `auditNoteReason` (≤500 chars, trimmed) for quarantine/release/backfill; `force:true` path emits INFO audit with `Quarantine released (force): …` and subsequent auditOnly confirm run | Mitigated |
| R-2 | Failed-webhook replay / retry-forgery | DLQ & redrive endpoints | Per-webhook idempotency via `webhook_ingestions.idempotencyKey`; 5-attempt exponential backoff with DLQ; quarantine hold does NOT increment `attempts` | Mitigated |
| I-1 | Cross-tenant ledger leak | `getLedgerChainEntries`, audit history | Keyset cursor resolution uses `findFirst({ id, userId })` — foreign-tenant/malformed cursor returns terminal empty page (`{entries:[], nextCursor:null}`) preventing enumeration | Mitigated |
| I-2 | Tenant-id tampering in Server Actions | `tenantId` param | `/^[A-Za-z0-9_-]{1,128}$/` regex AND `session.user.id === tenantId`; mismatch → `redirect("/login")` (no differential response) | Mitigated |
| I-3 | Secret length/value enumeration via timing | `CRON_SECRET` / webhook compares | `safeCompareSecrets` HMAC-SHA256 both inputs with per-process random key then `crypto.timingSafeEqual` on fixed 32-byte digests; null/empty/non-string → early-return false to avoid throwing `RangeError` | Mitigated |
| I-4 | PII/secret leakage in logs/telemetry | stdout/stderr/OTel | `sanitizeAttributes` drops functions/symbols, stringifies bigints/Decimals, converts Errors to `{name,message,stack}`, breaks circular refs; no secret env vars ever interpolated into messages; client errors sanitized to user-friendly strings (no stack leakage) | Mitigated |
| D-1 | DB connection exhaustion / thundering herd | Prisma pool & Postgres | Keyset batch cap 200 (`clampLimit`); reconciler Sweep A streams at 500 rows/batch with tail-catch-up (max 5 iters) and `setImmediate` yields; CircuitBreaker fast-fails OPEN after 5 consecutive infra errors; `withRetry` uses Full-Jitter `Math.random()*min(max,base*2^n)` backoff | Mitigated |
| D-2 | Sustained rate-limit flood | Server Action budget | Distributed Upstash sliding-window 10/60s/user; in-memory fallback with 5-min sweep | Mitigated |
| D-3 | Webhook queue flood / poison-pill crash loop | Stripe/Razorpay ingest | Per-tenant quarantine hold leaves events `PENDING` (attempts not burned); max 5 attempts → DLQ; BATCH_SIZE=20 SKIP LOCKED claim; stale PROCESSING reaped per-run | Mitigated |
| D-4 | DR failover / maintenance storm | All write paths | `SMARTBILL_READ_ONLY=1|true` immediately throws `ReadOnlyModeError` in Server Actions, returns 503+Retry-After:60 from webhook cron, returns `[]` from `reconcileAllTenants` — zero queue damage during replica promotion | Mitigated |
| E-1 | ORM `where`-filter bypass (Prisma client escape) | Tenant tables | RLS at DB kernel enforces `app.current_user_id = userId` on every SELECT/INSERT/UPDATE/DELETE, independent of the ORM — missing `where` returns zero rows or errors | Mitigated |
| E-2 | Role-hijack across pooled connections | app_user / service_role roles | `SET LOCAL ROLE` / `SET LOCAL app.current_user_id` / `SET LOCAL app.service_name` auto-reset at transaction COMMIT/ROLLBACK; a leaked connection returns to the pool as superuser but every `withTenant/withService` wrapper re-issues SET LOCAL and asserts via a post-setter `current_setting()` check before running queries | Mitigated |
| E-3 | Forged service-context invocation | service_role powers | `enterService` issues SET LOCAL then asserts `current_setting('app.service_name', true)` equals the expected name; service_role writes still require `app.current_user_id` via WITH CHECK (asymmetric USING vs WITH CHECK) | Mitigated |
| E-4 | SQL injection via tenantId into advisory lock / GUC | `pg_advisory_xact_lock`, SET LOCAL | `SAFE_USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/` allow-list; `escapeStringLiteral` applied to interpolated values; advisory key is FNV-1a folded into bigint arithmetic, never interpolated as a string literal | Mitigated |
| E-5 | Crypto-sidechannel in secret compares | CRON_SECRET & webhook secrets | Double-HMAC pattern — unequal-length inputs never reach timingSafeEqual; RangeError impossible; per-process random HMAC key prevents cross-request correlation | Mitigated |

---

## 3. STRIDE Deep Dive

### 3.1 Spoofing (S)

**S-1 — Webhook Forgery.** Stripe webhooks enter at `/api/webhooks/stripe` and call `stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)` inside a try/catch; any thrown `StripeSignatureVerificationError` returns `401 Invalid signature` and the raw body is never dispatched. Razorpay enters at `/api/webhooks/razorpay` and is verified by `verifyWebhookSignature(rawBody, x-razorpay-signature, RAZORPAY_WEBHOOK_SECRET)` using HMAC-SHA256 constant-time compare. In **production**, missing webhook secrets return `503 Webhook signature verification misconfigured` rather than silently skipping verification (fail-closed).

**S-2 — Cron-Job Spoofing.** All `/api/cron/*` routes accept either `Authorization: Bearer <CRON_SECRET>` or `?secret=…`. The `safeCompareSecrets` function (in `src/lib/api-helpers.ts`) eliminates both classical timing attacks and the Node.js `RangeError` from `crypto.timingSafeEqual` on length-mismatched Buffers by HMAC-SHA256-ing both inputs with a per-process random 32-byte key (`SAFE_COMPARE_KEY`, zero-fill on entropy failure) before comparing — both digests are *always* 32 bytes regardless of input length. The function returns `false` on `null`/`undefined`/empty/non-string inputs without any branch over the secret.

> Note: An empty `CRON_SECRET` in development is tolerated (for local work), but in `NODE_ENV=production` the cron handlers return HTTP 503 and refuse to run.

### 3.2 Tampering (T)

**T-1 — Silent Ledger Mutation.** The ledger is an append-only SHA-256 hash chain: `entryHash = SHA256(prevEntryHash | eventId | eventType | account | side | amountPaise | invoiceId | expenseId | currency)` (pipe-delimited canonical form, defined in `serializeForHash`). Reconciler Sweep A walks entries by `entryIndex ASC` (keyset batch of 500, bounded tail-catch-up to 5 iterations) and recomputes each hash. Any bit flip, orphaned INSERT, missing row (index gap), or broken prevHash pointer immediately produces a CRITICAL discrepancy:

- `HASH_CHAIN_BROKEN`
- `TAIL_POINTER_DESYNC` (users.lastLedgerEntryHash ≠ tail entryHash)
- `UNBALANCED_EVENT` (Σ Debits ≠ Σ Credits per eventId, in addition to the Postgres `ledger_assert_balanced_insert()` AFTER-INSERT statement trigger enforcing this at commit time)
- `ENTRY_INDEX_GAP`

**T-2 — Direct DB UPDATE/DELETE.** `prisma/ledger.sql` revokes UPDATE/DELETE on `ledger_entries` from PUBLIC, app_user, and service_role. The table owner (`smartbill`) retains ownership-level DDL rights but the application never connects as superuser through a tenant or service tx. An operator with psql access can still mutate rows as superuser — that is a deliberate break-glass path, and Sweep A is precisely what detects such action.

**T-3 — Audit Tampering.** `reconciliation_audits` is INSERT-only (UPDATE/DELETE revoked at SQL layer in `prisma/reconciler.sql`). The reconciler does not use the audit table as a state machine — state is derived from the hash chain + read-model cross-checks on every run.

**T-4 — Quarantine Bypass.** The quarantine guard is implemented at three layers:
1. **In-app fast-fail** in `postLedgerEvent → assertNotQuarantined(userId)` before acquiring the advisory lock.
2. **RLS policy** blocks writes to quarantined users (defense).
3. **Kernel trigger** `ledger_quarantine_guard()` is attached dynamically (via a `DO $$` block) as a BEFORE INSERT OR UPDATE OR DELETE trigger to **all six** financial tables: `invoices`, `invoice_items`, `expenses`, `ledger_entries`, `recurring_profiles`, `recurring_items`. When `app.current_user_id` is non-empty AND the user has `ledgerQuarantinedAt NOT NULL`, it raises `SQLSTATE 'L0001'`. Empty/NULL GUC passes through (for migrations/backfills running as superuser).

Test C of `reconciler.test.ts` proves this end-to-end: after tampering with the hash chain the reconcile returns HASH_BROKEN, quarantines the tenant, and a subsequent direct DB INSERT attempt raises L0001.

### 3.3 Repudiation (R)

**R-1 — Operator Cover-Up.** Three invariants prevent silent operator action:
- `releaseTenantQuarantineAction` requires a non-empty `auditNoteReason` (≤500 chars, trimmed by `sanitizeNote`); zero-length returns `{ok:false, error:"An audit note is required before releasing quarantine."}` before touching rate-limit/DB.
- `quarantineTenantAction` requires a similar audit note.
- The `force:true` override path in `releaseQuarantine` always emits an explicit `reconciliation_audits` row with detail `Quarantine released (force): <note>` and immediately runs a confirm reconcile in **auditOnly** mode (which logs residual drift but does NOT re-quarantine and does NOT fire alerts) so force-releases leave a permanent two-entry paper trail.

The admin console UI (`src/app/(dashboard)/admin/ledger/_components/ledger-admin.tsx`) mandates an explicit typed note textarea + checked confirmation checkbox before enabling the "Release Quarantine" button when HIGH/CRITICAL drift is still present.

**R-2 — Webhook Retry/Redrive Integrity.** The webhook worker marks quarantine-held events as `PENDING` with `lastError='tenant_quarantined'` **without incrementing `attempts`** (`markQuarantineHold`), so an operator cannot accuse the system of having "used up" retries during an incident. DLQ entries accumulate per-provider, per-tenant, per-event audit rows; the DLQ redrive endpoint requires CRON_SECRET and produces an INFO audit row on re-drive.

### 3.4 Information Disclosure (I)

**I-1 — Keyset-Cursor Tenant Enumeration.** `getLedgerChainEntries(tenantId, opts)` (in `actions.ts`):
- Cursors are validated against `^[A-Za-z0-9_-]{1,128}$/` (CUID shape).
- Resolution uses `prisma.ledgerEntry.findFirst({ where: { id: cursor, userId: tenantId } })` — the cursor row **must** belong to the requesting tenant; any missing/foreign-tenant cursor returns a terminal empty page `{entries:[], nextCursor:null}` after a single `console.error`.
- The same clamp + userId-scope applies to `listReconciliationAudits`.

This prevents the classical BOLA/IDOR where a cursor like `clg_ABC` leaking from one tenant returns the next page of another tenant's hash chain.

**I-2 — TenantId Mutation in Server Actions.** `ensureTenant(sessionUserId, tenantId)` requires both the regex and `session.user.id === tenantId`; any failure calls `redirect("/login")` — no differential 403/404 that leaks whether a tenantId exists.

**I-3 — Timing-Safe Secret Compares.** Documented under S-2. The double-HMAC construction means an attacker cannot distinguish "empty secret" from "wrong secret" from "right secret" via response latency, and cannot crash the compare path with empty strings or non-string inputs.

**I-4 — Log/Telemetry Hygiene.** The OTel wrapper in `src/lib/telemetry.ts` sanitizes attributes through `sanitizeAttribute`, which:
- Converts `BigInt` to string, `Date` to ISO-8601, `Error` to `{name,message,stack?}`, Prisma-Decimal-like values via `.toString()`.
- Replaces `NaN`/`Infinity`/invalid Dates with `null`.
- Drops `function` and `symbol` values (undefined → stripped by JSON.stringify).
- Detects circular references via a `WeakSet`, replacing them with `"[Circular]"` instead of throwing.

Client-thrown errors from Server Actions are mapped through `toError(err)` which returns `err.message` (never the stack) for toast display. Only server-side `console.error("[namespace]", err)` includes stack traces, and these never reach the browser.

### 3.5 Denial of Service (D)

**D-1 — DB Connection Exhaustion.**
- The reconciler reads chains in keyset batches of 500 rows (`DEFAULT_BATCH = 500`), bounded by `TAIL_CATCHUP_MAX_ITERS = 5`, yielding to the event loop via `setImmediate` between batches.
- Pagination `limit` is clamped to `[1, 200]` via `clampLimit()` on both the chain and audit listing entry points; the client component caps refresh to `min(max(currentCount,50), CHAIN_FETCH_MAX=200)`.
- `pg_advisory_xact_lock` is used for posting (namespace `1397772900n`). The reconciler uses `pg_try_advisory_xact_lock` (namespace `1397772901n`, non-blocking) so concurrent reconciles bail fast with a TRANSIENT_FAILURE audit row rather than queueing behind each other.
- The `CircuitBreaker` (`src/lib/circuit-breaker.ts`) trips OPEN after 5 consecutive transient infrastructure failures (P1001/P1002/P1008/P1017/40001/ETIMEDOUT/ECONNRESET/EPIPE/AbortError/fetch-failed) for 30 seconds; OPEN state throws `CircuitBreakerOpenError` immediately without issuing any network/DB call. A half-open probe resets to CLOSED on success or re-trips on failure. Permanent errors (P2xxx unique/constraint, L0001, LedgerQuarantinedError, ZodError, TypeError) do NOT count toward the breaker threshold, preventing application bugs from masking healthy infrastructure.
- `withRetry` uses **Full Jitter** exponential backoff (`Math.random() * Math.min(maxDelayMs, baseDelayMs*2**attempt)`), which eliminates thundering-herd retries across multi-instance deployments.

**D-2 — Server Action Rate Limiting.** `assertMutationRateLimit(userId)` (in `src/lib/rate-limiter.ts`) implements a true 10-requests/60-seconds sliding window. When Upstash is configured it issues a single EVALSHA against Redis (Lua sliding window using ZSET + ZREMRANGEBYSCORE + PEXPIRE, NOSCRIPT auto-recovery, 1500ms AbortController timeout); on any failure (timeout, DNS, 5xx) it transparently falls back to an in-process Map with a 5-minute sweep and logs once per process. No request is ever failed because the rate-limiter backend is down.

**D-3 — Webhook Flood / Poison Pill.**
- Stale PROCESSING claims are reaped at the start of every cron run (`reapStaleClaims`).
- Up to `BATCH_SIZE=20` due rows are claimed via `SKIP LOCKED` (never blocks).
- Per-tenant quarantine short-circuits before processing (`isTenantQuarantined` + `markQuarantineHold`) — payments queue safely until the operator releases.
- Retries use exponential backoff (`markRetry`); after 5 attempts the row is moved to DLQ rather than looping forever.

**D-4 — Disaster Recovery Maintenance.** Setting `SMARTBILL_READ_ONLY=1` or `SMARTBILL_READ_ONLY=true` (case-insensitive, trimmed; any other value → read-write) activates:
- `assertReadWriteMode(op)` throws `ReadOnlyModeError` **before** rate-limit/DB work in the four admin mutations (reconcile/release/quarantine/backfill).
- `/api/cron/process-webhooks` immediately returns HTTP 503 with `Retry-After: 60`, leaving all events in PENDING with zero attempts burned.
- `reconcileAllTenants` returns `[]` (no audit writes, no quarantine flips, no auto-backfills).
- `reconcileTenant` throws `ReadOnlyModeError` (so cron single-tenant runs, force-release, and operator backfill all fail closed).
- Read-only paths (`loadMoreLedgerEntriesAction`, GET of the admin console, invoice viewers, PDF statements) continue to function normally.

### 3.6 Elevation of Privilege (E)

**E-1 — ORM `where` Bypass.** Prisma's `prisma.ledgerEntry.findMany({ where: { userId } })` is a convenience, NOT a security boundary. Row-Level Security in the Postgres kernel enforces `(app.current_user_id = userId)` on every SELECT/INSERT/UPDATE/DELETE, regardless of whether the ORM included a `where` clause. A future bug that omits `userId` in a filter will silently return zero rows (or error on writes), not return another tenant's data.

**E-2 — Pooled-Connection Role Hijack.** The connection pool runs as superuser `smartbill`, but every tenant-facing transaction MUST call `SET LOCAL ROLE app_user` + `SET LOCAL app.current_user_id = '<userId>'`. `SET LOCAL` (not `SET`) applies only to the **current transaction** and is automatically reverted at COMMIT/ROLLBACK. There is no way to leak the elevated role to the next request that reuses the same TCP connection — even if an exception escapes the wrapper. `withTenant`/`withService` issue a post-setter assertion (`SELECT current_setting('app.current_user_id', true)`) and throw `RLS assertion failed` if the GUC is not exactly the expected user, so a failed `SET LOCAL` (e.g., role doesn't exist) never allows queries to proceed as superuser.

**E-3 — Asymmetric service_role Grants.** `service_role` is granted SELECT/INSERT/UPDATE/DELETE on tenant tables for cross-tenant discovery (reconciler needs to enumerate users), but its RLS policies use an asymmetric OR-clause:
- `USING` (read side): permits access when `app.current_user_id = userId` **OR** `current_setting('app.service_name', true) <> ''` (service reads).
- `WITH CHECK` (write side): ONLY permits writes when `app.current_user_id = userId`. The reconciler therefore sets `app.current_user_id` *inside* the service tx before writing quarantine flags. A cron bug that forgets to SET LOCAL `app.current_user_id` can READ cross-tenant (needed for enumeration) but CANNOT WRITE cross-tenant, and reads leave no audit trail of cross-tenant access beyond what the operator explicitly invoked.

**E-4 — SQL Injection via tenantId.** All raw `$executeRawUnsafe` interpolations of user-controlled identifiers (tenantId) are pre-validated against `SAFE_USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/`, passed through `escapeStringLiteral` (doubling single quotes and backslashes), and the advisory-lock key is computed arithmetically (BigInt multiplication + FNV-1a fold) — never as a string literal — so the lock key is always a 64-bit integer constant expression.

**E-5 — Crypto Side Channels.** See S-2/I-3: `safeCompareSecrets` double-HMAC pattern. Passwords are stored with `argon2` (argon2id, memory-hard), not with a fast hash. Reset tokens are stored SHA-256 hashed in `users.resetToken`; the raw token is only returned once in the reset email link.

---

## 4. OWASP API Security Top 10 (2023) — Mitigation Mapping

| OWASP API Risk | SmartBill Mitigation | Code Reference | Vitest/CI Proof |
|---|---|---|---|
| **API1:2023 Broken Object Level Authorization** | TenantId regex + session equality; cursor resolution scoped to `{id, userId}`; RLS at DB enforces it as defense-in-depth | `mutations.ts:ensureTenant`, `actions.ts:getLedgerChainEntries` findFirst with userId, `prisma/rls-setup.sql` | Test A/B/C/D operate on a single tenant and cannot read other tenants; enforced at SQL layer |
| **API2:2023 Broken Authentication** | NextAuth argon2id; CRON_SECRET double-HMAC timing-safe; all cookie state changes gated by `isSameOrigin()` | `auth.ts`, `api-helpers.ts:safeCompareSecrets`, `csrf.ts:isSameOrigin` | `npx next build` + tsc strict eliminate reference mistakes |
| **API3:2023 Broken Object Property Level Authorization** | Column-level REVOKE on `users` (name/email/passwordHash/resetToken/resetTokenExpires/createdAt cannot be UPDATEd by app_user); sanitized Server Action inputs (note truncation, limit clamping) | `prisma/rls-setup.sql` REVOKE list, `mutations.ts:sanitizeNote/clampLimit` | — |
| **API4:2023 Unrestricted Resource Consumption** | `clampLimit([1,200])` on pagination and audit listings; Upstash sliding-window 10/60s/user; reconciler batch streaming (500 rows × 5 iters) with setImmediate yields; `CircuitBreaker` OPEN fast-fail; webhook BATCH_SIZE=20 SKIP LOCKED | `actions.ts:clampLimit`, `rate-limiter.ts`, `circuit-breaker.ts`, `reconciler.ts:DEFAULT_BATCH`, `process-webhooks/route.ts:BATCH_SIZE=20` | CI runs the full reconcile on a populated ledger with sub-second duration |
| **API5:2023 Broken Function Level Authorization** | Server Actions call `requireUser()` and re-validate tenant equality; admin-only `/api/admin/dlq`, `/api/admin/ledger-verify`, and quarantine HTTP routes gated by session + CRON_SECRET | `mutations.ts:requireUser`, `src/app/api/admin/*` | — |
| **API6:2023 Unrestricted Access to Sensitive Business Flows** | Distributed rate-limiter applies to all five admin mutations; webhook signature verification fail-closed; full-jitter retry with circuit breaker prevents cascade | `rate-limiter.ts:assertMutationRateLimit`, `circuit-breaker.ts:withRetry+CircuitBreaker` | — |
| **API7:2023 Server Side Request Forgery** | No user-supplied URLs; all outbound HTTP is to pinned providers (Stripe/Razorpay/Resend/Upstash) with env-configured base URLs; fetch only uses known endpoints | `webhook-processors.ts`, `rate-limiter.ts:upstashFetch` | — |
| **API8:2023 Security Misconfiguration** | Production requires CRON_SECRET (cron routes 503 otherwise); drift-alert hook registered once; tsc `strict:true` + `noEmit`; `next build` fails on any type/schema error; `npx next build` in CI emits all routes | `reconcile/route.ts` CRON_SECRET check, `rate-limiter.ts` once-per-process fallback log, tsconfig.json `strict:true` | CI gates tsc + next build |
| **API9:2023 Improper Inventory Management** | Server Actions are enumerated in `mutations.ts`; cron routes in `src/app/api/cron/*`; deprecated endpoints are removed; OTel span names are dot-namespaced (`reconciler.sweep_a`, `admin/ledger:release-quarantine`) for inventory | `telemetry.ts:withSpan`, server action exports | — |
| **API10:2023 Unsafe Consumption of APIs** | Webhooks verify signatures BEFORE parsing the body as business events; Stripe/Razorpay constructEvent/verifySignature runs on the raw `request.text()` buffer; failures are caught and routed through retry/DLQ, never crash the worker | `src/app/api/webhooks/stripe/route.ts`, `src/app/api/webhooks/razorpay/route.ts`, `webhook-ingestion.ts:markRetry/markDone/markQuarantineHold` | — |

---

## 5. Automated Proof — Vitest Reconciler Invariants (Tests A–E)

All five invariants run on every PR via `.github/workflows/production-readiness.yml` against a `postgres:17-alpine` service container with the full SQL kernel (RLS, service_role grants, ledger balance trigger, quarantine guard) applied. They use `pool: "forks"` with `singleFork: true` so advisory locks serialize correctly.

| Test | Assertion | Threats proven |
|---|---|---|
| **A — Clean baseline** | Issuing + paying an invoice + recording an expense → reconcile returns `PASSED` with zero CRITICAL/HIGH/MEDIUM/INFO discrepancies; user is NOT quarantined. | T-1, T-4, I-1 |
| **B — Auto-backfill** | Deleting a ledger pair and re-running reconcile auto-remediates via `backfillLedgerForSingleTenant` INSIDE the REPEATABLE READ tx, returning PASSED with `autoRemediated: true`. | T-1, R-2 |
| **C — Hash tampering + quarantine + L0001** | Flipping an entry's side/amount produces `HASH_BROKEN` + CRITICAL count > 0; tenant is quarantined; subsequent direct INSERT raises SQLSTATE L0001; operator force-release with audit note clears the flag. | T-1, T-4, R-1 |
| **D — Force-release audit trail** | Force-release leaves a `(force)` INFO audit row, runs auditOnly confirm (does not re-quarantine); non-force release is refused when drift remains. | R-1 |
| **E — Void-after-partial-payment parity** | Partial payment (₹1000 on ₹2360) → void yields zero AR/CASH/EXPENSE/REVENUE_TAX mismatches; full pay (₹500) → void also yields PASSED; `resolveCashPaidForInvoice` reports correct net cash. | T-1 (correctness), financial integrity |

CI also independently runs `npm test -- src/lib/reconciler.test.ts` after `tsc --noEmit` and `next build` — so type drift, broken dynamic routes, or schema/SQL mismatches block merge before deploy.

---

## 6. Operational Security Posture

- **Fail-closed by default.** Missing CRON_SECRET → 503. Missing webhook secret → 503. RLS assertion fails → throws. Quarantine triggered → L0001 blocks writes. Circuit OPEN → fast-fail.
- **Zero float math.** All money arithmetic uses `BigInt` paise (integer subunit). Tax/discount calculations use integer cross-multiplication via `calcInvoiceTotals()`; Postgres `ROUND(amount::numeric * 100)` does the read-model aggregation; there is no IEEE-754 drift path between invoice totals and ledger.
- **Production upgrade path.** Prisma is pinned to `5.22.0` (Prisma 7 breaks datasource URL handling); Next 16.2.12 / React 19.2.4 are pinned; dependency upgrades require passing the full CI gate against a real Postgres 17.
- **No secrets in source.** `.env.example` contains placeholders only; reset tokens are SHA-256 hashed at rest; password reset links are single-use and expire.
- **Logging discipline.** `console.log/info` are stripped server-side; only `console.error("[namespace]", error)` remains. Client errors are sanitized to user-facing messages.
- **DR Mode.** `SMARTBILL_READ_ONLY=1` is a single kill switch for maintenance windows, failovers, and incident response. Reads stay up; writes fail closed with consistent, operator-visible feedback.

---

## 7. Residual Risks & Acknowledged Threats

| Risk | Severity | Rationale |
|---|---|---|
| Superuser (`smartbill`) psql access can bypass L0001 trigger (owner may ALTER TABLE DISABLE TRIGGER) | Critical — physical access | Mitigated operationally: superuser credentials are held by the break-glass runbook only; any such action leaves filesystem WAL audit trails and would be caught by the next Sweep A hash-chain walk. Not a software bug. |
| Dialog primitive lacks focus-trap/return-focus (admin UI) | Low — UX | Not a security boundary; the dialog is used for audit-note confirmation only and requires explicit click. Accepted for current milestone. |
| In-memory rate limiter fallback is per-process | Medium | Documented in `rate-limiter.ts`; Upstash deployment is the multi-instance configuration. The fallback is designed to degrade gracefully, not to fail open. |
| No Playwright/Jest-DOM e2e | Medium | Vitest integration suite covers all DB invariants at the Server-Action/kernel boundary; UI end-to-end coverage is scheduled as future work. |
| OTel envelope emits to stdout/stderr, not a native OTLP exporter | Low | Chosen deliberately for zero-dependency portability; any collector (Fluent Bit, Vector, Datadog agent, GCP Cloud Logging) can ship line-delimited JSON. Adding OTLP gRPC is a future enhancement. |

---

*Document maintained by SmartBill Engineering <eng@smartbill.in>. Reviewed alongside every reconciler/wiring PR and validated by CI.*
