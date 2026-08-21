-- Cash register · 008 — REPARA los movimientos que la puerta manual escribió con el tipo mal
-- (cash_register#54).
--
-- `commands/add_movement.sql` no nombraba `payment_method_type` en su INSERT, así que la columna se
-- quedaba con el `DEFAULT 'cash'` que le puso la migración 003 (que tampoco hizo backfill). Todo
-- movimiento manual registrado con tarjeta/transferencia/otro está HOY en las tablas de los hubs
-- diciendo que fue efectivo, y las cinco lecturas del arqueo comparan justo contra esa columna: el
-- cajón espera un dinero que no tiene, el cierre reconcilia contra ese esperado falso y el
-- descuadre se lo come el cajero. Arreglar solo la escritura deja el veneno dentro.
--
-- Es el mismo criterio de cash_register#48 —lo ya escrito mal no puede seguir envenenando el
-- arqueo— aplicado donde aquí toca. #48 pudo derivar el signo EN LA LECTURA porque el dato bueno
-- (`movement_type`) ya estaba en la fila; aquí el dato bueno es el propio método, así que la
-- reparación va a la fila, una vez. Repetirla en las seis lecturas además no bastaría: el INSERT de
-- `_reverse_sale.sql` filtra por esta columna para decidir si una venta anulada devolvió efectivo,
-- y eso ninguna lectura lo arregla.
--
-- ALCANCE — solo se repara lo que se puede NOMBRAR sin adivinar: las filas cuyo `payment_method` ES
-- uno de los cuatro tokens canónicos (`cash`|`card`|`transfer`|`other`), que es lo que escribe la
-- puerta manual (la pantalla del módulo, el asistente, la API). Las de la puerta de VENTA llevan el
-- `name` LOCALIZADO del catálogo de `sales` («Tarjeta», «Bizum»): traducirlo aquí exigiría leer
-- `sales_payment_method` desde una migración de este módulo — una dependencia dura entre módulos,
-- justo lo que el contrato prohíbe— y adivinarlo por lista de idiomas sería el mismo error del
-- revés. Esas filas se dejan como están; su escritura quedó arreglada en #33 y desde entonces
-- llegan con el tipo puesto.
--
-- Es un UPDATE, a propósito: ni índice ni CHECK. Una migración que falla deja el módulo IMPOSIBLE
-- de instalar (whatsapp_inbox#30, cash_register#49), y un CHECK sobre esta columna reventaría en
-- cualquier hub cuyo emisor de `sale.completed` haya mandado un tipo fuera del vocabulario. Es
-- idempotente: la segunda pasada no encuentra ninguna fila.
UPDATE cash_register_movement
SET payment_method_type = LOWER(TRIM(payment_method))
WHERE payment_method_type = 'cash'
  AND LOWER(TRIM(COALESCE(payment_method, ''))) IN ('card', 'transfer', 'other');
