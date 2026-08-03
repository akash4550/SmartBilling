# Smart Billing Application

[![CI](https://github.com/akash4550/SmartBilling/actions/workflows/ci.yml/badge.svg)](https://github.com/akash4550/SmartBilling/actions/workflows/ci.yml)

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

## 🌐 Live Demo

Deployed on Vercel: [**https://smart-bill-one-liard.vercel.app/login**](https://smart-bill-one-liard.vercel.app/login)

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
