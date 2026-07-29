import { z } from "zod";

// ============================================================
// INVOICE ITEM VALIDATION SCHEMA
// Validates a single line item on an invoice.
// ============================================================
export const invoiceItemSchema = z.object({
  /** Human-readable description of the product/service being billed. */
  description: z
    .string({ message: "Description is required" })
    .trim()
    .min(1, "Description cannot be empty")
    .max(300, "Description must be at most 300 characters"),

  /** Number of units; must be a positive integer (at least 1). */
  quantity: z.coerce
    .number({ message: "Quantity must be a number" })
    .int("Quantity must be a whole number")
    .min(1, "Quantity must be at least 1"),

  /** Unit price; must be a non-negative number (allowing zero for freebies). */
  price: z.coerce
    .number({ message: "Price must be a number" })
    .min(0, "Price must be zero or greater")
    .multipleOf(0.01, "Price can have at most 2 decimal places"),
});

export type InvoiceItemInput = z.infer<typeof invoiceItemSchema>;

// ============================================================
// CLIENT VALIDATION SCHEMA
// Validates client/biller data on create/update.
// ============================================================
export const clientSchema = z.object({
  /** Full name or company name of the client. */
  name: z
    .string({ message: "Name is required" })
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name must be at most 100 characters"),

  /** Unique email address used for contact & invoice delivery. */
  email: z
    .string({ message: "Email is required" })
    .trim()
    .email("Please enter a valid email address")
    .max(255, "Email must be at most 255 characters"),

  /** Optional billing address (street, city, state, ZIP, country). */
  address: z
    .string()
    .trim()
    .max(500, "Address must be at most 500 characters")
    .optional()
    .or(z.literal("").transform(() => undefined)),

  /** Optional contact phone number. */
  phone: z
    .string()
    .trim()
    .max(30, "Phone number must be at most 30 characters")
    .optional()
    .or(z.literal("").transform(() => undefined)),

  /** Optional internal notes (e.g. billing preferences). Not shown to clients. */
  notes: z
    .string()
    .trim()
    .max(2000, "Notes must be at most 2000 characters")
    .optional()
    .or(z.literal("").transform(() => undefined)),

  /** Optional per-client payment terms (days until due). Null = use user default. */
  dueDays: z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .nullable()
    .transform((v) => {
      if (v === null || v === undefined || v === "") return null;
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) return null;
      return Math.max(0, Math.min(365, Math.round(n)));
    }),
});

export type ClientInput = z.infer<typeof clientSchema>;

// ============================================================
// INVOICE VALIDATION SCHEMA
// Validates an entire invoice including its line items.
// ============================================================
const invoiceStatusEnum = z.enum(["DRAFT", "PENDING", "PAID"], {
  message: "Status must be DRAFT, PENDING, or PAID",
});
const discountTypeEnum = z.enum(["PERCENT", "FIXED"], {
  message: "Discount type must be PERCENT or FIXED",
});

export const invoiceSchema = z
  .object({
    /** The client this invoice is billed to (must reference an existing Client.id). */
    clientId: z
      .string({ message: "Please select a client" })
      .trim()
      .min(1, "Please select a client"),

    /** Lifecycle status of the invoice. Defaults to DRAFT on creation. */
    status: invoiceStatusEnum.default("DRAFT"),

    /** Date the invoice was issued (ISO date string YYYY-MM-DD). */
    issueDate: z
      .string({ message: "Issue date is required" })
      .min(1, "Issue date is required")
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Issue date must be in YYYY-MM-DD format"),

    /** Date payment is due (ISO date string YYYY-MM-DD). */
    dueDate: z
      .string({ message: "Due date is required" })
      .min(1, "Due date is required")
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Due date must be in YYYY-MM-DD format"),

    /** Tax rate as a percentage (0-100), default 0. Tax is applied after discount. */
    taxRate: z.coerce
      .number({ message: "Tax rate must be a number" })
      .min(0, "Tax rate cannot be negative")
      .max(100, "Tax rate cannot exceed 100%")
      .default(0),

    /** Tax label (GST/VAT/TAX/IGST etc). 1-12 chars, uppercased. */
    taxLabel: z
      .string()
      .trim()
      .min(1, "Tax label is required")
      .max(12, "Tax label must be at most 12 characters")
      .regex(/^[A-Za-z0-9 .-]+$/, "Only letters, numbers, dots, dashes, and spaces")
      .transform((s) => s.toUpperCase())
      .default("GST"),

    /** Optional discount (applied pre-tax). When discountType is set,
     *  discountValue must be a positive number (0..100 for PERCENT). */
    discountType: discountTypeEnum.optional().nullable(),
    discountValue: z.coerce
      .number()
      .min(0, "Discount cannot be negative")
      .optional()
      .nullable(),

    /** Optional free-text notes / terms shown on the invoice. */
    notes: z
      .string()
      .trim()
      .max(2000, "Notes must be at most 2000 characters")
      .optional()
      .or(z.literal("").transform(() => undefined)),

    /** At least one line item is required for a valid invoice. */
    items: z
      .array(invoiceItemSchema, { message: "At least one line item is required" })
      .min(1, "At least one line item is required"),
  })
  .refine(
    (data) => {
      const issue = new Date(data.issueDate).getTime();
      const due = new Date(data.dueDate).getTime();
      return !Number.isNaN(issue) && !Number.isNaN(due) && due >= issue;
    },
    {
      message: "Due date cannot be before the issue date",
      path: ["dueDate"],
    }
  )
  .refine(
    (data) => {
      if (data.discountType) {
        if (data.discountValue == null || Number.isNaN(Number(data.discountValue)) || Number(data.discountValue) <= 0) {
          return false;
        }
        if (data.discountType === "PERCENT" && Number(data.discountValue) > 100) {
          return false;
        }
      }
      return true;
    },
    {
      message:
        "Discount value is required when a discount type is set (0–100% or a positive amount)",
      path: ["discountValue"],
    }
  );

export type InvoiceInput = z.infer<typeof invoiceSchema>;

// ============================================================
// SETTINGS VALIDATION SCHEMA
// ============================================================
/** A 3- or 6-digit hex color string starting with `#`. */
const hexColor = z
  .string()
  .trim()
  .regex(/^#([0-9a-fA-F]{3}){1,2}$/, "Enter a valid hex color (e.g. #2563eb)");

export const settingsSchema = z.object({
  companyName: z.string().trim().min(1, "Company name is required").max(100),
  companyEmail: z.string().trim().email("Please enter a valid email").max(255),
  companyAddress: z.string().trim().max(1000).optional().or(z.literal("").transform(() => undefined)),
  companyPhone: z.string().trim().max(30).optional().or(z.literal("").transform(() => undefined)),
  defaultTaxRate: z.coerce.number().min(0).max(100, "Tax rate cannot exceed 100%"),
  /** Tax label shown next to the tax line (GST / VAT / TAX / IGST). */
  taxLabel: z
    .string()
    .trim()
    .min(1, "Tax label is required")
    .max(12, "Tax label must be at most 12 characters")
    .regex(/^[A-Za-z0-9 .-]+$/, "Only letters, numbers, dots, dashes, and spaces")
    .transform((s) => s.toUpperCase())
    .default("GST"),
  currency: z.string().trim().min(1).max(10).default("INR"),
  brandColor: hexColor.default("#2563eb"),
  defaultNotes: z
    .string()
    .trim()
    .max(2000, "Default notes must be at most 2000 characters")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  defaultDueDays: z.coerce
    .number()
    .int("Due days must be a whole number")
    .min(0, "Cannot be negative")
    .max(365, "Cannot exceed 365 days")
    .default(30),
  invoicePrefix: z
    .string()
    .trim()
    .min(1, "Prefix is required")
    .max(12, "Prefix must be at most 12 characters")
    .regex(/^[A-Za-z0-9_-]+$/, "Only letters, numbers, dashes, and underscores")
    .transform((s) => s.toUpperCase())
    .default("INV"),
  invoiceSeparator: z
    .string()
    .trim()
    .max(2, "Separator must be at most 2 characters")
    .regex(/^[-_. ]*$/, "Only dash, underscore, dot, or space")
    .default("-"),
  invoicePad: z.coerce
    .number()
    .int()
    .min(2, "Must be at least 2 digits")
    .max(8, "Must be at most 8 digits")
    .default(4),
});

export type SettingsInput = z.infer<typeof settingsSchema>;

// ============================================================
// ACCOUNT (PROFILE / PASSWORD) VALIDATION SCHEMA
// ============================================================
// Partial updates — callers send only the fields they want to change.
// Password changes require currentPassword for verification.
export const accountSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Name must be at least 2 characters")
      .max(80, "Name must be at most 80 characters")
      .optional(),

    email: z
      .string()
      .trim()
      .email("Please enter a valid email address")
      .max(255, "Email must be at most 255 characters")
      .optional(),

    currentPassword: z
      .string()
      .min(1, "Current password is required to change your password")
      .optional(),

    newPassword: z
      .string()
      .min(8, "New password must be at least 8 characters")
      .max(128, "New password must be at most 128 characters")
      .regex(/[A-Z]/, "New password must contain an uppercase letter")
      .regex(/[a-z]/, "New password must contain a lowercase letter")
      .regex(/[0-9]/, "New password must contain a number")
      .optional(),

    confirmPassword: z.string().optional(),
  })
  .refine(
    (data) => {
      // If any password field is set, all three must be set.
      const changing =
        data.currentPassword || data.newPassword || data.confirmPassword;
      if (!changing) return true;
      return Boolean(data.currentPassword && data.newPassword && data.confirmPassword);
    },
    {
      message:
        "To change your password, provide current password, new password, and confirmation",
      path: ["newPassword"],
    }
  )
  .refine(
    (data) => !data.newPassword || data.newPassword !== data.currentPassword,
    {
      message: "New password must be different from the current password",
      path: ["newPassword"],
    }
  )
  .refine(
    (data) => !data.newPassword || data.newPassword === data.confirmPassword,
    {
      message: "Passwords do not match",
      path: ["confirmPassword"],
    }
  );

export type AccountInput = z.infer<typeof accountSchema>;

// ============================================================
// RECURRING PROFILE VALIDATION SCHEMA
// ============================================================
export const recurrenceFrequencyEnum = z.enum(["WEEKLY", "MONTHLY", "YEARLY", "CUSTOM_DAYS"]);

export const recurringItemSchema = z.object({
  description: z.string().trim().min(1, "Description is required").max(300),
  quantity: z.coerce.number().int().min(1, "Quantity must be at least 1"),
  price: z.coerce.number().min(0).multipleOf(0.01, "Price can have at most 2 decimal places"),
});

export const recurringProfileSchema = z
  .object({
    clientId: z.string().min(1, "Please select a client"),
    frequency: recurrenceFrequencyEnum,
    intervalDays: z.coerce
      .number()
      .int()
      .min(1, "Interval must be at least 1 day")
      .max(365, "Interval cannot exceed 365 days")
      .optional(),
    dueInDays: z.coerce
      .number()
      .int()
      .min(0, "Due days cannot be negative")
      .max(365)
      .default(30),
    taxRate: z.coerce.number().min(0).max(100).default(0),
    notes: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    autoSend: z.coerce.boolean().default(true),
    active: z.coerce.boolean().default(true),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Start date must be YYYY-MM-DD")
      .optional(),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "End date must be YYYY-MM-DD")
      .optional()
      .or(z.literal("").transform(() => undefined)),
    items: z
      .array(recurringItemSchema)
      .min(1, "At least one line item is required"),
  })
  .refine(
    (data) => data.frequency !== "CUSTOM_DAYS" || (data.intervalDays && data.intervalDays >= 1),
    { message: "Custom frequency requires interval days", path: ["intervalDays"] }
  )
  .refine(
    (data) => !data.endDate || !data.startDate || data.endDate >= data.startDate,
    { message: "End date cannot be before start date", path: ["endDate"] }
  );

export type RecurringProfileInput = z.infer<typeof recurringProfileSchema>;
export type RecurringItemInput = z.infer<typeof recurringItemSchema>;

// ============================================================
// EXPENSE VALIDATION SCHEMA
// ============================================================
export const expenseSchema = z.object({
  date: z
    .string({ message: "Date is required" })
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
  category: z
    .string()
    .trim()
    .min(1, "Category is required")
    .max(40, "Category must be at most 40 characters")
    .default("General"),
  description: z
    .string({ message: "Description is required" })
    .trim()
    .min(1, "Description cannot be empty")
    .max(200, "Description must be at most 200 characters"),
  amount: z.coerce
    .number({ message: "Amount must be a number" })
    .min(0.01, "Amount must be greater than zero")
    .multipleOf(0.01, "Amount can have at most 2 decimal places"),
  notes: z
    .string()
    .trim()
    .max(1000, "Notes must be at most 1000 characters")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export type ExpenseInput = z.infer<typeof expenseSchema>;

export const DEFAULT_EXPENSE_CATEGORIES = [
  "Software & SaaS",
  "Marketing",
  "Travel",
  "Materials",
  "Contractors",
  "Office",
  "Legal & Accounting",
  "Taxes",
  "Bank Fees",
  "General",
] as const;
