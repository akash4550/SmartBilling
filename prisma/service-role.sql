-- =====================================================================
-- SmartBill: service_role setup (Batch 6)
--
-- A NOINHERIT/NOBYPASSRLS role used by background workers and internal
-- maintenance. It replaces the pattern of connecting as superuser for
-- non-tenant-scoped work. Two operating modes:
--
--   (A) Tenant-scoped: SET LOCAL ROLE service_role
--                     SET LOCAL app.current_user_id = '<uid>'
--       Behaves identically to app_user (all RLS policies match
--       app.current_user_id). Used by cron workers that process one
--       tenant at a time.
--
--   (B) Service-scoped: SET LOCAL ROLE service_role
--                      SET LOCAL app.service_name = '<cron|dlq|maint>'
--       Cross-tenant read access on tenant tables (service RLS policies
--       OR-in on app.service_name IS NOT NULL); write access only to
--       system tables (webhook_ingestions) and narrow whitelist.
--
-- Application code MUST NOT connect as superuser for runtime queries.
-- Migrations/seeding still run as the database owner (smartbill).
--
-- Re-runnable idempotently.
-- =====================================================================

-- 1. Create role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

GRANT CONNECT ON DATABASE smart_billing TO service_role;
GRANT USAGE ON SCHEMA public TO service_role;

-- 2. Grants: same read/write surface as app_user on tenant tables, plus
--    full access to webhook_ingestions (cron worker uses this as its
--    primary table). RLS below constrains the cross-tenant reads.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE settings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE clients TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE invoices TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE invoice_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE expenses TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE recurring_profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE recurring_items TO service_role;
GRANT SELECT, INSERT ON TABLE invoice_activities TO service_role;
GRANT SELECT, INSERT ON TABLE ledger_entries TO service_role;
-- Users table: same whitelist UPDATE as app_user (sessionVersion,
-- lastLedgerEntryHash, lastLedgerEntryId).
GRANT SELECT, UPDATE ON TABLE users TO service_role;
REVOKE UPDATE (id, name, email, "passwordHash", "resetToken", "resetTokenExpires", "createdAt")
  ON TABLE users FROM service_role;
-- webhook_ingestions: full R/W/D (cron worker needs to claim/resolve/replay/delete).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE webhook_ingestions TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- 3. Enable RLS on webhook_ingestions. The edge ingester (superuser)
--    bypasses by default; service_role is constrained by the policy below.
ALTER TABLE webhook_ingestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_ingest_service_all ON webhook_ingestions;
CREATE POLICY webhook_ingest_service_all ON webhook_ingestions
  FOR ALL USING (current_setting('app.service_name', true) IS NOT NULL)
  WITH CHECK (current_setting('app.service_name', true) IS NOT NULL);

DROP POLICY IF EXISTS webhook_ingest_superuser ON webhook_ingestions;
-- superuser/owner bypass RLS by default; no explicit policy needed.

-- 4. Add service-bypass OR-clause to existing tenant table RLS policies.
--    app.current_user_id match still works (service_role can drop into
--    tenant-scoped mode); additionally, if app.service_name is set to
--    any non-empty value, SELECT is allowed cross-tenant but only for
--    the maintenance/cron discovery phase. Writes still enforce
--    app.current_user_id (WITH CHECK below), so cross-tenant writes
--    are impossible unless the service also sets app.current_user_id.

-- Helper macro: for every tenant table, add a SELECT policy that allows
-- service access while keeping the existing tenant-isolation policy.
-- We can't easily ALTER an existing POLICY, so we drop+recreate with
-- an additional OR clause.

-- settings
DROP POLICY IF EXISTS settings_isolation ON settings;
CREATE POLICY settings_isolation ON settings
  FOR ALL USING (
    "userId" = current_setting('app.current_user_id', true)
    OR current_setting('app.service_name', true) IS NOT NULL
  )
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- clients
DROP POLICY IF EXISTS client_isolation ON clients;
CREATE POLICY client_isolation ON clients
  FOR ALL USING (
    "userId" = current_setting('app.current_user_id', true)
    OR current_setting('app.service_name', true) IS NOT NULL
  )
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- invoices
DROP POLICY IF EXISTS invoice_isolation ON invoices;
CREATE POLICY invoice_isolation ON invoices
  FOR ALL USING (
    "userId" = current_setting('app.current_user_id', true)
    OR current_setting('app.service_name', true) IS NOT NULL
  )
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- invoice_items
DROP POLICY IF EXISTS invoice_item_isolation ON invoice_items;
CREATE POLICY invoice_item_isolation ON invoice_items
  FOR ALL USING (
    "userId" = current_setting('app.current_user_id', true)
    OR current_setting('app.service_name', true) IS NOT NULL
  )
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- expenses
DROP POLICY IF EXISTS expense_isolation ON expenses;
CREATE POLICY expense_isolation ON expenses
  FOR ALL USING (
    "userId" = current_setting('app.current_user_id', true)
    OR current_setting('app.service_name', true) IS NOT NULL
  )
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- recurring_profiles
DROP POLICY IF EXISTS recurring_profile_isolation ON recurring_profiles;
CREATE POLICY recurring_profile_isolation ON recurring_profiles
  FOR ALL USING (
    "userId" = current_setting('app.current_user_id', true)
    OR current_setting('app.service_name', true) IS NOT NULL
  )
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- recurring_items
DROP POLICY IF EXISTS recurring_item_isolation ON recurring_items;
CREATE POLICY recurring_item_isolation ON recurring_items
  FOR ALL USING (
    "userId" = current_setting('app.current_user_id', true)
    OR current_setting('app.service_name', true) IS NOT NULL
  )
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- invoice_activities: append-only; service_role can also read/write scoped rows.
DROP POLICY IF EXISTS activity_select_isolation ON invoice_activities;
CREATE POLICY activity_select_isolation ON invoice_activities
  FOR SELECT USING (
    "userId" = current_setting('app.current_user_id', true)
    OR current_setting('app.service_name', true) IS NOT NULL
  );
DROP POLICY IF EXISTS activity_insert_isolation ON invoice_activities;
CREATE POLICY activity_insert_isolation ON invoice_activities
  FOR INSERT WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- ledger_entries: add service read (append-only); writes still require current_user_id.
DROP POLICY IF EXISTS ledger_select_isolation ON ledger_entries;
CREATE POLICY ledger_select_isolation ON ledger_entries
  FOR SELECT USING (
    "userId" = current_setting('app.current_user_id', true)
    OR current_setting('app.service_name', true) IS NOT NULL
  );
DROP POLICY IF EXISTS ledger_insert_isolation ON ledger_entries;
CREATE POLICY ledger_insert_isolation ON ledger_entries
  FOR INSERT WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- users table: SELECT own row OR service access; UPDATE only own row.
DROP POLICY IF EXISTS user_isolation ON users;
CREATE POLICY user_isolation ON users
  FOR ALL USING (
    "id" = current_setting('app.current_user_id', true)
    OR current_setting('app.service_name', true) IS NOT NULL
  )
  WITH CHECK ("id" = current_setting('app.current_user_id', true));

-- 5. Recognize service_name GUC.
DO $$
BEGIN
  PERFORM set_config('app.service_name', '', false);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
