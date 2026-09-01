-- Reversión de caja al ANULAR una venta (listener de `sale.voided`, ADR-0075).
-- Si la venta anulada dejó dinero VIVO en el cajón, postea un movimiento COMPENSATORIO `refund`
-- por ese importe negado, en la MISMA sesión que tuvo el movimiento original. NO muta el
-- movimiento original (rastro de auditoría intacto): añade la reversión.
--
-- "Pagado en efectivo" = el movimiento `sale` original quedó con `payment_method_type='cash'`
-- (es lo que `record_sale` persiste; reversamos exactamente lo que la caja capturó, sin
-- re-leer la venta). Tarjeta/bizum no tocan la caja, así que su anulación es no-op aquí.
-- hub#778: se compara contra payment_method_TYPE, no contra el `name` localizado.
--
-- 🔴 SE REVIERTE LO QUE QUEDA VIVO, NO LA VENTA ENTERA (cash_register#63). Hasta aquí esto era
-- `-SUM(sale)`: la reversión no sabía nada de las DEVOLUCIONES que ya habían salido de esa misma
-- venta (`refund` con `sale_reference = :sale_id`, que existen desde cash_register#62), así que una
-- venta devuelta EN PARTE y anulada después sacaba del cajón el trozo ya devuelto por segunda vez.
-- Con el ejemplo de la issue —fondo 100,00 €, venta de 100,00 € en efectivo, devolución de 30,00 €
-- y anulación— dentro del cajón solo quedaban 70,00 € de esa venta y la reversión sacaba 100,00 €:
-- el arqueo se pasaba en 30,00 €, en silencio y contra un esperado que el cajero no puede discutir.
--
-- Por qué NETO y no «rechazar la anulación» AQUÍ: esa política es de `sales`, no del cajón. El
-- mercado la tiene decidida y dice lo contrario que este listener asume — Stripe, Square, Clover,
-- Lightspeed, Shopify POS, Zettle y SumUp CIERRAN la puerta del void en cuanto se ha movido dinero
-- contra el cobro, y Business Central bloquea «Cancel» y obliga al abono: el resto vivo se devuelve
-- con OTRA devolución, nunca con una anulación (12 referencias verificadas, tabla en ERPlora/sales).
-- Pero esa puerta la cierra `sales`, y HOY no está cerrada: `sales._mark_refunded` solo marca la
-- venta cuando `fully_refunded`, así que una venta devuelta en parte sigue `completed` y se anula.
-- El cajón tiene que quedar bien con las dos políticas y no puede esperar a la otra: si `sales`
-- deja de permitirlo este listener simplemente no se dispara, y mientras lo permita el cajón se
-- mueve por el importe vivo y ni un céntimo más. NO netear no es la alternativa segura: sería
-- dejarse dentro los 70,00 € que el cliente ya se llevó, un descuadre MAYOR que el que cierra esto.
--
-- 🔴 EL TIPO ES EL DEL DESTINO, igual que en `_refund_movement_for_open_session` (cash_register#62).
-- Solo restan las devoluciones que volvieron EN EFECTIVO: una venta en efectivo devuelta a una
-- TARJETA no sacó un céntimo del cajón, así que su anulación sigue reversando el importe completo;
-- y una venta con tarjeta devuelta en efectivo no puede hacer que la anulación METa dinero en el
-- cajón — de ahí el suelo `WHERE live.amount > 0`, que además evita el `refund` de importe 0 de una
-- venta ya devuelta entera.
--
-- SIGNO SERVER-AUTHORITATIVE (cash_register#48): las magnitudes se derivan con `ABS()` en LAS DOS
-- patas, exactamente como las deriva `queries/session_summary.sql`. Una fila mal firmada de antes
-- de #48 cuenta como entrada en el arqueo, así que la anulación tiene que devolverla igual; leerla
-- de otra forma dejaría al cajón y al arqueo discrepando sobre la misma fila.
--
-- IDEMPOTENTE (defensa en profundidad sobre el marcador `_event_delivery` del runtime):
-- el INSERT ... SELECT solo produce fila si (a) queda importe vivo en efectivo para esta venta y
-- (b) NO existe ya su reversión (`refund` con sale_reference=:sale_id marcado '[VOID]'). Una
-- reentrega del evento no duplica; una segunda venta nunca re-emite (sales.void solo anula
-- 'completed'). El neto es la segunda cerradura: la propia reversión es un `refund` en efectivo de
-- esa venta, así que en una reentrega el importe vivo ya vale 0.
--
-- Runtime inyecta :new_id, :hub_id, :current_user_id, :now; :sale_id viene del evento.
INSERT INTO cash_register_movement
  (id, hub_id, session_id, movement_type, amount, payment_method, payment_method_type, sale_reference, description, employee_id,
   is_deleted, created_by, updated_by, created_at, updated_at)
SELECT
  :new_id, :hub_id, live.session_id, 'refund', -live.amount, 'cash', 'cash', :sale_id,
  '[VOID] Sale ' || :sale_id, :current_user_id,
  0, :current_user_id, :current_user_id, :now, :now
FROM (
  -- Lo que esta venta dejó VIVO en el cajón: lo que entró en efectivo menos lo que ya volvió en
  -- efectivo. Se agrupa por la sesión de los movimientos de VENTA (las devoluciones se anotan en la
  -- sesión abierta del momento, que no tiene por qué ser esa) para no cambiar dónde aterriza la
  -- reversión, que sigue siendo la sesión del movimiento original.
  SELECT
    orig.session_id AS session_id,
    SUM(ABS(orig.amount)) - COALESCE((
      SELECT SUM(ABS(rf.amount))
      FROM cash_register_movement rf
      WHERE rf.hub_id = :hub_id
        AND rf.sale_reference = :sale_id
        AND rf.movement_type = 'refund'
        AND COALESCE(rf.payment_method_type,'cash') = 'cash'
        AND rf.is_deleted = 0
    ), 0) AS amount
  FROM cash_register_movement orig
  WHERE orig.hub_id = :hub_id
    AND orig.sale_reference = :sale_id
    AND orig.movement_type = 'sale'
    AND COALESCE(orig.payment_method_type,'cash') = 'cash'
    AND orig.is_deleted = 0
  GROUP BY orig.session_id
) live
WHERE live.amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM cash_register_movement rev
    WHERE rev.hub_id = :hub_id
      AND rev.sale_reference = :sale_id
      AND rev.movement_type = 'refund'
      AND rev.description = '[VOID] Sale ' || :sale_id
  );
