#!/usr/bin/env python3
"""Voiding a sale reverses the drawer — the `cash_register` half of `void_reversal_e2e.rs`
(ERPlora/hub#1264, contract «El Hub se CIERRA como KERNEL» §5, slice 4: cash_register).

That e2e proved the CHAIN `sales.void` → `sale.voided` → cash_register (`_reverse_sale`) +
inventory (`_restock_on_void`) in the SAME test bodies. The stock half belongs to inventory (its
own slice); what `cash_register` owes the chain — and what this battery pins — is:

  1. A cash sale that put money in the drawer, once voided, gets a COMPENSATING `refund` movement
     for the exact amount (the original `sale` movement is never mutated — audit trail intact) and
     the session's expected balance (the arqueo) returns to the opening net.
  2. A card sale is a no-op for the DRAWER, voided or not — but not for the ledger: `record_sale`
     logs a `sale` movement for every payment leg regardless of tender (verified against the real
     runtime; the original hub e2e's hand-seeded precondition skipped this leg for card and so
     never saw it). What actually keeps a card sale off the physical float is the
     `payment_method_type = 'cash'` filter in `_reverse_sale.sql` AND in all three readings of the
     drawer — `queries/current_session.sql` (the live KPI the old e2e read as `expected_cash()`),
     `queries/session_summary.sql` (`expected_cash`, what `movement.add` checks
     `allow_negative_balance` against) and `commands/close_session.sql` (`expected_balance`):
     voiding a card sale posts no `refund`, and none of the three ever counted it. Each case below
     asserts the movement EXISTS and that all three figures EXCLUDE it — asserting only the closing
     figure left the live KPI unguarded (found with a mutant during the hub#1264 review).

Two things this battery deliberately does NOT attempt, and why:

  * **Redelivery idempotency.** `commands/_reverse_sale.sql` guards itself with a
    `NOT EXISTS (… refund … description = '[VOID] Sale :sale_id')`, defense in depth over the
    runtime's own `_event_delivery` marker — but nothing in the public API replays an outbox event
    on demand (only the Rust-internal `rt.drain_outbox()` the old e2e used can invoke a listener a
    second time). This is a genuine black-box gap, not a shortcut: see the coverage note on
    ERPlora/hub#1264 (inventory's `_restock_on_void` has the symmetric gap).
  * **The service-line scenario.** `_reverse_sale.sql` keys purely off `cash_register_movement` rows
    by `sale_reference` — it never reads `sales_sale_item`, so a service-only sale reverses
    identically to a product sale from cash_register's point of view. The distinguishing part of
    that original test (stock stays untouched) is inventory's assertion, not cash_register's.

`install_registers_void_listeners` (the registry check) is not ported as its own case either: a
battery cannot introspect `listeners_for`, only observe that voiding a cash sale actually reverses
it — which §1 below does.

Usage: `erplora test <dir> --against-hub [dev|stable|sha256:…]` (module-toolkit#110). Never on its
own: without a runtime it fails, it does not skip.
"""

import sys
import time

import hub_harness
from hub_harness import (
    Hub,
    card_method_id,
    cash_method_id,
    cents,
    key,
    live_expected_cash,
    open_session,
    wait_for_movements,
)


def charge(hub: Hub, payment_method_id: str, tag: str, total: int) -> str:
    out = hub.run(
        "sales.complete_sale",
        {
            "idempotency_key": key(tag),
            "payment_method_id": payment_method_id,
            "tax_included": False,
            "items": [
                {
                    "product_name": "X",
                    "price": total,
                    "quantity": hub_harness.ONE,
                    "tax_rate": 0.0,
                }
            ],
        },
    )
    return out["new_ids"][0]


def closing_expected_balance(hub: Hub, session_id: str) -> int:
    """Closes the session and returns the `expected_balance` the close froze — the reconciliation
    (the "arqueo") the original bug named: "el arqueo queda inflado por cada anulación"."""
    hub.run(
        "cash_register.session.close",
        {"session_id": session_id, "closing_balance": 0, "closing_notes": ""},
    )
    row = next(
        s for s in hub.query("cash_register.sessions.list") if s["id"] == session_id
    )
    return cents(row.get("expected_balance"))


def test_1_cash_sale_void_reverts_cash(hub: Hub) -> None:
    print(
        "\n1 · a voided CASH sale gets a compensating refund; the arqueo returns to the opening net"
    )
    opening = 10_000
    sid = open_session(hub, opening)
    total = 3000
    sale_id = charge(hub, cash_method_id(hub), "void-cash", total)

    sale_movs = wait_for_movements(hub, sid, sale_id, "sale")
    hub.check("the sale posted its cash movement first", len(sale_movs), 1)
    hub.check(
        "live (current_session.expected_total, summary.expected_cash) after the cash sale",
        live_expected_cash(hub, sid),
        (opening + total, opening + total),
    )

    hub.run("sales.void", {"sale_id": sale_id, "reason": "hub#1264 battery"})

    refund_movs = wait_for_movements(hub, sid, sale_id, "refund")
    hub.check("exactly one compensating refund", len(refund_movs), 1)
    hub.check(
        "the refund compensates the exact amount (negative, canonical)",
        cents(refund_movs[0].get("amount")),
        -total,
    )

    # The original `sale` movement is untouched — both rows coexist (audit trail intact).
    all_movs = hub.query("cash_register.movements.list", {"session_id": sid})
    types = [
        m.get("movement_type") for m in all_movs if m.get("sale_reference") == sale_id
    ]
    hub.check_true(
        "the original `sale` movement is not mutated, only compensated",
        "sale" in types and "refund" in types,
        str(types),
    )

    # sale(+3000) + refund(-3000) = 0 → every reading of the drawer is back at the opening net:
    # the two live ones while the session is still open, then the one the close freezes.
    hub.check(
        "live (current_session.expected_total, summary.expected_cash) after the void",
        live_expected_cash(hub, sid),
        (opening, opening),
    )
    hub.check("arqueo returns to the opening net", closing_expected_balance(hub, sid), opening)


def test_2_card_sale_void_is_a_cash_no_op(hub: Hub) -> None:
    print(
        "\n2 · a voided CARD sale is a cash no-op: `record_sale` still logs the leg, but no refund"
    )
    opening = 5_000
    sid = open_session(hub, opening)
    total = 3000
    sale_id = charge(hub, card_method_id(hub), "void-card", total)

    # `record_sale` logs a `sale` movement for EVERY payment leg, cash or not (cash_register#59,
    # `handler/src/lib.rs::record_sale_a_card_sale_carries_its_type`) — it is bookkeeping ("total
    # sales", regardless of tender), not a drawer entry. What makes a card sale a no-op for the
    # PHYSICAL drawer is every reading of the drawer filtering to `payment_method_type = 'cash'`:
    # the live KPI, the summary and the close — checked below both before and after the void.
    sale_movs = wait_for_movements(hub, sid, sale_id, "sale")
    hub.check("the card leg is still logged as a `sale` movement", len(sale_movs), 1)
    hub.check(
        "live (current_session.expected_total, summary.expected_cash) ignore the card leg",
        live_expected_cash(hub, sid),
        (opening, opening),
    )

    hub.run("sales.void", {"sale_id": sale_id, "reason": "hub#1264 battery"})

    # Nothing to WAIT for here (a `refund` movement that never gets posted stays absent forever), so
    # a short fixed settle past the relay's usual tick is the correct shape — `wait_for_movements`
    # would only time out proving the same thing more slowly.
    time.sleep(1.5)
    refunds = [
        m
        for m in hub.query("cash_register.movements.list", {"session_id": sid})
        if m.get("sale_reference") == sale_id and m.get("movement_type") == "refund"
    ]
    hub.check(
        "`_reverse_sale` skips it: no refund for a non-cash sale leg", len(refunds), 0
    )
    # opening(5000) + zero cash-typed movements (the card leg does not count) = 5000, unaffected by
    # either the sale or its void — live while open, and frozen by the close.
    hub.check(
        "live (current_session.expected_total, summary.expected_cash) after the card void",
        live_expected_cash(hub, sid),
        (opening, opening),
    )
    hub.check(
        "the drawer never counted the card sale, void included",
        closing_expected_balance(hub, sid),
        opening,
    )


def main() -> int:
    hub = Hub("reverse_on_void.hub", needs=("taxes", "sales", "cash_register"))
    print(
        f"Hub battery · reverse_on_void (hub#1264 ← void_reversal_e2e.rs, cash_register half) · "
        f"{hub_harness.BASE} · hub {hub.hub_id} · user {hub.user}"
    )
    test_1_cash_sale_void_reverts_cash(hub)
    test_2_card_sale_void_is_a_cash_no_op(hub)
    return hub.finish(
        "a void reverses exactly the cash a sale put in the drawer, against the real kernel"
    )


if __name__ == "__main__":
    sys.exit(main())
