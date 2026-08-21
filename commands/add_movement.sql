-- Inserts a cash movement resolving its session against the injected hub (pm#146). Since
-- cash_register#38 the public `cash_register.movement.add` is a WASM handler that enforces the
-- drawer settings (`allow_negative_balance`) and refuses an unknown session BEFORE resolving to
-- this SQL (`cash_register._movement_insert`); the row id comes as `:movement_id` (`new_ids[0]`).
--
-- `session_id` venía del payload sin comprobar nada, así que un movimiento de este hub podía quedar
-- colgando de la sesión de otro. Y aquí la fila cruzada no es un dato feo: `session_summary` suma
-- los movimientos de una sesión para dar el **arqueo**, así que es dinero mal contado.
--
-- La mitad de lectura se cerró en pm#89 (ese JOIN lleva ya la igualdad de hub), pero acotar la
-- lectura deja de ENSEÑAR la fila del vecino: no impide escribirla.
--
-- Si la sesión no es de este hub —o está borrada— no se selecciona nada, no se escribe nada, y
-- `expect_rows` lo convierte en un error de negocio. Sin esa guarda sería PEOR que el bug: el
-- command devolvería OK y emitiría `cash_register.movement_added` igualmente, así que quien
-- escuche el evento contaría un movimiento que no existe.
--
-- ⚠️ `payment_method_type` faltaba en esta lista de columnas (cash_register#54) — el MISMO defecto
-- que cash_register#33, por la otra puerta. El tipo CANÓNICO (`cash`|`card`|`transfer`|`other`,
-- hub#778) es contra el que comparan las cinco lecturas del arqueo; el `name` de al lado está
-- localizado y no sirve. Como el INSERT no la nombraba, la columna se quedaba con el `DEFAULT
-- 'cash'` de su migración (`003_payment_method_type.sql`, sin backfill) y un movimiento manual
-- registrado con `payment_method: "card"` entraba en el cajón COMO EFECTIVO: fondo de 100 € + un
-- movimiento de TARJETA de 50 € dejaba `expected_cash` en 150 €, dinero que la caja no tiene.
-- El tipo lo deriva el handler del método (una sola vez, en `payment_method_type()`), así que la
-- guarda `allow_negative_balance` y esta fila no pueden volver a discrepar.
INSERT INTO cash_register_movement
  (id, hub_id, session_id, movement_type, amount, payment_method, payment_method_type,
   sale_reference, description, employee_id,
   is_deleted, created_by, updated_by, created_at, updated_at)
SELECT
  :movement_id, :hub_id, s.id, :movement_type, :amount, COALESCE(:payment_method, 'cash'),
  COALESCE(NULLIF(CAST(:payment_method_type AS TEXT), ''), 'cash'),
  COALESCE(:sale_reference, ''), COALESCE(:description, ''), :current_user_id,
  0, :current_user_id, :current_user_id, :now, :now
FROM cash_register_session s
WHERE s.id = :session_id AND s.hub_id = :hub_id AND s.is_deleted = 0;
