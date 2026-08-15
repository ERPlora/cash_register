# Cash Register — Limits and troubleshooting

## Known limitation you should know about

**The live "expected cash" widget counts refunds and cash-outs with the wrong sign.** The current
session KPI flips the sign of negative movements, so a session with refunds or cash-outs shows a
higher expected figure than it should. **The closing reconciliation is correct** — it is only the
live widget that misreports. When the numbers matter, close the session and read expected, counted
and difference from there.

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

By role: **admin** has everything. **manager** and **employee** share the exact same set —
everything except `manage_settings`. That means a normal employee can open, close, move cash and
count, which is what a shift needs; but **only an admin can create a drawer or change how the till
behaves**.

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
that sale, in the session where the sale was originally recorded, which may not be today's.

**"There are two refunds for the same void."** There cannot be; the insertion is guarded. If you see
two, they are for different sales — check the sale reference on each.

**"I cannot record a movement."** There must be an **open** session for you. A closed session accepts
nothing.

**"The expected cash on the dashboard does not match the closing screen."** Trust the closing screen.
See the known limitation at the top of this page.

**"I closed the session by mistake."** There is no reopen. Open a new session with the counted cash
as its float and carry on; the two sessions together tell the true story.

**"Someone can sell without opening the till."** Turn on **Activar caja** and set the **protected POS
URL** to the sell screen in Settings. Only an admin can do this.

**"I want to correct a movement I typed wrong."** You cannot edit or delete it. Record the opposite
movement with a description saying why. The audit trail is the feature.
