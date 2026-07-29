/**
 * Minimal RFC-4180-ish CSV parser that handles quoted fields, embedded commas,
 * embedded newlines, and escaped quotes (""). Returns an array of plain
 * objects keyed by the header row. Column headers are trimmed and lowercased
 * for matching. Designed for client-side import of small-to-medium CSVs
 * (≤500 rows); deliberately dependency-free to keep bundle size down.
 */

export interface ParseResult<T extends Record<string, string> = Record<string, string>> {
  rows: T[];
  headers: string[];
  errors: string[];
}

const COLUMN_ALIASES: Record<string, string> = {
  // name
  name: "name",
  "client name": "name",
  "customer name": "name",
  fullname: "name",
  "full name": "name",
  // email
  email: "email",
  "e-mail": "email",
  "email address": "email",
  // phone
  phone: "phone",
  telephone: "phone",
  mobile: "phone",
  "phone number": "phone",
  contact: "phone",
  // address
  address: "address",
  "billing address": "address",
  "street address": "address",
  // expense columns
  date: "date",
  date_: "date",
  "transaction date": "date",
  "posting date": "date",
  "invoice date": "date",
  category: "category",
  type: "category",
  tag: "category",
  description: "description",
  memo: "description",
  particulars: "description",
  details: "description",
  naration: "description",
  narration: "description",
  vendor: "description",
  payee: "description",
  merchant: "description",
  amount: "amount",
  cost: "amount",
  total: "amount",
  "amount (inr)": "amount",
  "amount inr": "amount",
  debit: "amount",
  notes: "notes",
  note: "notes",
};

function normalizeHeader(h: string): string | null {
  const key = h.trim().toLowerCase().replace(/\s+/g, " ").replace(/["']/g, "");
  return COLUMN_ALIASES[key] ?? null;
}

export function parseCsv(text: string): ParseResult {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Last field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) {
    return { rows: [], headers: [], errors: ["CSV is empty"] };
  }

  const rawHeaders = rows[0].map((h) => h.trim());
  const normalizedHeaders = rawHeaders.map(normalizeHeader);
  const errors: string[] = [];

  const nameIdx = normalizedHeaders.indexOf("name");
  const emailIdx = normalizedHeaders.indexOf("email");
  if (nameIdx === -1) errors.push("Missing required column: name");
  if (emailIdx === -1) errors.push("Missing required column: email");

  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // Skip entirely empty rows
    if (cells.every((c) => !c || !c.trim())) continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < rawHeaders.length; c++) {
      const mapped = normalizedHeaders[c];
      if (!mapped) continue;
      obj[mapped] = (cells[c] ?? "").trim();
    }
    out.push(obj);
  }

  return { rows: out as ParseResult["rows"], headers: rawHeaders, errors };
}
