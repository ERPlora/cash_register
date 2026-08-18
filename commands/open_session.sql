-- Opens a cash session for the active user. The runtime injects :new_id, :hub_id,
-- :current_user_id, :now. The UI/SDK builds session_number = INITIALS-YYMMDD-HHMM (:session_number).
--
-- DEFAULTS (ADR-0073, QA 2026-06-25): `cash_register.session.open` declares a schema
-- (schemas/open_session.json) → the binder fills the optionals (register_id, opening_balance,
-- opening_notes) when the API sends a minimal payload. BUT the binder only fills static
-- LITERALS; it never generates values. `session_number` (NOT NULL, no static default possible:
-- every session needs a unique one) is DERIVED here with COALESCE when the API does not send it:
-- 'S-' || :new_id (the session's own unique id).
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
VALUES
  (:new_id, :hub_id, :current_user_id, :register_id,
   COALESCE(NULLIF(:session_number, ''), 'S-' || :new_id), 'open', :now,
   COALESCE(:opening_balance, 0), COALESCE(:opening_notes, ''),
   0, :current_user_id, :current_user_id, :now, :now)
ON CONFLICT (hub_id) WHERE status = 'open' AND is_deleted = 0 DO NOTHING;
