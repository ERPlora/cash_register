-- Resumen de una sesión: totales por tipo de movimiento. Portado de get_session_summary.
--
-- FIX SIGNO (QA 2026-06-25): los importes se almacenan CON SIGNO — entradas (`sale`,`in`)
-- en positivo y SALIDAS (`out`,`refund`) en NEGATIVO. Para que el desglose se lea como
-- MAGNITUDES POSITIVAS (un refund de 50€ = 50, no -50), se niega el SUM de las salidas
-- (`-SUM(...)`). El expected_total/efectivo neto sigue siendo `opening + SUM(amount)`
-- (entradas y salidas con su signo), igual que el arqueo de cierre. NO cambia el
-- almacenamiento del refund (sigue en negativo): solo la presentación del desglose.
SELECT
  s.id, s.session_number, s.status, s.opening_balance,
  COALESCE(SUM(CASE WHEN m.movement_type='sale'   THEN m.amount ELSE 0 END),0)      AS total_sales,
  -COALESCE(SUM(CASE WHEN m.movement_type='refund' THEN m.amount ELSE 0 END),0)      AS total_refunds,
  COALESCE(SUM(CASE WHEN m.movement_type='in'     THEN m.amount ELSE 0 END),0)      AS total_cash_in,
  -COALESCE(SUM(CASE WHEN m.movement_type='out'    THEN m.amount ELSE 0 END),0)      AS total_cash_out,
  COALESCE(SUM(m.gift_total),0) AS total_gifts,
  COUNT(m.id) AS movement_count
FROM cash_register_session s
LEFT JOIN cash_register_movement m ON m.session_id = s.id AND m.is_deleted = 0 AND m.hub_id = :hub_id
WHERE s.id = :session_id AND s.hub_id = :hub_id
GROUP BY s.id;
