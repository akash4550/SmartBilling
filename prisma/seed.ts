/**
 * Prisma seed script for SmartBill
 *
 * Run with:  npx prisma db seed
 *
 * Creates a demo admin user from ADMIN_EMAIL / ADMIN_PASSWORD env vars
 * (falling back to admin@smartbill.com / password123) and populates
 * that user with realistic Indian demo data — an "Acme Web Design"
 * studio with 7 clients and ~19 invoices spread over 6 months.
 */

import { PrismaClient, InvoiceStatus } from "@prisma/client";

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Demo constants
// ---------------------------------------------------------------------------
const COMPANY = {
  companyName: "Acme Web Design",
  companyEmail: "hello@acmewebdesign.in",
  companyAddress: "4th Floor, Innov8 Coworking\nKoramangala, Bengaluru, KA 560034",
  companyPhone: "+91 98765 43210",
  defaultTaxRate: 18,
  currency: "INR",
};

const ADMIN = {
  name: "Admin User",
  email: (process.env.ADMIN_EMAIL || "admin@smartbill.com").toLowerCase().trim(),
  password: process.env.ADMIN_PASSWORD || "password123",
};

const CLIENTS: Array<{ name: string; email: string; address: string; phone?: string }> = [
  { name: "Rohan Mehta", email: "rohan@bluestoneinteriors.in", address: "12, MG Road\nBengaluru, KA 560001", phone: "+91 98100 11122" },
  { name: "Priya Sharma", email: "priya@tastybites.co", address: "SCO 23, Sector 17\nChandigarh, 160017", phone: "+91 98765 22233" },
  { name: "Karthik Subramanian", email: "karthik@finflow.io", address: "Tidel Park, Taramani\nChennai, TN 600113" },
  { name: "Ananya Desai", email: "ananya@desaiboutique.com", address: "Linking Road\nBandra West, Mumbai, MH 400050", phone: "+91 99200 33344" },
  { name: "Vikram Reddy", email: "vikram@hydbrew.co", address: "Jubilee Hills\nHyderabad, TS 500033" },
  { name: "GreenLeaf Organics Pvt Ltd", email: "accounts@greenleaforganics.in", address: "Plot 45, Phase II\nUdyog Vihar, Gurugram, HR 122016", phone: "+91 124 456 7788" },
  { name: "Saira Kapoor", email: "saira@kapoorstudio.com", address: "Khan Market\nNew Delhi, 110003", phone: "+91 98111 55566" },
];

const SERVICE_CATALOG = [
  { description: "Landing page design & development", unitPrice: 18000 },
  { description: "Responsive website development (5 pages)", unitPrice: 45000 },
  { description: "E-commerce storefront setup", unitPrice: 85000 },
  { description: "Logo design & brand identity pack", unitPrice: 22000 },
  { description: "UI/UX design — mobile app", unitPrice: 60000 },
  { description: "Monthly website maintenance", unitPrice: 8000 },
  { description: "SEO setup & Google Analytics integration", unitPrice: 12000 },
  { description: "WordPress theme customization", unitPrice: 25000 },
  { description: "Custom CMS integration (Sanity/Strapi)", unitPrice: 35000 },
  { description: "Web hosting (annual)", unitPrice: 6000 },
  { description: "Domain registration (1 year)", unitPrice: 1200 },
  { description: "SSL certificate setup", unitPrice: 1500 },
  { description: "Contact form & email automation", unitPrice: 5500 },
  { description: "Performance & Core Web Vitals optimization", unitPrice: 9000 },
  { description: "Payment gateway integration (Razorpay/Stripe)", unitPrice: 11000 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function random(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
function daysFromNow(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}
function formatInvoiceNumber(seq: number): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `INV-${y}${m}-${String(seq).padStart(4, "0")}`;
}

function buildLineItems(): Array<{ description: string; quantity: number; price: number; total: number }> {
  const count = random(1, 4);
  const items: Array<{ description: string; quantity: number; price: number; total: number }> = [];
  const used = new Set<string>();
  while (items.length < count) {
    const svc = pick(SERVICE_CATALOG);
    if (used.has(svc.description)) continue;
    used.add(svc.description);
    const quantity = svc.description.startsWith("Monthly") ? random(1, 3) : 1;
    const price = svc.unitPrice;
    const total = Math.round(quantity * price * 100) / 100;
    items.push({ description: svc.description, quantity, price, total });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("🌱 Seeding database...");

  // 1. Wipe everything (respecting FKs)
  await prisma.invoiceItem.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.client.deleteMany();
  await prisma.settings.deleteMany();
  await prisma.user.deleteMany();
  console.log("  · Cleared existing data");

  // 2. Create admin user with argon2id-hashed password
  const { default: argon2 } = await import("argon2");
  const passwordHash = await argon2.hash(ADMIN.password, { type: 2 });
  const admin = await prisma.user.create({
    data: {
      name: ADMIN.name,
      email: ADMIN.email,
      passwordHash,
    },
  });
  console.log(`  · Admin user: ${ADMIN.email}`);

  // 3. Upsert settings row for this user
  await prisma.settings.create({
    data: {
      userId: admin.id,
      ...COMPANY,
    },
  });
  console.log(`  · Settings: ${COMPANY.companyName}`);

  // 4. Create clients scoped to admin
  const clients: Array<{ id: string }> = [];
  for (const c of CLIENTS) {
    const client = await prisma.client.create({
      data: {
        userId: admin.id,
        name: c.name,
        email: c.email,
        address: c.address,
        phone: c.phone,
      },
    });
    clients.push({ id: client.id });
  }
  console.log(`  · Created ${clients.length} clients`);

  // 5. Create invoices scoped to admin
  let seq = 1;

  async function createInvoice(params: {
    clientIdx: number;
    issueDate: Date;
    dueDate: Date;
    status: InvoiceStatus;
    taxRate: number;
    paidAt?: Date | null;
  }) {
    const items = buildLineItems();
    const subtotal = items.reduce((s, it) => s + it.total, 0);
    const taxAmount = Math.round((subtotal * (params.taxRate / 100) + Number.EPSILON) * 100) / 100;
    const totalAmount = Math.round((subtotal + taxAmount + Number.EPSILON) * 100) / 100;

    await prisma.invoice.create({
      data: {
        userId: admin.id,
        invoiceNumber: formatInvoiceNumber(seq++),
        clientId: clients[params.clientIdx].id,
        status: params.status,
        issueDate: params.issueDate,
        dueDate: params.dueDate,
        subtotal,
        taxRate: params.taxRate,
        totalAmount,
        paidAt: params.paidAt ?? null,
        items: {
          create: items.map((it) => ({
            userId: admin.id,
            description: it.description,
            quantity: it.quantity,
            price: it.price,
            total: it.total,
          })),
        },
      },
    });
  }

  await createInvoice({ clientIdx: 5, issueDate: daysAgo(28), dueDate: daysAgo(11), status: "PENDING", taxRate: COMPANY.defaultTaxRate });
  await createInvoice({ clientIdx: 1, issueDate: daysAgo(20), dueDate: daysAgo(3), status: "PENDING", taxRate: COMPANY.defaultTaxRate });

  const paidPerMonth = [1, 2, 3, 2, 3, 2];
  for (let monthIdx = 0; monthIdx < paidPerMonth.length; monthIdx++) {
    const count = paidPerMonth[monthIdx];
    for (let n = 0; n < count; n++) {
      const daysBack = (5 - monthIdx) * 30 + random(2, 28);
      // paidAt some day between issue/due and today (realistic payment delay)
      const paidDaysAgo = Math.max(1, daysBack - random(0, 25));
      await createInvoice({
        clientIdx: random(0, clients.length - 1),
        issueDate: daysAgo(daysBack),
        dueDate: daysAgo(Math.max(1, daysBack - 15)),
        status: "PAID",
        taxRate: COMPANY.defaultTaxRate,
        paidAt: daysAgo(paidDaysAgo),
      });
    }
  }

  await createInvoice({ clientIdx: 2, issueDate: daysAgo(5), dueDate: daysFromNow(10), status: "PENDING", taxRate: COMPANY.defaultTaxRate });
  await createInvoice({ clientIdx: 6, issueDate: daysAgo(2), dueDate: daysFromNow(21), status: "PENDING", taxRate: COMPANY.defaultTaxRate });
  await createInvoice({ clientIdx: 0, issueDate: new Date(), dueDate: daysFromNow(30), status: "DRAFT", taxRate: COMPANY.defaultTaxRate });
  await createInvoice({ clientIdx: 3, issueDate: daysAgo(1), dueDate: daysFromNow(14), status: "DRAFT", taxRate: COMPANY.defaultTaxRate });

  const [paidCount, pendingCount, draftCount] = await Promise.all([
    prisma.invoice.count({ where: { userId: admin.id, status: "PAID" } }),
    prisma.invoice.count({ where: { userId: admin.id, status: "PENDING" } }),
    prisma.invoice.count({ where: { userId: admin.id, status: "DRAFT" } }),
  ]);
  const overdueCount = await prisma.invoice.count({
    where: { userId: admin.id, status: "PENDING", dueDate: { lt: new Date() } },
  });

  console.log(`  · Created ${paidCount + pendingCount + draftCount} invoices (${paidCount} paid, ${pendingCount} pending, ${draftCount} draft)`);
  console.log(`  · Overdue pending invoices: ${overdueCount}`);
  console.log("✅ Seeding complete!");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
