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

## 🛡️ Ledger Audit Console (Admin)

SmartBill ships with an internal **Admin Audit Console** at `/admin/ledger`
(visible to signed-in users via the User Menu → "Ledger Audit Console"):

- **Section A — Health Banner.** Green/amber/red/slate status derived from the
  latest reconciliation run. Tiles show Open Receivables, Cash (ledger), Paid
  Invoices Σ, and Expenses Σ with Δ vs. read-model aggregates. Buttons:
  "Run Reconciler Now", "Backfill & Re-verify", and either "Release
  Quarantine…" (mandatory audit note + optional Force) or "Quarantine…"
  depending on state.
- **Section B — Hash-Chain Explorer.** Newest-first table of the SHA-256
  chained double-entry ledger with Dr/Cr side chips, copy-hash button, and
  a click-to-expand row that shows the prev ↓ entry hash link and full
  metadata (eventId, invoice/expense ids, currency, timestamp, note).
  "Load older entries" paginates back to 200 rows.
- **Section C — Audit History.** Collapsible list of every reconciliation
  run with status badges, severity pills (crit/high/med), scanned-row
  count, duration, and expanded expected/actual/Δ breakdown for each
  discrepancy.

### How reconciliation works

Two sweeps per tenant, every 15 min (incremental) and at 03:00 IST (full):

- **Sweep A** — Streams the ledger 500 rows at a time, verifies each SHA-256
  chain link, checks for entry-index gaps, and asserts ΣD = ΣC per eventId.
- **Sweep B** — SQL-pushed-down balance cross-checks:
  - `ACCOUNTS_RECEIVABLE` signed balance vs. Σ PENDING invoice totals.
  - `CASH` signed balance vs. per-event CASH aggregate (handles refunds and
    void-payment reversals correctly — no false positives after a
    `PAYMENT_REVERSED`).
  - `EXPENSES` signed balance vs. Σ expenses table.
  - MEDIUM-only Revenue/Tax parity (scoped to issuance/void events).

One idempotent auto-backfill runs for AR/CASH/EXPENSE mismatches when there
is no structural hash/gap failure; CRITICAL or residual HIGH drift flips
`users.ledgerQuarantinedAt` and **blocks all financial writes** via three
defense layers: `assertNotQuarantined()` before the chain lock,
`withTenant()` pre-tx check, and a `BEFORE INSERT OR UPDATE OR DELETE`
trigger raising SQLSTATE `L0001` on `invoices`, `invoice_items`,
`expenses`, `ledger_entries`.

Webhook payments for quarantined tenants are held (not DLQ'd) and resume
processing after release.

### API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/cron/reconcile?mode=incremental\|full\|single&tenantId=…` | Cron entry point (Bearer `CRON_SECRET`). |
| GET/POST | `/api/cron/reconcile-ledger` | Alias. |
| GET | `/api/admin/ledger/:tenantId/quarantine` | Current quarantine state + latest audit. |
| POST | `/api/admin/ledger/:tenantId/quarantine` | `{action: quarantine\|release\|backfill\|reconcile, reason, force?}`. Session callers are scoped to their own tenant; service callers use Bearer `CRON_SECRET`. Same-origin CSRF check enforced for cookie sessions. |
| GET | `/api/admin/ledger/:tenantId/audit?limit=N` | Recent audit rows. |

### Setup

After `prisma db push`, apply the RLS, service-role, ledger trigger, and
reconciler SQL files, then seed. The `npm run db:setup` script chains
these steps for a fresh database:

```bash
DATABASE_URL="postgresql://smartbill:smartbill@localhost:5432/smart_billing?schema=public" \
  npm run db:setup
```

A production-readiness audit of the full reconciler + UI stack is in
[`LEDGER_AUDIT_REPORT.md`](./LEDGER_AUDIT_REPORT.md).
