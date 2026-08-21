-- Cash register · 007 — CONTADOR DIARIO DE TURNOS (cash_register#49).
--
-- El número de sesión lo ponía QUIEN LLAMABA. La pantalla del módulo componía `S-YYMMDD-HHMMSS`,
-- pero abrir la caja por command —el asistente, la app instalable, una integración— dejaba el turno
-- como `S-898dbda8-39d7-4a13-b1c5-6d1a71b85b6a`: 38 caracteres, en la columna por la que el
-- encargado habla de un turno y busca en el listado. Y el propio formato de la UI podía COLISIONAR
-- entre dos terminales que abrieran caja el mismo segundo.
--
-- `sales` (`YYYYMMDD-NNNN`) y `payments` (`PAY-YYYYMMDD-NNNN`) ya acuñan el suyo con un contador
-- atómico por (hub, día); `cash_register` era el único de los tres sin contador. Esta tabla es ese
-- contador, calcada de `payments_payment_counter`.
--
-- El índice único (hub_id, day) es OBLIGATORIO: es el arbiter del `ON CONFLICT (hub_id, day)` de
-- `commands/_bump_counter.sql`, que es lo que hace el incremento atómico en UNA sentencia (sin
-- ventana SELECT→UPDATE). Por hub, además de por día: el turno del vecino no puede adelantar el
-- nuestro.
--
-- No se añade una UNIQUE sobre (hub_id, session_number): las filas históricas de los hubs vivos
-- llevan el `S-YYMMDD-HHMMSS` de la UI, que sí podía repetirse, y una migración que falla deja el
-- módulo IMPOSIBLE de instalar. La unicidad la da el contador de aquí en adelante.
CREATE TABLE IF NOT EXISTS cash_register_session_counter (
    id          TEXT PRIMARY KEY,
    hub_id      TEXT NOT NULL,
    day         TEXT NOT NULL,                              -- YYYYMMDD
    last_number INTEGER NOT NULL DEFAULT 0,
    is_deleted  INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT,
    created_by  TEXT,
    updated_by  TEXT,
    created_at  TEXT,
    updated_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_register_session_counter_hub_day
    ON cash_register_session_counter (hub_id, day);
