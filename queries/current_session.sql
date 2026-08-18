-- The hub's currently OPEN cash session: opening balance + net movements. The runtime injects
-- :hub_id. Returns 0..1 rows. This is also the POS guard (`protects.guard_query`, expect
-- non_empty), so every till user can run it.
--
-- expected_total = opening_balance + SUM(amount) (minor units, ADR-0007).
--
-- SIGN FIX (QA 2026-06-25): amounts are stored WITH their sign — inflows (`sale`, `in`) positive
-- and OUTFLOWS (`out`, `refund`) negative (the UI persists `out` as -amount and `_reverse_sale.sql`
-- persists `refund` as -SUM). The old KPI did `+in - out`, subtracting an already negative number
-- (double negation) and INFLATING the expected cash. The closing reconciliation
-- (`close_session.sql`) uses `opening + SUM(amount)` and balances; the SAME aggregation is
-- replicated here so the live widget matches the reconciliation. How refunds are stored does not
-- change (still negative): only the KPI sum was corrected.
--
-- BLIND COUNT (cash_register#24): when the hub's `require_blind_count` setting is on, this query
-- still proves the drawer is open but carries NO `expected_total` (NULL) — the person counting must
-- not be able to read what the drawer "should" hold before declaring the count (Square/Toast/
-- Lightspeed "blind close"). Supervisors read it from `cash_register.current_session.expected`
-- (permission `cash_register.view_expected_totals`). Off (or no settings row yet) = today's value.
--
-- If no session is open, no rows come back (the widget shows its empty state, invents no data).
SELECT
  s.id,
  s.session_number,
  s.opening_balance,
  -- The DRAWER is PHYSICAL cash (QA 07-16): the expected total only sums cash movements
  -- (COALESCE covers old rows without a method). Card stays in movements and KPIs.
  -- hub#778: compared against payment_method_TYPE ('cash' canonical), not the localised
  -- `name` («Efectivo»/«Cash») that never equals 'cash' in case-sensitive Postgres.
  CASE WHEN COALESCE((SELECT c.require_blind_count FROM cash_register_settings c
                      WHERE c.hub_id = s.hub_id AND c.is_deleted = 0 LIMIT 1), 0) = 1
       THEN NULL
       ELSE s.opening_balance + COALESCE(SUM(CASE WHEN COALESCE(m.payment_method_type,'cash') = 'cash' THEN m.amount ELSE 0 END),0)
  END AS expected_total,
  COALESCE(SUM(CASE WHEN m.movement_type='sale' THEN m.amount ELSE 0 END),0) AS total_sales,
  COUNT(m.id) AS movement_count
FROM cash_register_session s
LEFT JOIN cash_register_movement m
  ON m.session_id = s.id AND m.hub_id = s.hub_id AND m.is_deleted = 0
WHERE s.hub_id = :hub_id AND s.is_deleted = 0 AND s.status = 'open'
GROUP BY s.id
ORDER BY s.opened_at DESC
LIMIT 1;
