-- Abre una sesión de caja para el usuario activo. Runtime inyecta :new_id, :hub_id,
-- :current_user_id, :now. La UI/SDK arma session_number = INICIALES-YYMMDD-HHMM (:session_number).
--
-- DEFAULTS (ADR-0073, QA 2026-06-25): `cash_register.session.open` ya declara schema
-- (schemas/open_session.json) → el binder rellena los opcionales (register_id, opening_balance,
-- opening_notes) cuando la API manda un payload mínimo. PERO el binder solo rellena LITERALES
-- estáticos; NO genera valores. `session_number` (NOT NULL, sin default estático posible: cada
-- sesión necesita uno único) se DERIVA aquí con COALESCE si la API no lo aporta: 'S-' || :new_id
-- (id único de la sesión). Así un POST mínimo por API no rompe el NOT NULL de session_number,
-- mientras el flujo normal (UI/SDK) sigue mandando su número legible.
INSERT INTO cash_register_session
  (id, hub_id, user_id, register_id, session_number, status, opened_at, opening_balance, opening_notes,
   is_deleted, created_by, updated_by, created_at, updated_at)
VALUES
  (:new_id, :hub_id, :current_user_id, :register_id,
   COALESCE(NULLIF(:session_number, ''), 'S-' || :new_id), 'open', :now,
   COALESCE(:opening_balance, 0), COALESCE(:opening_notes, ''),
   0, :current_user_id, :current_user_id, :now, :now);
