/**
 * POST /api/clients/import
 *
 * Bulk-import clients from a CSV payload. The CSV must include the columns
 * `name` and `email`; `phone`, `address` are optional. Rows that fail
 * validation (or would duplicate an existing email for this user) are
 * returned in `errors` so the UI can display them; valid rows are created
 * in a single transaction.
 *
 * Rate limited: 5 imports per minute per user (each import may contain up
 * to 500 rows) — prevents abuse without blocking reasonable onboarding.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized, jsonError } from "@/lib/api-helpers";
import { rateLimit, requestKey } from "@/lib/rate-limit";
import { z } from "zod";
import { clientSchema } from "@/lib/validations";
import crypto from "node:crypto";

const importSchema = z.object({
  /** Array of row objects (parsed CSV) to import. */
  rows: z
    .array(
      z.object({
        name: z.unknown(),
        email: z.unknown(),
        phone: z.unknown().optional(),
        address: z.unknown().optional(),
      })
    )
    .min(1, "CSV contains no data rows")
    .max(500, "CSV exceeds the 500-row limit per import"),
});

interface ImportError {
  row: number;
  name?: string;
  email?: string;
  message: string;
}

interface ImportResult {
  created: number;
  skipped: number;
  errors: ImportError[];
  clients: Array<{ id: string; name: string; email: string }>;
}

function clean(v: unknown): string {
  if (v == null) return "";
  return String(v).trim().replace(/^"(.*)"$/, "$1").trim();
}

/** Generate a fresh 64-hex portal token for each newly imported client. */
function newPortalToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    // Rate limit: 5 imports per minute per user.
    const rl = rateLimit(requestKey(request, "import-clients"), {
      namespace: "import-clients",
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
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Invalid payload";
      return jsonError(msg, 400);
    }

    const { rows } = parsed.data;

    // Normalize rows into ClientInput-shaped objects and collect per-row errors.
    const prepared: Array<{ name: string; email: string; phone?: string; address?: string; rawRow: number }> = [];
    const errors: ImportError[] = [];
    const seenEmails = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const name = clean(r.name);
      const email = clean(r.email).toLowerCase();
      const phone = clean(r.phone) || undefined;
      const address = clean(r.address) || undefined;
      const rowNum = i + 2; // +2 accounts for header row + 0-index

      if (!name && !email) {
        // Entirely blank row — skip silently.
        continue;
      }

      const candidate = { name, email, phone, address };
      const v = clientSchema.safeParse(candidate);
      if (!v.success) {
        const firstIssue = v.error.issues[0];
        errors.push({
          row: rowNum,
          name: name || undefined,
          email: email || undefined,
          message: `${firstIssue.path.join(".")}: ${firstIssue.message}`,
        });
        continue;
      }

      const key = email.toLowerCase();
      if (seenEmails.has(key)) {
        errors.push({ row: rowNum, name, email, message: "Duplicate email in this CSV" });
        continue;
      }
      seenEmails.add(key);
      prepared.push({ ...v.data, email: v.data.email.toLowerCase(), rawRow: rowNum });
    }

    if (prepared.length === 0) {
      return NextResponse.json(
        { created: 0, skipped: rows.length, errors, clients: [] } satisfies ImportResult,
        { status: 200 }
      );
    }

    // Check for existing clients with these emails to skip duplicates.
    const existing = await prisma.client.findMany({
      where: {
        userId: user.id,
        email: { in: prepared.map((p) => p.email) },
      },
      select: { email: true },
    });
    const existingEmails = new Set(existing.map((e) => e.email.toLowerCase()));

    const toCreate = prepared.filter((p) => {
      if (existingEmails.has(p.email)) {
        errors.push({
          row: p.rawRow,
          name: p.name,
          email: p.email,
          message: "A client with this email already exists",
        });
        return false;
      }
      return true;
    });

    // Bulk create inside a transaction so we don't partially commit.
    const created = await prisma.$transaction(
      toCreate.map((c) =>
        prisma.client.create({
          data: {
            userId: user.id,
            name: c.name,
            email: c.email,
            phone: c.phone,
            address: c.address,
            portalToken: newPortalToken(),
          },
          select: { id: true, name: true, email: true },
        })
      )
    );

    return NextResponse.json({
      created: created.length,
      skipped: rows.length - created.length,
      errors,
      clients: created,
    } satisfies ImportResult, { status: 201 });
  } catch (error) {
    console.error("[POST /api/clients/import] Failed:", error);
    return jsonError("Failed to import clients", 500);
  }
}
