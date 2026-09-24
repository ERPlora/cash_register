# Cash Register — Screens

The module contributes one tab to the hub navigation — **Cash Register** — plus a **Caja** settings
tab the shell generates from the declarative settings block.

## Cash Register

A table of sessions with their status and totals (`cash_register.sessions.list`, 50 rows per page).
Requires `cash_register.view_session`. The table refreshes by itself when a session is opened or
closed.

- **Search** by session number.
- **Sort** by session number, status, register, opening and closing time, opening and closing
  balance, expected balance or difference.
- **Filter** by session number, status, register, or a range on any of the amounts and times.

**Expected** is live while the session is open: opening float plus every cash movement so far, the
same figure the KPI widget and the close use. You do not have to close the drawer to know what it
should hold — that is when the number is worth something (Square shows it on the open drawer, Toast
in Shift Review, Lightspeed in Cash management). **Counted** and **difference** stay "—" until the
count is declared: they are what somebody actually counted, and nothing invents them beforehand.
With **Arqueo ciego** on, the expected of the open session is blank for everybody in this table —
that is what makes the count blind; supervisors with `cash_register.view_expected_totals` read it
from the *Caja (sesión actual)* widget. Once closed, the column shows the figure the close froze,
never a recomputation: it is the number the stored difference was computed against.

Every action below is a row action on an **open** session; a closed session is read-only.

### Open the till at the start of a shift

1. Press **Abrir sesión** (open session).
2. Pick the drawer, if the hub has more than one configured. It is optional.
3. Enter the **opening float** — the cash already in the drawer. The hub can be configured to demand
   it.
4. Add a note if you want, and confirm.

The session number is generated for you as `S-YYMMDD-HHMMSS`. `cash_register.session_opened` is
emitted. Requires `cash_register.add_session`.

### Record cash in or cash out

1. On the open session, choose **Movimiento** (movement).
2. Pick **in** or **out**, enter the amount and a description.
3. Confirm.

A cash-out is stored as a negative amount so the reconciliation adds up. Use this for a supplier paid
in cash, a tip taken out, change brought in from the safe. Requires
`cash_register.add_movement`.

### Count the drawer

1. Choose **Arqueo** (count).
2. Enter how many of each note and coin you have. The total updates live as you type.
3. Confirm.

The total that gets stored is recomputed from the denominations by the server, not taken from the
screen. A count is either an **opening** count or a **closing** count. Requires
`cash_register.add_count`.

A **closing** count leads straight to the close, with its total already in **Efectivo contado** —
counting the drawer is the step before closing it, not a note filed on its own. It does not close
anything by itself: the close is still `cash_register.session.close`, it still needs
`cash_register.close_session`, and you still confirm it. An **opening** count does not: that one is
the start-of-shift check of the float.

### Close the till at the end of a shift

1. Choose **Cerrar** (close).
2. Enter the cash you counted — **already filled in** if this session has a closing count, so nobody
   counts the same drawer twice (that second pass is where differences are invented). Without such a
   count the field starts empty; it never inherits an opening count, nor an amount typed for another
   session. The hub can be configured to demand it.
3. Confirm.

The screen then shows the three numbers that matter: **expected**, **counted** and **difference**.
The session moves to `closed` and `cash_register.session_closed` is emitted. Requires
`cash_register.close_session`.

## The session detail (drawer report)

The **Detalle** row action opens the detail of any session — open or closed, like Square's drawer
report or Toast's cash drawer details. On top, the reconciliation summary
(`cash_register.session.summary`): opening float, **sales** (all tenders) and, below, the sales
**by payment method** — cash, card, and other methods (transfer, other) only when there were any;
only the cash line enters the drawer, like the tender breakdown of an X/Z report. In a hub with
blind count on, an OPEN session shows the total sales without the split (the cash line would give
the expected away). Then refunds, paid in, paid out,
**Invitaciones** (gifts) listed **separately, at cost** — a comped item never entered the drawer, so
it must not be mixed with cash —, the expected cash, and, once the session is closed, the counted
cash and the difference (an open session shows "—" there: the difference is revealed when the count
is declared). Below it, the two lists of that session, both 50 rows per page:

- **Movements** (`cash_register.movements.list`, needs `cash_register.view_movement`) — searchable by
  sale reference or description; filterable by type (`sale`, `refund`, `in`, `out`), amount range,
  payment method, sale reference or date. Newest first.
- **Counts** (`cash_register.counts.list`, needs `cash_register.view_count`) — the drawer counts of a
  register, with their denominations, total and notes.

## Registers (drawers)

The hub can have several physical or logical drawers (`cash_register.registers.list`). Each has a
name and an active flag. Creating one requires `cash_register.manage_settings`, which only an admin
has.

## Caja — settings

Generated by the shell from the settings schema. Requires `cash_register.manage_settings` —
**admin only**.

| Setting | Meaning |
|---|---|
| Activar caja | Turns cash session management on at all |
| Exigir saldo de apertura | The opening float is mandatory when opening — enforced by the server (`cash_register.opening_balance_required`), not just by the form |
| Exigir saldo de cierre | The counted cash is mandatory when closing — enforced by the server (`cash_register.closing_balance_required`) |
| Permitir saldo negativo | Whether a cash-out may leave the drawer below zero — enforced by the server (`cash_register.negative_balance_not_allowed`) |
| Arqueo ciego | Blind count: whoever counts the drawer does not see the expected cash until the count is declared. Supervisors with `cash_register.view_expected_totals` still see it |
| Cierre automático diario | If nobody closed the drawer, the hub closes it by itself at the hour below (business local time): expected cash computed, nothing counted, attributed to the system and marked in the closing notes. Off by default |
| Hora del cierre automático | Local hour of the automatic close (HH:00). Toast closes at 04:00 by default; pick the hour after your last shift |
| URL del POS protegido | The POS route that stays locked until the drawer is open (default `/m/sales/pos/`) |

All fields are sent together — the form saves a complete snapshot, not a single field.

The former *Abrir caja al iniciar sesión* / *Cerrar caja al cerrar sesión* toggles are gone: no
part of the product ever read them (and no reference POS opens a drawer on login or closes it on
logout), so offering them was a lie. What actually closes a forgotten drawer is the daily automatic
close above, run by the hub's scheduler every 5 minutes (`auto_close_sessions`).

## First-run setup

Cash Register contributes an **optional** setup step called **"Your cash drawer"**: *Decide how the
till opens and closes: the opening float, the closing count and the POS screen that stays locked
until the drawer is open.* It points at the settings screen and is considered done once the settings
row exists. It needs `cash_register.manage_settings`.

## Dashboard widgets

| Widget | Shows | Permission |
|---|---|---|
| Caja (sesión actual) | Expected cash in the currently open session | `cash_register.view_expected_totals` (admin, manager) |
| Descuadres recientes | The difference of the last eight closed sessions | `cash_register.view_reports` |
