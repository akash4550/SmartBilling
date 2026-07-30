-- =====================================================================
-- SmartBill: Ledger DDL (append-only RLS + balance invariant trigger)
--
-- 1. RLS on ledger_entries: SELECT/INSERT only for matching userId;
--    UPDATE and DELETE are REVOKEd from app_user so the ledger is
--    physically append-only from the application role.
-- 2. AFTER INSERT ... FOR EACH STATEMENT trigger that raises if any
--    eventId in the inserted set fails to balance (Σ D == Σ C) across
--    the full ledger. This runs per-statement; the posting helper
--    inserts all entries for an event in a single createMany call,
--    so by the time the trigger fires the full set is visible.
-- =====================================================================

-- 1. RLS.
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ledger_select_isolation ON ledger_entries;
CREATE POLICY ledger_select_isolation ON ledger_entries
  FOR SELECT USING ("userId" = current_setting('app.current_user_id', true));

DROP POLICY IF EXISTS ledger_insert_isolation ON ledger_entries;
CREATE POLICY ledger_insert_isolation ON ledger_entries
  FOR INSERT WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- Append-only from app_user.
REVOKE UPDATE, DELETE ON ledger_entries FROM PUBLIC;
REVOKE UPDATE, DELETE ON ledger_entries FROM app_user;
GRANT SELECT, INSERT ON ledger_entries TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- 2. Balance invariant trigger (INSERT path). We intentionally don't
--    create an UPDATE/DELETE trigger because app_user cannot issue
--    those against ledger_entries (revoked above), and superuser
--    (migrations) is trusted.

CREATE OR REPLACE FUNCTION ledger_assert_balanced_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bad RECORD;
BEGIN
  FOR bad IN
    SELECT le."eventId",
           SUM(CASE WHEN le.side = 'DEBIT'  THEN le."amountPaise"::bigint ELSE 0 END) AS total_debits,
           SUM(CASE WHEN le.side = 'CREDIT' THEN le."amountPaise"::bigint ELSE 0 END) AS total_credits
    FROM ledger_entries le
    WHERE le."eventId" IN (SELECT DISTINCT "eventId" FROM inserted)
    GROUP BY le."eventId"
    HAVING SUM(CASE WHEN le.side = 'DEBIT'  THEN le."amountPaise"::bigint ELSE 0 END)
        <> SUM(CASE WHEN le.side = 'CREDIT' THEN le."amountPaise"::bigint ELSE 0 END)
  LOOP
    RAISE EXCEPTION 'Ledger invariant violated on insert: eventId % has D=% C=% (paise)',
      bad."eventId", bad.total_debits, bad.total_credits;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ledger_balance_trigger_insert ON ledger_entries;
CREATE TRIGGER ledger_balance_trigger_insert
AFTER INSERT ON ledger_entries
REFERENCING NEW TABLE AS inserted
FOR EACH STATEMENT
EXECUTE FUNCTION ledger_assert_balanced_insert();
