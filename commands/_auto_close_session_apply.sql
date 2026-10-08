-- Closes ONE session the automatic daily close found due (cash_register#23, cash_register#145).
-- Reached only from the `auto_close_sessions` handler, once per row of the trusted read
-- `cash_register.sessions.due_for_auto_close`, which owns the cut-off and the time zone. A session
-- opened before the last cut-off stays before it, so the close itself does not recompute it.
--
-- `status = 'open'` + `min_affected_rows: 1`: a drawer somebody closed by hand between the read and
-- this transaction is not closed twice — the pass rolls back and announces nothing, and the next
-- pass reads the new state.
--
-- The close mirrors `close_session.sql`: `expected_balance` = opening + Σ cash movements, but
-- `closing_balance` stays NULL — nobody counted the drawer, and inventing a counted amount would
-- fake a reconciliation (`difference` stays NULL too, like the migration 004 auto-close). The row
-- is attributed to the system (`:current_user_id` is empty in the scheduler context) and marked in
-- `closing_notes`. `:now` is wrapped in `CAST(:now AS TEXT)` like every other statement of this
-- module (whatsapp_inbox#24).
--
-- SIGN (cash_register#48): the direction comes from `movement_type`, not from the stored sign —
-- `-ABS()` for `out`/`refund`, `ABS()` for `in`/`sale`. A badly signed row (a cash-out stored
-- positive) made the close balance against a false expected amount.
UPDATE cash_register_session s
SET status = 'closed',
    closed_at = CAST(:now AS TEXT),
    closing_balance = NULL,
    expected_balance = s.opening_balance + COALESCE((
        SELECT SUM(CASE WHEN COALESCE(m.payment_method_type,'cash') = 'cash' THEN CASE WHEN m.movement_type IN ('out','refund') THEN -ABS(m.amount) ELSE ABS(m.amount) END ELSE 0 END)
        FROM cash_register_movement m
        WHERE m.session_id = s.id AND m.is_deleted = 0
    ), 0),
    difference = NULL,
    closing_notes = CASE WHEN s.closing_notes = '' THEN 'auto-closed by schedule (cash_register#23)'
                         ELSE s.closing_notes || ' | auto-closed by schedule (cash_register#23)' END,
    updated_by = :current_user_id,
    updated_at = CAST(:now AS TEXT)
WHERE s.id = :session_id AND s.hub_id = :hub_id AND s.is_deleted = 0 AND s.status = 'open';
