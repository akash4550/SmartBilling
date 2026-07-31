-- =====================================================================
-- SmartBill: Automated Ledger Drift & Integrity Reconciler
-- Database hardening & quarantine trigger
--
-- Idempotent. Safe to re-run on an existing database at any time.
--
-- Assumptions:
--   * Prisma schema has already been pushed (reconciliation_audits,
--     ledger_entries, users.ledgerQuarantinedAt/Reason/lastReconciledAt
--     exist).
--   * App runs as the table owner (smartbill, a SUPERUSER used only
--     for migrations / trusted service setup).
--   * app_user and service_role are NOINHERIT NOBYPASSRLS roles
--     created by prisma/rls-setup.sql and prisma/service-role.sql.
--
-- What this script installs:
--   1. Append-only hardening on reconciliation_audits (no UPDATE/DELETE
--      from PUBLIC, app_user, or service_role).
--   2. Two composite indexes on ledger_entries for Sweep B
--      aggregations, with an existence check that inspects pg_indexes
--      keyed by leading-column signature so we do not duplicate
--      equivalent indexes Prisma migrations may have created under a
--      different name (e.g. camelCase vs snake_case).
--   3. A BEFORE INSERT OR UPDATE OR DELETE trigger function
--      ledger_quarantine_guard() that raises SQLSTATE 'L0001' on any
--      write to financial tables when
--      current_setting('app.current_user_id') resolves to a
--      quarantined tenant. Attached to invoices, invoice_items,
--      expenses, ledger_entries, recurring_profiles, and
--      recurring_items.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. reconciliation_audits: strictly append-only
--
-- Neither the tenant-facing role (app_user), the maintenance service
-- role (service_role), nor PUBLIC may UPDATE or DELETE rows once
-- written. INSERT is granted by prisma/service-role.sql (service_role
-- only); SELECT is governed by RLS policies.
--
-- We deliberately do NOT revoke from the table owner (smartbill). That
-- role is used for migrations / schema evolution that may legitimately
-- need to DROP or ALTER the table, and revoking from the owner would
-- break future prisma migrate runs. The owner is never exposed to the
-- application runtime (every tenant/service call enters RLS via
-- SET LOCAL ROLE).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'reconciliation_audits'
  ) THEN
    REVOKE UPDATE, DELETE ON reconciliation_audits FROM PUBLIC;
    REVOKE UPDATE, DELETE ON reconciliation_audits FROM app_user;
    REVOKE UPDATE, DELETE ON reconciliation_audits FROM service_role;
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 2. Composite indexes for Sweep B aggregations
--
--   (userId, account, side)         -> per-account signed D/C balance
--   (userId, account, "eventType")  -> per-eventType cash-flow breakdown
--
-- We deliberately own these indexes here (in the reconciler SQL)
-- rather than in the Prisma schema, so that re-running the hardening
-- script against an existing database does not double-create them and
-- so they are installed atomically with the quarantine trigger that
-- enforces the read model these indexes back.
--
-- Idempotency strategy: instead of a naive "CREATE INDEX IF NOT EXISTS"
-- (which keys off the index NAME and would happily create a duplicate
-- index if Prisma previously created one under a camelCase name such as
-- "ledgerEntries_userId_account_side"), we inspect pg_indexes joined
-- to pg_index + pg_attribute and check for the existence of ANY index
-- on ledger_entries whose LEADING THREE COLUMNS (in order) are exactly
-- (userId, account, side) or (userId, account, "eventType"). This
-- detects equivalent indexes regardless of naming convention and
-- prevents duplicate bloat.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ledger_entries'
  ) THEN

    -- (userId, account, side) -------------------------------------------------
    IF NOT EXISTS (
      SELECT 1
      FROM pg_indexes i
      JOIN pg_class      t   ON t.relname = i.tablename
                              AND t.relnamespace = to_regnamespace('public')
      JOIN pg_index      idx ON idx.indexrelid = to_regclass(
                                 i.schemaname || '.' || quote_ident(i.indexname))
      JOIN pg_attribute  a1  ON a1.attrelid = idx.indrelid
                              AND a1.attnum = idx.indkey[0]
                              AND a1.attname = 'userId'
      JOIN pg_attribute  a2  ON a2.attrelid = idx.indrelid
                              AND a2.attnum = idx.indkey[1]
                              AND a2.attname = 'account'
      JOIN pg_attribute  a3  ON a3.attrelid = idx.indrelid
                              AND a3.attnum = idx.indkey[2]
                              AND a3.attname = 'side'
      WHERE i.schemaname = 'public'
        AND i.tablename  = 'ledger_entries'
        AND idx.indnatts >= 3
        AND idx.indisunique = false
    ) THEN
      CREATE INDEX ledger_entries_user_account_side_idx
        ON ledger_entries ("userId", account, side);
    END IF;

    -- (userId, account, "eventType") ------------------------------------------
    IF NOT EXISTS (
      SELECT 1
      FROM pg_indexes i
      JOIN pg_class      t   ON t.relname = i.tablename
                              AND t.relnamespace = to_regnamespace('public')
      JOIN pg_index      idx ON idx.indexrelid = to_regclass(
                                 i.schemaname || '.' || quote_ident(i.indexname))
      JOIN pg_attribute  a1  ON a1.attrelid = idx.indrelid
                              AND a1.attnum = idx.indkey[0]
                              AND a1.attname = 'userId'
      JOIN pg_attribute  a2  ON a2.attrelid = idx.indrelid
                              AND a2.attnum = idx.indkey[1]
                              AND a2.attname = 'account'
      JOIN pg_attribute  a3  ON a3.attrelid = idx.indrelid
                              AND a3.attnum = idx.indkey[2]
                              AND a3.attname = 'eventType'
      WHERE i.schemaname = 'public'
        AND i.tablename  = 'ledger_entries'
        AND idx.indnatts >= 3
        AND idx.indisunique = false
    ) THEN
      CREATE INDEX ledger_entries_user_account_event_idx
        ON ledger_entries ("userId", account, "eventType");
    END IF;

  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 3. Quarantine guard trigger function
--
-- Contract: when the tenant referenced by app.current_user_id has
-- users.ledgerQuarantinedAt IS NOT NULL, ANY write (INSERT / UPDATE /
-- DELETE) against their financial tables raises SQLSTATE 'L0001'.
--
-- Why the GUC is trusted even when empty / NULL:
--   * app.current_user_id is set by withTenant() / withService() for
--     the duration of a single transaction (SET LOCAL). It is cleared
--     automatically at COMMIT / ROLLBACK and never persists across
--     connections (PgBouncer / pooled connections are safe because
--     SET LOCAL is scoped to the transaction, not the session).
--   * A NULL or empty GUC means one of three trusted paths is in
--     effect:
--       (a) A Prisma migration / schema change running as the table
--           owner (smartbill superuser). These do not SET ROLE or
--           SET app.current_user_id, and they execute DDL, not tenant
--           writes.
--       (b) A service_role discovery read (cron / reconciler / webhook
--           ingestion) that has entered the service context but has
--           not yet scoped to a specific tenant. Reads do not fire
--           this BEFORE-row trigger anyway; when the service later
--           needs to write a tenant-scoped row it calls
--           withTenant(uid, fn, {tx}) which SET LOCAL
--           app.current_user_id = uid inside the same transaction,
--           and the trigger enforces from that point forward.
--       (c) One-off operator backfill / maintenance invoked with
--           explicit superuser access (e.g. prisma db seed). The
--           audit trail for these actions is captured by the
--           reconciliation engine itself when it runs immediately
--           after.
--   * Allowing the NULL case is NOT a privilege-escalation hole
--     because:
--       - Application requests ALWAYS enter through withTenant(),
--         which sets app.current_user_id; RLS policies on user tables
--         also require the GUC (they fail closed when it is unset),
--         so tenant-scoped writes from the app cannot "forget" it.
--       - Direct superuser access is already protected by Postgres
--         connection credentials and is only available in controlled
--         migrations / operator scripts.
--
-- L0001 is chosen outside the standard SQLSTATE 5-char classes so it
-- cannot collide with built-in Postgres codes and is trivially
-- greppable across logs and the codebase (see TENANT_QUARANTINED_ERR
-- in webhook-processors.ts and the L0001 catch in process-webhooks).
--
-- The trigger reads users ONCE per row and is bounded by the primary
-- key lookup on id (O(1)). BEFORE-row triggers fire after RLS WITH
-- CHECK policies, so RLS is still the second layer of defense; this
-- trigger is the third (defense-in-depth).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_quarantine_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_uid         text;
  v_quarantined timestamptz;
  v_reason      text;
BEGIN
  -- Only enforce for tenant-scoped transactions. A NULL/empty GUC
  -- means a trusted system path is executing (see block comment
  -- above): migrations running as the table owner, service_role
  -- discovery that has not yet SET LOCAL app.current_user_id, or
  -- operator superuser maintenance. These paths bypass the trigger
  -- but are not reachable from normal application requests because
  -- withTenant() always SETs the GUC and RLS fails closed without it.
  v_uid := NULLIF(current_setting('app.current_user_id', true), '');
  IF v_uid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Look up quarantine state for the scoped tenant. A missing user
  -- row is treated as NOT quarantined (write proceeds; FK constraints
  -- will block any orphan references anyway).
  SELECT "ledgerQuarantinedAt", "ledgerQuarantineReason"
    INTO v_quarantined, v_reason
  FROM users
  WHERE id = v_uid;

  IF v_quarantined IS NOT NULL THEN
    RAISE EXCEPTION
      'Ledger is quarantined for tenant % (since %, reason=%). Financial writes blocked.',
      v_uid, v_quarantined, COALESCE(v_reason, 'unspecified')
      USING ERRCODE = 'L0001',
            HINT    = 'Release the quarantine via the admin console'
                     ' (POST /api/admin/ledger/:tenantId/quarantine'
                     ' {action:"release"}) or wait for auto-remediation.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;


-- ---------------------------------------------------------------------
-- Attach the guard trigger to every in-scope financial table.
--
-- Dynamic DO block:
--   * Iterates the SIX protected tables (invoices, invoice_items,
--     expenses, ledger_entries, recurring_profiles, recurring_items)
--     so that recurring-billing configuration cannot be mutated for a
--     quarantined tenant (otherwise a suspended tenant could have new
--     invoices auto-generated against a frozen ledger).
--   * Checks information_schema.tables for existence before attaching,
--     so the script remains 100% idempotent against partial / in-
--     progress schemas (e.g. applying reconciler.sql before the
--     recurring migration has run).
--   * Drops any prior trigger of the same name first, so re-runs are
--     clean and the trigger definition stays in sync with this file.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'invoices',
    'invoice_items',
    'expenses',
    'ledger_entries',
    'recurring_profiles',
    'recurring_items'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = v_tbl
    ) THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS ledger_quarantine_trigger ON %I',
        v_tbl
      );
      EXECUTE format(
        'CREATE TRIGGER ledger_quarantine_trigger
           BEFORE INSERT OR UPDATE OR DELETE ON %I
           FOR EACH ROW EXECUTE FUNCTION ledger_quarantine_guard()',
        v_tbl
      );
    END IF;
  END LOOP;
END $$;
