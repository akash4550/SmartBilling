# SmartBill — V2

> Tamper-evident, multi-tenant billing SaaS for Indian SMBs. INR-first, paise-accurate, en-IN / Asia/Calcutta.

SmartBill is a production-grade billing platform engineered for correctness over velocity. Every financial write is append-only, every cross-process side effect runs under durable execution, and every dashboard read is served from a cache-aside CQRS projection that degrades gracefully. The codebase is intentionally small, boring, and auditable — there are no clever abstractions where a plain SQL query or a `try/catch` would do.

**Demo credentials:** `admin@smartbill.com` / `password123`

---

## 🧱 Architectural Pillars

SmartBill V2 is built on four orthogonal pillars. Each owns a single responsibility and communicates with the others through well-defined boundaries; swapping any one out (e.g., replacing Temporal with a different orchestrator, or swapping Upstash for a self-hosted Redis) does not ripple through the rest of the code.

### 1. Next.js 16 App Router — The UI Edge

- **React 19 + TypeScript (strict).** Zero `any`; strict TypeScript is a CI gate.
- **App Router + RSCs.** Server Components render dashboards straight from Postgres/Redis; Client Components are isolated to interactive surfaces and ship minimal JS.
- **Hand-rolled UI primitives** in `src/components/ui/` (Radix-free). Dialogs implement a WCAG 2.1 AA focus trap, Esc-dismiss, backdrop-click close, and guaranteed return-focus.
- **Server Actions** for mutations, paired with client-side optimistic UI, double-click hardening, and AbortController-based stale-response suppression.
- **Currency stack:** INR ₹, locale `en-IN`, timezone `Asia/Calcutta`. All monetary values are integer **paise** (`bigint`) at rest and in transit; Decimal → paise conversion happens once at the edge via `toSubunit()`. There is zero JS floating-point on money paths.
- **Security:** Argon2id password hashing, NextAuth v5 JWT sessions, `server-only` enforced for every data-access module, constant-time `crypto.timingSafeEqual` for webhook/cron secrets.

### 2. PostgreSQL 17 — The Tamper-Evident Immutable Ledger

The database is the source of truth. The application never trusts caches, queues, or even Temporal's state for a balance.

- **Prisma 5.22.0** as the typed query builder; raw SQL (`$queryRaw`) for aggregations and locks where Prisma's abstraction would hide intent.
- **Row-Level Security (RLS)** with a split-role model:
  - `app_user` — NOINHERIT / NOBYPASSRLS, scoped per request by `withTenant()` (`SET app.current_user_id`).
  - `service_role` — used by the Temporal worker and reconciler; never exposed to the request path.
- **Double-entry ledger** (`ledger_entries`): every payment, reversal, expense, void writes balanced DEBIT/CREDIT rows. Balances are recomputed, not stored, and cross-checked by the reconciler.
- **Hash chain:** each ledger entry carries `prevEntryHash` (SHA-256 of the prior entry's canonical form + the new row's content). A broken hash trips quarantine automatically.
- **Idempotency:** unique constraints on `(provider, providerEventId)` for webhook ingestions and on reversal `note` keys prevent double-counting across Temporal retries and Stripe redeliveries.
- **Quarantine mode:** on hash-broken or critical drift, the tenant is flipped to `ledgerQuarantinedAt`, writes are short-circuited *before* acquiring the advisory lock so customer webhooks queue in Temporal (not fail) and resume on release.

### 3. Temporal.io — Durable Execution & Saga Orchestration

The webhook pipeline (`/api/webhooks/stripe`) does **no business logic** on the request path. It verifies HMAC, reads the Stripe event id, and starts a Temporal workflow. That's it. End-to-end edge latency target: < 50 ms.

- **`processPaymentWebhook`** is the saga for every payment event (`checkout.session.completed`, `payment_intent.succeeded`):

  ```
  checkTenantQuarantine        → retries until tenant healthy
  resolveInvoiceForWebhook     → no match ⇒ terminal “noop”
  postLedgerEvent              ★ SACRED STEP (ledger commit)
  refreshTenantReadModel       → fire-and-forget, 3 short retries
  sendReceiptEmail             → best-effort, 8 retries, never compensates
  recordWebhookOutcome         → audit upsert, fire-and-forget
  ```

- **Deduplication:** workflow id = `wh:${provider}:${providerEventId}` with `WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE`. Stripe's at-least-once retries collapse to a single execution at the Temporal boundary — no application-layer deduplication required.
- **Retry policy:** per-activity exponential backoff (1 s → 30 s, coefficient 2) with a typed non-retryable set: `UnsupportedProvider`, `NoMatchingInvoice`, `InvoiceNotFound`, `PaymentNotApplicable`, `InvalidSignature`, `MalformedPayload`.
- **"The ledger is sacred."** Once `postLedgerEvent` returns, downstream failures (Redis outage, SMTP timeout, worker crash) **never** trigger a compensating `PAYMENT_REVERSED`. A missed receipt is an operator to-do, not an excuse to refund money. Email failures log a warning and resolve to `applied_email_failed` so support can re-send manually from the admin console.
- **Fail-closed security:** the HMAC bypass header `x-test-bypass-hmac` is honored **only** when `NODE_ENV` is `development` or `test`; any other environment returns `401 Unauthorized`.

### 4. Upstash Redis — CQRS Read Model

The admin dashboard's metric grid (open receivables, cash, paid totals, last-reconciled tail hash, 30-day run counts) is an expensive aggregation over invoices, expenses, ledger entries, and reconciliation audits — four `$queryRaw` scans per page load. We front this with a CQRS projection:

- **Key:** `rm:overview:<tenantId>` — single JSON blob; value shape matches `TenantAuditOverview` exactly (paise as strings for BigInt-safe JSON).
- **TTL:** 1 hour as a wall-clock safety net if the invalidation path ever misses an event.
- **Write path:** *only* the Temporal `refreshTenantReadModel` activity writes to Redis. Webhook routes and UI mutations never touch the cache directly — they ask Temporal to recompute + overwrite immediately after the ledger commit (before email) to narrow the stale-read window.
- **Read path (`getTenantOverview`):** cache-first → Redis miss/error transparently falls back to a Postgres recompute + best-effort write-back. A Redis outage is a latency event, never an availability event.
- **Single-flight stampede defense:** an in-memory `Promise` map collapses concurrent misses for the same tenant within a Node instance into a single Postgres aggregation. Cross-instance stampedes are blunted by Redis being hot.

---

## 🛡️ Race Conditions & Concurrency Controls

SmartBill treats race conditions as a first-class design problem, not a bug class. Each layer has its own defense because there is no single distributed lock that covers the stack.

### Postgres Advisory Locks (`pg_advisory_xact_lock`)

- **Write serialisation** in `src/lib/ledger.ts`: every mutating ledger operation (invoice paid, payment reversed, expense recorded, void) acquires a **per-tenant transaction-level advisory lock** before writing. The key is derived via FNV-1a over the user id in a dedicated namespace so it never collides with reconciler locks. This guarantees that even with N webhook workers firing concurrently, only one payment can commit for a tenant at a time — no `SKIP LOCKED` queues, no race-prone `UPDATE ... WHERE status='PENDING'` patterns.
- **Reconciler non-blocking lock** in `src/lib/reconciler.ts` uses `pg_try_advisory_xact_lock` in a *separate* namespace. If a reconcile is already running for a tenant, the caller gets `false` back and exits immediately rather than queuing — an operator clicking "Run Reconciler" three times in a row produces exactly one run.
- **Quarantine short-circuit:** the quarantined-tenant check runs *before* acquiring the advisory lock so blocked webhooks don't hold a connection waiting on a lock we'll refuse anyway.

### Single-Flight Promises (Cache Stampede Defense)

In `src/lib/read-model.ts`, a module-level `Map<tenantId, Promise<TenantAuditOverview>>` collapses concurrent Redis misses for the same tenant into one Postgres computation:

```ts
const existing = inFlight.get(tenantId);
if (existing) return existing;
const promise = (async () => {
  try { return await computeTenantAuditOverview(tenantId); }
  finally { inFlight.delete(tenantId); } // never poison with a rejected promise
})();
inFlight.set(tenantId, promise);
return promise;
```

The entry is deleted in `finally`, not just on success — a transient Postgres blip does not leave a rejected promise cached in memory to fail every subsequent caller until cold-start. This pattern is deliberately kept per-process (in serverless, per-lambda-instance): cross-instance stampedes are absorbed by Redis, which is the hot path.

### AbortControllers (Stale-Response Suppression)

Every client-side mutation in `ledger-admin.tsx` owns an `AbortController` held in a ref. Three layered defenses prevent double-submits and stale-response UI clobbering:

1. **Synchronous DOM lock** — `if (e.currentTarget.disabled) return; e.currentTarget.disabled = true;` runs in the first tick of the click handler, *before* React schedules a render or any `await`. This defeats rapid double-clicks, Enter+Space, and assistive-tech synthesized events that slip past React's `disabled={isBusy}` prop.
2. **AbortController** — when a new mutation fires (or a dialog closes mid-flight), the prior controller is aborted. Server Action POSTs are already on the wire (Next.js doesn't accept a signal to the fetch), so we don't try to cancel network; instead every state update, toast, and optimistic-UI clear is gated on `signal.aborted === false`.
3. **Request epochs** — pagination/refresh uses a monotonically increasing `chainEpochRef` so a slow `loadMore()` returning after a post-mutation `refreshChain()` is discarded in its entirety rather than partially merged.

### Temporal Workflow-Id Reuse Policy

At-least-once delivery from Stripe is deduplicated by the orchestrator itself — `WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE` makes duplicate delivery a no-op at the Temporal frontend. We do not implement application-level dedup tables on top of this; we let Temporal be Temporal. The edge route treats `WorkflowExecutionAlreadyStartedError` as a `202 Accepted` success.

### Idempotent Activity Upserts

Every Temporal activity is written against unique constraints / conditional writes so Temporal retries and worker restarts cannot double-count money:

- `postLedgerEvent` returns `{ applied: false }` if the invoice is already `PAID` (idempotent re-replay).
- `recordWebhookOutcome` uses `prisma.webhookIngestion.upsert` against the `wh_ingest_provider_event_uniq` compound key.
- Cache writes are `SET` (overwrite), not `SETNX` (create-if-absent) — refreshes are commutative.

---

## 📦 Project Layout

```
src/
├── app/
│   ├── (dashboard)/admin/ledger/      # Audit dashboard (RSC actions + mutations + UI)
│   │   ├── _components/ledger-admin.tsx   # Client entrypoint (Health/Chain/Audit)
│   │   ├── actions.ts                     # RSC queries (delegates to read-model)
│   │   └── mutations.ts                   # Server Actions (reconcile/quarantine/release/backfill)
│   └── api/
│       └── webhooks/stripe/route.ts       # Thin HMAC verify → Temporal start
├── lib/
│   ├── ledger.ts                          # pg_advisory_xact_lock + double-entry writes
│   ├── reconciler.ts                      # Hash-chain & balance sweeper
│   ├── rate-limiter.ts                    # Canonical sliding-window limiter (memory + Redis)
│   ├── read-model.ts                      # CQRS projection (Redis cache + single-flight)
│   ├── tenant.ts                          # RLS withTenant() wrapper
│   ├── money.ts                           # toSubunit() — Decimal → BigInt paise
│   ├── dr-mode.ts                         # Quarantine/read-only mode assertions
│   ├── invoice-helpers.ts                 # markInvoicePaid (used by Temporal activity)
│   ├── send-payment-receipt.ts            # Resend receipt renderer
│   └── errors.ts                          # Typed error hierarchy
├── temporal/
│   ├── client.ts                          # Lazy Temporal Client singleton
│   ├── workflows.ts                       # processPaymentWebhook saga
│   ├── activities.ts                      # Idempotent activities
│   └── stripe-event-resolver.ts           # Pure event→invoice resolution
└── components/ui/                         # Hand-rolled accessible primitives
prisma/
├── schema.prisma
├── rls-setup.sql                          # RLS policies
├── service-role.sql                       # service_role grants
├── ledger.sql                             # Hash-chain trigger & constraints
└── reconciler.sql                         # Audit tables
e2e/
└── ledger-admin.spec.ts                   # Playwright: focus trap, optimistic UI, webhook E2E
```

---

## 🚀 Local Setup

### Prerequisites

- **Node.js 20+** (Next 16 requirement)
- **PostgreSQL 17** (native; the project uses hash-chain triggers and advisory locks that do not play well with older versions)
- **Temporal CLI** (`temporal`) for the webhook worker — `brew install temporal` or see [docs.temporal.io/cli](https://docs.temporal.io/cli)
- *(Optional)* **Upstash Redis** for the CQRS read model across instances; the app degrades gracefully without it (falls through to Postgres on every read)

### 1. Clone & install

```bash
git clone <repo> smart-billing
cd smart-billing
npm install
```

### 2. Start PostgreSQL

Native Debian/Ubuntu:
```bash
sudo pg_ctlcluster 17 main start
sudo -u postgres psql -c "CREATE USER smartbill WITH SUPERUSER PASSWORD 'smartbill';"
sudo -u postgres psql -c "CREATE DATABASE smart_billing OWNER smartbill;"
```

Docker (provided in `docker-compose.yml`):
```bash
docker compose up -d db
```

### 3. Configure environment

```bash
cp .env.example .env
```

Minimum required for local dev:
```env
DATABASE_URL="postgresql://smartbill:smartbill@localhost:5432/smart_billing?schema=public"
AUTH_SECRET="$(node -e "console.log(crypto.randomBytes(32).toString('hex'))")"
ADMIN_EMAIL="admin@smartbill.com"
ADMIN_PASSWORD="password123"
# Optionally (not required to boot):
# STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
# RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
# RESEND_API_KEY, FROM_EMAIL
# UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
# TEMPORAL_ADDRESS (defaults to localhost:7233)
# TEMPORAL_NAMESPACE (defaults to "default")
# TEMPORAL_TASK_QUEUE (defaults to "smartbill-webhooks")
```

### 4. Schema, RLS, seed

```bash
npm run db:setup
```

This runs (in order): `prisma db push` → `prisma generate` → `rls-setup.sql` → `service-role.sql` → `ledger.sql` → `reconciler.sql` → `prisma db seed`. The seed creates the admin user from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

### 5. Start Temporal dev server

```bash
temporal dev start
```
The Temporal frontend will listen on `localhost:7233` and the Web UI on `http://localhost:8233`.

### 6. Start the Temporal Worker

> A worker bootstrap (compiled from `src/temporal/*` against the Temporal Node SDK) must be running for webhook workflows to make progress. If you don't run one, webhooks will `202 Accepted` and queue in Temporal until a worker picks them up. For portfolio demo purposes, you can run the worker in a separate terminal:
>
> ```bash
> # See scripts — worker entrypoint coming in the next iteration;
> # during local dev you can run the workflow inline via the temporal CLI
> # or point Temporal's dev server at a worker process you spin up with:
> npx tsx src/temporal/worker.ts
> ```

*(If `src/temporal/worker.ts` is not yet present in your checkout, the app still boots — webhooks will sit in the Temporal task queue rather than being processed. The UI and ledger paths do not require a running worker.)*

### 7. Run the app

```bash
npm run dev
```
Open http://localhost:3000 and log in with `admin@smartbill.com` / `password123`.

### 8. Tests & typecheck

```bash
# Strict TypeScript (CI gate — must pass with zero errors)
./node_modules/.bin/tsc --noEmit

# Production build (authoritative check)
npm run build

# Vitest unit/integration tests (requires Postgres up for reconciler tests)
npm test

# Playwright E2E (Point PLAYWRIGHT_TEST_BASE_URL at a running dev server)
npx playwright test e2e/
```

### Production / Docker

```bash
docker compose up --build
```
The compose stack ships Postgres 16 and the Next.js production server; it does **not** ship a Temporal worker or Upstash — wire those via environment variables for production deploys.

---

## 🔐 Threat Model Highlights

- **Webhook HMAC is fail-closed.** Missing `STRIPE_WEBHOOK_SECRET` in production + a set `STRIPE_SECRET_KEY` returns `503` for every event and logs a one-time startup error. The `x-test-bypass-hmac` header returns `401` outside `development`/`test`.
- **Rate limit before HMAC.** Webhook endpoints apply a sliding-window limit (60 req/min/IP) before touching Stripe SDK or crypto to blunt abuse.
- **No float on money.** All arithmetic is `bigint` paise; JSON serialization uses string paise, never numbers.
- **Logs are sanitized.** `console.log` / `console.info` are stripped from the codebase. Only structured `console.error("[namespace]", err)` and security-relevant `console.warn` remain, and client-side error surfaces never echo stack traces.
- **Cron endpoints** require `Authorization: Bearer <CRON_SECRET>` validated with `crypto.timingSafeEqual`.
- **Reconciler runs can't be double-triggered** (pg_try_advisory_xact_lock) and write an append-only audit — a run cannot be deleted or edited after the fact.

See `THREAT_MODEL.md` and `LEDGER_AUDIT_REPORT.md` in the repo root for full coverage.

---

## 🧰 Version Pinning

Dependencies are pinned deliberately. Upgrades to Next/Prisma/Stripe/Temporal are treated as architecture reviews, not `npm update`s:

| Package | Version | Why |
|---|---|---|
| `next` | 16.2.12 | App Router, Turbopack, React 19 RC alignment |
| `react` / `react-dom` | 19.2.4 | |
| `@prisma/client` / `prisma` | 5.22.0 | Decimal precision & RLS compatibility |
| `stripe` | 22.3.2 | Webhook signature verification surface |
| `razorpay` | ^2.9.8 | India UPI/cards |
| `@temporalio/*` | 1.21.1 | Durable execution |
| `@upstash/redis` | ^1.38.1 | CQRS read model + distributed rate limit |
| `zod` | ^4 | Runtime validation |
| `argon2` | ^0.45.1 | Password hashing |
| `@react-pdf/renderer` | ^4.5.1 | Receipt PDF generation |
| `resend` | ^6 | Transactional email |
| `vitest` | 3.2.7 | Unit/integration |
| `server-only` | 0.0.1 | Server boundary enforcement |

---

## 📝 Conventions

- **Currency** defaults to INR ₹, locale `en-IN`, timezone `Asia/Calcutta`. Integer-paise `bigint` arithmetic only; no `number` on money.
- **Commits** are atomic, conventional, authored as `SmartBill Engineering <eng@smartbill.in>`.
- **Imports:** server-only modules start with `import "server-only";` to prevent accidental client-side bundling.
- **Do not refactor without reading existing files.** Trust source over comments. Zero new npm dependencies unless the alternative is materially worse. Prefer zero-dep adapters over wrapper libraries.
