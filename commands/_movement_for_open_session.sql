-- Crea el movimiento de una venta en la sesión de caja ABIERTA.
--
-- `payment_method` is the name the person sees («Efectivo», «Tarjeta») and it is localised.
-- `payment_method_type` is the CANONICAL type (`cash`|`card`|`transfer`|`other`, hub#778) and the
-- only thing that can be compared against: the count in `close_session.sql` sums by it, and the
-- void in `_reverse_movement_for_open_session.sql` filters by it.
--
-- ⚠️ Faltaba en esta lista de columnas (cash_register#33). El handler calculaba el tipo y lo pasaba
-- como parámetro, este INSERT no lo nombraba, y la columna se quedaba con el `DEFAULT 'cash'` que le
-- puso su migración (`003_payment_method_type.sql`, sin backfill). Resultado: **el arqueo contaba
-- las ventas con tarjeta como efectivo**, y el cajero cuadraba contra un descuadre fantasma del
-- tamaño exacto de lo cobrado con tarjeta. La anulación sí la escribía desde el principio, así que
-- las dos mitades de la misma operación no coincidían.
INSERT INTO cash_register_movement
  (id, hub_id, session_id, movement_type, amount, payment_method, payment_method_type,
   sale_reference, description, gift_total, employee_id,
   is_deleted, created_by, updated_by, created_at, updated_at)
SELECT
  :movement_id, :hub_id, s.id, :movement_type, :amount, :payment_method,
  COALESCE(NULLIF(CAST(:payment_method_type AS TEXT), ''), 'cash'),
  :sale_reference, :description, :gift_total, :current_user_id,
  0, :current_user_id, :current_user_id, :now, :now
FROM cash_register_session s
WHERE s.hub_id = :hub_id AND s.is_deleted = 0 AND s.status = 'open'
ORDER BY s.opened_at DESC
LIMIT 1;
