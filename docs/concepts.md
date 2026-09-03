# Cash Register — Concepts

The things people get wrong on their first day.

## A session is a shift, and there is one open at a time

A session is opened with a float, lives while people sell, and is closed with a count. Its status is
`open`, `closed` or `suspended`. Cash movements always land in **the open session of the person
recording them** — you never pick a session by hand when a sale is captured.

## Expected, counted, difference

Three numbers, and confusing them is the most common mistake.

- **Expected** = the opening float plus every movement of the session. The system computes it; you
  never type it.
- **Counted** (the closing balance) = what you physically counted and typed in.
- **Difference** = counted − expected. **Positive means surplus** (more cash than there should be),
  **negative means shortfall**.

The difference is recorded, not corrected. It is the whole point of the exercise: a till that always
reconciles to the cent is a till nobody is checking.

## A closed session is history

Closing reconciles and freezes. There is no command to reopen a session, to edit its float, or to
change a movement after the fact — and there is no command to delete a movement either.

**A wrong figure is corrected with another movement**, not by rewriting the old one. That is exactly
what the void handling does: it never touches the original movement, it posts a compensating one.
The trail of what happened stays readable.

## Cash out and refunds are stored negative

`in` and `sale` are positive; `out` and `refund` are negative. This is a deliberate convention so
that the expected balance is a plain sum of the movements and nothing has to know which types to
subtract.

So a movement list showing `-2500` for a supplier payment is correct, not a bug.

## Cash sales record themselves

When a sale completes, this module writes a `sale` movement into the open session for that sale's
total, tagged with the sale id and the payment method name. Nobody types it.

A sale whose total is zero or less records **nothing** — a fully comped ticket produces no cash
movement.

## Voiding a sale posts a refund; it does not erase anything

When a sale is voided, the module looks for the **cash** movement that sale produced.

- If it finds one, it inserts a compensating `refund` in the session that is **open right now**,
  marked with the voided sale, for the negated amount. The original movement is left exactly as it
  was.
- If the sale was paid by card, transfer or anything else, nothing happens — that money never touched
  the drawer.

This is **idempotent**: a repeated `sale.voided` delivery cannot post the refund twice.

The refund lands in **today's open drawer, never in a shift that has already been counted** — even
when the sale itself belongs to yesterday. That is where the money physically comes from, it is
where a plain refund has always gone, and it is what every till does: a closed shift is closed. If
no drawer is open at all the void is **refused out loud** instead of being lost: open the register
and the event is retried.

A shift that has been closed keeps the expected balance it was signed with, for good. Nothing
recorded later changes it.

## Gifts are shown apart, at cost

An invitation or comped item never entered the drawer, so it must never be counted as cash. The
module accumulates the **cost** of the gifts in a sale and the session summary exposes them as
**Invitaciones**, listed separately from sales and cash. Do not add them to your cash figure.

## The count is computed from the denominations, not typed

When you count the drawer you enter how many of each note and coin. The stored total is recomputed
server-side from those denominations. If you send an explicit total it is accepted, but the normal
path is: count the money, let the machine add it up.

A count is `opening` or `closing`. The denominations themselves are stored, so an audit can see the
composition of the drawer, not just its total.

## Every amount is an integer number of cents

The float, every movement, the expected balance, the counted balance and the difference are **cents**
(ADR-0123). `10000` is 100,00 €. There are no decimal amounts anywhere in this module.

## Sessions belong to a drawer, optionally

A hub can have several registers (drawers), or none configured at all — the register on a session is
optional. Deleting a register does not delete its sessions; they simply lose the link.

## The POS can be locked until the till is open

The settings hold the route of a **protected POS screen** (by default the sell screen). Combined with
**Activar caja**, this is what stops someone selling before anyone has opened the drawer for the
day.
