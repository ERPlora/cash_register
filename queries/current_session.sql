-- Sesión de caja ABIERTA actual del hub: balance de apertura + movimientos netos.
-- KPI "Caja (sesión actual)". Runtime inyecta :hub_id. Devuelve 0..1 filas.
-- expected_total = opening_balance + sum(sale + in - refund - out) (céntimos, ADR-0007).
-- Si no hay sesión abierta, no devuelve filas (el widget muestra estado vacío, sin inventar datos).
SELECT
  s.id,
  s.session_number,
  s.opening_balance,
  s.opening_balance
    + COALESCE(SUM(CASE WHEN m.movement_type IN ('sale','in')  THEN m.amount ELSE 0 END),0)
    - COALESCE(SUM(CASE WHEN m.movement_type IN ('refund','out') THEN m.amount ELSE 0 END),0)
    AS expected_total,
  COALESCE(SUM(CASE WHEN m.movement_type='sale' THEN m.amount ELSE 0 END),0) AS total_sales,
  COUNT(m.id) AS movement_count
FROM cash_register_session s
LEFT JOIN cash_register_movement m
  ON m.session_id = s.id AND m.hub_id = s.hub_id AND m.is_deleted = 0
WHERE s.hub_id = :hub_id AND s.is_deleted = 0 AND s.status = 'open'
GROUP BY s.id
ORDER BY s.opened_at DESC
LIMIT 1;
