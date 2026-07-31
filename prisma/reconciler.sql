-- =====================================================================
-- SmartBill: Reconciler / ledger-quarantine setup
--
-- - BEFORE-trigger financial-write guard for quarantined tenants (L0001).
-- - RLS + grants on reconciliation_audits (append-only).
-- - Column whitelist expansion on users so service_role can set
--   ledgerQuarantinedAt / ledgerQuarantineReason / lastReconciledAt.
--
-- Re-runnable idempotently. Safe to apply on an existing database;
-- assumes rls-setup.sql and service-role.sql have already been applied.
-- =====================================================================

-- 1. Quarantine column privileges.
--    Add the new reconciler columns to the REVOKE whitelist on users for
--    BOTH app_user and service_role, then explicitly GRANT UPDATE on the
--    narrow reconciliation columns so the reconciler can flip quarantine
--    under service_role ("maint:reconcile"). Default table-level UPDATE
--    was already GRANTed to both roles in rls-setup/service-role; these
--    REVOKEs make sure the new columns are not writable accidentally.
REVOKE UPDATE ("ledgerQuarantinedAt", "ledgerQuarantineReason", "lastReconciledAt")
  ON TABLE users FROM app_user;
-- service_role runs the reconciler; it needs to write quarantine + lastReconciledAt.
-- We explicitly GRANT UPDATE on those three columns via column privileges.
-- (REVOKE from non-service roles first to be safe.)
GRANT UPDATE ("ledgerQuarantinedAt", "ledgerQuarantineReason", "lastReconciledAt")
  ON TABLE users TO service_role;

-- 2. reconciliation_audits table grants + append-only policy.
--    Table is created by Prisma migrate / db push; this script only
--    configures privileges. If the table doesn't exist yet (first run),
--    this whole block will fail — that's fine: it is re-run after
--    `prisma db push`.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'reconciliation_audits') THEN

    -- Enable RLS on audits.
    ALTER TABLE reconciliation_audits ENABLE ROW LEVEL SECURITY;

    -- Grant SELECT to both roles; INSERT to service_role only (reconciler writes).
    GRANT SELECT ON TABLE reconciliation_audits TO app_user, service_role;
    GRANT INSERT ON TABLE reconciliation_audits TO service_role;
    -- Explicitly revoke UPDATE/DELETE from application roles + PUBLIC (append-only).
    REVOKE UPDATE, DELETE ON TABLE reconciliation_audits FROM app_user, service_role, PUBLIC;

    -- Tenant can SELECT its own audits.
    DROP POLICY IF EXISTS recon_audit_select_tenant ON reconciliation_audits;
    CREATE POLICY recon_audit_select_tenant ON reconciliation_audits
      FOR SELECT USING (
        "tenantId" = current_setting('app.current_user_id', true)
        OR current_setting('app.service_name', true) IS NOT NULL
      );

    -- Only the reconciler service can INSERT audits.
    DROP POLICY IF EXISTS recon_audit_insert_service ON reconciliation_audits;
    CREATE POLICY recon_audit_insert_service ON reconciliation_audits
      FOR INSERT WITH CHECK (current_setting('app.service_name', true) = 'maint:reconcile');
  END IF;
END $$;

-- Also allow app_user/service_role SELECT+INSERT on the ledger_entries sequence
-- (Prisma's cuid() doesn't use sequences, but future changes might).
-- Already covered by ALL SEQUENCES grants in rls-setup; nothing extra needed.

-- 3. Quarantine BEFORE-trigger guard on financial tables.
--    When a tenant has users.ledgerQuarantinedAt IS NOT NULL and the tx
--    is running as app_user/app.current_user_id (i.e. not a superuser
--    migration / service_role backfill), all INSERT/UPDATE/DELETE on
--    financial tables raise SQLSTATE 'L0001'.
--
--    The trigger reads app.current_user_id; if that GUC is empty the
--    trigger returns COALESCE(NEW,OLD) unchanged (allows service_role
--    discovery, migrations, and the reconciler's own writes under
--    maint:reconcile).
CREATE OR REPLACE FUNCTION ledger_quarantine_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  uid text;
  quarantined timestamptz;
  reason text;
BEGIN
  uid := current_setting('app.current_user_id', true);
  IF uid IS NULL OR uid = '' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT "ledgerQuarantinedAt", "ledgerQuarantineReason"
    INTO quarantined, reason
  FROM users WHERE id = uid;
  IF quarantined IS NOT NULL THEN
    RAISE EXCEPTION 'Ledger is quarantined for tenant % (since %, reason=%). Financial writes blocked.',
      uid, quarantined, COALESCE(reason, 'unspecified')
      USING ERRCODE = 'L0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$;

-- Apply the guard to the core financial-write tables per the reconciler
-- mandate: invoices, invoice_items, expenses, ledger_entries. Other tables
-- (recurring_profiles, recurring_items, clients, settings, users,
-- webhook_ingestions, invoice_activities) are excluded either because
-- they are non-financial, user-controlled (login/settings), append-only
-- audit trail, or system queue tables.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'invoices',
    'invoice_items',
    'expenses',
    'ledger_entries'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = t) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS ledger_quarantine_trigger ON %I', t);
      EXECUTE format(
        'CREATE TRIGGER ledger_quarantine_trigger
         BEFORE INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION ledger_quarantine_guard()',
        t
      );
    END IF;
  END LOOP;
END $$;

-- 4. Recognize the GUC (no-op; just ensure it can be set).
DO $$
BEGIN
  PERFORM set_config('app.current_user_id', '', false);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
