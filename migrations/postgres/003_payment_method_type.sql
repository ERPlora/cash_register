-- Cash register · 003 — TIPO CANÓNICO de método de pago (hub#778): cada movimiento de venta
-- guarda el `type` canónico del método (`cash`|`card`|`transfer`|`other`), leído del catálogo
-- `sales_payment_method.type` por el emisor del evento. Hasta ahora el cajón comparaba el `name`
-- localizado contra el literal 'cash', y las ventas en efectivo («Efectivo»/«Cash») nunca sumaban
-- al esperado del cajón. Con el `type` el arqueo compara contra 'cash' sin depender del idioma.
ALTER TABLE cash_register_movement ADD COLUMN payment_method_type TEXT NOT NULL DEFAULT 'cash';
