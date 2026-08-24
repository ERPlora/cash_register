ALTER TABLE cash_register_movement
  ADD COLUMN IF NOT EXISTS refund_reference TEXT NOT NULL DEFAULT '';
ALTER TABLE cash_register_movement
  ADD COLUMN IF NOT EXISTS source_payment_id TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_cashmovement_refund_document
    ON cash_register_movement (hub_id, refund_reference, source_payment_id)
    WHERE refund_reference <> '';

-- Cash register · 009 — el DOCUMENTO de devolución que dejó cada movimiento (cash_register#62).
--
-- `sales` v2.16.4 emite `sale.refunded` con una entrada por pata en `payments[]`, y el cajón las
-- anota (`_refund_movement_for_open_session`). Sin estas dos columnas no hay forma de saber si una
-- devolución YA se anotó, y una reentrega del evento sacaría el dinero del cajón otra vez.
--
--   refund_reference  = `refund_ref` del evento, el id ESTABLE del documento. Un reintento con la
--                       misma `idempotency_key` devuelve el MISMO id, así que es la clave del
--                       documento, no del intento.
--   source_payment_id = la pata de cobro de la que sale el dinero (`payment_id`). Es lo que
--                       distingue las N patas de UN documento: `sales` rechaza el mismo
--                       `payment_id` dos veces en la misma devolución
--                       (`sales.refund_tender_duplicated`), así que el par es único por fila.
--
-- 🔴 POR QUÉ UN ÍNDICE Y NO UN `NOT EXISTS`. La idempotencia de esto es dinero, y un `INSERT
-- ... SELECT ... WHERE NOT EXISTS` es check-then-act: dos entregas simultáneas del mismo evento
-- leen las dos que no hay fila, y las dos insertan. El descuadre resultante es del tamaño exacto de
-- la devolución y no deja ni un error en el log. El índice lo resuelve donde sí es atómico: la
-- segunda transacción espera en el índice, ve el conflicto al hacer COMMIT la primera, y su
-- `ON CONFLICT DO NOTHING` la convierte en el no-op que debía ser. Es la BD la que lo garantiza,
-- no el orden en que se ejecuten dos réplicas.
--
-- PARCIAL (`WHERE refund_reference <> ''`) a propósito: las decenas de miles de filas que ya
-- existen —ventas, entradas y salidas manuales, reversiones de anulación— no llevan documento de
-- devolución y comparten la cadena vacía. Un índice total las declararía duplicadas entre sí y la
-- migración fallaría al crearlo, dejando el módulo IMPOSIBLE de instalar (whatsapp_inbox#30,
-- cash_register#49). Con el predicado, solo entran al índice las filas que de verdad tienen
-- documento.
--
-- Lleva `hub_id` en primera posición porque el mismo documento puede existir en dos hubs de un
-- mismo Postgres (ADR-0201 les da BD propia, pero el contrato de fila con `hub_id` sigue vigente y
-- los tests lo ejercitan con un vecino VIVO). Sin él, la devolución del vecino se tragaría en
-- silencio como si fuera un reintento nuestro — un descuadre en la caja de OTRO negocio.
--
-- `DEFAULT ''` y NOT NULL, nunca NULL: en Postgres dos NULL no son iguales, así que un índice
-- único sobre columnas nullables no restringe nada y la protección quedaría abierta creyéndose
-- cerrada. `ADD COLUMN IF NOT EXISTS` e `IF NOT EXISTS` en el índice para que una segunda pasada
-- sea un no-op, igual que 006 y 007.
