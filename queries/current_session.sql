-- Sesión de caja ABIERTA actual del hub: balance de apertura + movimientos netos.
-- KPI "Caja (sesión actual)". Runtime inyecta :hub_id. Devuelve 0..1 filas.
-- expected_total = opening_balance + SUM(amount) (céntimos, ADR-0007).
--
-- FIX SIGNO (QA 2026-06-25): los importes ya viajan CON SIGNO en el almacenamiento —
-- las entradas (`sale`, `in`) en positivo y las SALIDAS (`out`, `refund`) en NEGATIVO
-- (lo persisten así la UI `movAmount` con `out`→ -amount y `_reverse_sale.sql` con
-- `refund`→ -SUM). El KPI antiguo hacía `+entradas - salidas`, lo que RESTABA un número
-- ya negativo (doble negación) e INFLABA el efectivo esperado. El arqueo de cierre
-- (`close_session.sql`) usa `opening + SUM(amount)` y cuadra; replicamos esa MISMA
-- agregación aquí para que el widget en vivo coincida con el arqueo. NO se cambia cómo
-- se almacena el refund (sigue en negativo): solo se corrige la suma del KPI.
-- Si no hay sesión abierta, no devuelve filas (el widget muestra estado vacío, sin inventar datos).
SELECT
  s.id,
  s.session_number,
  s.opening_balance,
  s.opening_balance + COALESCE(SUM(m.amount),0) AS expected_total,
  COALESCE(SUM(CASE WHEN m.movement_type='sale' THEN m.amount ELSE 0 END),0) AS total_sales,
  COUNT(m.id) AS movement_count
FROM cash_register_session s
LEFT JOIN cash_register_movement m
  ON m.session_id = s.id AND m.hub_id = s.hub_id AND m.is_deleted = 0
WHERE s.hub_id = :hub_id AND s.is_deleted = 0 AND s.status = 'open'
GROUP BY s.id
ORDER BY s.opened_at DESC
LIMIT 1;
