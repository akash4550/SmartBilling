/**
 * POST /api/expenses/import
 *
 * Bulk-import expenses from a parsed CSV payload. Expects { rows: [...] } where
 * each row has date (YYYY-MM-DD), category, description, amount, notes.
 * Creates all valid rows in a single transaction; returns per-row errors so
 * the UI can show them.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized, jsonError } from "@/lib/api-helpers";
import { rateLimit, requestKey } from "@/lib/rate-limit";
import { withTenant } from "@/lib/tenant";
import { postLedgerEvent } from "@/lib/ledger";
import { z } from "zod";
import { expenseSchema, DEFAULT_EXPENSE_CATEGORIES } from "@/lib/validations";

const importSchema = z.object({
  rows: z
    .array(
      z.object({
        date: z.unknown(),
        category: z.unknown().optional(),
        description: z.unknown(),
        amount: z.unknown(),
        notes: z.unknown().optional(),
      })
    )
    .min(1, "CSV contains no data rows")
    .max(500, "CSV exceeds the 500-row limit per import"),
});

interface ImportError {
  row: number;
  message: string;
}

function clean(v: unknown): string {
  if (v == null) return "";
  return String(v).trim().replace(/^"(.*)"$/, "$1").trim();
}

/** Parse a flexible date string — supports YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY,
 *  and ISO strings. Returns YYYY-MM-DD or null. */
function parseDate(input: string): string | null {
  if (!input) return null;
  // YYYY-MM-DD already
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  // Try native Date
  const d = new Date(input);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  // DD/MM/YYYY (India-friendly)
  const m = input.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    const dt = new Date(y, mo - 1, d);
    if (!Number.isNaN(dt.getTime())) {
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const rl = rateLimit(requestKey(request, "import-expenses"), {
      namespace: "import-expenses",
      limit: 5,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many imports — please wait a minute before trying again." },
        { status: 429 }
      );
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonError("Invalid JSON payload", 400);
    }
    const parsed = importSchema.safeParse(payload);
    if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload", 400);

    const knownCategories = new Set<string>(DEFAULT_EXPENSE_CATEGORIES);
    const prepared: Array<{ date: Date; category: string; description: string; amount: number; notes?: string; rawRow: number }> = [];
    const errors: ImportError[] = [];

    for (let i = 0; i < parsed.data.rows.length; i++) {
      const r = parsed.data.rows[i];
      const description = clean(r.description);
      const amountStr = clean(r.amount);
      const category = clean(r.category) || "General";
      const notes = clean(r.notes) || undefined;
      const dateRaw = clean(r.date);
      const rowNum = i + 2;

      if (!description && !amountStr && !dateRaw) continue; // blank row

      const date = parseDate(dateRaw);
      const amount = Number(amountStr.replace(/[^0-9.-]/g, ""));
      const candidate = {
        date: date ?? "",
        category,
        description,
        amount: Number.isFinite(amount) ? amount : Number.NaN,
        notes,
      };
      const v = expenseSchema.safeParse(candidate);
      if (!v.success) {
        errors.push({ row: rowNum, message: v.error.issues[0]?.message ?? "Invalid row" });
        continue;
      }
      if (!knownCategories.has(category)) {
        // Allow custom categories freely — just let them through.
      }
      prepared.push({
        date: new Date(v.data.date),
        category: v.data.category,
        description: v.data.description,
        amount: v.data.amount,
        notes: v.data.notes,
        rawRow: rowNum,
      });
    }

    if (prepared.length === 0) {
      return NextResponse.json({ created: 0, skipped: parsed.data.rows.length, errors });
    }

    // Create all expenses in a single RLS-scoped transaction; post an
    // EXPENSE_RECORDED ledger entry for each so the books balance.
    const created = await withTenant(user.id, async (tx) => {
      const out: Array<{ id: string; description: string; amount: number }> = [];
      for (const e of prepared) {
        const rec = await tx.expense.create({
          data: {
            userId: user.id,
            date: e.date,
            category: e.category,
            description: e.description,
            amount: e.amount,
            notes: e.notes ?? null,
          },
        });
        await postLedgerEvent(
          {
            type: "EXPENSE_RECORDED",
            expense: {
              id: rec.id,
              userId: user.id,
              amount: e.amount, // use the pre-validated number; Decimal type would also work but number avoids any type friction
              category: e.category,
            },
          },
          tx
        );
        out.push({ id: rec.id, description: rec.description, amount: e.amount });
      }
      return out;
    });

    return NextResponse.json({
      created: created.length,
      skipped: parsed.data.rows.length - created.length,
      errors,
    });
  } catch (error) {
    console.error("[POST /api/expenses/import] Failed:", error);
    return jsonError("Failed to import expenses", 500);
  }
}
