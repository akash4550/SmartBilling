-- CreateEnum
CREATE TYPE "InvoiceActivityType" AS ENUM ('CREATED', 'EDITED', 'SENT', 'REMINDED', 'VIEWED', 'PAID', 'PAYMENT_FAILED', 'MARKED_PAID', 'PDF_DOWNLOADED', 'DELETED', 'RECURRING_GENERATED');

-- CreateTable
CREATE TABLE "invoice_activities" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "InvoiceActivityType" NOT NULL,
    "message" TEXT,
    "ip" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_activities_invoiceId_createdAt_idx" ON "invoice_activities"("invoiceId", "createdAt");

-- CreateIndex
CREATE INDEX "invoice_activities_userId_idx" ON "invoice_activities"("userId");

-- AddForeignKey
ALTER TABLE "invoice_activities" ADD CONSTRAINT "invoice_activities_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_activities" ADD CONSTRAINT "invoice_activities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
