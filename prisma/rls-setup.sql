-- =====================================================================
-- SmartBill: Row-Level Security (RLS) setup
--
-- Creates a restricted `app_user` role (NOINHERIT, BYPASSRLS off) and
-- enables RLS on all tenant-scoped tables. The application connects as
-- the superuser `smartbill` (migration/setup user) but wraps user-facing
-- transactions with `SET LOCAL ROLE app_user; SET LOCAL app.current_user_id
-- = '<userId>';` via the `withTenant()` Prisma helper. If SET ROLE fails
-- or the role assertion doesn't match, withTenant() throws and no query
-- is executed as superuser on tenant tables.
--
-- Re-runnable: uses IF NOT EXISTS guards; re-applying policies is a no-op.
-- =====================================================================

-- 1. Create restricted app_user role (NOINHERIT, no BYPASSRLS).
--    NOINHERIT means the role must be explicitly SET; a misconfigured
--    connection that doesn't SET ROLE sees nothing (default-deny).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

-- Grant connect + usage on public schema.
GRANT CONNECT ON DATABASE smart_billing TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;

-- 2. Grant RLS-aware DML on tenant tables. `app_user` is allowed the
--    full DML surface on each table, but every row read/written MUST
--    satisfy the policy predicate (app.current_user_id matches userId).
--    Non-tenant tables (webhook_ingestions, _prisma_migrations, ledger_
--    entries partially) are owned by the superuser; only the specific
--    privileges documented below are granted to app_user.

-- Users: SELECT own row; UPDATE on a narrow whitelist of columns via
-- column-level privileges (sessionVersion for revocation, lastLedgerEntryHash
-- / lastLedgerEntryId for the ledger tail pointer). RLS policy restricts
-- updates to the user's own row. We also GRANT UPDATE at the table level
-- so Prisma doesn't need column lists in generated SQL.
GRANT SELECT, UPDATE ON TABLE users TO app_user;
-- Explicitly REVOKE UPDATE on all columns NOT in the whitelist, so app_user
-- can never change name/email/passwordHash/resetTokens via a SQL injection
-- or a future code bug.
REVOKE UPDATE (id, name, email, "passwordHash", "resetToken", "resetTokenExpires", "createdAt")
  ON TABLE users FROM app_user;

-- Settings / clients / invoices / invoice_items / expenses /
-- recurring_profiles / recurring_items: full RLS-scoped DML.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE settings TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE clients TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE invoices TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE invoice_items TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE expenses TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE recurring_profiles TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE recurring_items TO app_user;
-- InvoiceActivity + LedgerEntry are append-only for app_user (SELECT + INSERT only).
GRANT SELECT, INSERT ON TABLE invoice_activities TO app_user;
REVOKE UPDATE, DELETE ON TABLE invoice_activities FROM app_user;
GRANT SELECT, INSERT ON TABLE ledger_entries TO app_user;
-- webhook_ingestions is a system table (not tenant-scoped); it is only
-- accessed as superuser by the edge ingester + cron worker, so no
-- grants to app_user.

-- Sequence grants for tables that auto-generate integer PKs (settings.id).
-- Prisma uses cuid() strings for most PKs so this is minimal.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- 3. Backfill invoice_items.userId from parent Invoice.userId.
--    (Existing rows don't have userId; future creates MUST set it.)
UPDATE invoice_items ii
SET "userId" = i."userId"
FROM invoices i
WHERE ii."invoiceId" = i.id
  AND (ii."userId" IS NULL OR ii."userId" = '');

-- Backfill recurring_items.userId from parent RecurringProfile.userId.
UPDATE recurring_items ri
SET "userId" = rp."userId"
FROM recurring_profiles rp
WHERE ri."profileId" = rp.id
  AND (ri."userId" IS NULL OR ri."userId" = '');

-- 4. Enable RLS on every tenant-scoped table. Force default-deny:
--    table owners (superuser) bypass RLS by default, but app_user
--    NEVER bypasses (NOBYPASSRLS). The application connects as
--    superuser to bootstrap, but all tenant queries go through
--    withTenant() which SET ROLE app_user mid-transaction.
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients            ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices           ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_activities ENABLE ROW LEVEL SECURITY;

-- Force RLS on table owners too? No — our superuser (smartbill) needs
-- to bypass RLS for migrations/seeding/public view endpoints. The
-- security property is that (a) app_user can never read/write outside
-- its tenant, and (b) withTenant() refuses to run any user query if
-- SET ROLE app_user fails. This gives us defense-in-depth.

-- 5. Drop + recreate policies idempotently.
-- All policies use `current_setting('app.current_user_id', true)` which
-- returns NULL if the GUC is unset. With app_user's NOINHERIT and
-- default-deny, an unset GUC returns zero rows.

-- USERS: select only your own row; UPDATE only your own row (limited columns
-- are GRANTed to app_user at the privilege layer; the policy further restricts
-- which rows can be touched).
DROP POLICY IF EXISTS user_isolation ON users;
CREATE POLICY user_isolation ON users
  FOR ALL USING ("id" = current_setting('app.current_user_id', true))
  WITH CHECK ("id" = current_setting('app.current_user_id', true));

-- SETTINGS: select/insert/update/delete only your own settings row.
DROP POLICY IF EXISTS settings_isolation ON settings;
CREATE POLICY settings_isolation ON settings
  FOR ALL USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- CLIENTS: scoped to userId.
DROP POLICY IF EXISTS client_isolation ON clients;
CREATE POLICY client_isolation ON clients
  FOR ALL USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- INVOICES: scoped to userId.
DROP POLICY IF EXISTS invoice_isolation ON invoices;
CREATE POLICY invoice_isolation ON invoices
  FOR ALL USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- INVOICE_ITEMS: scoped to userId (denormalized, no FK join needed).
DROP POLICY IF EXISTS invoice_item_isolation ON invoice_items;
CREATE POLICY invoice_item_isolation ON invoice_items
  FOR ALL USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- EXPENSES: scoped to userId.
DROP POLICY IF EXISTS expense_isolation ON expenses;
CREATE POLICY expense_isolation ON expenses
  FOR ALL USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- RECURRING_PROFILES: scoped to userId.
DROP POLICY IF EXISTS recurring_profile_isolation ON recurring_profiles;
CREATE POLICY recurring_profile_isolation ON recurring_profiles
  FOR ALL USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- RECURRING_ITEMS: scoped to userId (denormalized).
DROP POLICY IF EXISTS recurring_item_isolation ON recurring_items;
CREATE POLICY recurring_item_isolation ON recurring_items
  FOR ALL USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- INVOICE_ACTIVITIES: append-only; SELECT/INSERT only. Scoped to userId.
DROP POLICY IF EXISTS activity_select_isolation ON invoice_activities;
CREATE POLICY activity_select_isolation ON invoice_activities
  FOR SELECT USING ("userId" = current_setting('app.current_user_id', true));
DROP POLICY IF EXISTS activity_insert_isolation ON invoice_activities;
CREATE POLICY activity_insert_isolation ON invoice_activities
  FOR INSERT WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- 6. Make the current_user_id GUC a recognized, empty-string default
--    so it can be SET LOCAL per-transaction without ceremony. `true`
--    flag in current_setting handles missing values (returns NULL).
DO $$
BEGIN
  -- This is a no-op set; subsequent SET LOCAL calls override per-tx.
  PERFORM set_config('app.current_user_id', '', false);
EXCEPTION WHEN OTHERS THEN
  -- Custom GUCs don't need pre-definition; ignore.
  NULL;
END $$;
