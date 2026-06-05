-- Resumen de una sesión: totales por tipo de movimiento. Portado de get_session_summary.
SELECT
  s.id, s.session_number, s.status, s.opening_balance,
  COALESCE(SUM(CASE WHEN m.movement_type='sale'   THEN m.amount ELSE 0 END),0) AS total_sales,
  COALESCE(SUM(CASE WHEN m.movement_type='refund' THEN m.amount ELSE 0 END),0) AS total_refunds,
  COALESCE(SUM(CASE WHEN m.movement_type='in'     THEN m.amount ELSE 0 END),0) AS total_cash_in,
  COALESCE(SUM(CASE WHEN m.movement_type='out'    THEN m.amount ELSE 0 END),0) AS total_cash_out,
  COUNT(m.id) AS movement_count
FROM cash_register_session s
LEFT JOIN cash_register_movement m ON m.session_id = s.id AND m.is_deleted = 0
WHERE s.id = :session_id AND s.hub_id = :hub_id
GROUP BY s.id;
