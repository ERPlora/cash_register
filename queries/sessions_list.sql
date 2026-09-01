-- The Cash grid (`cash_register.sessions.list`). The runtime injects :hub_id.
--
-- ESPERADO EN VIVO (cash_register#65). This used to SELECT the stored `expected_balance` column and
-- nothing else — and that column is written by `session.close`, so every OPEN session came back
-- `null` and the grid printed «—» in ESPERADO for the whole shift. The number existed all along
-- (`cash_register.current_session` computes it live); it just was not where the screen reads from,
-- so nobody could see what the drawer should hold at the only time it is worth something: BEFORE
-- closing. Square ("Expected in drawer" on the open drawer), Toast (Shift Review) and Lightspeed
-- (Cash management) all show it during the shift.
--
-- So the column now answers per STATUS:
--   · open   → computed live, exactly like `queries/current_session.sql` / `commands/close_session.sql`
--              (opening float + Σ CASH movements, minor units — ADR-0007/0400, integers only).
--   · closed → the STORED column, untouched. That is the AUDITED figure the stored `difference` was
--              computed against; recomputing it later (a movement backdated, a row soft-deleted)
--              would leave the row stating a difference that no longer follows from its own expected.
--
-- BLIND COUNT (cash_register#24). Same rule as the guard query: with the hub's `require_blind_count`
-- setting on, an OPEN session carries NO expected — the person counting must not be able to read
-- what the drawer should hold before declaring the count. Supervisors keep reading it through
-- `cash_register.current_session.expected` (permission `cash_register.view_expected_totals`), which
-- the setting does not gag. Hiding it from the cashier is what makes a count blind; leaving the
-- column empty for everybody just made the screen useless.
--
-- CASH ONLY: the drawer holds PHYSICAL cash, so only cash movements count (hub#778: keyed on
-- payment_method_TYPE, the canonical 'cash', never the localised `name` that reads «Efectivo»).
--
-- SIGNO SERVER-AUTHORITATIVE (cash_register#48): the sense of a movement comes from its
-- `movement_type`, not from the sign it happens to be stored with — `-ABS()` for `out`/`refund`,
-- `ABS()` for `in`/`sale`. A withdrawal sent positive used to ADD to the drawer.
--
-- CORRELATED SUBQUERY, not a JOIN: a `LEFT JOIN … GROUP BY` would multiply a session by its
-- movements inside the paginated subquery the list engine wraps this in, and the pager's total
-- would lie. It is also cheap — `ix_cashmovement_session (hub_id, session_id)` covers it, at most
-- one session per hub is open (`uq_cashsession_one_open_per_hub`) and CASE short-circuits, so a
-- closed row never runs the aggregate at all.
SELECT s.id, s.session_number, s.status, s.register_id, s.opened_at, s.opening_balance,
       s.closed_at, s.closing_balance,
       CASE
         WHEN s.status <> 'open' THEN s.expected_balance
         WHEN COALESCE((SELECT c.require_blind_count FROM cash_register_settings c
                        WHERE c.hub_id = s.hub_id AND c.is_deleted = 0 LIMIT 1), 0) = 1 THEN NULL
         ELSE s.opening_balance + COALESCE((
                SELECT SUM(CASE WHEN COALESCE(m.payment_method_type, 'cash') = 'cash'
                                THEN CASE WHEN m.movement_type IN ('out', 'refund') THEN -ABS(m.amount) ELSE ABS(m.amount) END
                                ELSE 0 END)
                FROM cash_register_movement m
                WHERE m.session_id = s.id AND m.hub_id = s.hub_id AND m.is_deleted = 0), 0)
       END AS expected_balance,
       s.difference
FROM cash_register_session s
WHERE s.hub_id = :hub_id AND s.is_deleted = 0
