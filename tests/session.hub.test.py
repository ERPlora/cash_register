#!/usr/bin/env python3
"""Cash sessions against the REAL kernel — `cash_register_e2e.rs` (ERPlora/hub#1264, contract «El
Hub se CIERRA como KERNEL» §5, slice 4: cash_register).

That e2e proved the module's own lifecycle: a session opens with a float, movements add up, a
close reconciles what was COUNTED against what was EXPECTED, the WASM handler sums a denomination
count, and a sale charged through `sales` lands as a cash movement in the open session — twice
over, once through the plain movement write and once through the event it announces. This battery
pins the same five behaviours (no separate issue: ported as-is from the hub e2e):

  1. Opening float + movements (`sale`, `out`) + close: `expected_balance` is the running total,
     `difference` is what was counted against it.
  2. `session.summary` aggregates by type: refunds/`out` are stored NEGATIVE but reported as a
     POSITIVE magnitude (the sign the till shows a cashier).
  3. `count.add` (the WASM handler) sums a denomination breakdown to its total in cents.
  4. A direct `movement.add` emits `cash_register.movement_added` — the data-ready event the
     current-session KPI widget refreshes on, in the SAME transaction as the write (ADR-0054 T3).
  5/6. The REAL chain `sales.complete_sale` → outbox → `cash_register.record_sale`: the movement
     lands in the session AND the same data-ready event fires, so a listener never sees a KPI query
     race the write that produced it.
  7. The «Difference» filter of `sessions.list` is a from / to RANGE (cash_register#107): the list
     engine reads the `op` of the manifest, so only a runtime proves that `f_difference_from/_to`
     are accepted and that a NEGATIVE edge (a short drawer) narrows the list. The UI half — typing
     «-5» asks for -500 cents — lives in `balance-range-filter.test.ts`.

`install_registers_capabilities` (the sixth original test) is not ported as its own case: every
command it named is exercised below (`session.open`/`movement.add`/`count.add`), and the
`sale.completed → cash_register.record_sale` mapping it checked via the registry is proven
functionally by §5 — a battery cannot introspect the registry, only observe what installing the
module lets it DO.

Usage: `erplora test <dir> --against-hub [dev|stable|sha256:…]` (module-toolkit#110). Never on its
own: without a runtime it fails, it does not skip.
"""

import sys

import hub_harness
from hub_harness import (
    Hub,
    cash_method_id,
    cents,
    close_session,
    key,
    open_session,
    wait_for_movements,
)


def test_1_open_movements_close_reconciles(hub: Hub) -> None:
    print("\n1 · movements accrue on the float; close reconciles counted vs. expected")
    sid = open_session(hub, 10_000)
    hub.run(
        "cash_register.movement.add",
        {
            "session_id": sid,
            "movement_type": "sale",
            "amount": 5000,
            "payment_method": "cash",
            "sale_reference": "",
            "description": "sale",
        },
    )
    hub.run(
        "cash_register.movement.add",
        {
            "session_id": sid,
            "movement_type": "out",
            "amount": -2000,
            "payment_method": "cash",
            "sale_reference": "",
            "description": "withdrawal",
        },
    )
    # Close counting 135,00 € → expected = 100+50-20 = 130,00 €; difference = 135-130 = 5,00 €.
    hub.run(
        "cash_register.session.close",
        {"session_id": sid, "closing_balance": 13500, "closing_notes": ""},
    )
    row = next(s for s in hub.query("cash_register.sessions.list") if s["id"] == sid)
    hub.check("status", row.get("status"), "closed")
    hub.check("expected_balance", cents(row.get("expected_balance")), 13000)
    hub.check("difference", cents(row.get("difference")), 500)


def test_2_summary_aggregates_by_type(hub: Hub) -> None:
    print(
        "\n2 · session.summary aggregates by type — refunds report as a POSITIVE magnitude"
    )
    sid = open_session(hub, 0)
    for movement_type, amount in (
        ("sale", 3000),
        ("sale", 2000),
        ("refund", -1000),
        ("in", 500),
    ):
        hub.run(
            "cash_register.movement.add",
            {
                "session_id": sid,
                "movement_type": movement_type,
                "amount": amount,
                "payment_method": "cash",
                "sale_reference": "",
                "description": "",
            },
        )
    summary = hub.query("cash_register.session.summary", {"session_id": sid})[0]
    hub.check("total_sales", cents(summary.get("total_sales")), 5000)
    # A refund stored at -1000 is reported as 1000 (the query negates the SUM of outflows).
    hub.check(
        "total_refunds (sign flipped for the till)",
        cents(summary.get("total_refunds")),
        1000,
    )
    hub.check("movement_count", summary.get("movement_count"), 4)
    close_session(hub, sid)


def test_3_count_wasm_sums_denominations(hub: Hub) -> None:
    print("\n3 · count.add (WASM) sums a denomination breakdown")
    sid = open_session(hub, 0)
    # 2×50 + 5×20 + 10×1 = 210,00 €.
    out = hub.run(
        "cash_register.count.add",
        {
            "session_id": sid,
            "count_type": "opening",
            "denominations": {"bills": {"50": 2, "20": 5}, "coins": {"1": 10}},
        },
    )
    hub.check("operations", out.get("operations"), 1)
    counts = hub.query("cash_register.counts.list", {"session_id": sid})
    hub.check("counts recorded", len(counts), 1)
    hub.check("total (cents)", cents(counts[0].get("total")), 21000)
    close_session(hub, sid)


def test_4_movement_add_emits_movement_added(hub: Hub) -> None:
    print("\n4 · a direct movement.add emits `cash_register.movement_added`")
    sid = open_session(hub, 10_000)
    hub.run(
        "cash_register.movement.add",
        {
            "session_id": sid,
            "movement_type": "sale",
            "amount": 5000,
            "payment_method": "cash",
            "sale_reference": "",
            "description": "sale",
        },
    )
    shape = hub.event_shape("cash_register.movement_added")
    hub.check_true(
        "cash_register.movement_added has been emitted",
        shape is not None and shape.get("samples", 0) >= 1,
        str(shape),
    )
    close_session(hub, sid)


def test_5_sale_completed_records_cash_movement(hub_sales: Hub) -> str:
    print(
        "\n5 · the REAL chain: sales.complete_sale → outbox → cash_register.record_sale"
    )
    sid = open_session(hub_sales, 0)
    sale_id = hub_sales.run(
        "sales.complete_sale",
        {
            "idempotency_key": key("cash-movement"),
            "payment_method_id": cash_method_id(hub_sales),
            "tax_included": False,
            "items": [
                {
                    "product_name": "X",
                    "price": 3000,
                    "quantity": hub_harness.ONE,
                    "tax_rate": 0.0,
                }
            ],
        },
    )["new_ids"][0]
    movs = wait_for_movements(hub_sales, sid, sale_id, "sale")
    hub_sales.check("movements for this sale", len(movs), 1)
    hub_sales.check("amount", cents(movs[0].get("amount")), 3000)
    close_session(hub_sales, sid)
    return sale_id


def test_6_record_sale_emits_movement_added_after_relay(hub_sales: Hub, sale_id: str) -> None:
    print(
        "\n6 · record_sale (the relay path) also emits `cash_register.movement_added`"
    )
    # §5 already drove one sale through the relay in THIS run; the event it left behind is what we
    # read here — no need to charge a second one, `event_shape` samples the NEWEST of its kind.
    #
    # Newest is the whole point: §1/§2/§4 already emitted `movement_added` through `movement.add`,
    # so "at least one sample exists" would stay green with `record_sale` emitting nothing at all
    # (proved with a mutant during the hub#1264 review). What tells the two producers apart is the
    # payload: the relay emits over the `sale.completed` payload, so its event carries `sale_id`
    # (the one §5 charged); a `movement.add` emission carries `session_id`/`sale_reference` and no
    # `sale_id`. Pinning the newest event to §5's sale is what makes this the relay path.
    field = hub_sales.event_field("cash_register.movement_added", "sale_id")
    hub_sales.check(
        "the newest cash_register.movement_added is the relay's, carrying §5's sale_id",
        (field or {}).get("sample"),
        sale_id,
    )


def closed_with_difference(hub: Hub, counted: int) -> str:
    """A session opened with a 100,00 € float, no movements, closed counting `counted` cents — so
    its stored difference is `counted - 10000`."""
    sid = open_session(hub, 10_000)
    hub.run(
        "cash_register.session.close",
        {"session_id": sid, "closing_balance": counted, "closing_notes": ""},
    )
    return sid


def test_7_difference_filter_is_a_money_range(hub: Hub) -> None:
    print("\n7 · the «Difference» filter of sessions.list is a range, minus sign included (#107)")
    over = closed_with_difference(hub, 10_500)  # +5,00 €
    short = closed_with_difference(hub, 9_500)  # -5,00 €
    slightly_short = closed_with_difference(hub, 9_950)  # -0,50 €
    ids = {over, short, slightly_short}

    def mine(filters: dict) -> set[str]:
        # The hub is shared with every other battery of the run: only the ids minted here count.
        rows = hub.query("cash_register.sessions.list", {"limit": 500, **filters})
        return {r["id"] for r in rows} & ids

    rows = [r for r in hub.query("cash_register.sessions.list", {"limit": 500}) if r["id"] in ids]
    hub.check("stored differences", sorted(cents(r["difference"]) for r in rows), [-500, -50, 500])
    hub.check("from -500 to -50", mine({"f_difference_from": -500, "f_difference_to": -50}), {short, slightly_short})
    hub.check("from 0", mine({"f_difference_from": 0}), {over})
    hub.check("to -100", mine({"f_difference_to": -100}), {short})


def main() -> int:
    hub = Hub("session.hub")
    print(
        f"Hub battery · session (hub#1264 ← cash_register_e2e.rs) · {hub_harness.BASE} · hub {hub.hub_id} · user {hub.user}"
    )
    test_1_open_movements_close_reconciles(hub)
    test_2_summary_aggregates_by_type(hub)
    test_3_count_wasm_sums_denominations(hub)
    test_4_movement_add_emits_movement_added(hub)

    hub_sales = Hub("session.hub (relay)", needs=("taxes", "sales", "cash_register"))
    sale_id = test_5_sale_completed_records_cash_movement(hub_sales)
    test_6_record_sale_emits_movement_added_after_relay(hub_sales, sale_id)
    hub.failures += hub_sales.failures

    # After §6 on purpose: §6 reads the NEWEST `movement_added`, and §7 opens and closes sessions.
    test_7_difference_filter_is_a_money_range(hub)

    return hub.finish(
        "sessions open, accrue, reconcile and relay a sale into the drawer, against the real kernel"
    )


if __name__ == "__main__":
    sys.exit(main())
