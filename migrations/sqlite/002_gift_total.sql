-- Cash register · 002 — INVITACIONES (comp): cada movimiento de venta guarda el coste de las
-- invitaciones de esa venta (`gift_total`, de sale.completed), para que el arqueo lo sume aparte.
ALTER TABLE cash_register_movement ADD COLUMN gift_total INTEGER NOT NULL DEFAULT 0;
