# SmartBill — Senior Staff Engineer Code Review

> **Archived review snapshot:** This report was produced against an earlier implementation. Several findings—especially API authentication, database-backed password hashing, standalone public layouts, dedicated public endpoints, dashboard summary APIs, and seed tax rounding—are already addressed on current `main` (`3789d0f`). Revalidate each finding against the current code before acting on it.

**Project:** Next.js 16 (App Router) · TypeScript (strict) · Prisma 5 / PostgreSQL · NextAuth v5 beta · Tailwind + Shadcn-style primitives · Resend · OpenAI (gpt-4o-mini) · Recharts · Framer Motion v12
**Scope:** every `.ts`/`.tsx` under `src/` + `prisma/schema.prisma`, `prisma/seed.ts`, `Dockerfile`, `middleware.ts`, config.
**Sanity checks performed:**
- `npx tsc --noEmit` → ✅ **0 TypeScript errors** (strict mode on).
- `npm run build` (Turbopack) → ✅ **build succeeds**; 14/14 routes are correctly marked `ƒ` (dynamic). Expected "Can't reach database server" noise during static pre-render is caught by the server-component try/catch fallbacks in `/clients` and `/clients/[id]` and returns `[]`.
- Hand-audit of every route, auth path, and data shape.

> **Headline:** The UI/UX, type discipline, component structure, Prisma modelling, and deployment scaffolding are genuinely strong. A v1 launch *could* ship after fixing one class of bugs. Unfortunately that class is **showstopper**: **every mutation API (and most read APIs) is completely unauthenticated**, because middleware whitelists `/api/invoices` and zero handlers ever call `auth()`. The rest of the report classifies every finding by severity with exact fix snippets.

---

## 🔴 CRITICAL / HIGH — must fix before deploy

### H1. **Unauthenticated API routes — full account data exfiltration / PII leak / data destruction**
**Files:** `src/middleware.ts`, and *every* handler in `src/app/api/**/route.ts` except `[...nextauth]`.

The comment in `src/app/api/invoices/[id]/route.ts` says:

> *"GET is intentionally public … All mutations (PATCH, DELETE) … are protected at the route level."*

This is **false**. No API handler imports `auth`, and middleware whitelists `/api/invoices`:

```ts
// src/middleware.ts
const PUBLIC_PATHS = [
  "/login", "/view", "/api/auth",
  "/api/invoices", // ❌ matches /api/invoices, /api/invoices/:id, /api/invoices/:id/send
  "/_next", "/favicon.ico", "/og.png",
];
```

Because the other protected prefixes are `/dashboard|/invoices|/clients|/settings` (page routes only), **none** of the following paths run an auth check anywhere:

| Method | Route | Impact |
|---|---|---|
| GET | `/api/invoices` | Enumerate every invoice + line items + client PII (name/email/address) — paginated, full dump |
| POST | `/api/invoices` | Forge invoices |
| PATCH | `/api/invoices/:id` | Mass "mark as paid" / revert to DRAFT on any invoice |
| DELETE | `/api/invoices/:id` | Delete any invoice (cascades to items) |
| POST | `/api/invoices/:id/send` | Trigger Resend spam/harassment; enumerate client emails via bounce/send-confirmation; burn Resend quota |
| GET/POST/PUT/PATCH/DELETE | `/api/clients[/:id]` | **Dump full client list (PII)**; create/edit/delete clients |
| GET/PATCH | `/api/settings` | Read company email/phone; **deface company profile** (name/email/phone/GST rate shown on every invoice + email) |
| POST | `/api/parse-receipt` | Unauthenticated OpenAI proxy — **free credit burn / DoS** |

Combined, an unauthenticated internet attacker can:
1. `GET /api/invoices?limit=100` → harvest every client's name + email + address + invoice totals (PII breach under GDPR/DPDPA).
2. `DELETE /api/invoices/:id` in a loop → wipe the database.
3. `PATCH /api/settings` with `{companyName:"Owned", companyEmail:"attacker@..."}` → every subsequently-sent invoice/email appears to come from the attacker.
4. `POST /api/parse-receipt` in a tight loop → burn OpenAI credits.

**Fix (apply uniformly):**

1. Remove `/api/invoices` from `PUBLIC_PATHS`; add a new narrow public prefix only for the single public read route (see step 3).
2. Add a tiny reusable auth guard and call it at the top of every protected handler:

```ts
// src/lib/api-helpers.ts  (add)
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function requireUser() {
  const session = await auth();
  if (!session?.user) return null;
  return session.user;
}
export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

3. Make only the single public endpoint public. Two good options:
   - **(Recommended)** Change the public portal to call a dedicated public route (e.g. `/api/public/invoices/[id]`) that only supports `GET` by CUID and apply stricter rate-limits, leaving `/api/invoices*` fully protected.
   - **(Quick)** In middleware, treat `/api/invoices/:id` GET as public *by method*; middleware can't see the method? Actually it can (`request.method`). For a faster patch, keep `/api/invoices` private and call auth inside `GET /api/invoices/[id]/route.ts` selectively (i.e. allow unauth *only* for GET, require auth for PATCH/DELETE in the same file):

```ts
// src/app/api/invoices/[id]/route.ts
import { requireUser, unauthorized } from "@/lib/api-helpers";

export async function GET(_req, { params }) {
  // public (by design — non-guessable CUID used in emailed links)
  ...
}
export async function PATCH(req, { params }) {
  if (!(await requireUser())) return unauthorized();
  ...
}
export async function DELETE(req, { params }) {
  if (!(await requireUser())) return unauthorized();
  ...
}
```

Apply the same `if (!(await requireUser())) return unauthorized();` guard to:
- `GET/POST /api/clients`, `GET/PUT/PATCH/DELETE /api/clients/[id]`
- `GET/POST /api/invoices` (list and create must be protected)
- `POST /api/invoices/[id]/send`
- `GET/PATCH /api/settings`
- `POST /api/parse-receipt`

And update middleware's public list accordingly:

```ts
// src/middleware.ts — recommended PUBLIC_PATHS
const PUBLIC_PATHS = [
  "/login",
  "/view",            // client portal page
  "/api/auth",        // NextAuth
  "/_next",
  "/favicon.ico",
  "/og.png",
];
// (Do NOT include /api/invoices — the public GET is handled inside the route
//  by calling auth() and skipping the check for GET.)
```

---

### H2. **Credentials stored in plaintext with hardcoded demo password (flagged, acceptable for demo, but not hardened)**
**File:** `src/lib/auth.ts`

```ts
password: "password123", // hardcoded, plaintext compare
```

The code already comments this clearly. However, before any real deploy:
- Move credentials to a database (the Prisma schema already has a `User` model that's unused) and hash with `bcrypt`/`argon2`.
- Add CSRF-safe callbackUrl validation — currently `callbackUrl` from the querystring is passed straight to `router.push(res.url || callbackUrl)` on the login page. `signIn`'s built-in redirect protection applies to its *own* redirect, but after a successful `redirect:false` signIn you manually `router.push(callbackUrl)` from the querystring, which is **open-redirect** (e.g. `/login?callbackUrl=https://evil.com`). Next.js's router will *not* navigate cross-origin on `router.push` (it resolves to the same origin), but it's still worth normalising:

```ts
// src/app/login/page.tsx
const rawCallbackUrl = searchParams.get("callbackUrl") || "/dashboard";
const callbackUrl = rawCallbackUrl.startsWith("/") && !rawCallbackUrl.startsWith("//")
  ? rawCallbackUrl
  : "/dashboard";
```

---

### H3. **`POST /api/invoices` — TOCTOU / race on invoice-number generation**
**File:** `src/app/api/invoices/route.ts`

```ts
const invoiceCount = await prisma.invoice.count();
const invoiceNumber  = generateInvoiceNumber(invoiceCount);
// ... await prisma.invoice.create({ data: { invoiceNumber, ... }})
```

Under concurrent creation (two requests in the same millisecond), both see the same `count` and try to insert the same `invoiceNumber`. The `@unique` constraint will make one of them throw a P2002, which is caught and returned as a 409 — **not** a data-corruption bug, but the UX is a hard error rather than a retry. Wrap in a transaction + small retry loop, or better: **generate the sequence number atomically** with a separate counter, or move away from count-based sequencing entirely (e.g. use a separate `InvoiceSequence` table, or use `prisma.$executeRaw` with a Postgres sequence).

Low-lift improvement: retry on P2002 up to 3 times inside POST.

---

### H4. **Demo seed data — tax is computed to 3-decimal precision instead of 2**
**File:** `prisma/seed.ts`

```ts
const taxAmount = Math.round(subtotal * params.taxRate * 100) / 10000;
```

The comment in the design says "2-decimal rounding". As written, `taxAmount` is rounded to 4 decimal places of *rupees*, i.e. 2-decimal places of the tax value only when `subtotal*rate` is an integer number of rupees. Example (`subtotal = 1000.55, rate = 18`): expected tax = `180.10`, seed produces `180.099` → stored as `180.099` in Decimal(12,2) which Prisma/Postgres will round to `180.10` upon insert — **Postgres rounds to 2 dp on save**, so the *stored* value ends up correct, but the returned in-memory value differs from the actual total, and the `totalAmount` calculation `Math.round((subtotal + taxAmount) * 100) / 100` is performed against the un-rounded `180.099` which gives `1180.65` (correct by accident).

Make it explicit and match the production helper:

```ts
// prisma/seed.ts (replacement)
function round2(n: number) { return Math.round((n + Number.EPSILON) * 100) / 100; }
// ...
const taxAmount = round2(subtotal * (params.taxRate / 100));
const totalAmount = round2(subtotal + taxAmount);
```

Also, the seed uses `formatInvoiceNumber(seq)` which is in format `INV-YYYYMM-NNNN` (monthly sequence) while production `generateInvoiceNumber(count)` uses `INV-YYYYMMDD-NNNN` (daily sequence). The seed creates 19 invoices total with `seq = 1..19`, which yields `INV-202607-0001 … INV-202607-0019` — **all in the current month with `seq` in order**, so there's no collision risk even across months since the format includes the month. However mixing formats (seed vs runtime) is confusing. Recommend the seed import & call `generateInvoiceNumber` from `src/lib/utils.ts` (after stripping the IST-specific date formatter, or duplicating it) so the two can't drift.

---

## 🟡 MEDIUM — performance / UX / hydration warnings

### M1. **`/view/:id` still renders the admin Navbar + footer** (violates the "standalone no Navbar" spec)
**File:** `src/app/view/[id]/page.tsx`, `src/components/layout/navbar.tsx`

The Navbar explicitly hides only on `/login`:

```ts
const isLoginPage = pathname === "/login";
if (isLoginPage) return null;
```

Result: the public, client-facing invoice page shows the full admin nav ("Dashboard / Invoices / Clients", "Sign in", theme toggle) and the site footer. Emailed clients will see internal navigation.

**Fix:**

```ts
// src/components/layout/navbar.tsx
const pathname = usePathname();
if (pathname === "/login" || pathname.startsWith("/view")) return null;
```

Also hide the footer inside `/view` the same way (either conditionally in `layout.tsx`, or by moving the portal page to its own `src/app/view/[id]/layout.tsx` that renders without the site chrome — the cleaner Shadcn/Next approach):

```ts
// src/app/view/[id]/layout.tsx
export default function PublicViewLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-slate-50 dark:bg-slate-950">{children}</div>;
}
```
… and move Navbar/Footer out of `app/layout.tsx` into a new `(dashboard)/layout.tsx` route group so `/login` and `/view` don't inherit them. That's the correct App-Router structure.

---

### M2. **Middleware matcher is missing `/api/parse-receipt` and `/api/settings` auth, AND static-asset regex is case-insensitively wrong but harmless**
Already covered in H1 but worth calling out: the static-asset block in middleware also matches things like `/api/invoices/something.map` or `/clients/foo.js` and returns the security-header response without auth. This is a theoretical path-confusion risk — real static files don't live there, so no data leak, but tighten the regex to only known extensions at end of pathname *and* not under `/api/`:

```ts
if (
  !pathname.startsWith("/api/") &&
  /\.(svg|png|jpe?g|gif|webp|ico|woff2?|ttf|eot|css|js|map|txt)$/i.test(pathname)
) {
  return response;
}
```

(Also, `css/js` are served under `/_next/static/` anyway.)

---

### M3. **`new Date().toISOString().split("T")[0]` default dates — off-by-one for IST (and any non-UTC timezone)**
**File:** `src/components/invoices/new-invoice-form.tsx`

```ts
function toISO(d: Date) { return d.toISOString().split("T")[0]; }
function defaultDates() {
  const today = new Date();
  const due = new Date(); due.setDate(due.getDate() + 30);
  return { issue: toISO(today), due: toISO(due) };
}
```

`toISOString()` serializes in UTC. Between midnight IST and 05:30 IST (= midnight UTC to 00:00 UTC + 5:30), `new Date()` is e.g. `2026-07-27 03:00 IST` = `2026-07-26 21:30 UTC`, so `toISO().split("T")[0]` returns **"2026-07-26"** — one day behind. For a user in Pune creating an invoice at 2 am IST, the issue date defaults to yesterday. (This is a classic Next.js foot-gun.)

**Fix** — use a local-date formatter consistent with the IST formatting already used in `generateInvoiceNumber`:

```ts
function toLocalISODate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
```

(Use `get*` instead of `getUTC*` so it honours the browser's TZ, which is correct for an `input[type=date]`.)

---

### M4. **`/invoices` — client-side search filters the current page *only*, not the paginated set**
**File:** `src/app/invoices/page.tsx`

```ts
const filteredInvoices = useMemo(() => {
  if (!debouncedSearch.trim()) return data.data; // ❌ returns only current page
  return data.data.filter((inv) => inv.invoiceNumber.includes(q) || ...);
}, [data, debouncedSearch]);
```

So when the user types an invoice number that lives on page 2, they get "No matching invoices". The backend doesn't support a `q` param either. This is a real UX foot-gun.

**Fix (two part):**
1. Add a `q` filter to `GET /api/invoices`:
   ```ts
   if (q) where.OR = [
     { invoiceNumber: { contains: q, mode: "insensitive" } },
     { client: { name:  { contains: q, mode: "insensitive" } } },
     { client: { email: { contains: q, mode: "insensitive" } } },
   ];
   ```
   (Requires Prisma `mode: "insensitive"` preview off — works out of the box on Postgres.)
2. Remove the client-side filter entirely; include `q` in the `useEffect` deps and pass it as a query param.

Also: CSV export requests `limit=1000` but the Zod schema caps `limit` at **100** (`z.coerce.number().int().min(1).max(100).default(10)`) — so the export silently returns at most 100 invoices. Raise the cap to 1000 (or unpaginated export endpoint):

```ts
// src/app/api/invoices/route.ts
limit: z.coerce.number().int().min(1).max(1000).default(10),
```

---

### M5. **Dashboard `totalRevenue`, `pendingAmount`, `totalInvoices` only count invoices from the most recent 100**
**File:** `src/app/dashboard/page.tsx`

```ts
fetch("/api/invoices?limit=100", { cache: "no-store" })
```

For a business with more than ~100 invoices, the KPI cards undercount revenue/pending/total, and "Total Invoices" shows "100 invoices" forever. The paginated limit cap (M4) makes this worse.

**Fix:** either:
- raise limit to something safely larger (e.g. 500), or
- build a dedicated `/api/dashboard/summary` server endpoint that computes KPIs with `prisma.invoice.aggregate({ _sum: { totalAmount }, where: { status: "PAID" } })` etc. — one query, O(1) instead of O(n) over the wire, accurate regardless of volume. **Strongly recommended.**

Similarly, `OverdueInvoices` requests `?status=PENDING&limit=100` and does the overdue calculation client-side; an 101st pending invoice past due would be silently omitted from the "red total-overdue box". Move overdue-filtering server-side:

```ts
where: { status: "PENDING", dueDate: { lt: startOfTodayUTC() } }
```

---

### M6. **CSS `.print-card [class*="bg-"] { -webkit-print-color-adjust: exact }` forces backgrounds to print for *every* bg- utility inside the card**, including `bg-slate-50`, hover rows, table headers, the red overdue banner, etc. Many users will get ugly grey/coloured boxes they didn't expect on paper. The only place you really need colour is the status badge and the Totals block.

**Fix:** scope it to specific classes (e.g. `.print-color-exact`) and apply that class to the Badge and the "Total Due" row.

---

### M7. **CSP `script-src 'unsafe-inline' 'unsafe-eval'`**
**File:** `src/middleware.ts`

Required today for Next.js dev HMR and certain chunks, but in `next build` production the `'unsafe-eval'` can usually be dropped. Double-check with a production build; leaving it in weakens XSS defense-in-depth (since you're already preventing injection via React escaping). Low risk because the app has no user-generated raw HTML, but tighten before production.

---

### M8. **Hydration — footer year uses `new Date().getFullYear()` in a server component (safe) but `PageTransition` runs `motion.div` with an `exit` animation without `AnimatePresence`**
**Files:** `src/app/layout.tsx`, `src/components/page-transition.tsx`

```ts
<motion.div initial=… animate=… exit=…>…</motion.div>
```

With App Router you need `<AnimatePresence>` around the route `children` (inside the layout, not on every page) for `exit` to actually run. Right now `exit` is a no-op, and a `motion.div` re-mounts per route change which is fine but doesn't get the orchestrated page-out effect. Minor polish, not a bug.

---

### M9. **`/login` calls `useSearchParams()` without Suspense**
**File:** `src/app/login/page.tsx`

Next.js 15+ will bail out of static rendering / warn at build time if you call `useSearchParams()` under a non-Suspense tree in a client page (you already did this correctly for `/invoices` and `/view`). The build currently succeeds, but wrap it in `<Suspense>` the same way to future-proof.

```tsx
// src/app/login/page.tsx — wrap the default export in Suspense
export default function LoginPage() {
  return (
    <Suspense fallback={…}>
      <LoginForm />
    </Suspense>
  );
}
```

---

### M10. **`NewClientDialog` rendered as an *imported client component* from the *server* page `/clients/page.tsx` — OK, but its `trigger` prop receives a `<Card>` (a `<div>`) which is cloned onto a `<button>` (DialogTrigger)**
**File:** `src/app/clients/page.tsx` + `src/components/ui/dialog.tsx`

```tsx
<NewClientDialog
  trigger={
    <Card className="…cursor-pointer group w-full text-left">…</Card>  {/* this is a <div> */}
  }
/>
```

`DialogTrigger` with `asChild` clones the child and injects `onClick`. The child is a `div` here, not a button — click works, but it's not keyboard-accessible (no Enter/Space, no focus ring). The "Add Client" button on `/clients` and the card on `/dashboard` should be a `<Button asChild>` wrapping the card, or the card itself should be a `<button type="button">`.

Also: `DialogContent` renders `<form>` markup with `px-6 pt-0 padding` while `DialogFooter`/`DialogHeader` also add `p-6`, which causes double-padding in the client form (visible as the form having extra horizontal padding). Wrap the `<form>` around the entire content or remove the double padding — minor visual nit.

---

### M11. **Dashboard `computeMonthlyRevenue` uses `updatedAt` as a proxy for "when invoice was paid"**
**File:** `src/app/dashboard/page.tsx`

Any edit to a PAID invoice (or a status revert to DRAFT/PENDING) shifts the revenue to the month of the edit rather than the issue/paid month. Better: add a `paidAt` column to `Invoice` and set it on `PATCH {status:"PAID"}`. This is a modelling enhancement rather than a bug, but it produces misleading charts as soon as you edit an old paid invoice.

---

### M12. **`generateInvoiceNumber` ignores the passed-in `count` when options are specified?**
**File:** `src/lib/utils.ts`

Signature is `generateInvoiceNumber(count: number = 0, options={})` but the body destructures `separator, pad` from options — **the `count` parameter in the options type is never used.** That's dead API surface. Either remove `count` from `GenerateInvoiceNumberOptions` or rename the positional param and use options.count. Harmless, but confusing for future callers.

Also note the header docstring says `@param count — How many invoices already exist today`, but the POST route passes the **total** invoice count (`prisma.invoice.count()`), not the count *today*. So the sequence resets across day boundaries? Let's see: first invoice of a new day gets `count = N (running total)` → `INV-YYYYMMDD-N+1` which is correct-ish (always increments, never resets to 0001 daily). That's actually *better* than resetting daily (no collision), but the docstring lies. Update the comment.

---

## 🔵 LOW / NICKS / BEST-PRACTICE

### L1. **Unused dependencies in `package.json`**
- `@radix-ui/react-dropdown-menu`, `@radix-ui/react-tabs`, `@radix-ui/react-toast`, `@radix-ui/react-select`, `@radix-ui/react-label` are listed but:
  - `react-dropdown-menu` isn't imported anywhere (the navbar has a hand-rolled dropdown).
  - `react-tabs` / `react-toast` aren't used (status tabs are hand-rolled; toasts aren't wired up — Settings uses an inline success banner).
  - `react-label` — `<Label>` is a custom component that doesn't use Radix Label.
  - `react-select` — the selects in the invoice form are native `<select>`, not Radix Select.

Prune to keep `node_modules` small and audit surface minimal.

### L2. **Several UI primitives are hand-rolled instead of using Radix** (Dialog, Select). They work, but they're missing:
- Focus trap (Dialog keeps focus in document body; Tab leaves the modal).
- Scroll-lock uses `document.body.style.overflow = "hidden"` but doesn't compensate for scrollbar jump.
- No `aria-describedby` / `aria-labelledby` wired up.
- `DialogContent` renders the close button with `absolute right-4 top-4` but `DialogHeader` has `p-6` so the X can overlap the title.

Not a launch blocker (it functions), but swapping in Radix Dialog later will improve a11y for free.

### L3. **`src/components/ui/select.tsx`** — appears in the file list per the summary but isn't actually used. Remove or wire up.

### L4. **`types/index.ts` defines `ClientWithInvoices` which isn't used anywhere** and `DashboardSummary` which also isn't used (the dashboard inlines its own `DashboardData` interface). Remove dead types.

### L5. **`settingsSchema.currency` is `z.string().min(1).max(10).default("INR")`** — allows garbage like `"💩"`; `Intl.NumberFormat` will throw and `formatMoney` falls back to `"💩 123.00"`. Tighten to `z.string().regex(/^[A-Z]{3}$/)` and to-uppercase.

### L6. **`Client` schema is missing `phone`** even though the Prisma model has `Client.phone` and the seed sets it on the company settings. The New Client dialog and API never accept a phone, so the column is forever `null`. Either add phone to the form/schema or drop the column.

### L7. **DELETE handlers re-fetch the record before deleting:**
```ts
const existing = await prisma.invoice.findUnique({ where: { id } });
if (!existing) return 404;
await prisma.invoice.delete({ where: { id } });
```
This is a mild race (the record can be deleted between the two calls → Prisma throws P2025 which isn't caught and returns 500). Use `delete()` inside a try/catch handling `P2025 → 404`, removing the extra read:

```ts
try {
  await prisma.invoice.delete({ where: { id } });
  return NextResponse.json({ success: true });
} catch (e) {
  if (getPrismaErrorCode(e) === "P2025") return jsonError("Not found", 404);
  throw e;
}
```

Applies to `/api/clients/[id]/DELETE`, `/api/invoices/[id]/DELETE`, and the update handlers (the "find then update" pattern can lose concurrent updates, but in a single-admin app this is negligible).

### L8. **`formatCurrency` (INR-hardcoded) exists alongside `formatMoney` (currency-aware)** and both are used across the app — invoice detail and public view use `formatMoney`, but dashboard stats, invoice list, CSV export, overdue widget, and line-item totals use `formatCurrency` with INR hardcoded. This means changing `settings.currency` to USD/EUR will only partially take effect. Centralise on `formatMoney` (pulling `settings.currency` via a hook/context), and delete `formatCurrency`.

CSV export also hardcodes `"INR"` as the currency column:

```ts
// src/lib/export-csv.ts
"INR",  // ← should be invoice currency or settings.currency
```

### L9. **`useCallback` dependency on `fetchData` in `dashboard/page.tsx`** is listed in deps but `fetchData` itself has `[]` deps and is only referenced once — that's fine, but `useCallback` there is unnecessary; an async function inside `useEffect` is simpler and doesn't change identity.

### L10. **`SendInvoiceButton` does `window.location.reload()` after success** instead of `router.refresh()` — causes a full page reload. Use `router.refresh()` to keep the SPA feel.

### L11. **Public view `/view/:id` fetches `/api/settings` which (post-H1 fix) will be protected.** Either make `GET /api/settings` public (it contains company name/email/phone — public-by-necessity for the portal) or create a dedicated `/api/public/settings` route that returns only the fields needed for invoice rendering (companyName, companyEmail, companyPhone, companyAddress, currency).

### L12. **Resend `fromEmail` default uses `billing@smartbill.app`**
```ts
const fromEmail = process.env.FROM_EMAIL || `${settings.companyName} <billing@smartbill.app>`;
```
Resend requires sending from a verified domain; in production without `FROM_EMAIL` set, every send will fail with 502. Add an early warning or require `FROM_EMAIL` if `RESEND_API_KEY` is set.

### L13. **`Dockerfile` copies entire `node_modules` (including devDeps) into the runner image** — this is noted in a comment but inflates image size ~3×. After `npm run build`, run `npm prune --production` in a new layer or use Next.js `output: "standalone"` (uncomment the matching lines).

### L14. **`next.config.ts` is empty** — add basic security/reporting config:

```ts
const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: { typedRoutes: true /* if desired */ },
};
```
(`poweredByHeader:false` removes the `X-Powered-By: Next.js` header which is a small defense-in-depth win.)

### L15. **Auth cookie/session JWT has no maxAge set** — defaults to session cookie (30 days in NextAuth v5 for JWT sessions). Explicit is better:

```ts
session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
jwt: { maxAge: 30 * 24 * 60 * 60 },
```

### L16. **Seed wipe order is correct (items → invoices → clients → settings), but `settings.deleteMany()` is redundant with `settings.create({id:1,...})` — use `prisma.settings.upsert`** like the API does, so seeding is idempotent without wiping.

### L17. **Small type-safety nit:** `getPrismaErrorCode` returns `string | null` but is called as:
```ts
if (code === "P2002") { … }
if (code === "P2003") { … }
```
which is fine, but `P2025` (record not found) is not handled anywhere, which means DELETE/PATCH races return 500 instead of 404. (See L7.)

### L18. **`tailwind.config.js`** — worth checking content globs cover `src/components/ui/*.tsx` and `src/app/**/*.{ts,tsx}` (defaults usually do). Quick smoke-test: build passes so content globs are correct.

---

## ✅ Things done well

- Strict TypeScript throughout; **zero** implicit `any`; type re-exports via `src/types/index.ts`.
- Prisma schema models are clean, cascading deletes correct (`onDelete: Cascade` from Client→Invoice→InvoiceItem), decimal precision appropriate (12,2) for money, (5,2) for tax.
- Server-side recalculation of totals in POST `/api/invoices` (prevents client-side tampering — great).
- Zod v4 usage is correct (`error.issues`, `message:` param instead of `required_error:`); the helper correctly normalises between v3/v4 shapes.
- Lazy OpenAI init (doesn't blow up build when key missing) ✅.
- Suspense wrapping on `useSearchParams()` pages (the ones that were done — add to `/login`).
- `mounted` guard in `ThemeToggle` to prevent flash-of-incorrect-icon.
- Print CSS is thoughtful (A4, `no-print`, `@page margin`, `-webkit-print-color-adjust`).
- IST-aware invoice-number date formatting (uses `Intl.DateTimeFormat` with `timeZone:"Asia/Calcutta"` — correct for the user's locale).
- `global-error.tsx` correctly renders its own `<html>/<body>` (a common App-Router gotcha).
- Dockerfile uses a non-root UID 1001, healthcheck in docker-compose, libc6-compat for Prisma Engines on Alpine.
- Framer Motion `useReducedMotion()` a11y check.
- Custom Dialog ESC handling + scroll lock.
- Email HTML is parameterized and escaped (`esc()` helper over all user data).
- CSV BOM (`\uFEFF`) for Excel compatibility.

---

## Recommended fix order (ship-blocking path)

1. **H1** — add `requireUser()` guard and *remove `/api/invoices`* from `PUBLIC_PATHS`. Keep `GET /api/invoices/:id` public inside the handler.
2. **H1 follow-ups** — add session checks to clients/settings/parse-receipt/send handlers.
3. **M1** — give `/view` its own layout (no Navbar/Footer) so the portal page is standalone as specified.
4. **M3** — fix `toISO` date default to local TZ (IST bug).
5. **M4 + M5** — raise pagination cap to 1000, add server-side `q` search, build a summary API for dashboard KPIs.
6. **H4** — correct seed tax rounding + consider unifying number format.
7. **M11 + L8 + L11** — add `paidAt`, centralise currency formatting, make `GET /api/settings` a dedicated public endpoint.

After these, the app is production-ready from a security/data-accuracy standpoint. The remaining items are polish.
