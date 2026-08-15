-- Registra un movimiento resolviendo su sesión contra el hub inyectado (pm#146).
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
INSERT INTO cash_register_movement
  (id, hub_id, session_id, movement_type, amount, payment_method, sale_reference, description, employee_id,
   is_deleted, created_by, updated_by, created_at, updated_at)
SELECT
  :new_id, :hub_id, s.id, :movement_type, :amount, COALESCE(:payment_method, 'cash'),
  COALESCE(:sale_reference, ''), COALESCE(:description, ''), :current_user_id,
  0, :current_user_id, :current_user_id, :now, :now
FROM cash_register_session s
WHERE s.id = :session_id AND s.hub_id = :hub_id AND s.is_deleted = 0;
