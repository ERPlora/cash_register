-- Cierra y reconcilia: expected = opening + Σ movimientos no borrados;
-- difference = closing - expected. Fiel a CashSession.close_session. Todo en SQL,
-- sin read-back. Runtime inyecta :hub_id, :current_user_id, :now.
UPDATE cash_register_session
SET status = 'closed',
    closed_at = :now,
    closing_balance = :closing_balance,
    expected_balance = opening_balance + COALESCE((
        SELECT SUM(amount) FROM cash_register_movement m
        WHERE m.session_id = cash_register_session.id AND m.is_deleted = 0
    ), 0),
    difference = :closing_balance - (opening_balance + COALESCE((
        SELECT SUM(amount) FROM cash_register_movement m
        WHERE m.session_id = cash_register_session.id AND m.is_deleted = 0
    ), 0)),
    closing_notes = :closing_notes,
    updated_by = :current_user_id, updated_at = :now
WHERE id = :session_id AND hub_id = :hub_id AND status = 'open';
