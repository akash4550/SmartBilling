/*
  Warnings:

  - A unique constraint covering the columns `[portalToken]` on the table `clients` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[resetToken]` on the table `users` will be added. If there are existing duplicate values, this will fail.
  - The required column `portalToken` was added to the `clients` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - Added the required column `userId` to the `invoice_items` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `recurring_items` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "WebhookIngestionStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'DLQ', 'POISON');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ACCOUNTS_RECEIVABLE', 'REVENUE', 'DISCOUNT_CONTRA', 'TAX_PAYABLE', 'CASH', 'EXPENSES');

-- CreateEnum
CREATE TYPE "EntrySide" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "LedgerEventType" AS ENUM ('INVOICE_ISSUED', 'INVOICE_PAID', 'INVOICE_VOIDED', 'PAYMENT_REVERSED', 'EXPENSE_RECORDED');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('PASSED', 'DRIFT_DETECTED', 'HASH_BROKEN', 'TRANSIENT_FAILURE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InvoiceActivityType" ADD VALUE 'VOIDED';
ALTER TYPE "InvoiceActivityType" ADD VALUE 'EMAIL_DELIVERED';
ALTER TYPE "InvoiceActivityType" ADD VALUE 'EMAIL_BOUNCED';
ALTER TYPE "InvoiceActivityType" ADD VALUE 'EMAIL_COMPLAINED';
ALTER TYPE "InvoiceActivityType" ADD VALUE 'EMAIL_OPENED';

-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'VOID';

-- DropIndex
DROP INDEX "invoices_userId_idx";

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "dueDays" INTEGER,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "portalToken" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "invoice_items" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "discountType" "DiscountType",
ADD COLUMN     "discountValue" DECIMAL(12,2),
ADD COLUMN     "taxLabel" TEXT NOT NULL DEFAULT 'GST';

-- AlterTable
ALTER TABLE "recurring_items" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "brandColor" TEXT NOT NULL DEFAULT '#2563eb',
ADD COLUMN     "defaultDueDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "defaultNotes" TEXT,
ADD COLUMN     "invoicePad" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "invoicePrefix" TEXT NOT NULL DEFAULT 'INV',
ADD COLUMN     "invoiceSeparator" TEXT NOT NULL DEFAULT '-',
ADD COLUMN     "logoContentType" TEXT,
ADD COLUMN     "logoData" TEXT,
ADD COLUMN     "taxLabel" TEXT NOT NULL DEFAULT 'GST';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "lastLedgerEntryHash" TEXT,
ADD COLUMN     "lastLedgerEntryId" TEXT,
ADD COLUMN     "lastReconciledAt" TIMESTAMP(3),
ADD COLUMN     "ledgerQuarantineReason" TEXT,
ADD COLUMN     "ledgerQuarantinedAt" TIMESTAMP(3),
ADD COLUMN     "resetToken" TEXT,
ADD COLUMN     "resetTokenExpires" TIMESTAMP(3),
ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'General',
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_ingestions" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT,
    "eventType" TEXT NOT NULL,
    "rawBody" TEXT NOT NULL,
    "signature" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "WebhookIngestionStatus" NOT NULL DEFAULT 'PENDING',
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "poisonPill" BOOLEAN NOT NULL DEFAULT false,
    "poisonReason" TEXT,
    "redriveCount" INTEGER NOT NULL DEFAULT 0,
    "redriveAfter" TIMESTAMP(3),
    "lastAlertedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolveNote" TEXT,

    CONSTRAINT "webhook_ingestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" "LedgerEventType" NOT NULL,
    "account" "AccountType" NOT NULL,
    "side" "EntrySide" NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "prevEntryHash" TEXT NOT NULL,
    "entryHash" TEXT NOT NULL,
    "entryIndex" INTEGER NOT NULL,
    "invoiceId" TEXT,
    "expenseId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_audits" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "status" "ReconciliationStatus" NOT NULL,
    "entriesScanned" INTEGER NOT NULL DEFAULT 0,
    "firstBrokenIndex" INTEGER,
    "discrepancies" JSONB,
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "highCount" INTEGER NOT NULL DEFAULT 0,
    "mediumCount" INTEGER NOT NULL DEFAULT 0,
    "infoCount" INTEGER NOT NULL DEFAULT 0,
    "triggeredAlert" BOOLEAN NOT NULL DEFAULT false,
    "autoRemediated" BOOLEAN NOT NULL DEFAULT false,
    "autoRemediation" TEXT,
    "workerId" TEXT,
    "version" TEXT NOT NULL DEFAULT '1',

    CONSTRAINT "reconciliation_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expenses_userId_date_idx" ON "expenses"("userId", "date");

-- CreateIndex
CREATE INDEX "expenses_userId_category_idx" ON "expenses"("userId", "category");

-- CreateIndex
CREATE INDEX "wh_ingest_claim_idx" ON "webhook_ingestions"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "wh_ingest_created_idx" ON "webhook_ingestions"("createdAt");

-- CreateIndex
CREATE INDEX "wh_ingest_redrive_idx" ON "webhook_ingestions"("status", "redriveAfter");

-- CreateIndex
CREATE INDEX "wh_ingest_poison_idx" ON "webhook_ingestions"("poisonPill", "status");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_ingestions_provider_providerEventId_key" ON "webhook_ingestions"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "ledger_entries_userId_createdAt_idx" ON "ledger_entries"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_entries_userId_eventId_idx" ON "ledger_entries"("userId", "eventId");

-- CreateIndex
CREATE INDEX "ledger_entries_invoiceId_idx" ON "ledger_entries"("invoiceId");

-- CreateIndex
CREATE INDEX "ledger_entries_expenseId_idx" ON "ledger_entries"("expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_userId_entryIndex_key" ON "ledger_entries"("userId", "entryIndex");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_userId_entryHash_key" ON "ledger_entries"("userId", "entryHash");

-- CreateIndex
CREATE INDEX "reconciliation_audits_tenantId_startedAt_idx" ON "reconciliation_audits"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "reconciliation_audits_status_startedAt_idx" ON "reconciliation_audits"("status", "startedAt");

-- CreateIndex
CREATE INDEX "reconciliation_audits_criticalCount_highCount_idx" ON "reconciliation_audits"("criticalCount", "highCount");

-- CreateIndex
CREATE UNIQUE INDEX "clients_portalToken_key" ON "clients"("portalToken");

-- CreateIndex
CREATE INDEX "invoice_items_userId_idx" ON "invoice_items"("userId");

-- CreateIndex
CREATE INDEX "invoices_userId_createdAt_idx" ON "invoices"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "invoices_userId_paidAt_idx" ON "invoices"("userId", "paidAt");

-- CreateIndex
CREATE INDEX "invoices_userId_dueDate_idx" ON "invoices"("userId", "dueDate");

-- CreateIndex
CREATE INDEX "invoices_userId_issueDate_idx" ON "invoices"("userId", "issueDate");

-- CreateIndex
CREATE INDEX "invoices_stripePaymentIntentId_idx" ON "invoices"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "invoices_razorpayOrderId_idx" ON "invoices"("razorpayOrderId");

-- CreateIndex
CREATE INDEX "recurring_items_userId_idx" ON "recurring_items"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "users_resetToken_key" ON "users"("resetToken");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_audits" ADD CONSTRAINT "reconciliation_audits_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
