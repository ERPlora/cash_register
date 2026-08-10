-- Reversión de caja al ANULAR una venta (listener de `sale.voided`, ADR-0073).
-- Si la venta anulada registró en su día un movimiento de caja en EFECTIVO (tipo `sale`,
-- lo crea `record_sale` al escuchar `sale.completed`), postea un movimiento COMPENSATORIO
-- `refund` por el importe negado, en la MISMA sesión que tuvo el movimiento original. NO
-- muta el movimiento original (rastro de auditoría intacto): añade la reversión.
--
-- "Pagado en efectivo" = el movimiento `sale` original quedó con `payment_method_type='cash'`
-- (es lo que `record_sale` persiste; reversamos exactamente lo que la caja capturó, sin
-- re-leer la venta). Tarjeta/bizum no tocan la caja, así que su anulación es no-op aquí.
-- hub#778: se compara contra payment_method_TYPE, no contra el `name` localizado.
--
-- IDEMPOTENTE (defensa en profundidad sobre el marcador `_event_delivery` del runtime):
-- el INSERT ... SELECT solo produce fila si (a) existe un movimiento `sale` en efectivo para
-- esta venta y (b) NO existe ya su reversión (`refund` con sale_reference=:sale_id marcado
-- '[VOID]'). Una reentrega del evento no duplica; una segunda venta nunca re-emite (sales.void
-- solo anula 'completed').
--
-- Runtime inyecta :new_id, :hub_id, :current_user_id, :now; :sale_id viene del evento.
INSERT INTO cash_register_movement
  (id, hub_id, session_id, movement_type, amount, payment_method, payment_method_type, sale_reference, description, employee_id,
   is_deleted, created_by, updated_by, created_at, updated_at)
SELECT
  :new_id, :hub_id, orig.session_id, 'refund', -SUM(orig.amount), 'cash', 'cash', :sale_id,
  '[VOID] Sale ' || :sale_id, :current_user_id,
  0, :current_user_id, :current_user_id, :now, :now
FROM cash_register_movement orig
WHERE orig.hub_id = :hub_id
  AND orig.sale_reference = :sale_id
  AND orig.movement_type = 'sale'
  AND COALESCE(orig.payment_method_type,'cash') = 'cash'
  AND orig.is_deleted = 0
  AND NOT EXISTS (
    SELECT 1 FROM cash_register_movement rev
    WHERE rev.hub_id = :hub_id
      AND rev.sale_reference = :sale_id
      AND rev.movement_type = 'refund'
      AND rev.description = '[VOID] Sale ' || :sale_id
  )
GROUP BY orig.session_id
HAVING SUM(orig.amount) > 0;
