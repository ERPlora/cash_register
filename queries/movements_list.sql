-- Movimientos de una sesión de caja.
--
-- `employee_id` (ADR-0130): la sesión es del TERMINAL y todos los cajeros venden dentro de ella, así
-- que sin saber QUIÉN hizo cada movimiento un descuadre no tiene dueño — el «descuadre sin culpable»
-- que documentan Toast y Lightspeed, y que ambos resuelven atando cada movimiento a la persona.
SELECT id, movement_type, amount, payment_method, sale_reference, description, employee_id, created_at
FROM cash_register_movement
WHERE session_id = :session_id AND hub_id = :hub_id AND is_deleted = 0
