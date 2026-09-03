-- The write half of the void reversal (`sale.voided`, ADR-0075). Called by the `reverse_sale`
-- handler, which already refused if there is no drawer open.
--
-- If the voided sale left LIVE cash in the drawer, this posts ONE compensating `refund` movement
-- for that amount, negated, in the session that is OPEN RIGHT NOW. It never mutates the original
-- movement (the audit trail stays intact): it adds the reversal.
--
-- 🔴 IN THE OPEN SHIFT, NOT IN THE ORIGINAL ONE (cash_register#77). This used to group by
-- `orig.session_id` — one reversal per session that had taken a leg of the sale — and nothing said
-- those sessions had to still be open. A sale voided the day after, or after the shift was cashed
-- up, wrote a movement into a CLOSED session: `queries/session_summary.sql` recomputed its
-- `expected_cash`, so the expected of a shift that had already been counted and signed moved after
-- the count, while the STORED `expected_balance`/`difference` — the audited pair the cashier was
-- measured against, and what `sessions_list.sql` serves for closed shifts since #65 — stayed put.
-- Two readings of the same shift, disagreeing. And the drawer the money physically comes out of
-- today did not move at all.
--
-- The market decided this one in a single direction, and the reasoning is in `reverse_sale`'s doc
-- comment: a closed shift is not reopened. It is also the symmetry that was missing — a REFUND has
-- gone to the open shift since #62 and a VOID went to the original one, for the same movement of
-- money. When the void happens during the shift that took the sale (the ordinary case) the open
-- session IS the original one, so nothing about that path changes.
--
-- ONE TARGET, SO ONE ROW, SO ONE ID. `004_one_open_session_per_hub.sql` allows a single open
-- session per hub, and `ORDER BY s.opened_at DESC LIMIT 1` is the same tie-break the two sibling
-- doors use (`_movement_for_open_session`, `_refund_movement_for_open_session`) for the day several
-- tills are allowed. That is what makes the primary-key collision of cash_register#61 structurally
-- impossible here: the statement can only ever write one row, so the single `:movement_id` the
-- handler hands over is always the row that exists. The waterfall #61 needed to spread the live
-- amount over several sessions is gone with the reason for it.
--
-- "Paid in cash" = the original `sale` movement was stored with `payment_method_type='cash'` (what
-- `record_sale` persists; we reverse exactly what the drawer captured, without re-reading the
-- sale). Card/bizum never touch the drawer, so voiding them is a no-op here. hub#778: compared
-- against payment_method_TYPE, never against the localised `name`.
--
-- 🔴 WHAT IS REVERSED IS WHAT IS STILL ALIVE, NOT THE WHOLE SALE (cash_register#63). This was once
-- `-SUM(sale)`: the reversal knew nothing about the REFUNDS already paid out of that same sale
-- (`refund` rows with `sale_reference = :sale_id`, which exist since #62), so a sale partly
-- refunded and then voided took the refunded slice out of the drawer a second time. With the
-- issue's example — 100,00 € float, a 100,00 € cash sale, a 30,00 € refund and then the void — only
-- 70,00 € of that sale were still in the till and the reversal took 100,00 €: the count came out
-- 30,00 € over, silently, against an expected the cashier cannot argue with.
--
-- Why NET and not "refuse the void" HERE: that policy belongs to `sales`, not to the drawer. The
-- market has it decided and says the opposite of what this listener assumes — Stripe, Square,
-- Clover, Lightspeed, Shopify POS, Zettle and SumUp CLOSE the void door as soon as money has moved
-- against the charge, and Business Central blocks "Cancel" and forces the credit memo: the live
-- remainder is returned with ANOTHER refund, never with a void (12 references verified, table in
-- ERPlora/sales). But that door is closed by `sales`, and TODAY it is not: `sales._mark_refunded`
-- only marks the sale when `fully_refunded`, so a partly refunded sale stays `completed` and can be
-- voided. The drawer has to come out right under both policies and cannot wait for the other one:
-- if `sales` stops allowing it this listener simply stops firing, and while it allows it the drawer
-- moves by the live amount and not one cent more. NOT netting is not the safe alternative: it would
-- leave inside the 70,00 € the customer already took, a BIGGER mismatch than the one this closes.
--
-- 🔴 THE TYPE IS THE DESTINATION'S, as in `_refund_movement_for_open_session` (cash_register#62).
-- Only refunds that went back IN CASH are subtracted: a cash sale refunded to a CARD took nothing
-- out of the drawer, so voiding it still reverses the full amount; and a card sale refunded in cash
-- cannot make the void PUT money into the drawer — hence the `live.amount > 0` floor, which also
-- avoids the zero-amount `refund` of a sale already refunded in full.
--
-- SERVER-AUTHORITATIVE SIGN (cash_register#48): magnitudes are derived with `ABS()` on BOTH legs,
-- exactly as `queries/session_summary.sql` derives them. A badly signed row from before #48 counts
-- as an inflow in the count, so the void has to give it back the same way; reading it any other way
-- would leave the drawer and the count disagreeing about the same row.
--
-- IDEMPOTENT (defence in depth over the runtime's `_event_delivery` marker): the INSERT … SELECT
-- only produces a row if (a) there is live cash left for this sale and (b) its reversal does not
-- already exist (a `refund` with sale_reference=:sale_id marked '[VOID]'). A re-delivery does not
-- duplicate; a second sale never re-emits (`sales.void` only voids 'completed'). The netting is the
-- second lock: the reversal is itself a cash `refund` of that sale, so on a re-delivery the live
-- amount is already 0.
--
-- The runtime injects :hub_id, :current_user_id, :now; :movement_id and :sale_id come from the
-- handler.
WITH live AS (
  SELECT GREATEST(
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
    0) AS amount
)
INSERT INTO cash_register_movement
  (id, hub_id, session_id, movement_type, amount, payment_method, payment_method_type, sale_reference, description, employee_id,
   is_deleted, created_by, updated_by, created_at, updated_at)
SELECT
  :movement_id, :hub_id, s.id, 'refund', -live.amount, 'cash', 'cash', :sale_id,
  '[VOID] Sale ' || :sale_id, :current_user_id,
  0, :current_user_id, :current_user_id, :now, :now
FROM cash_register_session s, live
WHERE s.hub_id = :hub_id
  AND s.is_deleted = 0
  AND s.status = 'open'
  AND live.amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM cash_register_movement rev
    WHERE rev.hub_id = :hub_id
      AND rev.sale_reference = :sale_id
      AND rev.movement_type = 'refund'
      AND rev.description = '[VOID] Sale ' || :sale_id
  )
ORDER BY s.opened_at DESC
LIMIT 1;
