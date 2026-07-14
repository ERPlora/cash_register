-- Inserta un movimiento en la sesión de caja ABIERTA del TERMINAL (resuelta por subquery).
--
-- ADR-0130: la sesión es del TERMINAL, no del cajero (patrón unánime del mercado: Odoo, Loyverse,
-- Square, Lightspeed, Shopify). Se abre una vez por jornada y TODOS los cajeros venden dentro de
-- ella; quién cobró queda en `employee_id` (= :current_user_id), que es donde vive la
-- responsabilidad individual.
--
-- ANTES esto filtraba por `s.user_id = :current_user_id` y PERDÍA DINERO: si la cajera A abría la
-- caja y cobraba la B, el INSERT ... SELECT no casaba ninguna fila → no se insertaba el movimiento,
-- SIN ERROR, y el efectivo desaparecía del arqueo. Además contradecía a `current_session.sql`, que
-- ya resolvía la sesión abierta del HUB (el KPI decía «caja abierta» mientras el cobro se perdía).
--
-- Sigue siendo un INSERT ... SELECT con guardia: si NO hay sesión abierta no inserta nada (y no
-- falla). Que no se pueda vender con la caja cerrada lo garantiza el guard de ruta (ADR-0130), no
-- esta sentencia.
--
-- Runtime inyecta :movement_id, :hub_id, :current_user_id, :now; el resto los aporta el handler.
INSERT INTO cash_register_movement
  (id, hub_id, session_id, movement_type, amount, payment_method, sale_reference, description, gift_total, employee_id,
   is_deleted, created_by, updated_by, created_at, updated_at)
SELECT
  :movement_id, :hub_id, s.id, :movement_type, :amount, :payment_method, :sale_reference, :description, :gift_total, :current_user_id,
  0, :current_user_id, :current_user_id, :now, :now
FROM cash_register_session s
WHERE s.hub_id = :hub_id AND s.is_deleted = 0 AND s.status = 'open'
ORDER BY s.opened_at DESC
LIMIT 1;
