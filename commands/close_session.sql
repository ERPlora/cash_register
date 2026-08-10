-- Cierra y reconcilia: expected = opening + Σ movimientos no borrados;
-- difference = closing - expected. Fiel a CashSession.close_session. Todo en SQL,
-- sin read-back. Runtime inyecta :hub_id, :current_user_id, :now.
UPDATE cash_register_session
-- El CAJÓN es efectivo FÍSICO (QA 07-16, P0 del arqueo): expected/difference solo
-- suman movimientos cash — con día mixto (tarjeta) el arqueo cuadra contra lo contado.
-- hub#778: se compara contra payment_method_TYPE ('cash' canónico), no contra el `name`
-- localizado («Efectivo») que nunca iguala 'cash' en Postgres case-sensitive.
SET status = 'closed',
    closed_at = :now,
    closing_balance = :closing_balance,
    expected_balance = opening_balance + COALESCE((
        SELECT SUM(CASE WHEN COALESCE(m.payment_method_type,'cash') = 'cash' THEN m.amount ELSE 0 END)
        FROM cash_register_movement m
        WHERE m.session_id = cash_register_session.id AND m.is_deleted = 0
    ), 0),
    difference = :closing_balance - (opening_balance + COALESCE((
        SELECT SUM(CASE WHEN COALESCE(m.payment_method_type,'cash') = 'cash' THEN m.amount ELSE 0 END)
        FROM cash_register_movement m
        WHERE m.session_id = cash_register_session.id AND m.is_deleted = 0
    ), 0)),
    -- GUARDARRAÍL QA (2026-06-25): sin schema que aplique defaults, las notas opcionales llegan
    -- NULL → NOT NULL en closing_notes. COALESCE a '' para que el cierre sin notas funcione.
    closing_notes = COALESCE(:closing_notes, ''),
    updated_by = :current_user_id, updated_at = :now
WHERE id = :session_id AND hub_id = :hub_id AND status = 'open';
