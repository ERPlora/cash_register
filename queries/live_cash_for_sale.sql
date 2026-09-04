-- How much CASH is still alive against a sale, right now (cash_register#80). Same CTE
-- `_reverse_movement_for_open_session.sql` computes at write time — original cash sold, minus cash
-- already refunded for that same `sale_id`, floored at zero (a sale already refunded in full, or
-- one that never touched the drawer, answers 0). Always exactly one row: unlike the write SQL this
-- never depends on a session existing, cash or card, open or closed.
--
-- What it is FOR: `reverse_sale` needs to know, BEFORE deciding whether to refuse for "no open
-- session", whether the void has anything in cash to reverse at all. Refusing a card-only void for
-- lack of an open drawer was a false alarm — the drawer was never going to move either way — and it
-- dead-lettered every one of them (cash_register#80). Reading this first lets the handler skip that
-- refusal exactly when it would have been pointless, without touching the write SQL's own guard
-- (`live.amount > 0`, which stays the source of truth for what actually gets posted).
SELECT
  GREATEST(
    COALESCE((
      SELECT SUM(ABS(orig.amount))
      FROM cash_register_movement orig
      WHERE orig.hub_id = :hub_id
        AND orig.sale_reference = :sale_id
        AND orig.movement_type = 'sale'
        AND COALESCE(orig.payment_method_type,'cash') = 'cash'
        AND orig.is_deleted = 0
    ), 0)
    - COALESCE((
      SELECT SUM(ABS(rf.amount))
      FROM cash_register_movement rf
      WHERE rf.hub_id = :hub_id
        AND rf.sale_reference = :sale_id
        AND rf.movement_type = 'refund'
        AND COALESCE(rf.payment_method_type,'cash') = 'cash'
        AND rf.is_deleted = 0
    ), 0),
    0
  ) AS amount;
