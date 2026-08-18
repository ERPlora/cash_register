-- One OPEN cash session per hub, enforced by the engine (cash_register#11).
--
-- QA 2026-08-10: with a session open, "Open session" still worked and created a second `open`
-- session for the same hub. Every reader of "the open session" (`current_session`,
-- `_movement_for_open_session`, the POS guard) picks ONE by `ORDER BY opened_at DESC LIMIT 1`, so
-- sales landed in a drawer nobody would count. A button cannot guarantee an invariant (two tabs,
-- two devices, a retried request); the database can.
--
-- PARTIAL unique index: only rows that are `open` and not soft-deleted compete for the slot, so the
-- closed history of a hub is never blocked. `open_session.sql` inserts with
-- `ON CONFLICT ... DO NOTHING` against this index and the command's `expect_rows` gate turns the
-- 0-row outcome into the domain error `cash_register.session_already_open` — no 500, no second
-- session, no lost event.
--
-- Pre-existing duplicates (hubs that already hit the bug): keep the MOST RECENT open session and
-- close the older ones with a marker in `closing_notes`, so the index can be created and the
-- drawer the cashier is using stays open. Amounts are left untouched (closing_balance NULL): a
-- session closed by a migration was never counted, and pretending otherwise would fake an arqueo.
UPDATE cash_register_session s
SET status = 'closed',
    closed_at = COALESCE(s.closed_at, s.updated_at, s.opened_at),
    closing_notes = CASE WHEN s.closing_notes = '' THEN 'auto-closed: duplicate open session (cash_register#11)'
                         ELSE s.closing_notes || ' | auto-closed: duplicate open session (cash_register#11)' END
WHERE s.status = 'open' AND s.is_deleted = 0
  AND EXISTS (
    SELECT 1 FROM cash_register_session n
    WHERE n.hub_id = s.hub_id AND n.status = 'open' AND n.is_deleted = 0
      AND (COALESCE(n.opened_at, '') > COALESCE(s.opened_at, '')
           OR (COALESCE(n.opened_at, '') = COALESCE(s.opened_at, '') AND n.id > s.id))
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_cashsession_one_open_per_hub
  ON cash_register_session (hub_id)
  WHERE status = 'open' AND is_deleted = 0;
