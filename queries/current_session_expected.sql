-- The hub's currently OPEN cash session WITH its expected cash total, for supervisors
-- (permission `cash_register.view_expected_totals`, cash_register#24). Same aggregation as
-- `current_session.sql` and `close_session.sql` (opening + Σ cash movements, minor units) — but
-- this one is NOT subject to the `require_blind_count` setting: it is the number a manager checks
-- against the count. It backs the dashboard widget "Expected cash in drawer". The runtime injects
-- :hub_id. Returns 0..1 rows.
SELECT
  s.id,
  s.session_number,
  s.opening_balance,
  s.opening_balance + COALESCE(SUM(CASE WHEN COALESCE(m.payment_method_type,'cash') = 'cash' THEN m.amount ELSE 0 END),0) AS expected_total,
  COALESCE(SUM(CASE WHEN m.movement_type='sale' THEN m.amount ELSE 0 END),0) AS total_sales,
  COUNT(m.id) AS movement_count
FROM cash_register_session s
LEFT JOIN cash_register_movement m
  ON m.session_id = s.id AND m.hub_id = s.hub_id AND m.is_deleted = 0
WHERE s.hub_id = :hub_id AND s.is_deleted = 0 AND s.status = 'open'
GROUP BY s.id
ORDER BY s.opened_at DESC
LIMIT 1;
