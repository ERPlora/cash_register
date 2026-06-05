-- Inserta un movimiento en la sesión ABIERTA del usuario activo (resuelta por subquery).
-- Si el usuario no tiene sesión abierta, el subquery da NULL y el INSERT no casa FK lógica
-- (session_id NULL) → en la práctica el WHERE del SELECT no produce fila. Por eso usamos
-- INSERT ... SELECT con guardia: solo inserta si existe sesión abierta.
-- Runtime inyecta :movement_id, :hub_id, :current_user_id, :now; el resto los aporta el handler.
INSERT INTO cash_register_movement
  (id, hub_id, session_id, movement_type, amount, payment_method, sale_reference, description, employee_id,
   is_deleted, created_by, updated_by, created_at, updated_at)
SELECT
  :movement_id, :hub_id, s.id, :movement_type, :amount, :payment_method, :sale_reference, :description, :current_user_id,
  0, :current_user_id, :current_user_id, :now, :now
FROM cash_register_session s
WHERE s.hub_id = :hub_id AND s.user_id = :current_user_id AND s.status = 'open'
ORDER BY s.opened_at DESC
LIMIT 1;
