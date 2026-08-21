-- Inserts a cash session for the active user (`cash_register._open_session_insert`). Since
-- cash_register#38 the public `cash_register.session.open` is a WASM handler that enforces the
-- drawer settings and resolves to this SQL; the handler hands the row id as `:session_id`
-- (`new_ids[0]`, the id the caller gets back). The runtime injects :hub_id, :current_user_id, :now.
--
-- EL NÚMERO DE TURNO LO ACUÑA EL SERVIDOR (cash_register#49). Antes lo componía la UI
-- (`S-YYMMDD-HHMMSS`) y, si la API no mandaba ninguno, este SQL caía a `'S-' || :session_id`: abrir
-- la caja por command dejaba el turno como `S-898dbda8-39d7-4a13-b1c5-6d1a71b85b6a`, 38 caracteres,
-- en la columna por la que el encargado habla de un turno y por la que BUSCA en el listado. El
-- fallback resolvía el NOT NULL pero dejaba un identificador de NEGOCIO en manos del cliente — y ni
-- siquiera había contrato: el schema declaraba `session_number` como string libre.
--
-- Ahora se compone aquí, en la misma transacción, leyendo el contador que acaba de incrementar
-- `cash_register._bump_counter` (patrón `payments._insert_payment`: el guest WASM nunca hace
-- read-back). `:day` (YYYYMMDD, la clave del contador) y `:session_day` (YYMMDD, lo que lee la
-- persona) los aporta el handler desde el reloj del HOST. Padding NNNN portable SQLite↔Postgres
-- (sin printf/lpad, ADR-0007): substr(CAST(10000+n AS TEXT), 2); n >= 10000 cae a su representación
-- plena. Con el contador desaparece además la colisión que tenía `S-YYMMDD-HHMMSS` entre dos
-- terminales que abrieran caja el mismo segundo.
--
-- ONE OPEN SESSION PER HUB (cash_register#11): the partial unique index
-- `uq_cashsession_one_open_per_hub` (004_one_open_session_per_hub.sql) is the invariant;
-- `ON CONFLICT ... DO NOTHING` makes a concurrent or repeated open a 0-row no-op instead of a
-- constraint error, and the command's `expect_rows {min 1}` gate turns that 0-row outcome into
-- the domain error `cash_register.session_already_open`. The UI never gets to create a second
-- drawer, whatever button it presses.
INSERT INTO cash_register_session
  (id, hub_id, user_id, register_id, session_number, status, opened_at, opening_balance, opening_notes,
   is_deleted, created_by, updated_by, created_at, updated_at)
SELECT
  :session_id, :hub_id, :current_user_id, :register_id,
  'S-' || :session_day || '-' ||
  CASE WHEN c.last_number < 10000
       THEN substr(CAST(10000 + c.last_number AS TEXT), 2)
       ELSE CAST(c.last_number AS TEXT)
  END,
  'open', :now,
  COALESCE(:opening_balance, 0), COALESCE(:opening_notes, ''),
  0, :current_user_id, :current_user_id, :now, :now
FROM (
  SELECT last_number FROM cash_register_session_counter
  WHERE hub_id = :hub_id AND day = :day
) AS c
ON CONFLICT (hub_id) WHERE status = 'open' AND is_deleted = 0 DO NOTHING;
