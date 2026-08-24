INSERT INTO cash_register_movement
  (id, hub_id, session_id, movement_type, amount, payment_method, payment_method_type,
   sale_reference, refund_reference, source_payment_id, description, gift_total, employee_id,
   is_deleted, created_by, updated_by, created_at, updated_at)
SELECT
  :movement_id, :hub_id, s.id, 'refund',
  -ABS(CAST(:amount AS INTEGER)),
  :payment_method,
  COALESCE(NULLIF(CAST(:payment_method_type AS TEXT), ''), 'cash'),
  :sale_reference, :refund_reference, :source_payment_id, :description, 0, :current_user_id,
  0, :current_user_id, :current_user_id, :now, :now
FROM cash_register_session s
WHERE s.hub_id = :hub_id AND s.is_deleted = 0 AND s.status = 'open'
ORDER BY s.opened_at DESC
LIMIT 1
ON CONFLICT (hub_id, refund_reference, source_payment_id) WHERE refund_reference <> ''
DO NOTHING;

-- Anota en la sesión de caja ABIERTA una pata de una DEVOLUCIÓN (`sale.refunded`, cash_register#62).
-- Una fila por entrada de `payments[]`, igual que `_movement_for_open_session` hace al cobrar.
--
-- 🔴 EL TIPO ES EL DEL DESTINO, NO EL DEL ORIGEN. El evento trae las dos cosas y no son la misma:
-- `source_payment_id` es la pata de la que SALE el dinero (manda sobre el tope: no se puede devolver
-- por la tarjeta más de lo que la tarjeta cobró) y `payment_method_type` es por dónde VUELVE (manda
-- sobre el cajón). Una venta con tarjeta puede devolverse en EFECTIVO cuando esa tarjeta ya no
-- existe, y entonces sale dinero de un cajón en el que esa venta nunca entró. Tipar por el origen
-- —que es lo que hace `_reverse_sale`— descuadraría ese caso y su simétrico (una venta en efectivo
-- devuelta a una tarjeta sacaría del cajón un dinero que sigue dentro).
--
-- IDEMPOTENTE POR DOCUMENTO, y de verdad: `ON CONFLICT ... DO NOTHING` sobre el índice único
-- `uq_cashmovement_refund_document (hub_id, refund_reference, source_payment_id)` que crea la
-- migración 009. No es un `NOT EXISTS`: eso es check-then-act, y dos entregas simultáneas del mismo
-- evento pasarían las dos y sacarían el dinero dos veces. La atomicidad la pone el índice. Es
-- defensa en profundidad sobre el marcador `_event_delivery` del runtime, y aquí hace falta porque
-- `refund_ref` es ESTABLE por documento: un reintento con la misma `idempotency_key` devuelve el
-- MISMO id, así que dos eventos distintos pueden nombrar la misma devolución.
--
-- El índice lleva `source_payment_id` porque las N patas de UN documento comparten `refund_ref`: sin
-- él, la segunda pata de una devolución repartida entre efectivo y tarjeta se tragaría como si fuera
-- un reintento de la primera. `sales` garantiza que el par es único — rechaza el mismo `payment_id`
-- dos veces en la misma devolución (`sales.refund_tender_duplicated`).
--
-- SIGNO SERVER-AUTHORITATIVE (cash_register#48): `-ABS(...)`, no `-:amount`. El importe llega del
-- evento en positivo, pero el sentido de un movimiento lo decide su tipo, no el signo con el que
-- venga: un emisor que mandara la devolución ya negada dejaría aquí un `refund` POSITIVO, y aunque
-- las lecturas del arqueo derivan el signo, la lista de movimientos que lee el cajero mostraría un
-- «+50,00 €» sobre dinero que salió.
--
-- `gift_total` = 0 SIEMPRE: las invitaciones son de la VENTA y `session_summary.sql` las suma con
-- `SUM(m.gift_total)`. Repetirlas aquí las contaría dos veces, que es el mismo error que
-- cash_register#59 evitó viajando solo en la primera pata del cobro.
--
-- Si NO hay sesión abierta el SELECT no produce fila y no se anota nada — igual que el cobro. Eso
-- aquí sería dinero desaparecido sin rastro, así que no se deja al SQL: el handler
-- `_record_refund` lee `cash_register.current_session` por `context.reads` y RECHAZA en voz alta
-- (`cash_register.refund_no_open_session`) antes de llegar hasta aquí, para que el evento caiga al
-- dead-letter del outbox en vez de evaporarse en silencio.
