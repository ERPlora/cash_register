-- Movimientos de una sesión de caja.
--
-- `employee_id` (ADR-0130): la sesión es del TERMINAL y todos los cajeros venden dentro de ella, así
-- que sin saber QUIÉN hizo cada movimiento un descuadre no tiene dueño — el «descuadre sin culpable»
-- que documentan Toast y Lightspeed, y que ambos resuelven atando cada movimiento a la persona.
--
-- SIGNO SERVER-AUTHORITATIVE (cash_register#48, explicado entero en `queries/session_summary.sql`):
-- el sentido lo da `movement_type`, no el signo guardado — `-ABS()` para `out`/`refund`, `ABS()`
-- para `in`/`sale`. Una salida enviada en positivo SUMABA al cajón, y las filas que ya se
-- escribieron así envenenarían el arqueo para siempre si la lectura se fiara del signo.
--
-- Aquí también: la tabla que ve el encargado enseñaba `out 99.999,00 €` y `out −30,00 €` en filas
-- contiguas, con el mismo TIPO y signos opuestos. Con el signo derivado, una salida se ve como una
-- salida siempre.
SELECT id, movement_type,
       CASE WHEN cash_register_movement.movement_type IN ('out','refund') THEN -ABS(cash_register_movement.amount) ELSE ABS(cash_register_movement.amount) END AS amount,
       payment_method, sale_reference, description, employee_id, created_at
FROM cash_register_movement
WHERE session_id = :session_id AND hub_id = :hub_id AND is_deleted = 0
