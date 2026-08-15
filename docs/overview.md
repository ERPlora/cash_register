# Cash Register — Overview

## What this module does

Cash Register is the cash-control layer of the point of sale. It tracks **sessions** (shifts): who
opened the till, with how much float, what cash went in and out during the shift, and what was
actually counted when it closed. At closing it reconciles the cash it **expected** against the cash
that was **counted** and records the difference.

It also captures cash sales by itself: every completed sale becomes a movement in the open session
without anyone typing it in.

## What this module does NOT do

- **It does not take payments.** Charging a customer belongs to `sales`; this module only records
  what that did to the drawer.
- **It does not open a physical drawer.** The kick signal belongs to the payment method and to
  `printing`.
- **It does not track card or transfer money.** Those never touched the till, so a voided card sale
  produces no cash movement.
- **It does not do banking, deposits or safe drops beyond a plain cash-out movement.** <!-- TODO: verify -->
- **It does not depend on any other module.** It listens to sales events if `sales` is there, and
  works standalone if it is not.

## Modules it connects to

**Depends on nothing.** `depends_on` is empty; the module installs alone.

**Events it emits**

| Event | When |
|---|---|
| `cash_register.session_opened` | a session is opened |
| `cash_register.session_closed` | a session is closed and reconciled |
| `cash_register.settings_updated` | the settings are saved |

**Events it listens to**

| Event | Runs | Effect |
|---|---|---|
| `sale.completed` (from `sales`) | `cash_register.record_sale` | Records a `sale` movement in the open session for the sale total |
| `sale.voided` (from `sales`) | `cash_register._reverse_sale` | If that sale had produced a **cash** movement, posts a compensating refund in the same session |

Both are no-ops in the cases that should be no-ops: a sale with a total of zero or less records
nothing, and voiding a card or transfer sale touches no cash.

## Where its numbers come from

- **All amounts are integer cents** (ADR-0123). An opening float of `10000` is 100,00 €.
- **Expected balance** = opening float + the sum of every non-deleted movement of the session.
- **Difference** = counted at closing − expected. Positive means there is more cash than there should
  be; negative means less.
- **Cash out and refunds are stored as negative amounts**, so that a plain sum of the movements is
  the net change of the drawer.
