# Smart Billing Application

A modern, full-stack invoicing and billing application built with:

- **Next.js 16 (App Router, Turbopack)** with React 19
- **TypeScript (strict)** for end-to-end type safety
- **Tailwind CSS** for styling
- **Shadcn-style UI** primitives (hand-rolled Radix-free components)
- **Prisma 5 ORM** with PostgreSQL
- **NextAuth v5 (Auth.js)** with JWT sessions and Argon2id password hashing
- **Zod v4** for runtime validation
- **React Hook Form** for client-side forms
- **Resend** for invoice emails
- **OpenAI GPT-4o-mini** for AI receipt scanning
- **Recharts** for dashboard charts
- **Framer Motion v12** for animations

---

## 🏗️ System Architecture & Concurrency Model

SmartBill is engineered as a stateless, serverless-ready SaaS (works on Vercel Node runtimes, Docker, or any Node host) with strict multi-tenant isolation and idempotent write paths. The diagram below illustrates the critical concurrent flows — webhook fan-in, payment-session creation, and cron-driven recurring generation — and the mechanisms that keep them correct.

```mermaid
flowchart TD
    subgraph Edge["Edge / Public Internet"]
        Browser["Client Browser<br/>(view/[id] & portal/[token])"]
        StripeWH["Stripe Webhook<br/>(checkout.session.completed)"]
        RazorWH["Razorpay Webhook<br/>(payment.captured)"]
        Cron["Vercel Cron<br/>(daily 09:00 IST)"]
    end

    subgraph App["Next.js 16 (Node runtime)"]
        Rate["Rate Limiter<br/><b>Memory</b> default<br/><b>Upstash Redis</b> when<br/>UPSTASH_REDIS_REST_URL set"]
        Api["Route Handlers /api/*<br/>(tenant-scoped by requireUser())"]
        PayStripe["/pay (Stripe)"]
        PayRazor["/pay-razorpay (Razorpay)"]
        WHStripe["/webhooks/stripe<br/>(signature verified)"]
        WHRazor["/webhooks/razorpay<br/>(signature verified)"]
        CronGen["/cron/generate-recurring<br/>(CRON_SECRET, timingSafeEqual)"]
        CronRem["/cron/send-reminders<br/>(CRON_SECRET, timingSafeEqual)"]
        AtomPay["markInvoicePaid()"]
    end

    subgraph Data["PostgreSQL (Prisma)"]
        Inv[(invoices)]
        Rec[(recurring_profiles)]
        AdvLocks["pg_advisory_xact_lock<br/>(per-profile)"]
    end

    Browser --> Rate --> Api
    StripeWH --> Rate --> WHStripe --> AtomPay
    RazorWH --> Rate --> WHRazor --> AtomPay
    Cron --> Rate --> CronGen
    Cron --> Rate --> CronRem

    Api --> PayStripe
    Api --> PayRazor

    PayStripe -. "pending_ reservation<br/>(idempotent claim)" .-> Inv
    PayRazor  -. "pending_ reservation<br/>(idempotent claim)" .-> Inv
    PayStripe --> Stripe["Stripe API"]
    PayRazor --> Razorpay["Razorpay API"]

    AtomPay -- "UPDATE invoices WHERE status NOT IN ('PAID','VOID')<br/>→ 1 winner; activity + email post-commit" --> Inv

    CronGen -->|"SELECT due profiles"| Rec
    CronGen -->|"transaction + advisory lock"| AdvLocks --> Inv

    classDef critical fill:#fde68a,stroke:#b45309,color:#000
    class AtomPay,AdvLocks,Rate critical
```

### Why these mechanisms?

- **`BigInt` paise arithmetic with Prisma `Decimal` ROUND_HALF_UP** — IEEE-754 binary floats cannot represent `0.1` or `0.07` exactly; summing thousands of line items in JS `number` produces off-by-one-paisa errors that surface as mismatched totals on receipts and tax filings. We keep all money math in integer subunits (`BigInt`) and only convert to float at the display/boundary layer after rounding is finalized. Stripe and Razorpay both mandate ROUND_HALF_UP for subunit conversion.
- **Postgres `pg_advisory_xact_lock` for recurring generation** — application-level mutexes (in-memory sets, Redis locks) break across serverless replicas and cold starts. A transaction-scoped advisory lock is held for the duration of the invoice-creation transaction, serializes at the database level (no race even across multiple app instances), and auto-releases on commit/rollback so a crashed worker never wedges a profile.
- **`pending_` reservation markers for payment session creation** — wrapping `stripe.checkout.sessions.create` in a transaction is dangerous because a Stripe API call inside a long-running DB transaction holds locks and can leave orphaned sessions on network failure. Instead we do a cheap `UPDATE ... WHERE session_id IS NULL` with a short-lived `pending_<ts>_<rand>` marker, call Stripe, then finalize with the real session id. Concurrent double-clicks get `count === 0`, reload the existing (open) session, and return it without leaking a Stripe session.
- **Atomic conditional `UPDATE ... WHERE status NOT IN ('PAID','VOID')` for mark-as-paid** — the classic webhook double-delivery problem is solved with a single DML statement: exactly one concurrent webhook sees `matched === 1` and proceeds to write activity logs + fire the receipt email; all replays hit `matched === 0` and return silently. VOID is excluded from the guard so a late/forged webhook cannot resurrect a voided invoice.

---

## 🌐 Live Demo

Deployed on Vercel: [**https://smart-bill-theta.vercel.app/login**](https://smart-bill-theta.vercel.app/login)

**Demo admin credentials** (seeded, see below):
- Email: `admin@smartbill.com`
- Password: `password123`

You can also create your own account by clicking **"Create one"** on the login page — each account is fully isolated (per-tenant clients, invoices, and company settings).

---

## 🚀 Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and set:

- `DATABASE_URL` — PostgreSQL connection string
- `AUTH_SECRET` (or `NEXTAUTH_SECRET`) — JWT signing secret (generate with `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`)
- Optional:
  - `ADMIN_EMAIL` / `ADMIN_PASSWORD` — override the seeded admin account (defaults to `admin@smartbill.com` / `password123`)
  - `OPENAI_API_KEY` — enable AI receipt scanning
  - `RESEND_API_KEY` + `FROM_EMAIL` — enable invoice email delivery
  - `NEXT_PUBLIC_SITE_URL` — public base URL (used in invoice email links)

### 3. Run database migrations

```bash
npx prisma migrate dev --name multi_tenant
```

This creates the tables based on `prisma/schema.prisma` and generates the Prisma Client.

### 4. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 📁 Project Structure

```
smart-billing/
├── prisma/
│   ├── schema.prisma          # Database schema (Client, Invoice, InvoiceItem)
│   └── migrations/            # Auto-generated migration files
│
├── src/
│   ├── app/                   # Next.js App Router (pages + API routes)
│   │   ├── layout.tsx         # Root layout (Navbar, fonts, etc.)
│   │   ├── page.tsx           # Entry → redirects to /dashboard
│   │   ├── globals.css        # Tailwind + CSS variables (Shadcn theme)
│   │   │
│   │   ├── dashboard/
│   │   │   └── page.tsx       # Dashboard with stats + recent invoices
│   │   │
│   │   ├── clients/
│   │   │   ├── page.tsx       # Clients list
│   │   │   └── [id]/page.tsx  # Single client detail + invoice history
│   │   │
│   │   ├── invoices/
│   │   │   ├── page.tsx          # Invoices list
│   │   │   ├── new/page.tsx      # Create new invoice
│   │   │   └── [id]/page.tsx     # Single invoice detail (printable view)
│   │   │
│   │   └── api/               # REST API routes
│   │       ├── clients/
│   │       │   ├── route.ts       # GET / POST clients
│   │       │   └── [id]/route.ts  # GET / PUT / DELETE single client
│   │       └── invoices/
│   │           ├── route.ts       # GET / POST invoices
│   │           └── [id]/route.ts  # GET / PATCH / DELETE single invoice
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   └── navbar.tsx        # Top navigation bar
│   │   ├── ui/                   # Reusable Shadcn-style primitives
│   │   │   ├── button.tsx
│   │   │   ├── input.tsx
│   │   │   ├── card.tsx
│   │   │   ├── badge.tsx
│   │   │   └── label.tsx
│   │   ├── clients/
│   │   │   └── new-client-dialog.tsx  # Modal form to add clients
│   │   └── invoices/
│   │       ├── new-invoice-form.tsx    # Invoice creation form w/ live totals
│   │       ├── mark-paid-button.tsx    # Status update action
│   │       └── delete-invoice-button.tsx
│   │
│   ├── lib/                    # Shared utilities & business logic
│   │   ├── prisma.ts           # Prisma Client singleton (hot-reload safe)
│   │   ├── utils.ts            # cn(), formatCurrency(), formatDate(), generateInvoiceNumber()
│   │   └── validations.ts      # Zod schemas (clientSchema, invoiceSchema, invoiceItemSchema)
│   │
│   └── types/
│       └── index.ts            # Shared TS types (re-exports Prisma types + payloads)
│
├── public/                     # Static assets
├── tailwind.config.js          # Tailwind config with Shadcn theme tokens
├── postcss.config.js
├── tsconfig.json               # Path alias @/* → src/*
└── package.json
```

---

## 🗄️ Database Schema

### `Client`
| Field       | Type      | Notes                        |
|-------------|-----------|------------------------------|
| id          | String    | CUID, primary key            |
| name        | String    | Required                     |
| email       | String    | Unique, required             |
| address     | String?   | Optional                     |
| createdAt   | DateTime  | Auto-set                     |
| updatedAt   | DateTime  | Auto-updated                 |
| invoices    | Invoice[]| One-to-many → Invoice        |

### `Invoice`
| Field          | Type           | Notes                                  |
|----------------|----------------|----------------------------------------|
| id             | String         | CUID, primary key                      |
| invoiceNumber  | String         | Unique, auto-generated (INV-YYYYMMDD-0001) |
| clientId       | String         | FK → Client (`onDelete: Cascade`)      |
| status         | InvoiceStatus  | Enum: `DRAFT` / `PENDING` / `PAID`     |
| issueDate      | Date           | Required                               |
| dueDate        | Date           | Required                               |
| subtotal       | Decimal(12,2)  | Sum of item totals (pre-tax)           |
| taxRate        | Decimal(5,2)   | Percentage (default 0)                 |
| totalAmount    | Decimal(12,2)  | subtotal + tax                         |
| items          | InvoiceItem[] | One-to-many → InvoiceItem (`onDelete: Cascade`) |

### `InvoiceItem`
| Field       | Type          | Notes                               |
|-------------|---------------|-------------------------------------|
| id          | String        | CUID, primary key                   |
| invoiceId   | String        | FK → Invoice (`onDelete: Cascade`)  |
| description | String        | Required                            |
| quantity    | Int           | Default 1, min 1                    |
| price       | Decimal(12,2) | Unit price                          |
| total       | Decimal(12,2) | quantity × price (stored for audit) |

### Cascading Deletes
- Deleting a **Client** → deletes all their Invoices → deletes all InvoiceItems on those invoices.
- Deleting an **Invoice** → deletes all its InvoiceItems.

---

## ✨ Features Implemented

- ✅ Dashboard with revenue stats (monthly chart of paid revenue) & recent invoices
- ✅ Multi-user auth (Argon2id hashed credentials, NextAuth v5 JWT sessions, safe callback URLs, public signup)
- ✅ Client management (create, edit, view, list, delete) with phone support
- ✅ Invoice CRUD with line items, auto-calculated totals & tax, notes/terms field
- ✅ **Edit Invoice** flow — update client, dates, tax, notes, line items (server-reconciled upsert, paidAt preserved correctly)
- ✅ **PDF download** — one-click, server-rendered, branded PDFs for admins and public clients (`@react-pdf/renderer`); separate authenticated + CUID-protected public endpoints with rate limiting
- ✅ **Payment reminders** — per-invoice "Send Reminder" (24h cooldown, rate-limited) + bulk "Send Reminders" dashboard action that emails all overdue PENDING invoices via Resend; HTML+text templates with overdue banner and PDF link; `lastSentAt` / `lastRemindedAt` audit stamps
- ✅ **Account settings** — name/email updates, password change with current-password verification (argon2id rehash + sign-out on rotation), account deletion with password confirmation, validation via React Hook Form + Zod
- ✅ **Online payments** via **Stripe** (international cards/wallets, hosted Checkout redirect) and **Razorpay** (India: UPI, cards, netbanking, wallets — inline Checkout modal) — Pay Now buttons on admin + public invoice pages; webhook-verified `payment.captured` / `checkout.session.completed` auto-marks invoices PAID + sets `paidAt`; order/session idempotency; currency-aware subunit conversion; HMAC signature verification; 503 graceful fallback when neither gateway is configured
- ✅ **Recurring / subscription invoices** — `RecurringProfile` templates with weekly/monthly/yearly/custom-N-days frequency, auto-send option, start/end dates, pause/resume, "Run now" admin action; cron endpoint `/api/cron/generate-recurring` (protected by `CRON_SECRET`) with Vercel Cron job config (`vercel.json`) that auto-generates + emails due invoices; `/recurring` management page with navbar entry + dashboard quick-action + "Upcoming Recurring" widget; `onDelete: SetNull` preserves invoice history
- ✅ Invoice status lifecycle (Draft → Pending → Paid) with automatic `paidAt` timestamping
- ✅ Printable invoice detail view (`window.print()`-friendly) + public share link (`/view/:id`)
- ✅ AI receipt scanning (OpenAI GPT-4o-mini) to auto-fill line items
- ✅ Invoice email delivery via Resend, with CSV export
- ✅ Rate limiting on auth / public-read / expensive endpoints; IP sliding window
- ✅ Security-hardened proxy (HSTS, CSP, X-Frame-Options, etc.) replacing deprecated `middleware.ts`
- ✅ Form validation with Zod v4, sonner toasts, Framer Motion page transitions
- ✅ Currency formatting (INR / en-IN locale) & IST-aware date handling
- ✅ Automatic invoice number generation (INV-YYYYMMDD-NNNN)
- ✅ Cascading deletes at the DB level & per-tenant isolation on every API
- ✅ Responsive design (mobile-friendly), light & dark mode
- ✅ Strict TypeScript throughout (no `any`) with Prisma-generated types

---

## 📝 Useful Commands

```bash
npx prisma studio          # Open Prisma Studio (GUI DB browser)
npx prisma migrate dev     # Create & apply new migration during dev
npx prisma generate        # Regenerate Prisma Client
npx prisma db seed         # Run seed script (if you add one)
npm run build              # Production build
npm run start              # Run production server
```

---

## 🔧 Adding Seed Data

Create `prisma/seed.ts`:

```ts
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const client = await prisma.client.create({
    data: {
      name: "Acme Corp",
      email: "billing@acme.com",
      address: "123 Main St, Mumbai, MH 411001",
    },
  });
  console.log("Seeded client:", client.id);
}

main().finally(() => prisma.$disconnect());
```

Then run:
```bash
npx tsx prisma/seed.ts
```

---

## 🛡️ Enterprise Hardening (Batch 5)

### 1. Row-Level Security (RLS)

Application-level `where: { userId }` clauses are defense-in-depth; the real enforcement sits in Postgres. We create a restricted role `app_user` (NOINHERIT, NOBYPASSRLS) whose queries against tenant tables are filtered by `current_setting('app.current_user_id')`. The `withTenant(userId, fn)` helper opens an interactive transaction, runs:

```sql
SET LOCAL ROLE app_user;
SET LOCAL app.current_user_id = '<userId>';
```
and asserts both took effect (fail-closed if SET ROLE fails) before running the callback. `InvoiceItem` and `RecurringItem` carry a denormalized `userId` so the policies don't require FK joins. SET LOCAL auto-resets at transaction end so there's zero risk of leaking the role to subsequent queries on a pooled connection.

To apply the RLS role + policies on a fresh database:
```bash
psql "$DATABASE_URL" -f prisma/rls-setup.sql
```

This is idempotent (IF NOT EXISTS + DROP POLICY IF EXISTS). Public CUID-protected routes (`/view/:id`, `/pay`, `/pay-razorpay`, webhooks) run as the superuser against non-tenant scoped queries or against specific CUID-known rows — they don't need RLS because they don't enumerate tenants. All admin financial writes (invoice create/edit/delete/duplicate, recurring generation, mark-paid) go through `withTenant`.

### 2. Async Webhook Ingestion with SKIP LOCKED

Previously, Stripe/Razorpay/Resend webhooks did all DB work (mark PAID, update checkout session ids, write activity rows, send receipt emails) on the request thread. A burst of payment events would tie up serverless DB connections and drop deliveries. Now:

1. **Thin edge** — verify HMAC signature (fail-closed in production, as before), INSERT raw payload into the append-only `WebhookIngestion` table, return **202 Accepted** in <50ms. Duplicate `(provider, providerEventId)` inserts are silently absorbed (idempotent retries).
2. **Decoupled worker** (`/api/cron/process-webhooks`, every minute via Vercel Cron) claims rows via `SELECT ... FOR UPDATE SKIP LOCKED` (concurrent workers don't fight), dispatches to provider-specific processors, marks DONE or schedules exponential-backoff retries (`5s * 2^n + jitter`). After 5 failed attempts → **DLQ** status for manual review. Stale PROCESSING rows (worker crashed mid-handle) are reaped on each invocation.

Raw bodies are retained for 90 days for forensic audit.

```mermaid
flowchart LR
    Stripe[Stripe] --> EdgeSig[Edge: verify HMAC]
    Razor[Razorpay] --> EdgeSig
    Resend[Resend] --> EdgeSig
    EdgeSig -->|INSERT rawBody<br/>202 Accepted| Q[(WebhookIngestion)]
    Cron[Vercel Cron<br/>* * * * *] -->|SKIP LOCKED claim| Q
    Cron -->|dispatch| Proc[Provider processors]
    Proc -->|mark DONE| Q
    Proc -->|error<br/>backoff 5s·2^n| Q
    Proc -. 5 fails .-> DLQ[DLQ review]
    Proc --> Inv[Invoice PAID<br/>activity logs]
```

### 3. Immutable Double-Entry Financial Ledger

Every state change that moves money now produces a balanced set of double-entry postings in an append-only `LedgerEntry` table with a SHA-256 hash chain. This gives us three guarantees the application layer cannot provide on its own:

1. **Immutability at the database layer.** `app_user` (the role every tenant query runs as via `withTenant()`) holds only `SELECT` and `INSERT` on `ledger_entries` — `UPDATE` and `DELETE` are explicitly `REVOKE`d. Voiding, refunding, or "un-marking" a payment is modelled as a new reversing entry, never a mutation of history.
2. **Balanced-books invariant enforced in Postgres.** An `AFTER INSERT ... FOR EACH STATEMENT` trigger sums debits and credits per `eventId` across the whole table and raises an exception if they differ in integer paise. An unbalanced insert cannot commit — even if there is a bug in application code.
3. **Tamper-evident hash chain.** Every entry carries `entryHash = SHA256(prevEntryHash | canonical_entry_bytes)` where the canonical form is a pipe-delimited record `eventId|eventType|account|side|amountPaise|invoiceId|expenseId|currency`. The user's `lastLedgerEntryHash` / `lastLedgerEntryId` tail pointer is updated in the same transaction, serialized by a `pg_advisory_xact_lock` keyed per user, so concurrent writes cannot fork the chain. `verifyUserLedger(userId)` walks the chain from `GENESIS_HASH`, recomputes every hash, rechecks per-event balance, verifies the tail pointer, and returns account balances.

**Accounts (paise balances).**

| Account           | Type          | Debit when…                       | Credit when…              |
|-------------------|---------------|-----------------------------------|---------------------------|
| ACCOUNTS_RECEIVABLE | asset        | Invoice issued (owed to you)      | Payment received / voided |
| REVENUE           | income        | Voided (reversal)                 | Invoice issued            |
| DISCOUNT_CONTRA   | contra-rev    | Discount on invoice               | Void reverses discount    |
| TAX_PAYABLE       | liability     | Voided (reversal)                 | GST/VAT on invoice        |
| CASH              | asset         | Payment received                  | Expense paid / refund     |
| EXPENSES          | expense       | Expense recorded                  | (no credit events today)  |

**Events posted:** `INVOICE_ISSUED` (PENDING/PAID create, send DRAFT→PENDING, recurring autoSend, draft→issued edit); `INVOICE_PAID` (mark paid, Stripe/Razorpay settle); `INVOICE_VOIDED` (void — reverses issuance *and* payment if previously PAID); `PAYMENT_REVERSED` (PAID→PENDING/DRAFT un-mark); `EXPENSE_RECORDED` (expense create, CSV import). DRAFT creates/duplicates do not post (no economic event yet).

**Reconciliation.** `GET /api/admin/ledger-verify` returns the verification result plus an AR-vs-open-PENDING-invoices cross-check so the Settings page can confirm the books tie out. The P&L and dashboard aggregates currently read from `Invoice`/`Expense` tables (projections over the ledger); switching them to read balances from the ledger is a follow-up.

To apply the ledger DDL on a fresh database (in addition to `rls-setup.sql`):
```bash
psql "$DATABASE_URL" -f prisma/ledger.sql
```

On an existing database, `backfillLedger()` is idempotent — it posts `INVOICE_ISSUED` for every non-DRAFT invoice that has no issuance entry, plus `INVOICE_PAID`/`INVOICE_VOIDED`/`EXPENSE_RECORDED` as current state indicates.

### 4. Service Role (Batch 6: Least-Privilege Background Workers)

`app_user` is strictly tenant-scoped. A second role, `service_role` (NOINHERIT, NOBYPASSRLS), is used by background workers (crons, DLQ redrive, admin ops):

- `withService(serviceName, fn)` opens a transaction, `SET LOCAL ROLE service_role; SET LOCAL app.service_name = '<name>';` and asserts both took effect before running the callback (same fail-closed pattern as `withTenant()`).
- Tenant tables use RLS policies with an OR-clause: rows are visible if either `app.current_user_id = userId` (tenant mode) **or** `app.service_name IS NOT NULL` (service discovery mode).
- Writes via RLS **always** require `app.current_user_id` to match `userId` (WITH CHECK), even for service_role — a cron cannot write across tenants, only *discover* across them to know which tenant to process next. When a per-tenant write is needed, workers drop into `withTenant(userId, fn, {tx})` inside the service tx to SET `app.current_user_id`.
- Application code no longer needs to connect as the database superuser for runtime queries. Migrations/seeding still run as the owner (`smartbill`).

To apply:
```bash
psql "$DATABASE_URL" -f prisma/service-role.sql
```

### 5. Ledger Throughput (Batch 6)

To avoid serial-chain lock contention during high-throughput bursts (bulk CSV imports, subscription renewals):

- `postLedgerEvents(events[])` accepts multiple events for the **same** user, acquires the per-user advisory lock **once**, computes the entire chain of hashes for all entries across all events, and inserts via a single bulk `createMany`. This reduces lock hold time from N round trips to 1.
- `postLedgerEvent` / `postLedgerEvents` now include bounded retry with exponential backoff (20ms · 2^n + jitter, up to 4 retries) on Postgres transient errors: `deadlock_detected (40P01)`, `lock_not_available (55P03)`, `serialization_failure (40001)`, and connection-reset errors.
- The CSV expense import now uses `postLedgerEvents` for the bulk ledger append (one lock per import, not per row). The cron worker dispatches serially, so Stripe/Razorpay webhook bursts are absorbed by the SKIP LOCKED queue and don't contend on the ledger at ingest time.

The hash chain itself is still strictly serialized per user — we have not weakened tamper-evidence, only shortened the critical section.

### 6. DLQ Replay, Poison-Pill Isolation & Alerting (Batch 6)

The webhook DLQ is now an operational subsystem, not a graveyard:

- **Poison-pill classification.** `classifyError(err)` inspects the failure and flags deterministic errors (malformed JSON, invalid signature, unknown provider, `resource_missing`) as poison. These go directly to `POISON` status on the first failure and are **never auto-retried or auto-redriven** — no infinite cycling.
- **Transient failures** move to `DLQ` after 5 attempts with `redriveAfter = now + 15m`. The `/api/cron/redrive-dlq` cron (every 15 min) flips eligible rows back to PENDING (capped at 10/tick) for reprocessing.
- **Redrive quota.** Each row is auto-redriven at most `MAX_REDRIVES = 3` times; after that it is promoted to `POISON` with `poisonReason = "redrive_quota_exceeded"` so a persistent downstream outage doesn't cycle rows forever.
- **Operator controls.** `POST /api/admin/dlq/:id?action=redrive[&force=1]` replays one row (force=1 bypasses the POISON check for an operator-confirmed replay); `POST /api/admin/dlq/:id?action=resolve` marks a row resolved with an operator note. `GET /api/admin/dlq` lists rows. All endpoints authenticate via `CRON_SECRET`.
- **Alerting.** `registerDlqAlertHook(hook)` lets any module subscribe to DLQ/POISON transitions. The default hook emits a structured `[dlq-alert]` error log line (consumed by Vercel Log Drains / Datadog / whatever log shipper you use). Adding Slack/PagerDuty/Resend notifications is a one-line hook registration.
- Idempotency: replaying an already-DONE/PENDING/PROCESSING row returns `{ ok: false, reason: 'already_*' }`. Rows that have been replayed and fail again naturally re-enter the retry/DLQ path up to the redrive cap.

---

## 🛡️ Automated Ledger Drift &amp; Integrity Reconciler (v1 — Production)

SmartBill ships a tamper-evident, double-entry financial ledger with a
fail-closed reconciler and a first-class **Admin Audit Console** at
`/admin/ledger` (User Menu → "Ledger Audit Console"). The subsystem is
engineered like a database kernel: **integrity is enforced in PostgreSQL
itself**, not in TypeScript ORM code, so a bug in the application layer
cannot silently corrupt the books.

### System Architecture

```mermaid
flowchart TD
    subgraph Edge["Edge Ingestion (Next.js 16 Route Handlers)"]
        StripeWH["Stripe Webhook<br/>checkout.session.completed<br/>HMAC-verified"]
        RazorWH["Razorpay Webhook<br/>payment.captured<br/>HMAC-verified"]
        Cron["Vercel Cron<br/>reconcile */15min &amp; 03:00 IST<br/>generate-recurring hourly<br/>process-webhooks * * * * *"]
        BrowserOps["Operator Browser<br/>/admin/ledger RSC + Server Actions"]
    end

    subgraph Queue["Webhook SKIP-LOCKED Worker Queue"]
        Ingest["Thin edge → INSERT<br/>WebhookIngestion rawBody<br/>202 Accepted in &lt;50ms"]
        Worker["/api/cron/process-webhooks<br/>SELECT … FOR UPDATE SKIP LOCKED<br/>exp-backoff 5s·2^n → DLQ → POISON"]
        Ingest --> Worker
    end

    subgraph AppLayer["Application Layer (Node, Server Components + Actions)"]
        Rate["Distributed Sliding-Window Rate Limiter<br/><b>Upstash Redis</b> when UPSTASH_REDIS_REST_URL/TOKEN set<br/><b>In-memory Map</b> graceful fallback<br/>10 req / 60s per user"]
        Rsc["RSC page.tsx<br/>Promise.all overview + first chain page + recent audits"]
        Actions["Server Actions<br/>triggerReconcile / release / quarantine / backfill / loadMore"]
        APIRoutes["Admin REST API<br/>/api/admin/ledger/[tenantId]/{quarantine,audit}<br/>Same-origin CSRF + CRON_SECRET + session.user.id===tenantId"]
    end

    subgraph TenantGate["Database-Kernel Isolation"]
        WTenant["withTenant(uid, fn)<br/>SET LOCAL ROLE app_user<br/>SET LOCAL app.current_user_id = uid<br/>assertion fail-closed"]
        WService["withService(name, fn)<br/>SET LOCAL ROLE service_role<br/>SET LOCAL app.service_name = name<br/>discovery-only OR-policy; writes re-enter withTenant"]
        AppRole["app_user role<br/>NOINHERIT NOBYPASSRLS<br/>SELECT/INSERT only on ledger_entries<br/>no UPDATE/DELETE on financial tables"]
        SvcRole["service_role role<br/>NOINHERIT NOBYPASSRLS<br/>OR-clause USING for discovery<br/>WITH CHECK enforces userId match"]
    end

    subgraph LedgerCore["Accounting Truth (PostgreSQL 17)"]
        LedgerTbl[(ledger_entries<br/>append-only, SHA-256 chained)]
        SixTables[(invoices<br/>invoice_items<br/>expenses<br/>ledger_entries<br/>recurring_profiles<br/>recurring_items)]
        BalanceTrig["ledger_assert_balanced_insert()<br/>AFTER INSERT per-statement<br/>Σ debits = Σ credits per eventId<br/>integer paise"]
        QuarTrig["ledger_quarantine_guard()<br/>BEFORE INSERT OR UPDATE OR DELETE<br/>raises SQLSTATE L0001 when<br/>users.ledgerQuarantinedAt IS NOT NULL<br/>(empty GUC pass-through for migrations/backfills)"]
        AdvLock["pg_advisory_xact_lock<br/><b>ns 1397772900n</b> → ledger posting<br/><b>ns 1397772901n</b> → reconcile<br/><b>ns 1397772876n</b> → recurring profiles"]
        HashChain["entryHash = SHA256(prevEntryHash ‖ canonical_bytes)<br/>canonical = eventId|eventType|account|side|amountPaise|invoiceId|expenseId|currency<br/>lastLedgerEntryHash/Id updated atomically in tx"]
    end

    subgraph Reconciler["Automated Reconciler (Sweep A + Sweep B)"]
        SweepA["Sweep A — Hash-Chain Integrity<br/>Streaming keyset cursor LIMIT 500<br/>• SHA-256 link verification<br/>• entryIndex gap detection<br/>• per-event ΣD = ΣC<br/>• tail-pointer sync check"]
        SweepB["Sweep B — Balance Cross-Checks<br/>SQL-pushed aggregates<br/>• AR ↔ Σ PENDING invoices<br/>• CASH ↔ signed Σ payment events<br/>• EXPENSES ↔ Σ expenses<br/>• Revenue/Tax parity (issuance-scoped)"]
        AuditRow[(reconciliation_audits<br/>PASSED / DRIFT_DETECTED / HASH_BROKEN / TRANSIENT_FAILURE<br/>critical/high/medium/info counts<br/>autoRemediated flag)]
        Quarantine["On CRITICAL / residual HIGH:<br/>1. SET users.ledgerQuarantinedAt<br/>2. Write HASH_BROKEN/DRIFT audit row<br/>3. fireDriftAlerts() cooldowns CRIT 60m / HIGH 6h / MED 24h"]
    end

    subgraph UI["Admin Audit Console /admin/ledger"]
        Banner["Section A · Health Banner<br/>emerald/amber/red/gray<br/>WRITES BLOCKED pulsing badge<br/>4-metric grid with BigInt Δ vs read models"]
        Explorer["Section B · Hash-Chain Explorer<br/>Dr/Cr chips · copy-hash · expandable prev↔entry rows<br/>keyset-cursor pagination (Load 50 More)"]
        History["Section C · Audit History<br/>severity pills · duration · expected/actual/Δ"]
        Buttons["Run Reconciler · Backfill &amp; Re-verify<br/>Release (mandatory note + Force checkbox)<br/>Quarantine (mandatory note)"]
    end

    StripeWH --> Ingest
    RazorWH --> Ingest
    Cron --> Worker
    Cron --> APIRoutes
    BrowserOps --> Rate --> Rsc --> Actions
    Actions --> WTenant
    APIRoutes --> WService

    Worker --> WService
    WTenant --> AppRole
    WService --> SvcRole

    AppRole --> SixTables
    AppRole --> LedgerTbl
    SvcRole --> SixTables
    SvcRole --> LedgerTbl

    LedgerTbl --> HashChain --> AdvLock
    SixTables --> QuarTrig
    LedgerTbl --> BalanceTrig

    SweepA --> LedgerTbl --> AdvLock
    SweepB --> SixTables
    SweepB --> LedgerTbl
    SweepA --> AuditRow
    SweepB --> AuditRow
    SweepA --> Quarantine
    SweepB --> Quarantine
    Quarantine -. sets flag, L0001 trigger then blocks all financial writes .-> SixTables
    Worker -. "markQuarantineHold()<br/>status=PENDING lastError=tenant_quarantined<br/>nextAttemptAt=+15min (no attempt increment)" .-> Ingest

    Rsc --> Banner
    Rsc --> Explorer
    Rsc --> History
    Actions --> Buttons
    Buttons --> Banner
    Actions -. "router.refresh() hydrates" .-> Rsc

    classDef kernel fill:#fee2e2,stroke:#b91c1c,color:#000
    classDef integrity fill:#fef3c7,stroke:#b45309,color:#000
    classDef worker fill:#dbeafe,stroke:#1d4ed8,color:#000
    classDef ui fill:#dcfce7,stroke:#15803d,color:#000
    class BalanceTrig,QuarTrig,AdvLock,HashChain,AppRole,SvcRole,WTenant,WService kernel
    class SweepA,SweepB,AuditRow,Quarantine,Rate integrity
    class Worker,Ingest worker
    class Banner,Explorer,History,Buttons,Rsc,UI ui
```

### Core Architectural Invariants (The "Why")

Each decision below is a deliberate guard against a specific class of
failure that an ORM-layer guard alone cannot prevent.

#### 1. Asymmetric Least-Privilege RLS (kernel-level USING vs. WITH CHECK)

Application-level `where: { userId }` filters are a convenience, not a
security boundary — any code path that forgets the clause (a new
endpoint, a debugging patch, a future engineer's typo) silently leaks
cross-tenant data. SmartBill enforces tenant isolation *in the database
kernel* via two restricted roles, `app_user` and `service_role`, both
created with `NOINHERIT NOBYPASSRLS`:

- `withTenant(uid, fn)` opens a transaction, runs
  `SET LOCAL ROLE app_user; SET LOCAL app.current_user_id = '<uid>';`,
  and **asserts both SETs took effect** before the callback runs. If the
  SET is rejected (role misconfiguration, dropped GUC), the tx aborts
  rather than silently running as superuser.
- RLS `USING` clauses filter *visible* rows — a tenant query can only
  ever see rows where `userId = current_setting('app.current_user_id')`
  (or, for `service_role`, the service-discovery OR clause). There is no
  statement the application can issue that returns another tenant's
  rows, because the database itself filters the result set before rows
  leave the executor.
- RLS `WITH CHECK` clauses are **asymmetric**: they enforce that
  *writes* must set `userId = current_setting('app.current_user_id')`,
  even for `service_role`. A cron running as `service_role` can
  *discover* tenants across the system to know whom to reconcile, but
  cannot insert or mutate a row without re-entering `withTenant(uid)`
  to pin `app.current_user_id` to that exact tenant.
- The result is a kernel-style **fail-closed** posture: the Prisma client
  is a prisoner of its role, not a trusted peer. Buggy application code
  fails loudly with a Postgres permission error instead of silently
  exfiltrating or corrupting another tenant's data.

`SET LOCAL` scope (transaction-local, auto-reset on commit/rollback) is
critical: pooled connections cannot leak role or GUC state between
requests even if the Node process crashes mid-query.

#### 2. Advisory-Locked Chained Ledgers (split namespaces 1397772900n / 1397772901n)

Every ledger append must: (a) read the current tail hash, (b) compute
`entryHash = SHA256(prevEntryHash ‖ canonical_bytes)`, (c) insert the
new rows, and (d) update the user's `lastLedgerEntryHash`/`lastLedgerEntryId`.
Without serialization, two concurrent webhooks could read the same
`prevEntryHash` and fork the chain — a tamper-evidence failure that
Sweep A would later flag as CRITICAL `HASH_CHAIN_BROKEN`. Rather than
rely on a heavyweight table lock or SERIALIZABLE isolation (both
disastrous for throughput), we use `pg_advisory_xact_lock` with
**deliberately separate namespaces**:

| BigInt key                | Namespace      | Purpose                                                 |
|---------------------------|----------------|---------------------------------------------------------|
| `1397772900n * 2^32 + h`  | Ledger Posting | Serializes `postLedgerEvent(s)` writes for one tenant.  |
| `1397772901n * 2^32 + h`  | Reconcile      | Serializes concurrent reconcile runs for one tenant.    |
| `1397772876n * 2^32 + h`  | Recurring      | Guards recurring-invoice generation per profile.        |

The namespace IDs are FNV-1a 32-bit folds of symbolic names (e.g.,
`"smartbill:ledger:post"`, `"smartbill:ledger:reconcile"`), shifted
into the high 32 bits so user-hash collisions across namespaces are
impossible.

**Why split the posting and reconcile namespaces?** A reconcile run
takes tens to hundreds of milliseconds per tenant (Sweep A streams the
entire chain). If it held the *posting* lock for that duration, bursty
webhook payments during a reconcile window would serialize behind it
and pile up in the SKIP-LOCKED ingestion queue, increasing payment
latency and triggering duplicate webhook retries from Stripe/Razorpay.
By giving reconciles their own lock, webhook writes continue to commit
on the hot path while the reconcile holds a *logically separate* guard
against concurrent reconcile invocations. The reconciler uses
`pg_try_advisory_xact_lock` on its namespace — contention (e.g., an
incremental cron firing while an operator is mid-backfill) returns
`TRANSIENT_FAILURE` immediately rather than queuing behind a lock.

#### 3. Three-Layer Fail-Closed Quarantine (app → webhook hold → SQLSTATE L0001)

When Sweep A detects a broken hash chain, an entry-index gap, or an
unbalanced event, OR Sweep B detects residual high-severity drift that
auto-backfill cannot resolve, the reconciler flips
`users.ledgerQuarantinedAt` and all further **financial writes must
block** until an operator releases the flag after review. This is
enforced in three independent layers, because one of them is not
enough:

1. **Application helper** — `assertNotQuarantined(uid)` is called
   *before* `postLedgerEvent` acquires the chain lock, and
   `withTenant()` runs a pre-tx quarantine check. This is the hot-path
   gate: it fails fast with a typed `LedgerQuarantinedError`, returns a
   clean error to the UI, and avoids burning a transaction on work that
   will be rejected downstream.
2. **Webhook hold (no poison, no DLQ)** — the `process-webhooks` worker
   calls `isTenantQuarantined()` before dispatching a payment event
   and, if quarantined, calls `markQuarantineHold()` which sets
   `status=PENDING`, `lastError='tenant_quarantined'`, and
   `nextAttemptAt=now + 15min` without incrementing `attempts`.
   Quarantined payments are not dropped into the DLQ (that would lose
   revenue) and not marked poison — they wait on the queue until the
   operator releases the flag, then drain normally.
3. **Database trigger SQLSTATE `L0001`** — `ledger_quarantine_guard()`
   is a `BEFORE INSERT OR UPDATE OR DELETE` trigger attached (via a
   dynamic `DO` block that checks `information_schema.tables`, so the
   DDL is idempotent against schema drift) to **all six financial
   tables**: `invoices`, `invoice_items`, `expenses`, `ledger_entries`,
   `recurring_profiles`, `recurring_items`. It raises SQLSTATE `L0001`
   whenever `app.current_user_id` is non-empty *and* the user's
   `ledgerQuarantinedAt IS NOT NULL`. This is the last line of defense:
   even if a bug slips past the helper, a raw query is run via
   Prisma's `$executeRaw`, or an RLS policy is ever relaxed, the
   trigger still fires inside the executor and aborts the transaction.
   The trigger deliberately permits the empty/NULL GUC so migrations,
   superuser backfills, and `service_role` discovery don't wedge; all
   trusted paths run with known empty or non-user GUCs, and every
   tenant-facing `withTenant` call sets the GUC unconditionally, so
   the trigger fails *closed* for untrusted traffic.

The vitest integration suite (`src/lib/reconciler.test.ts`, Test C)
asserts all three layers: the helper throws, a Prisma-tx write throws,
and a raw PL/pgSQL INSERT as `app_user` with `app.current_user_id` set
raises `L0001`.

#### 4. Keyset Streaming + Zero-Float Paise (O(batch) memory, no IEEE 754 drift)

Two independent correctness choices that are easy to get wrong:

- **Zero JavaScript floats for money.** Every monetary amount is stored
  as integer paise in `BigInt` (or as Prisma `Decimal(12,2)` with an
  explicit `ROUND_HALF_UP` to integer subunits at the boundary). GST at
  18% on ₹1000 is `BigInt("118000")` paise internally. There is no
  `0.1 + 0.2 === 0.30000000000000004` footgun anywhere on the write
  path, in the balance trigger (which sums integer paise), or in the
  reconciler. Display formatting happens once, at the React boundary,
  using `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })`
  against an integer-to-decimal divisor.
- **Keyset (cursor) pagination, everywhere.** The reconciler's Sweep A
  walks the hash chain 500 rows at a time with a `WHERE entryIndex >
  cursor ORDER BY entryIndex ASC LIMIT 500` loop, with a bounded
  tail-catch-up of five extra iterations for concurrent-appended
  entries. The Admin Console's Hash-Chain Explorer uses the same
  pattern on `entryIndex DESC` with a cursor resolved from the last
  row's `id`, so "Load 50 More" has constant-time plans regardless of
  chain length. `OFFSET`-based pagination is not used anywhere on the
  ledger: on a chain with 1M entries, `OFFSET 500000 LIMIT 50` would
  force Postgres to sort and discard 500 000 rows on every page and
  produce inconsistent results under concurrent writes. Keyset cursors
  are O(batch) memory and stay consistent in the face of concurrent
  inserts.

Sweep B goes further: instead of loading every row into Node to sum
balances (the O(n)-memory anti-pattern), every cross-check is a SQL
aggregate (`SELECT SUM(...) FILTER (WHERE ...)`), pushed down to the
database and returned as a single row. The reconciler itself can run
comfortably inside Vercel's Serverless Function memory ceiling even on
tenants with millions of ledger rows.

### Admin Audit Console — Operating Manual

The console at `/admin/ledger` is a React Server Component that
hydrates from three parallel promises (`getTenantAuditOverview`, first
keyset page of 50 chain entries, most recent 25 audit rows) and hands
them to a single `"use client"` component (`ledger-admin.tsx`). All
mutations flow through `"use server"` actions that share a unified
refresh payload so every button click rehydrates the banner, chain,
and audit history in **one RTT** with no `window.location.reload`.

#### Section A — Health Banner

- **emerald** = last reconcile PASSED, not quarantined, all four Δ
  metrics at zero.
- **amber** = last reconcile passed with INFO/MEDIUM findings (e.g.,
  issuance-scoped revenue/tax parity drift that the engine didn't
  auto-fix).
- **red** = DRIFT_DETECTED or HASH_BROKEN; quarantined is `true`; a
  pulsing **WRITES BLOCKED** badge is rendered; all financial APIs
  (invoice create/edit/pay, expense create, recurring generate,
  webhook processing for this tenant) will reject at one of the three
  quarantine layers.
- **gray** = no reconciliation has ever run for this tenant (fresh
  account).
- Four metric tiles: Open Receivables (AR), Cash on ledger, Paid
  Invoices Σ, Expenses Σ, each with a BigInt Δ vs. the Invoice/Expense
  read-model aggregates so an operator sees exactly which aggregate
  disagrees before drilling into Section C.

#### Section B — Hash-Chain Explorer

- Newest-first table of `LedgerEntry` rows with `DEBIT`/`CREDIT` side
  chips and copy-to-clipboard entry hash.
- Click a row to expand the canonical hash-link visualization:
  `prevEntryHash ↓ entryHash` in monospace, with full metadata
  (eventId, eventType, account, invoice/expense id, currency,
  timestamp, note).
- **"Load 50 More Entries"** button triggers the
  `loadMoreLedgerEntriesAction` server action, which goes through the
  same auth/tenant-isolation/rate-limit pipeline as mutations to
  prevent a compromised session from scraping another tenant's chain.
  The button is hidden when `nextCursor === null` and shows a spinner
  during fetch. After any mutation, `refreshChain()` resets to the
  first page with a `take = max(currentEntries.length, 50)` so newly
  appended entries appear at the top without clobbering scroll
  position.

#### Section C — Audit History

- Collapsible list of every `reconciliation_audits` row, newest first,
  with status badges (PASSED / DRIFT_DETECTED / HASH_BROKEN /
  TRANSIENT_FAILURE) and severity count pills (critical / high /
  medium / info).
- Expanding a row shows scanned-row count, duration, worker id,
  reconciler version, and an expected/actual/Δ paise breakdown for
  each discrepancy (formatted with the same `formatPaise` helper used
  by the UI so the numbers reconcile visually with Section A).

#### Operator Controls &amp; the Force-Release Workflow

All four mutation buttons share: (a) session auth via `requireUser()`,
(b) strict tenant id regex + `session.user.id === tenantId` check
(redirects to `/login` on mismatch — never reveals tenant existence),
(c) same-origin CSRF check on cookie sessions, (d) the distributed
rate limiter (10 req / 60 s per user — see below).

- **Run Reconciler Now** → `triggerTenantReconcileAction(uid)` with
  `force:true` (skips the engine's minimum-interval gate). Returns the
  serialized audit row.
- **Backfill &amp; Re-verify** → `backfillTenantAction(uid)` runs
  `operatorBackfill(uid)` (idempotently posts `INVOICE_ISSUED` for
  non-DRAFT invoices missing an issuance entry, plus PAID/VOIDED/
  EXPENSE_RECORDED as current state dictates), then a reconcile with
  `skipAutoBackfill` to avoid a second backfill pass.
- **Quarantine…** → prompts for a mandatory audit note (≤ 500 chars,
  trimmed), then calls `quarantineTenantAction`. Used when an operator
  suspects fraud, an import has corrupted data, or a migration went
  sideways — flips the quarantine flag without needing to wait for a
  reconcile cycle.
- **Release Quarantine…** → the safety-critical control.
  - Without **Force**, the engine runs a fresh reconcile and refuses
    to clear the flag unless the result is PASSED; residual drift
    leaves the flag set and returns `{ok:false, error}`.
  - With **Force** (labeled as an emergency override, destructive
    styling, confirmation checkbox), the flag is cleared
    unconditionally, and a confirm-run in `auditOnly:true` mode logs
    any residual drift as an INFO audit row *without re-quarantining*.
    This exists for two scenarios: (i) the operator has reviewed the
    discrepancies and accepted them as a known-good state change
    (e.g., a manually corrected opening balance), and (ii) emergency
    restoration of service while post-mortem is ongoing.
  - In both modes, an audit note is **mandatory** and becomes the
    `reason` on the release audit row so every state transition has a
    durable, attributable paper trail.

**Distributed rate limiting.** Server actions call
`assertMutationRateLimit(uid)` from `src/lib/rate-limiter.ts`. When
`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set, the
limiter evaluates a Lua sliding-window script over Upstash's REST API
with a 1.5 s timeout; on any timeout, network failure, or missing
credentials, it transparently falls back to an in-process `Map`-based
window so the app never crashes due to Redis unavailability. A single
stderr notice logs the fallback event once per process lifetime.

### Setup &amp; Verification Commands

SmartBill's Prisma schema, RLS policies, service role, ledger triggers,
and reconciler guard triggers are all applied via a single chainable
setup script. On a fresh PostgreSQL database:

```bash
# 1. Install dependencies
npm install

# 2. Apply Prisma schema, RLS, service-role, ledger triggers,
#    reconciler guard (6 tables), and seed the demo account.
#    Requires a running Postgres with the superuser role from prisma/schema.prisma.
DATABASE_URL="postgresql://smartbill:smartbill@localhost:5432/smart_billing?schema=public" \
  npm run db:setup
```

For CI and for verifying a change to the reconciler, ledger, or rate
limiter hasn't broken invariants:

```bash
# TypeScript strict-mode check (zero any, strict nulls)
./node_modules/.bin/tsc --noEmit

# Reconciler integration suite: 4 tests covering PASSED,
# auto-remediate backfill, hash-tamper → HASH_BROKEN + quarantine
# + L0001 trigger at the SQL layer, and force-release semantics.
npm test -- src/lib/reconciler.test.ts

# Authoritative production build (prisma generate + next build);
# fails on any tsc or RSC/server-action type error.
npx next build
```

The vitest suite provisions a stable `usr_reconciler_ci` test user
and resets all financial tables between tests, so it can be run
repeatedly against a local database without side effects.

### API Surface (Summary)

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/cron/reconcile?mode=incremental\|full\|single&tenantId=…` | Cron entry point, Bearer `CRON_SECRET`. `incremental` every 15 min, `full` at 03:00 IST. |
| GET/POST | `/api/cron/reconcile-ledger` | Alias for `/api/cron/reconcile` with dynamic config loading. |
| GET | `/api/admin/ledger/:tenantId/quarantine` | Current quarantine state + latest audit. |
| POST | `/api/admin/ledger/:tenantId/quarantine` | `{action: quarantine\|release\|backfill\|reconcile, reason, force?}`. Session callers scoped to own tenant; service callers use Bearer `CRON_SECRET`. Same-origin CSRF enforced. |
| GET | `/api/admin/ledger/:tenantId/audit?limit=N` | Recent audit rows. |

All server actions (trigger, release, quarantine, backfill, loadMore)
are callable directly from client components via the imported
`"use server"` references and don't have separate HTTP endpoints.

### Drift Taxonomy

| Severity | Code | Meaning | Auto-remediated? |
|---|---|---|---|
| CRITICAL | `HASH_CHAIN_BROKEN` | `entryHash` / `prevEntryHash` mismatch (tampering or bug) | No → quarantine |
| CRITICAL | `TAIL_POINTER_DESYNC` | User's `lastLedgerEntryId` doesn't match chain tail | Yes, in-tx |
| CRITICAL | `UNBALANCED_EVENT` | Σ debits ≠ Σ credits for an eventId | No → quarantine |
| CRITICAL | `ENTRY_INDEX_GAP` | Non-contiguous `entryIndex` (deleted/skipped row) | No → quarantine |
| HIGH | `AR_MISMATCH` | Ledger AR balance ≠ Σ PENDING invoice totals | Yes (backfill) |
| HIGH | `CASH_MISMATCH` | Ledger CASH balance ≠ signed Σ payment events | Yes (backfill) |
| HIGH | `EXPENSE_MISMATCH` | Ledger EXPENSES ≠ Σ expenses table | Yes (backfill) |
| MEDIUM | `REVENUE_TAX_MISMATCH` | Issuance-scoped revenue/tax parity | Information only |
| INFO | `TRANSIENT_ERROR` | Reconcile hit lock contention / retryable SQLSTATE | Next cron picks up |

A separate production-readiness audit of the full reconciler + UI
stack is maintained in [`LEDGER_AUDIT_REPORT.md`](./LEDGER_AUDIT_REPORT.md).
