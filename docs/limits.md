# Cash Register — Limits and troubleshooting

## Known limitation you should know about

**Sessions that were already open when this fix shipped may still close short.** Until
cash_register#33, a sale's movement did not record *how* it was paid: the column existed with a
`DEFAULT 'cash'` and nothing wrote to it, so the closing reconciliation counted **card sales as
cash** and the drawer came up short by exactly the card takings.

It is fixed forward — every movement created from now on records its real payment type. But the
movements written **before** the fix still say `cash`, and there is deliberately **no backfill**:

- **Sessions already closed are not rewritten.** Their expected, counted and difference are frozen
  on the session row: they are the record of what a cashier actually counted that day. Correcting
  them afterwards would not fix anything that happened — it would falsify a closed arqueo.
- **For a session still open**, the only trace left of the payment type is the method's *display
  name* (`Efectivo`, `Tarjeta`, `Card`…), which is localised and free text per business. Guessing
  from it would turn a known error into an invisible one.

⚠️ **What to do:** if a session was open across the update, close it and read the difference knowing
its card sales are still counted as cash. From the next session on, the figure is right.

**The live expected cash is trustworthy (it was not always).** It used to be a known limitation: the
current-session KPI flipped the sign of refunds and cash-outs, so a shift with either showed more
than the drawer held, and the advice was to close the session and read the numbers from there. That
was fixed in cash_register#48 — the sign now comes from the movement's KIND on the server, not from
how the amount happens to be stored — and since cash_register#65 the sessions table computes the
same figure the same way. The grid, the *Caja (sesión actual)* widget and the close all run one
formula, and a battery fails if they ever disagree (`tests/open_session_expected.postgres.test.py`).

## Caps and sizes

| Limit | Value |
|---|---|
| Rows per page (sessions, movements, counts, registers) | 50 |
| Maximum rows a paginated request may ask for | 500 |
| Protected POS URL | up to 255 characters |
| Count type | `opening` or `closing` only |
| Movement type | `sale`, `refund`, `in` or `out` only |
| Session status | `open`, `closed` or `suspended` |

## Permissions per action

| To do this | You need |
|---|---|
| See sessions, registers and the settings | `cash_register.view_session` |
| Open a session | `cash_register.add_session` |
| Close a session | `cash_register.close_session` |
| See movements | `cash_register.view_movement` |
| Record a movement (in / out) | `cash_register.add_movement` |
| See counts | `cash_register.view_count` |
| Record a drawer count | `cash_register.add_count` |
| See reports and the discrepancy widget | `cash_register.view_reports` |
| Create a register, change the settings | `cash_register.manage_settings` |
| See the expected cash of the open session before the count (widget, `current_session.expected`) | `cash_register.view_expected_totals` |

By role: **admin** has everything. **manager** has everything except `manage_settings`.
**employee** is a manager minus `view_expected_totals`; **cashier** (declared by `sales`) gets the
operational set only. That means a normal employee can open, close, move cash and count, which is
what a shift needs; but **only an admin can create a drawer or change how the till behaves**, and
with the *Arqueo ciego* setting on, only admins and managers see what the drawer should hold before
it is counted.

## Dependencies — what breaks if something is missing

**This module depends on nothing** and can be installed on its own.

**`sales` is optional but expected.** Without it, nothing emits `sale.completed`, so the till records
only what you type by hand: opening float, manual movements and counts. Reconciliation still works;
it just has no automatic sales in it.

**Nothing depends on Cash Register**, so it can be uninstalled without breaking another module. Its
sessions and movements are the record of what happened; removing the module removes that record from
view.

## When something looks wrong

**"A sale did not appear in the till."** Check, in this order: was the total greater than zero (a
fully comped sale records nothing)? Is there an **open session** for the person who sold? Is `sales`
installed and emitting?

**"The difference is not zero and I do not know why."** That is the normal outcome and the reason the
count exists. Read the movement list of the session: manual outs, refunds from voided cash sales, and
the opening float are the usual suspects. Remember gifts are **not** cash and are reported apart.

**"I voided a sale and the cash did not come back."** If it was paid by card or transfer, nothing
should come back — the drawer never had it. If it was cash, look for a `refund` movement marked with
that sale **in the drawer that is open now**, not in the shift that sold it: the money goes out of
today's till. If there was no session open when the sale was voided the reversal was refused and
retried later — check that a register is open.

**"There are two refunds for the same void."** There cannot be; the insertion is guarded. If you see
two, they are for different sales — check the sale reference on each.

**"I cannot record a movement."** There must be an **open** session for you. A closed session accepts
nothing.

**"The expected cash on the dashboard does not match the closing screen."** They cannot differ any
more: the table, the widget and the close compute it the same way (cash_register#48/#65). If you do
see a gap, it is a real bug — report it with both numbers and the session number.

**"The expected column of an open session is empty."** **Arqueo ciego** is on: the expected is hidden
until the count is declared, on purpose. A supervisor with `cash_register.view_expected_totals` sees
it in the *Caja (sesión actual)* widget.

**"I closed the session by mistake."** There is no reopen. Open a new session with the counted cash
as its float and carry on; the two sessions together tell the true story.

**"Someone can sell without opening the till."** Turn on **Activar caja** and set the **protected POS
URL** to the sell screen in Settings. Only an admin can do this.

**"I want to correct a movement I typed wrong."** You cannot edit or delete it. Record the opposite
movement with a description saying why. The audit trail is the feature.
