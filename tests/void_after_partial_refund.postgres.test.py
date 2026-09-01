#!/usr/bin/env python3
"""Voiding a sale that was ALREADY refunded in part reverses only what is LEFT (cash_register#63).

`commands/_reverse_sale.sql` (the `sale.voided` listener) reversed the WHOLE sale: `-SUM(amount)`
over the sale's cash movements. It knew nothing about the refunds that had already gone out of that
same sale, so a sale refunded in part and voided afterwards took the refunded slice out of the
drawer TWICE.

THE NUMBERS, and they are the issue's own:

  float                            100,00 €   drawer expects 100,00 €
  sale of 100,00 € in CASH                    drawer expects 200,00 €
  refund of 30,00 € in cash (#62)             drawer expects 170,00 €
  the sale is VOIDED                          drawer expects 100,00 €  ← only with this fix
                                              drawer expected  70,00 € before it
                                              → 30,00 € taken out twice, silently

Only 70,00 € of that sale was still inside the till. The old reversal pulled 100,00 €.

WHY "REVERSE THE REST" AND NOT "REFUSE THE VOID" HERE. The market has this decided, and it decides
it the other way: Stripe, Square, Clover, Lightspeed, Shopify POS, Zettle and SumUp all CLOSE the
void door once money has moved against the payment, and Business Central blocks "Cancel" outright
and makes you post a credit memo — the live remainder goes back as ANOTHER refund, never as a void
(12 verified references; the table lives in the ERPlora/sales issue this battery links). But that
door belongs to `sales`, and today it is open: `sales._mark_refunded` only marks the sale when
`fully_refunded`, so a partially refunded sale stays `completed` and can be voided. The drawer has
to be right under BOTH policies and cannot wait for the other one: if `sales` ever refuses the
void, this listener simply never fires; while it allows it, the till must move by the live amount
and not a cent more. Doing NOTHING is not the safe alternative — it would keep counting the 70,00 €
the customer already walked out with, a BIGGER hole than the one this closes.

WHAT DECIDES THE SLICE: the DESTINATION, exactly as in cash_register#62. Only refunds that went
back IN CASH shrink the reversal. A cash sale pushed back onto a card never left the till, so
voiding it still reverses the whole amount (§3) — and a card sale refunded in cash must never make
the void push money INTO the drawer (§5). Subtracting refunds by the ORIGIN tender gets both of
those exactly wrong, and those two sections are what tells the two rules apart.

Sign is server-authoritative (cash_register#48): magnitudes are derived with `ABS()` on BOTH sides,
the same way `queries/session_summary.sql` derives them, so the reversal and the arqueo can never
disagree about a row (§8).

Usage: tests/void_after_partial_refund.postgres.test.py   (exit 0 = green)
  Uses the `erplora-test-pg-5433` container by default (override:
  CASH_REGISTER_TEST_PG_CONTAINER). Creates a scratch database and DROPS it at the end, pass or
  fail. It NEVER skips itself: a battery that goes green because it could not reach Postgres is
  worse than no battery at all.
"""

import json
import os
import pathlib
import re
import subprocess
import sys
import uuid

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())
CONTAINER = os.environ.get("CASH_REGISTER_TEST_PG_CONTAINER", "erplora-test-pg-5433")
DB = f"cash_register_void_net_test_{os.getpid()}"
HUB = "hub-a"
NEIGHBOUR = "hub-next-door"
USER = "u-cashier"

OPENING_FLOAT = 10000  # 100,00 €
SALE_TOTAL = 10000  # 100,00 €
PARTIAL_REFUND = 3000  # 30,00 €
STILL_IN_THE_TILL = SALE_TOTAL - PARTIAL_REFUND  # 70,00 €

failures: list[str] = []


def fail(m: str) -> None:
    failures.append(m)
    print(f"  ✗ {m}")


def ok(m: str) -> None:
    print(f"  ✓ {m}")


def check(label: str, got, want) -> None:
    if got != want:
        fail(f"{label}: got {got!r}, want {want!r}")
    else:
        ok(label)


# ── Postgres plumbing (same shape as tests/refund_arqueo.postgres.test.py) ──────────────────────


def psql(args: list[str], db: str | None = None, stdin: str | None = None) -> str:
    cmd = [
        "docker",
        "exec",
        "-i",
        CONTAINER,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
    ]
    if db:
        cmd += ["-d", db]
    res = subprocess.run(cmd + args, input=stdin, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip() or res.stdout.strip())
    return res.stdout


def literal(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def bind(sql: str, params: dict) -> str:
    return re.sub(
        r"(?<!:):([a-z_][a-z0-9_]*)",
        lambda m: literal(params.get(m.group(1))),
        sql,
        flags=re.IGNORECASE,
    )


def sys_params(payload: dict, hub: str = HUB) -> dict:
    p = dict(payload)
    p.setdefault("hub_id", hub)
    p.setdefault("current_user_id", USER)
    p.setdefault("now", "2026-08-24T10:00:00+00:00")
    p.setdefault("new_id", str(uuid.uuid4()))
    return p


def run_sql_command(name: str, payload: dict, hub: str = HUB) -> None:
    cmd = MANIFEST["commands"][name]
    p = sys_params(payload, hub)
    if name == "cash_register._open_session_insert":
        p.setdefault("day", "20260824")
        p.setdefault("session_day", "260824")
        cmd = {
            "sql": MANIFEST["commands"]["cash_register._bump_counter"]["sql"]
            + cmd["sql"]
        }
    psql(
        [],
        db=DB,
        stdin="\n".join(
            ["BEGIN;"]
            + [bind((MODULE_DIR / r).read_text(), p) for r in cmd["sql"]]
            + ["COMMIT;"]
        ),
    )


def run_query(name: str, payload: dict | None = None, hub: str = HUB) -> list[dict]:
    q = MANIFEST["queries"][name]
    sql = (
        bind((MODULE_DIR / q["sql"]).read_text(), sys_params(payload or {}, hub))
        .rstrip()
        .rstrip(";")
    )
    out = psql(
        [
            "-tA",
            "-c",
            f"SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM ({sql}) t",
        ],
        db=DB,
    )
    return json.loads(out.strip() or "[]")


def open_session(hub: str = HUB) -> str:
    sid = str(uuid.uuid4())
    run_sql_command(
        "cash_register._open_session_insert",
        {
            "session_id": sid,
            "opening_balance": OPENING_FLOAT,
            "register_id": None,
            "opening_notes": "",
        },
        hub,
    )
    return sid


def close_session(session_id: str, hub: str = HUB) -> None:
    run_sql_command(
        "cash_register._close_session_apply",
        {
            "session_id": session_id,
            "closing_balance": 0,
            "expected_balance": 0,
            "difference": 0,
            "closing_notes": "",
        },
        hub,
    )


def book_sale(amount: int, kind: str, name: str, sale_id: str, hub: str = HUB) -> None:
    """One SALE movement, through the door `record_sale` emits."""
    run_sql_command(
        "cash_register._movement_for_open_session",
        {
            "movement_id": str(uuid.uuid4()),
            "movement_type": "sale",
            "amount": amount,
            "gift_total": 0,
            "payment_method": name,
            "payment_method_type": kind,
            "sale_reference": sale_id,
            "description": f"Sale {sale_id}",
        },
        hub,
    )


def book_refund(sale_id: str, amount: int, kind: str, ref: str, hub: str = HUB) -> None:
    """One refund leg, through the door `_record_refund` emits (cash_register#62).

    `kind` is the DESTINATION's canonical type — where the money goes back to — which is the only
    thing that decides whether the till moved."""
    run_sql_command(
        "cash_register._refund_movement_for_open_session",
        {
            "movement_id": str(uuid.uuid4()),
            "amount": amount,
            "payment_method": {"cash": "Efectivo", "card": "Tarjeta"}.get(kind, kind),
            "payment_method_type": kind,
            "sale_reference": sale_id,
            "refund_reference": ref,
            "source_payment_id": f"pay-{ref}",
            "description": f"Refund {ref} · sale {sale_id}",
        },
        hub,
    )


def void(sale_id: str, hub: str = HUB) -> None:
    """The `sale.voided` listener, through its own door."""
    run_sql_command("cash_register._reverse_sale", {"sale_id": sale_id}, hub)


def expected_cash(session_id: str, hub: str = HUB) -> int:
    return run_query("cash_register.session.summary", {"session_id": session_id}, hub)[
        0
    ]["expected_cash"]


def void_movements(sale_id: str, hub: str = HUB) -> list[int]:
    """The magnitudes the void reversal posted for this sale, in the order they were written."""
    return json.loads(
        psql(
            [
                "-tA",
                "-c",
                "SELECT COALESCE(json_agg(ABS(m.amount) ORDER BY m.id), '[]'::json)"
                " FROM cash_register_movement m"
                f" WHERE m.hub_id = '{hub}' AND m.sale_reference = '{sale_id}'"
                " AND m.movement_type = 'refund'"
                f" AND m.description = '[VOID] Sale {sale_id}'",
            ],
            db=DB,
        ).strip()
    )


# ── the cases ──────────────────────────────────────────────────────────────────────────────────


def run_cases() -> None:
    # ── 1. THE ISSUE, with the issue's own ladder ───────────────────────────────────────────────
    print("\n1 · the issue: a partially refunded sale, then voided")
    sid = open_session()
    check("the float is what the drawer expects", expected_cash(sid), OPENING_FLOAT)

    book_sale(SALE_TOTAL, "cash", "Efectivo", "sale-partly-refunded")
    check(
        "the cash sale enters the till", expected_cash(sid), OPENING_FLOAT + SALE_TOTAL
    )

    book_refund("sale-partly-refunded", PARTIAL_REFUND, "cash", "refund-doc-63-a")
    check(
        "the 30,00 € refund leaves the till (cash_register#62)",
        expected_cash(sid),
        OPENING_FLOAT + SALE_TOTAL - PARTIAL_REFUND,
    )

    void("sale-partly-refunded")
    # 🔴 THE issue. Only 70,00 € of that sale was still inside: the void must pull 70,00 €, so the
    # drawer lands exactly back on the float. Before the fix it pulled 100,00 € and landed on
    # 70,00 € — the refunded 30,00 € taken out a second time.
    check(
        "the void reverses ONLY what was left: the drawer is back on the float",
        expected_cash(sid),
        OPENING_FLOAT,
    )
    check(
        "and the compensating movement is the LIVE amount, not the sale total",
        void_movements("sale-partly-refunded"),
        [STILL_IN_THE_TILL],
    )
    summary = run_query("cash_register.session.summary", {"session_id": sid})[0]
    check(
        "the session reports both refunds: the document and the void",
        summary["total_refunds"],
        PARTIAL_REFUND + STILL_IN_THE_TILL,
    )
    check(
        "and the sale is still on the record as sold",
        summary["total_sales"],
        SALE_TOTAL,
    )

    # ── 2. NO REGRESSION: a sale with no refunds voids for its full amount ──────────────────────
    # The control. Without it, "subtract the refunds" and "reverse nothing at all" would look the
    # same in §1's numbers.
    print("\n2 · the control: a sale with NO refunds still reverses in full")
    before = expected_cash(sid)
    book_sale(4000, "cash", "Efectivo", "sale-clean")
    check("the clean sale enters the till", expected_cash(sid), before + 4000)
    void("sale-clean")
    check("voiding it reverses all 40,00 €", expected_cash(sid), before)
    check(
        "with one movement for the whole amount", void_movements("sale-clean"), [4000]
    )

    # ── 3. THE DESTINATION RULE: a cash sale refunded onto a CARD ───────────────────────────────
    # The card refund never touched the till, so the whole 50,00 € of that sale is still inside and
    # the void has to reverse all of it. Subtracting refunds by the ORIGIN tender would reverse
    # only 20,00 € and leave 30,00 € of phantom cash in the arqueo.
    print("\n3 · a cash sale refunded onto a CARD still reverses in full")
    before = expected_cash(sid)
    book_sale(5000, "cash", "Efectivo", "sale-refunded-to-card")
    book_refund("sale-refunded-to-card", 3000, "card", "refund-doc-63-b")
    check(
        "a refund pushed onto a card leaves the till untouched",
        expected_cash(sid),
        before + 5000,
    )
    void("sale-refunded-to-card")
    check("so the void still pulls the whole 50,00 €", expected_cash(sid), before)
    check(
        "in one movement for the sale total",
        void_movements("sale-refunded-to-card"),
        [5000],
    )

    # ── 4. FULLY refunded in cash, then voided: nothing left to reverse ─────────────────────────
    # Reachable today: `sales._mark_refunded` marks the sale only when `fully_refunded`, and the
    # event ordering is not ours to assume. The drawer must post NOTHING — not a zero-amount row.
    print(
        "\n4 · a sale already refunded in FULL leaves nothing for the void to reverse"
    )
    before = expected_cash(sid)
    book_sale(6000, "cash", "Efectivo", "sale-fully-refunded")
    book_refund("sale-fully-refunded", 6000, "cash", "refund-doc-63-c")
    check("the till is back where it started", expected_cash(sid), before)
    void("sale-fully-refunded")
    check("the void moves nothing", expected_cash(sid), before)
    check("and posts no movement at all", void_movements("sale-fully-refunded"), [])

    # ── 5. THE FLOOR: the void must never push money INTO the drawer ────────────────────────────
    # A CARD sale refunded IN CASH (cash_register#62's own case: the card is gone). No cash ever
    # entered the till for that sale, and 20,00 € went out of it. A reversal netted without a floor
    # would post a POSITIVE compensation and hand the drawer 20,00 € that does not exist.
    print("\n5 · the floor: a card sale refunded in cash never gains the drawer money")
    before = expected_cash(sid)
    book_sale(9000, "card", "Tarjeta", "sale-on-card")
    check("the card sale never enters the till", expected_cash(sid), before)
    book_refund("sale-on-card", 2000, "cash", "refund-doc-63-d")
    check("but the cash handed back does leave it", expected_cash(sid), before - 2000)
    void("sale-on-card")
    check("voiding it adds nothing back", expected_cash(sid), before - 2000)
    check("and posts no movement", void_movements("sale-on-card"), [])

    # ── 6. IDEMPOTENCE, with a partial refund in the middle ────────────────────────────────────
    # Defence in depth over the runtime's `_event_delivery` marker. Netting makes it doubly safe:
    # the second delivery finds the sale's live amount already at zero.
    print("\n6 · re-delivering the void does not reverse twice")
    square = expected_cash(sid)
    void("sale-partly-refunded")
    check("the drawer does not move again", expected_cash(sid), square)
    check(
        "and there is still exactly one void movement",
        void_movements("sale-partly-refunded"),
        [STILL_IN_THE_TILL],
    )

    # ── 7. TENANCY, with a LIVE neighbour ──────────────────────────────────────────────────────
    # The same sale reference, refunded in the hub next door. If the "already refunded" lookup
    # forgot `hub_id`, our void would reverse 70,00 € instead of 100,00 € and the shortfall would
    # land in a drawer that never saw the refund.
    print(
        "\n7 · a neighbour's refund on the same sale reference never shrinks our reversal"
    )
    neighbour = open_session(NEIGHBOUR)
    book_sale(SALE_TOTAL, "cash", "Efectivo", "sale-shared-ref", hub=NEIGHBOUR)
    book_refund(
        "sale-shared-ref", PARTIAL_REFUND, "cash", "refund-doc-63-e", hub=NEIGHBOUR
    )
    check(
        "the neighbour's own drawer sees its refund",
        expected_cash(neighbour, NEIGHBOUR),
        OPENING_FLOAT + SALE_TOTAL - PARTIAL_REFUND,
    )
    mine = expected_cash(sid)
    book_sale(SALE_TOTAL, "cash", "Efectivo", "sale-shared-ref")
    void("sale-shared-ref")
    check("our void reverses OUR full sale", expected_cash(sid), mine)
    check(
        "in one movement for the whole amount",
        void_movements("sale-shared-ref"),
        [SALE_TOTAL],
    )
    check(
        "and the neighbour's drawer is untouched by our void",
        expected_cash(neighbour, NEIGHBOUR),
        OPENING_FLOAT + SALE_TOTAL - PARTIAL_REFUND,
    )

    # ── 8. SIGN IS SERVER-AUTHORITATIVE (cash_register#48) ──────────────────────────────────────
    # `session_summary.sql` derives every magnitude with `ABS()`, precisely because rows written
    # before #48 may carry the wrong sign and would poison the arqueo forever. The reversal has to
    # read those rows the SAME way, or the void and the arqueo disagree about the same row: a sale
    # stored as -80,00 € counts as +80,00 € in the drawer, so the void owes it 80,00 € back.
    print("\n8 · the reversal derives magnitudes exactly as the arqueo does")
    before = expected_cash(sid)
    psql(
        [
            "-c",
            "INSERT INTO cash_register_movement (id, hub_id, session_id, movement_type, amount,"
            " payment_method, payment_method_type, sale_reference, description, employee_id,"
            " is_deleted, created_by, updated_by, created_at, updated_at) VALUES"
            f" ('mv-legacy-mis-signed', '{HUB}', '{sid}', 'sale', -8000, 'Efectivo', 'cash',"
            f" 'sale-legacy-mis-signed', 'Sale sale-legacy-mis-signed', '{USER}',"
            " 0, 'u', 'u', '2026-08-24T10:00:00+00:00', '2026-08-24T10:00:00+00:00')",
        ],
        db=DB,
    )
    check(
        "the arqueo counts a mis-signed sale as money IN",
        expected_cash(sid),
        before + 8000,
    )
    void("sale-legacy-mis-signed")
    check("and the void takes exactly that back out", expected_cash(sid), before)
    check(
        "with one movement of the same magnitude",
        void_movements("sale-legacy-mis-signed"),
        [8000],
    )

    close_session(sid)
    close_session(neighbour, NEIGHBOUR)


def main() -> int:
    print(f"[void-net] real Postgres · container {CONTAINER}")
    if (
        subprocess.run(["docker", "inspect", CONTAINER], capture_output=True).returncode
        != 0
    ):
        print(f"  ✗ container `{CONTAINER}` is not running")
        return 1
    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        for rel in MANIFEST["migrations"]["postgres"]:
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
        run_cases()
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])

    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print(
        "\nOK — voiding a partially refunded sale reverses only what was still in the till"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
